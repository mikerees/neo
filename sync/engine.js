// sync/engine.js — Sync orchestrator for NEO
// Coordinates push (on save), pull (on open/focus), and initial upload/download.
// Runs entirely in the main process.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SC = require('./crypto.js');
const Drive = require('./drive.js');
const State = require('./state.js');
const Manifest = require('./manifest.js');

// ---------------------------------------------------------------------------
// Engine state (in-memory)
// ---------------------------------------------------------------------------

let _masterKey = null;       // Buffer, unwrapped
let _libraryDir = null;      // absolute path to the NEO Library
let _sendStatus = null;      // (status) => void — notify renderer
let _logError = null;        // (context, err) => void

let _syncInProgress = false;
let _pushDebounce = null;    // timer for batch push
const _pushQueue = new Map();  // relativePath -> queuedAt
const PUSH_DEBOUNCE_MS = 3000;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_CONCURRENT_DOWNLOADS = 2;

// Files and patterns to exclude from sync
const EXCLUDE_PATTERNS = [
  /^Backups\//,
  /^Exports\//,
  /^_catalog\.txt$/,
  /^neo-errors\.log$/,
  /^snapshots\//i,
  /\.tmp$/,
  /\.bak$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /^Sync Trash\//,
  /^sync-state\.json$/
];

function shouldSync(relativePath) {
  const norm = relativePath.replace(/\\/g, '/');
  return !EXCLUDE_PATTERNS.some((re) => re.test(norm));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init({ masterKey, libraryDir, sendStatus, logError }) {
  _masterKey = masterKey;
  _libraryDir = libraryDir;
  _sendStatus = sendStatus || (() => {});
  _logError = logError || (() => {});
}

function setMasterKey(key) { _masterKey = key; }
function getMasterKey() { return _masterKey; }
function isReady() { return !!_masterKey && !!_libraryDir; }

function status(state, detail) {
  if (_sendStatus) _sendStatus({ type: 'syncStatus', state, detail: detail || '' });
}

// ---------------------------------------------------------------------------
// Enumerate syncable files in the library
// ---------------------------------------------------------------------------

function enumerateLibrary(libraryDir) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), rel);
      } else if (ent.isFile() && shouldSync(rel)) {
        files.push(rel);
      }
    }
  };
  walk(libraryDir, '');
  return files;
}

// ---------------------------------------------------------------------------
// Initial upload — first-device setup
// ---------------------------------------------------------------------------

async function initialUpload(onProgress) {
  if (!isReady()) throw new Error('Sync engine not initialized');

  const state = State.readState();
  const fk = SC.fileIdKey(_masterKey);
  const ck = SC.contentKey(_masterKey);
  const mfk = SC.manifestKey(_masterKey);

  const files = enumerateLibrary(_libraryDir);
  const manifest = Manifest.createManifest(state.deviceId);
  const total = files.length;
  let done = 0;

  status('syncing', `Uploading ${total} files…`);

  // Upload in batches
  for (let i = 0; i < files.length; i += MAX_CONCURRENT_UPLOADS) {
    const batch = files.slice(i, i + MAX_CONCURRENT_UPLOADS);
    await Promise.all(batch.map(async (rel) => {
      try {
        const abs = path.join(_libraryDir, rel);
        const data = fs.readFileSync(abs);
        const hash = SC.contentHash(data);
        const objectId = SC.deriveObjectId(fk, rel);
        const objectVersion = 1;

        const blob = SC.encryptBlob(ck, data, objectId, objectVersion);
        await Drive.createFile(objectId, blob, 'application/octet-stream');

        Manifest.setObject(manifest, objectId, {
          relativePath: rel,
          bookId: bookIdFromPath(rel),
          contentHash: hash,
          objectVersion,
          lastWriterDeviceId: state.deviceId,
          size: data.length
        });

        State.markSynced(state, objectId, rel, hash, objectVersion);
        done++;
        if (onProgress) onProgress(done, total);
        status('syncing', `Uploaded ${done} of ${total}`);
      } catch (err) {
        if (_logError) _logError('sync upload', err);
      }
    }));
  }

  // Upload manifest
  manifest.manifestVersion = 1;
  const manifestBlob = Manifest.encryptManifestVersioned(manifest, mfk);
  const manifestName = 'manifest-' + crypto.randomUUID();
  await Drive.createFile(manifestName, manifestBlob, 'application/octet-stream');

  state.lastSyncAt = new Date().toISOString();
  state.lastManifestVersion = manifest.manifestVersion;
  state.enabled = true;
  State.writeState(state);

  status('synced');
  return { uploaded: done, total };
}

