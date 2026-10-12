// scripts/sync-crypto.test.js — tests for sync/crypto.js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const SC = require('../sync/crypto.js');

// ---------------------------------------------------------------------------
// Master key generation
// ---------------------------------------------------------------------------

describe('generateMasterKey', () => {
  it('produces a 32-byte buffer', () => {
    const k = SC.generateMasterKey();
    assert.equal(k.length, SC.KEY_LEN);
    assert.ok(Buffer.isBuffer(k));
  });

  it('produces distinct keys', () => {
    const a = SC.generateMasterKey();
    const b = SC.generateMasterKey();
    assert.ok(!a.equals(b));
  });
});

// ---------------------------------------------------------------------------
// KDF (scrypt)
// ---------------------------------------------------------------------------

describe('deriveKEK', () => {
  it('produces a 32-byte key', () => {
    const salt = crypto.randomBytes(SC.SALT_LEN);
    const kek = SC.deriveKEK('test-password', salt);
    assert.equal(kek.length, SC.KEY_LEN);
  });

  it('same inputs produce same key', () => {
    const salt = crypto.randomBytes(SC.SALT_LEN);
    const a = SC.deriveKEK('hello', salt);
    const b = SC.deriveKEK('hello', salt);
    assert.ok(a.equals(b));
  });

  it('different passwords produce different keys', () => {
    const salt = crypto.randomBytes(SC.SALT_LEN);
    const a = SC.deriveKEK('alpha', salt);
    const b = SC.deriveKEK('bravo', salt);
    assert.ok(!a.equals(b));
  });

  it('different salts produce different keys', () => {
    const s1 = crypto.randomBytes(SC.SALT_LEN);
    const s2 = crypto.randomBytes(SC.SALT_LEN);
    const a = SC.deriveKEK('same', s1);
    const b = SC.deriveKEK('same', s2);
    assert.ok(!a.equals(b));
  });
});

// ---------------------------------------------------------------------------
// HKDF subkeys
// ---------------------------------------------------------------------------

describe('HKDF subkeys', () => {
  const mk = SC.generateMasterKey();

  it('contentKey, manifestKey and fileIdKey return 32-byte buffers', () => {
    assert.equal(SC.contentKey(mk).length, SC.KEY_LEN);
    assert.equal(SC.manifestKey(mk).length, SC.KEY_LEN);
    assert.equal(SC.fileIdKey(mk).length, SC.KEY_LEN);
  });

  it('each purpose produces a different key', () => {
    const ck = SC.contentKey(mk);
    const mfk = SC.manifestKey(mk);
    const fk = SC.fileIdKey(mk);
    assert.ok(!ck.equals(mfk));
    assert.ok(!ck.equals(fk));
    assert.ok(!mfk.equals(fk));
  });

  it('same inputs are deterministic', () => {
    assert.ok(SC.contentKey(mk).equals(SC.contentKey(mk)));
  });
});

// ---------------------------------------------------------------------------
// Wrap / unwrap master key
// ---------------------------------------------------------------------------

describe('wrapMasterKey / unwrapMasterKey', () => {
  it('round-trips', () => {
    const mk = SC.generateMasterKey();
    const kek = crypto.randomBytes(SC.KEY_LEN);
    const { nonce, wrappedKey, tag } = SC.wrapMasterKey(mk, kek);
    const restored = SC.unwrapMasterKey(kek, nonce, wrappedKey, tag);
    assert.ok(mk.equals(restored));
  });

  it('wrong KEK throws', () => {
    const mk = SC.generateMasterKey();
    const kek = crypto.randomBytes(SC.KEY_LEN);
    const bad = crypto.randomBytes(SC.KEY_LEN);
    const { nonce, wrappedKey, tag } = SC.wrapMasterKey(mk, kek);
    assert.throws(() => SC.unwrapMasterKey(bad, nonce, wrappedKey, tag));
  });

  it('tampered wrapped key throws', () => {
    const mk = SC.generateMasterKey();
    const kek = crypto.randomBytes(SC.KEY_LEN);
    const { nonce, wrappedKey, tag } = SC.wrapMasterKey(mk, kek);
    wrappedKey[0] ^= 0xFF;
    assert.throws(() => SC.unwrapMasterKey(kek, nonce, wrappedKey, tag));
  });
});

// ---------------------------------------------------------------------------
// Keyfile
// ---------------------------------------------------------------------------

