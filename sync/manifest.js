// sync/manifest.js — Encrypted manifest for the remote object store
// The manifest maps objectId -> { relativePath, contentHash, objectVersion, ... }
// It is encrypted with the manifest subkey and stored as a blob on Drive.
'use strict';

const SC = require('./crypto.js');

const MANIFEST_SCHEMA = 1;

// ---------------------------------------------------------------------------
// Create an empty manifest
// ---------------------------------------------------------------------------

function createManifest(deviceId) {
  return {
    schemaVersion: MANIFEST_SCHEMA,
    updatedAt: new Date().toISOString(),
    deviceId,
    manifestVersion: 1,
    objects: {}
  };
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt manifest
// ---------------------------------------------------------------------------

// Versioned manifest blob: [4-byte LE manifestVersion][nonce][ciphertext][tag]
function encryptManifestVersioned(manifest, manifestKeyBuf) {
  const json = JSON.stringify(manifest);
  const plaintext = Buffer.from(json, 'utf8');
  const aad = SC.buildAAD(MANIFEST_SCHEMA, 'manifest', manifest.manifestVersion);
  const { nonce, ciphertext, tag } = SC.encryptRaw(manifestKeyBuf, plaintext, aad);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(manifest.manifestVersion, 0);
  return Buffer.concat([header, nonce, ciphertext, tag]);
}

function decryptManifestVersioned(blob, manifestKeyBuf) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  const MIN_LEN = 4 + SC.NONCE_LEN + SC.GCM_TAG_LEN;
  if (blob.length < MIN_LEN) throw new Error('Manifest blob too short');
  const manifestVersion = blob.readUInt32LE(0);
  const nonce = blob.subarray(4, 4 + SC.NONCE_LEN);
  const tagStart = blob.length - SC.GCM_TAG_LEN;
  const ciphertext = blob.subarray(4 + SC.NONCE_LEN, tagStart);
  const tag = blob.subarray(tagStart);
  const aad = SC.buildAAD(MANIFEST_SCHEMA, 'manifest', manifestVersion);
  const pt = SC.decryptRaw(manifestKeyBuf, nonce, ciphertext, tag, aad);
  const manifest = JSON.parse(pt.toString('utf8'));
  if (manifest.schemaVersion > MANIFEST_SCHEMA) {
    throw new Error('Manifest was created by a newer version of NEO. Please update.');
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Set / update an object entry in the manifest
// ---------------------------------------------------------------------------

function setObject(manifest, objectId, entry) {
  manifest.objects[objectId] = {
    relativePath: entry.relativePath,
    bookId: entry.bookId || null,
    contentHash: entry.contentHash,
    objectVersion: entry.objectVersion,
    deleted: !!entry.deleted,
    updatedAt: entry.updatedAt || new Date().toISOString(),
    lastWriterDeviceId: entry.lastWriterDeviceId,
    size: entry.size || 0
  };
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

function deleteObject(manifest, objectId, deviceId) {
  const existing = manifest.objects[objectId];
  if (existing) {
    existing.deleted = true;
    existing.objectVersion = (existing.objectVersion || 0) + 1;
    existing.updatedAt = new Date().toISOString();
    existing.lastWriterDeviceId = deviceId;
  }
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

// ---------------------------------------------------------------------------
// Diff: compare remote manifest against local sync state
// ---------------------------------------------------------------------------

function diffManifest(remoteManifest, localState) {
  const toDownload = [];  // objects newer on remote
  const toDelete = [];    // objects deleted on remote
  const conflicts = [];   // both local and remote changed

  for (const [objectId, remote] of Object.entries(remoteManifest.objects)) {
    const local = localState.objects[objectId];
    const localTombstone = localState.tombstones[objectId];

    if (remote.deleted) {
      // Remote says deleted
      if (local && !localTombstone) {
        toDelete.push({ objectId, remote });
      }
      continue;
    }

    if (!local) {
      // New object from remote
      toDownload.push({ objectId, remote });
      continue;
    }

    if (remote.objectVersion <= local.lastSyncedObjectVersion) continue;

    if (remote.contentHash === local.lastSyncedHash) continue;

    // Remote changed. Did local also change?
    // We'll mark it as a conflict candidate; the engine checks the actual
    // local file hash to determine if it's truly a conflict.
    toDownload.push({ objectId, remote, mayConflict: true });
  }

  return { toDownload, toDelete, conflicts };
}

// ---------------------------------------------------------------------------
// Merge two manifests (optimistic read-merge-write)
// Per-object: highest objectVersion wins. Tombstones respected.
// ---------------------------------------------------------------------------

function mergeManifests(base, incoming, deviceId) {
  const merged = {
    schemaVersion: MANIFEST_SCHEMA,
    updatedAt: new Date().toISOString(),
    deviceId,
    manifestVersion: Math.max(base.manifestVersion || 0, incoming.manifestVersion || 0) + 1,
    objects: { ...base.objects }
  };

  for (const [objectId, entry] of Object.entries(incoming.objects)) {
    const existing = merged.objects[objectId];
    if (!existing || entry.objectVersion > existing.objectVersion) {
      merged.objects[objectId] = { ...entry };
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Prune old tombstones from the manifest
// ---------------------------------------------------------------------------

function pruneManifestTombstones(manifest, maxAgeDays = 90) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [id, entry] of Object.entries(manifest.objects)) {
    if (entry.deleted && new Date(entry.updatedAt).getTime() < cutoff) {
      delete manifest.objects[id];
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function objectCount(manifest) {
  return Object.values(manifest.objects).filter((o) => !o.deleted).length;
}

function findByPath(manifest, relativePath) {
  for (const [id, obj] of Object.entries(manifest.objects)) {
    if (obj.relativePath === relativePath && !obj.deleted) return { objectId: id, ...obj };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  MANIFEST_SCHEMA,
  createManifest,
  encryptManifestVersioned,
  decryptManifestVersioned,
  setObject,
  deleteObject,
  diffManifest,
  mergeManifests,
  pruneManifestTombstones,
  objectCount,
  findByPath
};
