// scripts/sync-manifest.test.js — tests for sync/manifest.js and sync/state.js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Manifest = require('../sync/manifest.js');
const State = require('../sync/state.js');
const SC = require('../sync/crypto.js');

// ---------------------------------------------------------------------------
// Manifest creation
// ---------------------------------------------------------------------------

describe('createManifest', () => {
  it('returns a valid empty manifest', () => {
    const m = Manifest.createManifest('dev-1');
    assert.equal(m.schemaVersion, Manifest.MANIFEST_SCHEMA);
    assert.equal(m.deviceId, 'dev-1');
    assert.equal(m.manifestVersion, 1);
    assert.deepEqual(m.objects, {});
    assert.ok(m.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// Manifest encrypt / decrypt (versioned)
// ---------------------------------------------------------------------------

describe('manifest encrypt/decrypt', () => {
  const mk = SC.generateMasterKey();
  const mfk = SC.manifestKey(mk);

  it('round-trips', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-1', {
      relativePath: 'library.json',
      contentHash: 'abc123',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-1',
      size: 100
    });
    const blob = Manifest.encryptManifestVersioned(m, mfk);
    const restored = Manifest.decryptManifestVersioned(blob, mfk);
    assert.equal(restored.deviceId, 'dev-1');
    assert.equal(restored.objects['obj-1'].relativePath, 'library.json');
    assert.equal(restored.objects['obj-1'].contentHash, 'abc123');
  });

  it('wrong key throws', () => {
    const m = Manifest.createManifest('dev-1');
    const blob = Manifest.encryptManifestVersioned(m, mfk);
    const badKey = crypto.randomBytes(SC.KEY_LEN);
    assert.throws(() => Manifest.decryptManifestVersioned(blob, badKey));
  });

  it('tampered blob throws', () => {
    const m = Manifest.createManifest('dev-1');
    const blob = Manifest.encryptManifestVersioned(m, mfk);
    const bad = Buffer.from(blob);
    bad[20] ^= 0xFF;
    assert.throws(() => Manifest.decryptManifestVersioned(bad, mfk));
  });

  it('too-short blob throws', () => {
    assert.throws(() => Manifest.decryptManifestVersioned(Buffer.alloc(10), mfk), /too short/);
  });

  it('preserves manifestVersion in the blob header', () => {
    const m = Manifest.createManifest('dev-1');
    m.manifestVersion = 42;
    const blob = Manifest.encryptManifestVersioned(m, mfk);
    assert.equal(blob.readUInt32LE(0), 42);
    const restored = Manifest.decryptManifestVersioned(blob, mfk);
    assert.equal(restored.manifestVersion, 42);
  });
});

// ---------------------------------------------------------------------------
// Manifest set / delete object
// ---------------------------------------------------------------------------

describe('setObject / deleteObject', () => {
  it('adds an object entry', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-1', {
      relativePath: 'book-a/book.json',
      bookId: 'book-a',
      contentHash: 'hash1',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-1',
      size: 200
    });
    assert.equal(Object.keys(m.objects).length, 1);
    assert.equal(m.objects['obj-1'].relativePath, 'book-a/book.json');
    assert.equal(m.objects['obj-1'].deleted, false);
  });

  it('marks an object deleted', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-1', {
      relativePath: 'book-a/book.json',
      contentHash: 'hash1',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-1'
    });
    Manifest.deleteObject(m, 'obj-1', 'dev-1');
    assert.equal(m.objects['obj-1'].deleted, true);
    assert.equal(m.objects['obj-1'].objectVersion, 2);
  });
});

// ---------------------------------------------------------------------------
// Manifest diff
// ---------------------------------------------------------------------------