describe('keyfile', () => {
  it('createKeyfile + openKeyfile round-trip', () => {
    const pw = 'my-secret-password';
    const { masterKey, keyfile } = SC.createKeyfile(pw);
    const restored = SC.openKeyfile(keyfile, pw);
    assert.ok(masterKey.equals(restored));
  });

  it('wrong password fails cleanly', () => {
    const { keyfile } = SC.createKeyfile('correct-password');
    assert.throws(() => SC.openKeyfile(keyfile, 'wrong-password'));
  });

  it('keyfile contains expected fields', () => {
    const { keyfile } = SC.createKeyfile('pw');
    assert.equal(keyfile.version, 1);
    assert.equal(keyfile.kdf, 'scrypt');
    assert.deepEqual(keyfile.kdfParams, SC.SCRYPT_DEFAULTS);
    assert.equal(Buffer.from(keyfile.salt, 'base64').length, SC.SALT_LEN);
    assert.equal(Buffer.from(keyfile.nonce, 'base64').length, SC.NONCE_LEN);
    assert.equal(Buffer.from(keyfile.wrappedKey, 'base64').length, SC.KEY_LEN);
    assert.equal(Buffer.from(keyfile.tag, 'base64').length, SC.GCM_TAG_LEN);
  });

  it('unsupported version throws', () => {
    const { keyfile } = SC.createKeyfile('pw');
    keyfile.version = 99;
    assert.throws(() => SC.openKeyfile(keyfile, 'pw'), /Unsupported keyfile version/);
  });

  it('unsupported KDF throws', () => {
    const { keyfile } = SC.createKeyfile('pw');
    keyfile.kdf = 'argon2';
    assert.throws(() => SC.openKeyfile(keyfile, 'pw'), /Unsupported KDF/);
  });
});

// ---------------------------------------------------------------------------
// Rekey
// ---------------------------------------------------------------------------

describe('rekeyKeyfile', () => {
  it('re-wraps master key with a new password', () => {
    const pw1 = 'old-password';
    const pw2 = 'new-password';
    const { masterKey, keyfile: kf1 } = SC.createKeyfile(pw1);
    const kf2 = SC.rekeyKeyfile(masterKey, pw2);
    const restored = SC.openKeyfile(kf2, pw2);
    assert.ok(masterKey.equals(restored));
    assert.throws(() => SC.openKeyfile(kf2, pw1));
  });

  it('old keyfile still works with old password', () => {
    const { masterKey, keyfile: kf1 } = SC.createKeyfile('old');
    SC.rekeyKeyfile(masterKey, 'new');
    const fromOld = SC.openKeyfile(kf1, 'old');
    assert.ok(masterKey.equals(fromOld));
  });
});

// ---------------------------------------------------------------------------
// Blob encrypt / decrypt
// ---------------------------------------------------------------------------

