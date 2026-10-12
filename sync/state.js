// sync/state.js — Local sync state persistence
// Stored at <userData>/sync-state.json, outside the library folder.
// Tracks per-file hashes, pending uploads, and tombstones.
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// State file path — set once at startup from app.getPath('userData')
// ---------------------------------------------------------------------------

let _statePath = null;

function setStatePath(userDataDir) {
  _statePath = path.join(userDataDir, 'sync-state.json');
}

function getStatePath() {
  return _statePath;
}

// ---------------------------------------------------------------------------
// Durable read / write (same pattern as main.js writeFileDurable + readJSON)
// ---------------------------------------------------------------------------

function readState() {
  if (!_statePath) return createEmpty();
  try {
    const raw = fs.readFileSync(_statePath, 'utf8');
    const state = JSON.parse(raw);
    return normalise(state);
  } catch {
    // try .bak
    try {
      const raw = fs.readFileSync(_statePath + '.bak', 'utf8');
      const state = JSON.parse(raw);
      return normalise(state);
    } catch { /* no state yet */ }
  }
  return createEmpty();
}

function writeState(state) {
  if (!_statePath) return;
  const json = JSON.stringify(state, null, 2);
  const tmp = _statePath + '.tmp';
  fs.writeFileSync(tmp, json);
  // .bak of previous good copy
  try {
    if (fs.existsSync(_statePath)) fs.copyFileSync(_statePath, _statePath + '.bak');
  } catch { /* best effort */ }
  fs.renameSync(tmp, _statePath);
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

function createEmpty() {
  return {
    deviceId: crypto.randomUUID(),
    enabled: false,
    accountEmail: null,
    lastSyncAt: null,
    lastManifestVersion: 0,
    objects: {},         // objectId -> { relativePath, lastSyncedHash, lastSyncedObjectVersion }
    pendingUploads: [],  // [{ relativePath, objectId, queuedAt }]
    tombstones: {}       // objectId -> { deletedAt, objectVersion }
  };
}

function normalise(state) {
  return {
    deviceId: state.deviceId || crypto.randomUUID(),
    enabled: !!state.enabled,
    accountEmail: state.accountEmail || null,
    lastSyncAt: state.lastSyncAt || null,
    lastManifestVersion: state.lastManifestVersion || 0,
    objects: state.objects || {},
    pendingUploads: Array.isArray(state.pendingUploads) ? state.pendingUploads : [],
    tombstones: state.tombstones || {}
  };
}

// ---------------------------------------------------------------------------
// Convenience mutators (all return the modified state for chaining)
// ---------------------------------------------------------------------------

// Mark a file as synced after a successful push
function markSynced(state, objectId, relativePath, contentHash, objectVersion) {
  state.objects[objectId] = { relativePath, lastSyncedHash: contentHash, lastSyncedObjectVersion: objectVersion };
  state.pendingUploads = state.pendingUploads.filter((p) => p.objectId !== objectId);
  return state;
}

// Enqueue a file for upload (idempotent by objectId)
function enqueue(state, relativePath, objectId) {
  if (state.pendingUploads.some((p) => p.objectId === objectId)) return state;
  state.pendingUploads.push({ relativePath, objectId, queuedAt: new Date().toISOString() });
  return state;
}

// Remove a pending upload (after success or cancellation)
function dequeue(state, objectId) {
  state.pendingUploads = state.pendingUploads.filter((p) => p.objectId !== objectId);
  return state;
}

// Record a tombstone for a deleted object
function addTombstone(state, objectId, objectVersion) {
  state.tombstones[objectId] = { deletedAt: new Date().toISOString(), objectVersion };
  delete state.objects[objectId];
  state.pendingUploads = state.pendingUploads.filter((p) => p.objectId !== objectId);
  return state;
}

// Prune tombstones older than maxAgeDays
function pruneTombstones(state, maxAgeDays = 90) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.tombstones)) {
    if (new Date(ts.deletedAt).getTime() < cutoff) delete state.tombstones[id];
  }
  return state;
}

// Lookup helpers
function getObjectState(state, objectId) {
  return state.objects[objectId] || null;
}

function findObjectByPath(state, relativePath) {
  for (const [id, obj] of Object.entries(state.objects)) {
    if (obj.relativePath === relativePath) return { objectId: id, ...obj };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  setStatePath,
  getStatePath,
  readState,
  writeState,
  createEmpty,

  markSynced,
  enqueue,
  dequeue,
  addTombstone,
  pruneTombstones,
  getObjectState,
  findObjectByPath
};