describe('diffManifest', () => {
  it('detects new objects to download', () => {
    const remote = Manifest.createManifest('dev-2');
    Manifest.setObject(remote, 'obj-1', {
      relativePath: 'book-a/book.json',
      contentHash: 'hash1',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-2'
    });
    const localState = State.createEmpty();
    const diff = Manifest.diffManifest(remote, localState);
    assert.equal(diff.toDownload.length, 1);
    assert.equal(diff.toDownload[0].objectId, 'obj-1');
  });

  it('skips objects already synced at same version', () => {
    const remote = Manifest.createManifest('dev-2');
    Manifest.setObject(remote, 'obj-1', {
      relativePath: 'book-a/book.json',
      contentHash: 'hash1',
      objectVersion: 3,
      lastWriterDeviceId: 'dev-2'
    });
    const localState = State.createEmpty();
    State.markSynced(localState, 'obj-1', 'book-a/book.json', 'hash1', 3);
    const diff = Manifest.diffManifest(remote, localState);
    assert.equal(diff.toDownload.length, 0);
  });

  it('detects updated objects', () => {
    const remote = Manifest.createManifest('dev-2');
    Manifest.setObject(remote, 'obj-1', {
      relativePath: 'book-a/book.json',
      contentHash: 'hash2',
      objectVersion: 4,
      lastWriterDeviceId: 'dev-2'
    });
    const localState = State.createEmpty();
    State.markSynced(localState, 'obj-1', 'book-a/book.json', 'hash1', 3);
    const diff = Manifest.diffManifest(remote, localState);
    assert.equal(diff.toDownload.length, 1);
    assert.equal(diff.toDownload[0].remote.contentHash, 'hash2');
  });

  it('detects remote deletes', () => {
    const remote = Manifest.createManifest('dev-2');
    Manifest.setObject(remote, 'obj-1', {
      relativePath: 'book-a/book.json',
      contentHash: 'hash1',
      objectVersion: 2,
      lastWriterDeviceId: 'dev-2',
      deleted: true
    });
    // Simulate object was locally known
    remote.objects['obj-1'].deleted = true;
    const localState = State.createEmpty();
    State.markSynced(localState, 'obj-1', 'book-a/book.json', 'hash1', 1);
    const diff = Manifest.diffManifest(remote, localState);
    assert.equal(diff.toDelete.length, 1);
    assert.equal(diff.toDownload.length, 0);
  });

  it('marks potential conflicts', () => {
    const remote = Manifest.createManifest('dev-2');
    Manifest.setObject(remote, 'obj-1', {
      relativePath: 'book-a/chapters/ch-1.html',
      contentHash: 'remote-hash',
      objectVersion: 2,
      lastWriterDeviceId: 'dev-2'
    });
    const localState = State.createEmpty();
    State.markSynced(localState, 'obj-1', 'book-a/chapters/ch-1.html', 'old-hash', 1);
    const diff = Manifest.diffManifest(remote, localState);
    assert.equal(diff.toDownload.length, 1);
    assert.equal(diff.toDownload[0].mayConflict, true);
  });
});

// ---------------------------------------------------------------------------
// Manifest merge
// ---------------------------------------------------------------------------