describe('blob encrypt / decrypt', () => {
  const mk = SC.generateMasterKey();
  const key = SC.contentKey(mk);

  it('round-trips string content', () => {
    const plain = 'Hello, encrypted world!';
    const blob = SC.encryptBlob(key, plain, 'obj-1', 1);
    const out = SC.decryptBlob(key, blob, 'obj-1', 1);
    assert.equal(out.toString('utf8'), plain);
  });

  it('round-trips buffer content', () => {
    const plain = crypto.randomBytes(1000);
    const blob = SC.encryptBlob(key, plain, 'obj-2', 5);
    const out = SC.decryptBlob(key, blob, 'obj-2', 5);
    assert.ok(plain.equals(out));
  });

  it('round-trips empty content', () => {
    const blob = SC.encryptBlob(key, '', 'obj-3', 1);
    const out = SC.decryptBlob(key, blob, 'obj-3', 1);
    assert.equal(out.toString('utf8'), '');
  });

  it('tampered ciphertext throws', () => {
    const blob = SC.encryptBlob(key, 'secret', 'obj-4', 1);
    const tampered = Buffer.from(blob);
    tampered[SC.BLOB_HEADER_LEN + 2] ^= 0xFF;
    assert.throws(() => SC.decryptBlob(key, tampered, 'obj-4', 1));
  });

  it('tampered tag throws', () => {
    const blob = SC.encryptBlob(key, 'secret', 'obj-5', 1);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xFF;
    assert.throws(() => SC.decryptBlob(key, tampered, 'obj-5', 1));
  });

  it('wrong objectId (swapped AAD) throws', () => {
    const blob = SC.encryptBlob(key, 'secret', 'obj-A', 1);
    assert.throws(() => SC.decryptBlob(key, blob, 'obj-B', 1));
  });

  it('wrong objectVersion (rollback AAD) throws', () => {
    const blob = SC.encryptBlob(key, 'secret', 'obj-6', 3);
    assert.throws(() => SC.decryptBlob(key, blob, 'obj-6', 2));
  });

  it('wrong key throws', () => {
    const blob = SC.encryptBlob(key, 'secret', 'obj-7', 1);
    const badKey = crypto.randomBytes(SC.KEY_LEN);
    assert.throws(() => SC.decryptBlob(badKey, blob, 'obj-7', 1));
  });

  it('blob has correct magic and version', () => {
    const blob = SC.encryptBlob(key, 'data', 'obj-8', 1);
    assert.ok(blob.subarray(0, 4).equals(SC.BLOB_MAGIC));
    assert.equal(blob[4], SC.BLOB_VERSION);
  });

  it('too-short blob throws', () => {
    assert.throws(() => SC.decryptBlob(key, Buffer.alloc(10), 'x', 1), /Blob too short/);
  });

  it('bad magic throws', () => {
    const blob = SC.encryptBlob(key, 'data', 'obj-9', 1);
    const bad = Buffer.from(blob);
    bad[0] = 0x00;
    assert.throws(() => SC.decryptBlob(key, bad, 'obj-9', 1), /Bad blob magic/);
  });

  it('unsupported version throws', () => {
    const blob = SC.encryptBlob(key, 'data', 'obj-10', 1);
    const bad = Buffer.from(blob);
    bad[4] = 0xFF;
    assert.throws(() => SC.decryptBlob(key, bad, 'obj-10', 1), /Unsupported blob version/);
  });
});

// ---------------------------------------------------------------------------
// parseBlobHeader
// ---------------------------------------------------------------------------

describe('parseBlobHeader', () => {
  it('parses a valid blob', () => {
    const key = SC.contentKey(SC.generateMasterKey());
    const blob = SC.encryptBlob(key, 'hello', 'id', 1);
    const h = SC.parseBlobHeader(blob);
    assert.equal(h.version, SC.BLOB_VERSION);
    assert.equal(h.nonce.length, SC.NONCE_LEN);
  });

  it('returns null for too-short input', () => {
    assert.equal(SC.parseBlobHeader(Buffer.alloc(5)), null);
  });

  it('returns null for bad magic', () => {
    assert.equal(SC.parseBlobHeader(Buffer.alloc(20)), null);
  });
});

// ---------------------------------------------------------------------------
// Object ID derivation
// ---------------------------------------------------------------------------

