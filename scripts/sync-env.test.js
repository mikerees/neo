'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SyncEnv = require('../sync/env.js');

describe('parseEnvFile', () => {
  it('parses KEY=VALUE and ignores comments', () => {
    const parsed = SyncEnv.parseEnvFile(`
# comment
GOOGLE_CLIENT_ID=abc.apps.googleusercontent.com
EMPTY=
`);
    assert.equal(parsed.GOOGLE_CLIENT_ID, 'abc.apps.googleusercontent.com');
    assert.equal(parsed.EMPTY, '');
  });

  it('strips quotes', () => {
    const parsed = SyncEnv.parseEnvFile('GOOGLE_CLIENT_ID="quoted-id"');
    assert.equal(parsed.GOOGLE_CLIENT_ID, 'quoted-id');
  });
});

describe('resolveGoogleClientId', () => {
  let tmp;
  let prev;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-env-'));
    prev = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
  });

  afterEach(() => {
    if (prev !== undefined) process.env.GOOGLE_CLIENT_ID = prev;
    else delete process.env.GOOGLE_CLIENT_ID;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers process.env over .env file', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'GOOGLE_CLIENT_ID=from-file');
    process.env.GOOGLE_CLIENT_ID = 'from-shell';
    assert.equal(SyncEnv.resolveGoogleClientId({ appRoot: tmp }), 'from-shell');
  });

  it('reads from appRoot .env', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'GOOGLE_CLIENT_ID=file-client-id');
    assert.equal(SyncEnv.resolveGoogleClientId({ appRoot: tmp }), 'file-client-id');
  });

  it('reads from libraryDir .env', () => {
    const lib = path.join(tmp, 'Library');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, '.env'), 'GOOGLE_CLIENT_ID=library-id');
    assert.equal(SyncEnv.resolveGoogleClientId({ appRoot: path.join(tmp, 'no-env-here'), libraryDir: lib }), 'library-id');
  });

  it('reads client secret from the same .env', () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'GOOGLE_CLIENT_ID=id\nGOOGLE_CLIENT_SECRET=sec');
    const creds = SyncEnv.resolveOAuthCredentials({ appRoot: tmp });
    assert.equal(creds.clientId, 'id');
    assert.equal(creds.clientSecret, 'sec');
  });
});