describe('mergeManifests', () => {
  it('higher objectVersion wins', () => {
    const base = Manifest.createManifest('dev-1');
    Manifest.setObject(base, 'obj-1', {
      relativePath: 'library.json',
      contentHash: 'v1',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-1'
    });
    const incoming = Manifest.createManifest('dev-2');
    Manifest.setObject(incoming, 'obj-1', {
      relativePath: 'library.json',
      contentHash: 'v3',
      objectVersion: 3,
      lastWriterDeviceId: 'dev-2'
    });
    const merged = Manifest.mergeManifests(base, incoming, 'dev-1');
    assert.equal(merged.objects['obj-1'].contentHash, 'v3');
    assert.equal(merged.objects['obj-1'].objectVersion, 3);
  });

  it('base wins when it has higher version', () => {
    const base = Manifest.createManifest('dev-1');
    Manifest.setObject(base, 'obj-1', {
      relativePath: 'x.json',
      contentHash: 'v5',
      objectVersion: 5,
      lastWriterDeviceId: 'dev-1'
    });
    const incoming = Manifest.createManifest('dev-2');
    Manifest.setObject(incoming, 'obj-1', {
      relativePath: 'x.json',
      contentHash: 'v2',
      objectVersion: 2,
      lastWriterDeviceId: 'dev-2'
    });
    const merged = Manifest.mergeManifests(base, incoming, 'dev-1');
    assert.equal(merged.objects['obj-1'].contentHash, 'v5');
  });

  it('tombstone with higher version beats live entry', () => {
    const base = Manifest.createManifest('dev-1');
    Manifest.setObject(base, 'obj-1', {
      relativePath: 'a.json',
      contentHash: 'v1',
      objectVersion: 1,
      lastWriterDeviceId: 'dev-1'
    });
    const incoming = Manifest.createManifest('dev-2');
    Manifest.setObject(incoming, 'obj-1', {
      relativePath: 'a.json',
      contentHash: 'v1',
      objectVersion: 3,
      deleted: true,
      lastWriterDeviceId: 'dev-2'
    });
    const merged = Manifest.mergeManifests(base, incoming, 'dev-1');
    assert.equal(merged.objects['obj-1'].deleted, true);
    assert.equal(merged.objects['obj-1'].objectVersion, 3);
  });

  it('merges new objects from both sides', () => {
    const base = Manifest.createManifest('dev-1');
    Manifest.setObject(base, 'obj-A', { relativePath: 'a', contentHash: 'ha', objectVersion: 1, lastWriterDeviceId: 'dev-1' });
    const incoming = Manifest.createManifest('dev-2');
    Manifest.setObject(incoming, 'obj-B', { relativePath: 'b', contentHash: 'hb', objectVersion: 1, lastWriterDeviceId: 'dev-2' });
    const merged = Manifest.mergeManifests(base, incoming, 'dev-1');
    assert.ok(merged.objects['obj-A']);
    assert.ok(merged.objects['obj-B']);
  });

  it('manifestVersion is bumped', () => {
    const base = Manifest.createManifest('dev-1');
    base.manifestVersion = 5;
    const incoming = Manifest.createManifest('dev-2');
    incoming.manifestVersion = 7;
    const merged = Manifest.mergeManifests(base, incoming, 'dev-1');
    assert.equal(merged.manifestVersion, 8);
  });
});

// ---------------------------------------------------------------------------
// Manifest tombstone pruning
// ---------------------------------------------------------------------------

describe('pruneManifestTombstones', () => {
  it('removes old tombstones', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-1', {
      relativePath: 'a.json',
      contentHash: 'h',
      objectVersion: 2,
      deleted: true,
      updatedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      lastWriterDeviceId: 'dev-1'
    });
    Manifest.setObject(m, 'obj-2', {
      relativePath: 'b.json',
      contentHash: 'h2',
      objectVersion: 1,
      deleted: true,
      updatedAt: new Date().toISOString(),
      lastWriterDeviceId: 'dev-1'
    });
    Manifest.pruneManifestTombstones(m, 90);
    assert.equal(m.objects['obj-1'], undefined);
    assert.ok(m.objects['obj-2']);
  });
});

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

describe('manifest helpers', () => {
  it('objectCount excludes deleted', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-1', { relativePath: 'a', contentHash: 'h', objectVersion: 1, lastWriterDeviceId: 'd' });
    Manifest.setObject(m, 'obj-2', { relativePath: 'b', contentHash: 'h', objectVersion: 1, lastWriterDeviceId: 'd', deleted: true });
    assert.equal(Manifest.objectCount(m), 1);
  });

  it('findByPath returns the right entry', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-X', { relativePath: 'book-a/book.json', contentHash: 'hX', objectVersion: 2, lastWriterDeviceId: 'd' });
    const found = Manifest.findByPath(m, 'book-a/book.json');
    assert.equal(found.objectId, 'obj-X');
    assert.equal(found.objectVersion, 2);
  });

  it('findByPath skips deleted entries', () => {
    const m = Manifest.createManifest('dev-1');
    Manifest.setObject(m, 'obj-Y', { relativePath: 'x.json', contentHash: 'h', objectVersion: 1, lastWriterDeviceId: 'd', deleted: true });
    assert.equal(Manifest.findByPath(m, 'x.json'), null);
  });
});