describe('deriveObjectId', () => {
  const fk = SC.fileIdKey(SC.generateMasterKey());

  it('returns a hex string', () => {
    const id = SC.deriveObjectId(fk, 'library.json');
    assert.match(id, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const a = SC.deriveObjectId(fk, 'book-abc/book.json');
    const b = SC.deriveObjectId(fk, 'book-abc/book.json');
    assert.equal(a, b);
  });

  it('different paths produce different IDs', () => {
    const a = SC.deriveObjectId(fk, 'a.json');
    const b = SC.deriveObjectId(fk, 'b.json');
    assert.notEqual(a, b);
  });

  it('normalizes backslashes to forward slashes', () => {
    const a = SC.deriveObjectId(fk, 'book\\chapters\\ch1.html');
    const b = SC.deriveObjectId(fk, 'book/chapters/ch1.html');
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

describe('contentHash', () => {
  it('returns a SHA-256 hex string', () => {
    const h = SC.contentHash('hello');
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    assert.equal(SC.contentHash('same'), SC.contentHash('same'));
  });

  it('differs for different content', () => {
    assert.notEqual(SC.contentHash('a'), SC.contentHash('b'));
  });

  it('works with buffers', () => {
    const buf = Buffer.from('test');
    assert.equal(SC.contentHash(buf), SC.contentHash('test'));
  });
});

// ---------------------------------------------------------------------------
// Recovery key
// ---------------------------------------------------------------------------

describe('recovery key', () => {
  it('round-trips master key', () => {
    const mk = SC.generateMasterKey();
    const rk = SC.recoveryKeyFromMaster(mk);
    const restored = SC.masterFromRecoveryKey(rk);
    assert.ok(mk.equals(restored));
  });

  it('recovery key is base64, 44 chars', () => {
    const mk = SC.generateMasterKey();
    const rk = SC.recoveryKeyFromMaster(mk);
    assert.equal(typeof rk, 'string');
    // 32 bytes -> 44 base64 chars (with padding)
    assert.equal(rk.length, 44);
  });

  it('invalid length throws', () => {
    assert.throws(() => SC.masterFromRecoveryKey('dG9vc2hvcnQ='), /Invalid recovery key/);
  });
});

// ---------------------------------------------------------------------------
// buildAAD
// ---------------------------------------------------------------------------

describe('buildAAD', () => {
  it('produces a JSON string with v, id, ver', () => {
    const aad = SC.buildAAD(1, 'abc', 5);
    const parsed = JSON.parse(aad);
    assert.deepEqual(parsed, { v: 1, id: 'abc', ver: 5 });
  });
});

// ---------------------------------------------------------------------------
// Raw encrypt / decrypt (used for manifest)
// ---------------------------------------------------------------------------

describe('encryptRaw / decryptRaw', () => {
  const key = crypto.randomBytes(SC.KEY_LEN);

  it('round-trips with AAD', () => {
    const plain = Buffer.from('manifest data');
    const aad = 'some-aad';
    const { nonce, ciphertext, tag } = SC.encryptRaw(key, plain, aad);
    const out = SC.decryptRaw(key, nonce, ciphertext, tag, aad);
    assert.ok(plain.equals(out));
  });

  it('round-trips without AAD', () => {
    const plain = Buffer.from('no aad');
    const { nonce, ciphertext, tag } = SC.encryptRaw(key, plain);
    const out = SC.decryptRaw(key, nonce, ciphertext, tag);
    assert.ok(plain.equals(out));
  });

  it('wrong AAD throws', () => {
    const plain = Buffer.from('aad matters');
    const { nonce, ciphertext, tag } = SC.encryptRaw(key, plain, 'correct');
    assert.throws(() => SC.decryptRaw(key, nonce, ciphertext, tag, 'wrong'));
  });
});

// ---------------------------------------------------------------------------
// Full flow: keyfile -> subkeys -> blob encrypt/decrypt
// ---------------------------------------------------------------------------

describe('full end-to-end flow', () => {
  it('creates keyfile, opens it, derives keys, encrypts and decrypts a blob', () => {
    const password = 'hunter2';
    const { masterKey, keyfile } = SC.createKeyfile(password);

    const restored = SC.openKeyfile(keyfile, password);
    assert.ok(masterKey.equals(restored));

    const ck = SC.contentKey(restored);
    const plain = '<p>Chapter 1: It was a dark and stormy night.</p>';
    const objectId = SC.deriveObjectId(SC.fileIdKey(restored), 'book-test/chapters/ch-1.html');
    const objectVersion = 1;

    const blob = SC.encryptBlob(ck, plain, objectId, objectVersion);
    const decrypted = SC.decryptBlob(ck, blob, objectId, objectVersion);
    assert.equal(decrypted.toString('utf8'), plain);

    assert.equal(SC.contentHash(plain), SC.contentHash(decrypted));
  });

  it('password change preserves ability to decrypt existing blobs', () => {
    const pw1 = 'first-password';
    const pw2 = 'second-password';
    const { masterKey, keyfile: kf1 } = SC.createKeyfile(pw1);

    const ck = SC.contentKey(masterKey);
    const blob = SC.encryptBlob(ck, 'important text', 'obj-1', 1);

    const kf2 = SC.rekeyKeyfile(masterKey, pw2);
    const mk2 = SC.openKeyfile(kf2, pw2);
    const ck2 = SC.contentKey(mk2);

    const decrypted = SC.decryptBlob(ck2, blob, 'obj-1', 1);
    assert.equal(decrypted.toString('utf8'), 'important text');
  });

  it('recovery key restores access after password change', () => {
    const { masterKey, keyfile } = SC.createKeyfile('original');
    const rk = SC.recoveryKeyFromMaster(masterKey);

    const restored = SC.masterFromRecoveryKey(rk);
    assert.ok(masterKey.equals(restored));

    const newKeyfile = SC.rekeyKeyfile(restored, 'brand-new');
    const mk3 = SC.openKeyfile(newKeyfile, 'brand-new');
    assert.ok(masterKey.equals(mk3));
  });
});
