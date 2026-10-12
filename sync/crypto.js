// sync/crypto.js — End-to-end encryption for NEO sync
// All crypto uses Node built-ins (crypto module). No external dependencies.
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BLOB_MAGIC = Buffer.from([0x4E, 0x45, 0x4F, 0x31]); // "NEO1"
const BLOB_VERSION = 1;
const BLOB_HEADER_LEN = 4 + 1 + 12; // magic(4) + version(1) + nonce(12)
const GCM_TAG_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32; // 256 bits
const SALT_LEN = 16;

const SCRYPT_DEFAULTS = { N: 131072, r: 8, p: 1, dkLen: 32 }; // N = 2^17

const HKDF_INFO_CONTENT = 'neo-sync-content-v1';
const HKDF_INFO_MANIFEST = 'neo-sync-manifest-v1';
const HKDF_INFO_FILEID = 'neo-sync-fileid-v1';

// ---------------------------------------------------------------------------
// Master key generation
// ---------------------------------------------------------------------------

function generateMasterKey() {
  return crypto.randomBytes(KEY_LEN);
}

// ---------------------------------------------------------------------------
// KDF — derive a key-encryption key from the user's password
// ---------------------------------------------------------------------------

function deriveKEK(password, salt, params) {
  const p = { ...SCRYPT_DEFAULTS, ...params };
  return crypto.scryptSync(
    Buffer.from(password, 'utf8'),
    salt,
    p.dkLen,
    { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r }
  );
}

// ---------------------------------------------------------------------------
// HKDF — derive purpose-specific subkeys from the master key
// ---------------------------------------------------------------------------

function deriveSubkey(masterKey, info) {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), info, KEY_LEN)
  );
}

function contentKey(masterKey) { return deriveSubkey(masterKey, HKDF_INFO_CONTENT); }
function manifestKey(masterKey) { return deriveSubkey(masterKey, HKDF_INFO_MANIFEST); }
function fileIdKey(masterKey) { return deriveSubkey(masterKey, HKDF_INFO_FILEID); }

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt / decrypt (raw, no blob header)
// ---------------------------------------------------------------------------

function encryptRaw(key, plaintext, aad) {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: ct, tag };
}

function decryptRaw(key, nonce, ciphertext, tag, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return pt;
}

// ---------------------------------------------------------------------------
// Wrap / unwrap master key with the KEK
// ---------------------------------------------------------------------------

function wrapMasterKey(masterKey, kek) {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, nonce);
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, wrappedKey: ct, tag };
}

function unwrapMasterKey(kek, nonce, wrappedKey, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(wrappedKey), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Keyfile — the JSON uploaded to Drive (unencrypted, integrity via GCM tag)
// ---------------------------------------------------------------------------

function createKeyfile(password) {
  const masterKey = generateMasterKey();
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = deriveKEK(password, salt, SCRYPT_DEFAULTS);
  const { nonce, wrappedKey, tag } = wrapMasterKey(masterKey, kek);
  const keyfile = {
    version: 1,
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_DEFAULTS.N, r: SCRYPT_DEFAULTS.r, p: SCRYPT_DEFAULTS.p, dkLen: SCRYPT_DEFAULTS.dkLen },
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'),
    tag: tag.toString('base64')
  };
  return { masterKey, keyfile };
}

function openKeyfile(keyfile, password) {
  if (!keyfile || keyfile.version !== 1) throw new Error('Unsupported keyfile version');
  if (keyfile.kdf !== 'scrypt') throw new Error('Unsupported KDF: ' + keyfile.kdf);
  const salt = Buffer.from(keyfile.salt, 'base64');
  const nonce = Buffer.from(keyfile.nonce, 'base64');
  const wrappedKey = Buffer.from(keyfile.wrappedKey, 'base64');
  const tag = Buffer.from(keyfile.tag, 'base64');
  const kek = deriveKEK(password, salt, keyfile.kdfParams);
  return unwrapMasterKey(kek, nonce, wrappedKey, tag);
}

function rekeyKeyfile(masterKey, newPassword) {
  const salt = crypto.randomBytes(SALT_LEN);
  const kek = deriveKEK(newPassword, salt, SCRYPT_DEFAULTS);
  const { nonce, wrappedKey, tag } = wrapMasterKey(masterKey, kek);
  return {
    version: 1,
    kdf: 'scrypt',
    kdfParams: { N: SCRYPT_DEFAULTS.N, r: SCRYPT_DEFAULTS.r, p: SCRYPT_DEFAULTS.p, dkLen: SCRYPT_DEFAULTS.dkLen },
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    wrappedKey: wrappedKey.toString('base64'),
    tag: tag.toString('base64')
  };
}