// ---------------------------------------------------------------------------
// State module
// ---------------------------------------------------------------------------

describe('sync state', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-state-test-'));
    State.setStatePath(tmpDir);
  });

  it('readState returns empty state when no file exists', () => {
    const s = State.readState();
    assert.ok(s.deviceId);
    assert.equal(s.enabled, false);
    assert.deepEqual(s.objects, {});
    assert.deepEqual(s.pendingUploads, []);
  });

  it('writeState + readState round-trips', () => {
    const s = State.createEmpty();
    s.deviceId = 'test-device';
    s.enabled = true;
    s.accountEmail = 'a@b.com';
    State.markSynced(s, 'obj-1', 'library.json', 'hash1', 1);
    State.writeState(s);
    const loaded = State.readState();
    assert.equal(loaded.deviceId, 'test-device');
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.accountEmail, 'a@b.com');
    assert.equal(loaded.objects['obj-1'].lastSyncedHash, 'hash1');
  });

  it('markSynced removes from pending', () => {
    const s = State.createEmpty();
    State.enqueue(s, 'library.json', 'obj-1');
    assert.equal(s.pendingUploads.length, 1);
    State.markSynced(s, 'obj-1', 'library.json', 'hash', 1);
    assert.equal(s.pendingUploads.length, 0);
  });

  it('enqueue is idempotent', () => {
    const s = State.createEmpty();
    State.enqueue(s, 'a.json', 'obj-1');
    State.enqueue(s, 'a.json', 'obj-1');
    assert.equal(s.pendingUploads.length, 1);
  });

  it('dequeue removes by objectId', () => {
    const s = State.createEmpty();
    State.enqueue(s, 'a.json', 'obj-1');
    State.enqueue(s, 'b.json', 'obj-2');
    State.dequeue(s, 'obj-1');
    assert.equal(s.pendingUploads.length, 1);
    assert.equal(s.pendingUploads[0].objectId, 'obj-2');
  });

  it('addTombstone removes from objects and pending', () => {
    const s = State.createEmpty();
    State.markSynced(s, 'obj-1', 'a.json', 'h', 1);
    State.enqueue(s, 'a.json', 'obj-1');
    State.addTombstone(s, 'obj-1', 2);
    assert.equal(s.objects['obj-1'], undefined);
    assert.equal(s.pendingUploads.length, 0);
    assert.ok(s.tombstones['obj-1']);
  });

  it('pruneTombstones removes old entries', () => {
    const s = State.createEmpty();
    s.tombstones['old'] = { deletedAt: new Date(Date.now() - 100 * 86400000).toISOString(), objectVersion: 1 };
    s.tombstones['new'] = { deletedAt: new Date().toISOString(), objectVersion: 1 };
    State.pruneTombstones(s, 90);
    assert.equal(s.tombstones['old'], undefined);
    assert.ok(s.tombstones['new']);
  });

  it('findObjectByPath returns the right entry', () => {
    const s = State.createEmpty();
    State.markSynced(s, 'obj-A', 'book/ch.html', 'h1', 1);
    const found = State.findObjectByPath(s, 'book/ch.html');
    assert.equal(found.objectId, 'obj-A');
    assert.equal(found.lastSyncedHash, 'h1');
  });

  it('recovers from .bak when main file is corrupt', () => {
    const s = State.createEmpty();
    s.deviceId = 'bak-device';
    State.writeState(s);
    // Write again so the first write becomes the .bak
    s.deviceId = 'bak-device';
    State.writeState(s);
    // Corrupt main file
    fs.writeFileSync(State.getStatePath(), 'not json');
    const loaded = State.readState();
    assert.equal(loaded.deviceId, 'bak-device');
  });
});