// ---------------------------------------------------------------------------
// Push — encrypt and upload changed files
// ---------------------------------------------------------------------------

function enqueueSync(relativePath) {
  if (!isReady()) return;
  if (!shouldSync(relativePath)) return;

  _pushQueue.set(relativePath, Date.now());

  // Debounce: wait for more saves to batch
  clearTimeout(_pushDebounce);
  _pushDebounce = setTimeout(() => {
    syncPush().catch((err) => {
      if (_logError) _logError('sync push', err);
      status('error', err.message);
    });
  }, PUSH_DEBOUNCE_MS);
}

// Cancel any pending debounce and push immediately — called before syncAll
// so that a manual "Sync Now" includes everything enqueued up to this moment.
function flushPushDebounce() {
  if (_pushDebounce) {
    clearTimeout(_pushDebounce);
    _pushDebounce = null;
  }
}

async function syncPush() {
  if (!isReady() || _syncInProgress || _pushQueue.size === 0) return;
  _syncInProgress = true;
  status('syncing');

  try {
    const state = State.readState();
    const fk = SC.fileIdKey(_masterKey);
    const ck = SC.contentKey(_masterKey);
    const mfk = SC.manifestKey(_masterKey);

    // Snapshot the queue
    const items = [..._pushQueue.entries()];
    _pushQueue.clear();

    // Read current manifest from Drive
    let manifest = await fetchRemoteManifest(mfk);
    if (!manifest) manifest = Manifest.createManifest(state.deviceId);
    let manifestChanged = false;

    for (let i = 0; i < items.length; i += MAX_CONCURRENT_UPLOADS) {
      const batch = items.slice(i, i + MAX_CONCURRENT_UPLOADS);
      await Promise.all(batch.map(async ([rel]) => {
        try {
          const abs = path.join(_libraryDir, rel);
          if (!fs.existsSync(abs)) return; // file deleted between queue and push

          // library.json: merge with remote before pushing so neither side overwrites the other
          if (rel === 'library.json') {
            const remoteEntry = Manifest.findByPath(manifest, 'library.json');
            if (remoteEntry) {
              try {
                const remotePlaintext = await downloadAndDecrypt(
                  remoteEntry.objectId, remoteEntry.objectVersion, ck
                );
                if (remotePlaintext) mergeLibraryJson(abs, remotePlaintext, _libraryDir);
              } catch (_err) {
                if (_logError) _logError('sync push library merge', _err);
              }
            }
          }

          // book.json: don't push a hollow rebuild over a real remote
          if (rel.endsWith('/book.json') && isHollowBookMeta(abs)) {
            const remoteEntry = Manifest.findByPath(manifest, rel);
            if (remoteEntry) {
              try {
                const remotePlaintext = await downloadAndDecrypt(
                  remoteEntry.objectId, remoteEntry.objectVersion, ck
                );
                if (remotePlaintext) {
                  let remoteMeta;
                  try { remoteMeta = JSON.parse(remotePlaintext.toString('utf8')); } catch { /* */ }
                  if (remoteMeta && remoteMeta.title && remoteMeta.title !== 'Untitled') {
                    // Remote has real content — adopt it instead of pushing the rebuild
                    writeFileDurable(abs, remotePlaintext);
                    const remoteHash = SC.contentHash(remotePlaintext);
                    State.markSynced(state, SC.deriveObjectId(fk, rel), rel,
                      remoteHash, remoteEntry.objectVersion);
                    return; // skip pushing
                  }
                }
              } catch (_err) {
                if (_logError) _logError('sync push book.json guard', _err);
              }
            }
          }

          const data = fs.readFileSync(abs);
          const hash = SC.contentHash(data);
          const objectId = SC.deriveObjectId(fk, rel);

          // Skip if unchanged from last sync
          const prev = State.getObjectState(state, objectId);
          if (prev && prev.lastSyncedHash === hash) return;

          const objectVersion = (prev ? prev.lastSyncedObjectVersion : 0) + 1;
          const blob = SC.encryptBlob(ck, data, objectId, objectVersion);

          // Upload or update the blob on Drive
          await Drive.uploadOrUpdate(objectId, blob, 'application/octet-stream');

          Manifest.setObject(manifest, objectId, {
            relativePath: rel,
            bookId: bookIdFromPath(rel),
            contentHash: hash,
            objectVersion,
            lastWriterDeviceId: state.deviceId,
            size: data.length
          });

          State.markSynced(state, objectId, rel, hash, objectVersion);
          manifestChanged = true;
        } catch (err) {
          // Re-enqueue on failure so it retries
          _pushQueue.set(rel, Date.now());
          if (_logError) _logError('sync push file', err);
        }
      }));
    }

    // Upload updated manifest (optimistic write)
    if (manifestChanged) {
      manifest.manifestVersion = (manifest.manifestVersion || 0) + 1;
      manifest.deviceId = state.deviceId;
      await uploadManifest(manifest, mfk);
      state.lastManifestVersion = manifest.manifestVersion;
    }

    state.lastSyncAt = new Date().toISOString();
    State.writeState(state);
    status(_pushQueue.size > 0 ? 'syncing' : 'synced');
  } finally {
    _syncInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Pull — download changed files from remote
// ---------------------------------------------------------------------------

async function syncPull() {
  if (!isReady() || _syncInProgress) return { downloaded: 0 };
  _syncInProgress = true;
  status('syncing');

  try {
    const state = State.readState();
    const ck = SC.contentKey(_masterKey);
    const mfk = SC.manifestKey(_masterKey);

    const manifest = await fetchRemoteManifest(mfk);
    if (!manifest) { status('synced'); return { downloaded: 0 }; }

    const diff = Manifest.diffManifest(manifest, state);
    let downloaded = 0;
    const conflicts = [];

    // Download changed objects
    for (let i = 0; i < diff.toDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
      const batch = diff.toDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
      await Promise.all(batch.map(async ({ objectId, remote, mayConflict }) => {
        try {
          const rel = remote.relativePath;
          const abs = path.join(_libraryDir, ...rel.split('/'));

          // Check for conflict: local file also changed since last sync
          if (mayConflict) {
            // library.json is always merged, never conflicted
            if (rel === 'library.json') {
              const plaintext = await downloadAndDecrypt(objectId, remote.objectVersion, ck);
              if (plaintext) {
                mergeLibraryJson(abs, plaintext, _libraryDir);
                const mergedHash = localFileHash(abs);
                State.markSynced(state, objectId, rel, mergedHash || remote.contentHash, remote.objectVersion);
                downloaded++;
              }
              return;
            }
            const localHash = localFileHash(abs);
            const prev = State.getObjectState(state, objectId);
            if (localHash && prev && localHash !== prev.lastSyncedHash && remote.contentHash !== prev.lastSyncedHash) {
              // True conflict: both sides changed
              conflicts.push({ objectId, relativePath: rel, remoteHash: remote.contentHash });
              // Save remote version as conflict file
              const blob = await downloadAndDecrypt(objectId, remote.objectVersion, ck);
              if (blob) {
                const conflictPath = conflictFilePath(abs);
                writeFileDurable(conflictPath, blob);
              }
              // Keep local as-is, update state to note the conflict
              return;
            }
          }

          // Download, decrypt, write
          const plaintext = await downloadAndDecrypt(objectId, remote.objectVersion, ck);
          if (!plaintext) return;

          // Verify hash
          const hash = SC.contentHash(plaintext);
          if (hash !== remote.contentHash) {
            if (_logError) _logError('sync pull', new Error('Hash mismatch for ' + rel));
            return;
          }

          // library.json gets merged, not overwritten
          if (rel === 'library.json') {
            mergeLibraryJson(abs, plaintext, _libraryDir);
          } else {
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeFileDurable(abs, plaintext);
          }

          State.markSynced(state, objectId, rel, hash, remote.objectVersion);
          downloaded++;
        } catch (err) {
          if (_logError) _logError('sync pull file', err);
        }
      }));
    }

    // Apply tombstones: move locally deleted files to Sync Trash
    for (const { objectId, remote } of diff.toDelete) {
      try {
        const rel = remote.relativePath;
        const abs = path.join(_libraryDir, ...rel.split('/'));
        if (fs.existsSync(abs)) {
          const trashDir = path.join(_libraryDir, 'Sync Trash', new Date().toISOString().slice(0, 10));
          if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
          const trashDest = path.join(trashDir, rel.replace(/\//g, '_'));
          fs.renameSync(abs, trashDest);
        }
        State.addTombstone(state, objectId, remote.objectVersion);
      } catch (err) {
        if (_logError) _logError('sync tombstone', err);
      }
    }

    // Always merge library.json with remote even if diffManifest said it was
    // current — the local copy may have orphaned authorIds or missing books
    // from a previous sync that ran before the merge code existed.
    const libWasDownloaded = diff.toDownload.some(
      (d) => d.remote && d.remote.relativePath === 'library.json'
    );
    if (!libWasDownloaded) {
      const libEntry = Manifest.findByPath(manifest, 'library.json');
      if (libEntry) {
        try {
          const remotePlaintext = await downloadAndDecrypt(
            libEntry.objectId, libEntry.objectVersion, ck
          );
          if (remotePlaintext) {
            const absLib = path.join(_libraryDir, 'library.json');
            mergeLibraryJson(absLib, remotePlaintext, _libraryDir);
            const mergedHash = localFileHash(absLib);
            State.markSynced(state, libEntry.objectId, 'library.json',
              mergedHash || libEntry.contentHash, libEntry.objectVersion);
            downloaded++;
          }
        } catch (err) {
          if (_logError) _logError('sync pull library reconcile', err);
        }
      }
    }

    // Safety net: remap orphaned shelf authorIds and shelve any book folder
    // on disk that isn't on a shelf yet.
    if (ensureBooksAreShelved(_libraryDir)) downloaded++;

    // Reconcile book.json files: if the app rebuilt a default book.json
    // (Untitled / Anonymous) because of a race with the sync, re-download
    // the real version from the manifest.
    downloaded += await reconcileBookMeta(manifest, ck, state, _libraryDir);

    state.lastSyncAt = new Date().toISOString();
    state.lastManifestVersion = manifest.manifestVersion;
    State.pruneTombstones(state);
    State.writeState(state);

    if (conflicts.length > 0 && _sendStatus) {
      _sendStatus({ type: 'syncConflict', conflicts });
    }

    status('synced');
    return { downloaded, conflicts: conflicts.length };
  } finally {
    _syncInProgress = false;
  }
}

// Full sync: push local changes first so the other device sees them,
// then pull remote changes, then push again for anything the pull changed
// (e.g. a merged library.json).
async function syncAll() {
  flushPushDebounce();
  await syncPush();
  const pullResult = await syncPull();
  await syncPush();
  return pullResult;
}

// ---------------------------------------------------------------------------
// Tombstone push — mark a deleted file in the manifest
// ---------------------------------------------------------------------------

async function pushTombstone(relativePath) {
  if (!isReady()) return;
  const state = State.readState();
  const fk = SC.fileIdKey(_masterKey);
  const mfk = SC.manifestKey(_masterKey);
  const objectId = SC.deriveObjectId(fk, relativePath);

  const prev = State.getObjectState(state, objectId);
  if (!prev) return; // never synced

  const objectVersion = prev.lastSyncedObjectVersion + 1;

  try {
    const manifest = await fetchRemoteManifest(mfk);
    if (!manifest) return;

    Manifest.deleteObject(manifest, objectId, state.deviceId);
    manifest.manifestVersion = (manifest.manifestVersion || 0) + 1;
    await uploadManifest(manifest, mfk);

    // Delete the blob from Drive
    try {
      const files = await Drive.listFiles(`name='${objectId}'`);
      for (const f of files) await Drive.deleteFile(f.id);
    } catch { /* best effort */ }

    State.addTombstone(state, objectId, objectVersion);
    State.writeState(state);
  } catch (err) {
    if (_logError) _logError('sync tombstone push', err);
  }
}

// ---------------------------------------------------------------------------
// Manifest fetch / upload helpers
// ---------------------------------------------------------------------------

let _manifestFileId = null;  // cached Drive file ID of the manifest

async function fetchRemoteManifest(mfk) {
  try {
    const files = await Drive.listFiles("name contains 'manifest-'");
    if (files.length === 0) return null;
    // Pick the newest manifest
    const sorted = files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
    _manifestFileId = sorted[0].id;
    const blob = await Drive.downloadFile(_manifestFileId);
    return Manifest.decryptManifestVersioned(blob, mfk);
  } catch (err) {
    if (_logError) _logError('sync manifest fetch', err);
    return null;
  }
}

async function uploadManifest(manifest, mfk) {
  const blob = Manifest.encryptManifestVersioned(manifest, mfk);
  if (_manifestFileId) {
    await Drive.updateFile(_manifestFileId, blob, 'application/octet-stream');
  } else {
    const name = 'manifest-' + crypto.randomUUID();
    const result = await Drive.createFile(name, blob, 'application/octet-stream');
    _manifestFileId = result.id;
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function downloadAndDecrypt(objectId, objectVersion, contentKeyBuf) {
  const files = await Drive.listFiles(`name='${objectId}'`);
  if (files.length === 0) return null;
  const blob = await Drive.downloadFile(files[0].id);
  return SC.decryptBlob(contentKeyBuf, blob, objectId, objectVersion);
}

function localFileHash(absPath) {
  try {
    const data = fs.readFileSync(absPath);
    return SC.contentHash(data);
  } catch {
    return null;
  }
}

function conflictFilePath(absPath) {
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  const when = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `${base}.conflict-${when}${ext}`);
}

function writeFileDurable(file, data) {
  const tmp = file + '.tmp';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function bookIdFromPath(rel) {
  const parts = rel.replace(/\\/g, '/').split('/');
  if (parts.length > 0 && parts[0].startsWith('book-')) return parts[0];
  return null;
}

// ---------------------------------------------------------------------------
// library.json merge — intelligent merge instead of flat overwrite
// ---------------------------------------------------------------------------

// Per-device keys that must never be overwritten by a remote library.json
// (matches DEVICE_LOOK in app.js)
const DEVICE_LOOK = [
  'pageTheme', 'uiBright', 'uiBrightAside', 'uiZoom', 'editorFontSize',
  'typewriter', 'focus', 'posMode', 'outlineView', 'vimKeys'
];

function listBookFoldersOnDisk(libraryDir) {
  const ids = [];
  try {
    for (const d of fs.readdirSync(libraryDir)) {
      if (d.startsWith('book-') && fs.existsSync(path.join(libraryDir, d, 'chapters'))) {
        ids.push(d);
      }
    }
  } catch { /* empty library */ }
  return ids;
}

function ensureBooksAreShelved(libraryDir) {
  const absPath = path.join(libraryDir, 'library.json');
  let lib;
  try { lib = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { return false; }

  const authors = Array.isArray(lib.authors) && lib.authors.length ? lib.authors : [];
  const authorIds = new Set(authors.map((a) => a.id));
  const shelves = Array.isArray(lib.shelves) ? lib.shelves : [];
  let changed = false;

  // Remap orphaned shelf authorIds: a shelf whose authorId doesn't match
  // any local author becomes invisible in shelvesFor(). Remap it to the
  // first author so the books on it become visible again.
  if (authors.length > 0) {
    const firstId = authors[0].id;
    for (const shelf of shelves) {
      if (shelf.authorId && !authorIds.has(shelf.authorId)) {
        shelf.authorId = firstId;
        changed = true;
      }
    }
  }

  // Unshelved book folders on disk go on the first shelf
  const allOnDisk = listBookFoldersOnDisk(libraryDir);
  const shelvedSet = new Set(shelves.flatMap((s) => s.bookIds || []));
  const unshelved = allOnDisk.filter((id) => !shelvedSet.has(id));

  if (unshelved.length > 0) {
    if (shelves.length > 0) {
      for (const id of unshelved) shelves[0].bookIds.push(id);
    } else {
      shelves.push({ id: 's-' + Date.now().toString(36), name: 'Shelf', bookIds: unshelved });
      lib.shelves = shelves;
    }
    changed = true;
  }

  if (!changed) return false;
  writeFileDurable(absPath, JSON.stringify(lib, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// book.json reconciliation — detect hollow rebuilds and re-download
// ---------------------------------------------------------------------------

// A book.json written by rebuildBookMeta has title 'Untitled' (or its
// translation) and author 'Anonymous'. When the manifest holds a version
// with a real title, the remote wins — the rebuild was caused by a race
// between sync and the running app.
function isHollowBookMeta(absPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    if (!meta || typeof meta !== 'object') return true;
    const title = (meta.title || '').trim();
    const author = (meta.author || '').trim();
    if (!title || title === 'Untitled') return true;
    if (!author || author === 'Anonymous') return true;
    return false;
  } catch { return true; }
}

async function reconcileBookMeta(manifest, ck, state, libraryDir) {
  const bookDirs = listBookFoldersOnDisk(libraryDir);
  let fixed = 0;
  for (const bookDir of bookDirs) {
    const rel = bookDir + '/book.json';
    const abs = path.join(libraryDir, bookDir, 'book.json');

    if (!isHollowBookMeta(abs)) continue;

    const entry = Manifest.findByPath(manifest, rel);
    if (!entry) continue;

    try {
      const remotePlaintext = await downloadAndDecrypt(
        entry.objectId, entry.objectVersion, ck
      );
      if (!remotePlaintext) continue;

      // Only overwrite if remote actually has a real title
      let remoteMeta;
      try { remoteMeta = JSON.parse(remotePlaintext.toString('utf8')); } catch { continue; }
      if (!remoteMeta || !remoteMeta.title || remoteMeta.title === 'Untitled') continue;

      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeFileDurable(abs, remotePlaintext);

      const hash = SC.contentHash(remotePlaintext);
      State.markSynced(state, entry.objectId, rel, hash, entry.objectVersion);
      fixed++;
    } catch (err) {
      if (_logError) _logError('sync reconcile book.json', err);
    }
  }
  return fixed;
}

function mergeLibraryJson(absPath, remoteBuffer, libraryDir) {
  let local;
  try { local = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { local = {}; }
  let remote;
  try { remote = JSON.parse(remoteBuffer.toString('utf8')); } catch { remote = {}; }

  // Preserve local device-specific keys; strip them from remote
  const deviceSnapshot = {};
  for (const k of DEVICE_LOOK) {
    if (local[k] !== undefined) deviceSnapshot[k] = local[k];
    delete remote[k];
  }

  // --- Authors ---
  const localAuthors = Array.isArray(local.authors) && local.authors.length
    ? local.authors
    : [{ id: 'a1', name: local.authorName || 'Anonymous' }];
  const remoteAuthors = Array.isArray(remote.authors) && remote.authors.length
    ? remote.authors
    : [{ id: 'a1', name: remote.authorName || 'Anonymous' }];

  // Build a map: remote author id -> local author id (when names match)
  const authorIdMap = {};
  const localHadAuthors = Array.isArray(local.authors) && local.authors.length > 0;
  const mergedAuthors = [...localAuthors];

  for (const ra of remoteAuthors) {
    const raName = (ra.name || '').trim().toLowerCase();
    // First try exact ID match
    const byId = mergedAuthors.find((a) => a.id === ra.id);
    if (byId) {
      // If the local author was a synthetic fallback, adopt the remote name
      if (!localHadAuthors && byId.name === 'Anonymous' && ra.name) {
        byId.name = ra.name;
      }
      authorIdMap[ra.id] = byId.id;
      continue;
    }
    // Then try name match (case-insensitive)
    const byName = mergedAuthors.find((a) => (a.name || '').trim().toLowerCase() === raName);
    if (byName) {
      authorIdMap[ra.id] = byName.id;
      continue;
    }
    // No match — add this author
    mergedAuthors.push({ ...ra });
    authorIdMap[ra.id] = ra.id;
  }

  // --- Shelves ---
  const localShelves = Array.isArray(local.shelves) ? local.shelves : [];
  const remoteShelves = Array.isArray(remote.shelves) ? remote.shelves : [];
  const mergedShelves = localShelves.map((s) => ({ ...s, bookIds: [...(s.bookIds || [])] }));

  for (const rs of remoteShelves) {
    // Remap authorId through the author merge map
    const mappedAuthorId = rs.authorId ? (authorIdMap[rs.authorId] || rs.authorId) : undefined;

    const existing = mergedShelves.find((s) => s.id === rs.id);
    if (existing) {
      // Union bookIds: add remote books not already present
      for (const bid of (rs.bookIds || [])) {
        if (!existing.bookIds.includes(bid)) existing.bookIds.push(bid);
      }
      // Adopt binding info from remote if local doesn't have it
      if (rs.binding && !existing.binding) existing.binding = rs.binding;
    } else {
      // Shelf exists only on remote — add it with remapped authorId
      mergedShelves.push({
        ...rs,
        bookIds: [...(rs.bookIds || [])],
        ...(mappedAuthorId ? { authorId: mappedAuthorId } : {})
      });
    }
  }

  // --- Safety net: any book folder on disk not on any shelf gets shelved ---
  const allOnDisk = listBookFoldersOnDisk(libraryDir || _libraryDir);
  const shelvedSet = new Set(mergedShelves.flatMap((s) => s.bookIds || []));
  const unshelved = allOnDisk.filter((id) => !shelvedSet.has(id));

  if (unshelved.length > 0) {
    // Put unshelved books on the first shelf (of the first author if available)
    const target = mergedShelves[0];
    if (target) {
      for (const id of unshelved) target.bookIds.push(id);
    }
  }

  // --- Merge scalar / non-device keys ---
  const merged = { ...local };

  // Remote wins for these metadata keys if they carry information
  if (remote.authorName && !local.authorName) merged.authorName = remote.authorName;
  if (remote.firstRunDone) merged.firstRunDone = true;
  if (remote.spellLanguage && !local.spellLanguage) merged.spellLanguage = remote.spellLanguage;
  if (remote.writingStyle && !local.writingStyle) merged.writingStyle = remote.writingStyle;
  if (remote.currentAuthorId && !local.currentAuthorId) {
    merged.currentAuthorId = authorIdMap[remote.currentAuthorId] || remote.currentAuthorId;
  }

  // Union customWords
  if (Array.isArray(remote.customWords) || Array.isArray(local.customWords)) {
    const words = new Set([...(local.customWords || []), ...(remote.customWords || [])]);
    merged.customWords = [...words];
  }

  // Union tabDefaults
  if (remote.tabDefaults && !local.tabDefaults) merged.tabDefaults = remote.tabDefaults;

  merged.authors = mergedAuthors;
  merged.shelves = mergedShelves;

  // Restore device-specific keys
  for (const k of DEVICE_LOOK) {
    if (deviceSnapshot[k] !== undefined) merged[k] = deviceSnapshot[k];
    else delete merged[k];
  }

  // Write atomically
  writeFileDurable(absPath, JSON.stringify(merged, null, 2));
  return merged;
}

// ---------------------------------------------------------------------------
// Status query (for IPC)
// ---------------------------------------------------------------------------

function getStatus() {
  const state = State.readState();
  return {
    enabled: state.enabled,
    state: _syncInProgress ? 'syncing' : (state.enabled ? 'synced' : 'disabled'),
    lastSync: state.lastSyncAt,
    pending: state.pendingUploads.length + _pushQueue.size,
    account: state.accountEmail,
    conflicts: 0 // TODO: track conflict count
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  init,
  setMasterKey,
  getMasterKey,
  isReady,

  // Sync operations
  initialUpload,
  syncPush,
  syncPull,
  syncAll,
  enqueueSync,
  pushTombstone,

  // Status
  getStatus,

  // Helpers (for testing)
  enumerateLibrary,
  shouldSync,
  bookIdFromPath,
  mergeLibraryJson,
  ensureBooksAreShelved,
  isHollowBookMeta,
  reconcileBookMeta,
  listBookFoldersOnDisk,
  DEVICE_LOOK
};