// ---------------------------------------------------------------------------
// Blob format — versioned binary envelope for encrypted content
//
//   Bytes   Field
//   0-3     Magic: 0x4E 0x45 0x4F 0x31 ("NEO1")
//   4       Schema version: 0x01
//   5-16    Nonce (12 bytes)
//   17..N   Ciphertext
//   N+1..   GCM auth tag (16 bytes)
// ---------------------------------------------------------------------------

function buildAAD(schemaVersion, objectId, objectVersion) {
  return JSON.stringify({ v: schemaVersion, id: objectId, ver: objectVersion });
}

function encryptBlob(key, plaintext, objectId, objectVersion) {
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const aad = buildAAD(BLOB_VERSION, objectId, objectVersion);
  const { nonce, ciphertext, tag } = encryptRaw(key, buf, aad);
  const header = Buffer.alloc(BLOB_HEADER_LEN);
  BLOB_MAGIC.copy(header, 0);
  header[4] = BLOB_VERSION;
  nonce.copy(header, 5);
  return Buffer.concat([header, ciphertext, tag]);
}

function decryptBlob(key, blob, objectId, objectVersion) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < BLOB_HEADER_LEN + GCM_TAG_LEN) throw new Error('Blob too short');
  if (!blob.subarray(0, 4).equals(BLOB_MAGIC)) throw new Error('Bad blob magic');
  const version = blob[4];
  if (version !== BLOB_VERSION) throw new Error('Unsupported blob version: ' + version);
  const nonce = blob.subarray(5, 5 + NONCE_LEN);
  const tagStart = blob.length - GCM_TAG_LEN;
  const ciphertext = blob.subarray(BLOB_HEADER_LEN, tagStart);
  const tag = blob.subarray(tagStart);
  const aad = buildAAD(version, objectId, objectVersion);
  return decryptRaw(key, nonce, ciphertext, tag, aad);
}

function parseBlobHeader(blob) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);
  if (blob.length < BLOB_HEADER_LEN) return null;
  if (!blob.subarray(0, 4).equals(BLOB_MAGIC)) return null;
  return { version: blob[4], nonce: blob.subarray(5, 5 + NONCE_LEN) };
}

// ---------------------------------------------------------------------------
// Object ID derivation — HMAC-based opaque IDs from relative paths
// ---------------------------------------------------------------------------

function deriveObjectId(fileIdKeyBuf, relativePath) {
  return crypto.createHmac('sha256', fileIdKeyBuf)
    .update(relativePath.replace(/\\/g, '/'))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Content hashing — SHA-256 of plaintext for change detection
// ---------------------------------------------------------------------------

function contentHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Recovery key — master key as base64 for offline backup
// ---------------------------------------------------------------------------

function recoveryKeyFromMaster(masterKey) {
  return masterKey.toString('base64');
}

function masterFromRecoveryKey(recoveryKey) {
  const buf = Buffer.from(recoveryKey, 'base64');
  if (buf.length !== KEY_LEN) throw new Error('Invalid recovery key length');
  return buf;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  BLOB_MAGIC, BLOB_VERSION, BLOB_HEADER_LEN, GCM_TAG_LEN, NONCE_LEN, KEY_LEN, SALT_LEN,
  SCRYPT_DEFAULTS,
  HKDF_INFO_CONTENT, HKDF_INFO_MANIFEST, HKDF_INFO_FILEID,

  // Key management
  generateMasterKey,
  deriveKEK,
  deriveSubkey,
  contentKey,
  manifestKey,
  fileIdKey,

  // Wrap / unwrap
  wrapMasterKey,
  unwrapMasterKey,

  // Keyfile
  createKeyfile,
  openKeyfile,
  rekeyKeyfile,

  // Blob encrypt / decrypt
  encryptBlob,
  decryptBlob,
  parseBlobHeader,
  buildAAD,

  // Raw encrypt / decrypt (for manifest)
  encryptRaw,
  decryptRaw,

  // Object IDs
  deriveObjectId,

  // Content hashing
  contentHash,

  // Recovery key
  recoveryKeyFromMaster,
  masterFromRecoveryKey
};
