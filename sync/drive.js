// sync/drive.js — Google Drive v3 appDataFolder client for NEO sync
// OAuth 2.0 PKCE loopback flow, token management, and REST operations.
// Runs in the main process only. No secrets enter the renderer.
'use strict';

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// OAuth client ID (and optional secret for "Web application" clients in Cloud Console).
// Desktop app clients use PKCE only; Web clients require client_secret on token exchange.
let _clientId = null;
let _clientSecret = null;

function setClientId(id) { _clientId = id; }
function setClientSecret(secret) { _clientSecret = secret || null; }
function getClientId() {
  if (_clientId) return _clientId;
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID;
  return null;
}
function getClientSecret() {
  if (_clientSecret) return _clientSecret;
  if (process.env.GOOGLE_CLIENT_SECRET) return process.env.GOOGLE_CLIENT_SECRET;
  return null;
}

function tokenParams(base) {
  const secret = getClientSecret();
  if (secret) base.client_secret = secret;
  return base;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.appdata'];
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// ---------------------------------------------------------------------------
// Token storage callbacks — set by the host (sync-ipc.js) at startup
// ---------------------------------------------------------------------------

let _saveTokens = null;   // async (tokens) => void
let _loadTokens = null;   // async () => tokens | null

function setTokenCallbacks(save, load) {
  _saveTokens = save;
  _loadTokens = load;
}

// In-memory access token cache
let _accessToken = null;
let _tokenExpiry = 0;      // ms since epoch

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// OAuth 2.0 loopback flow
// ---------------------------------------------------------------------------

async function authorize() {
  const clientId = getClientId();
  if (!clientId) throw new Error('Google OAuth client ID not configured');

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  // Start a temporary local HTTP server for the redirect
  const { port, codePromise, server } = await startLoopbackServer();

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent'
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;

  // Open the system browser
  const { shell } = require('electron');
  shell.openExternal(authUrl);

  let code;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  // Exchange the code for tokens
  const tokens = await exchangeCode(code, redirectUri, verifier);
  _accessToken = tokens.access_token;
  _tokenExpiry = Date.now() + (tokens.expires_in - 60) * 1000;

  const saved = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry: _tokenExpiry
  };
  if (_saveTokens) await _saveTokens(saved);

  return { email: await getAccountEmail() };
}

function startLoopbackServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const codePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('OAuth timed out')); server.close(); }
      }, 300000); // 5 minutes

      server.on('request', (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1`);
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (code) {
          res.end('<html><body><h2>Sign-in complete</h2><p>You can close this tab and return to NEO.</p></body></html>');
          if (!settled) { settled = true; clearTimeout(timeout); resolve(code); }
        } else {
          res.end(`<html><body><h2>Sign-in failed</h2><p>${error || 'Unknown error'}</p></body></html>`);
          if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(error || 'OAuth denied')); }
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, codePromise, server });
    });
    server.on('error', reject);
  });
}

async function exchangeCode(code, redirectUri, verifier) {
  const clientId = getClientId();
  const body = new URLSearchParams(tokenParams({
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  }));
  const res = await netFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = 'Token exchange failed: ' + res.status + ' ' + text;
    if (text.includes('client_secret is missing')) {
      msg += '\n\nUse a Google Cloud OAuth client of type Desktop app (PKCE, no secret), '
        + 'or add GOOGLE_CLIENT_SECRET to your .env if this is a Web application client.';
    }
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const tokens = _loadTokens ? await _loadTokens() : null;
  if (!tokens || !tokens.refresh_token) throw new Error('Not signed in to Google');

  const clientId = getClientId();
  const body = new URLSearchParams(tokenParams({
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  }));
  const res = await netFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      _accessToken = null;
      _tokenExpiry = 0;
      throw new Error('Google sign-in expired. Please sign in again.');
    }
    throw new Error('Token refresh failed: ' + res.status + ' ' + text);
  }
  const data = await res.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;

  if (_saveTokens) {
    await _saveTokens({
      refresh_token: tokens.refresh_token,
      access_token: data.access_token,
      expiry: _tokenExpiry
    });
  }
  return _accessToken;
}

// ---------------------------------------------------------------------------
// Revocation / sign out
// ---------------------------------------------------------------------------

async function revokeTokens() {
  try {
    const tokens = _loadTokens ? await _loadTokens() : null;
    if (tokens && tokens.refresh_token) {
      await netFetch(`${REVOKE_URL}?token=${encodeURIComponent(tokens.refresh_token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    }
  } catch { /* best effort */ }
  _accessToken = null;
  _tokenExpiry = 0;
}

function isSignedIn() {
  return !!_accessToken || (_loadTokens !== null);
}

// ---------------------------------------------------------------------------
// Account info
// ---------------------------------------------------------------------------

async function getAccountEmail() {
  try {
    const token = await getAccessToken();
    const res = await netFetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const info = await res.json();
      return info.email || null;
    }
  } catch { /* non-fatal */ }
  return null;
}

// ---------------------------------------------------------------------------
// Drive v3 REST — appDataFolder operations
// ---------------------------------------------------------------------------

async function driveRequest(url, options = {}, retries = 0) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, ...options.headers };
  const res = await netFetch(url, { ...options, headers });

  // Retry on transient errors with exponential backoff
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && retries < 5) {
    const delay = Math.min(1000 * Math.pow(2, retries), 32000) + Math.random() * 1000;
    await sleep(delay);
    // On 401, try refreshing the token
    if (res.status === 401) {
      _accessToken = null;
      _tokenExpiry = 0;
    }
    return driveRequest(url, options, retries + 1);
  }
  return res;
}

// List files in appDataFolder
async function listFiles(query) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name,size,modifiedTime,md5Checksum)',
    pageSize: '1000'
  });
  if (query) params.set('q', query);
  const res = await driveRequest(`${DRIVE_API}/files?${params.toString()}`);
  if (!res.ok) throw new Error('Drive list failed: ' + res.status);
  const data = await res.json();
  return data.files || [];
}

// Get file metadata
async function getFileMeta(fileId) {
  const res = await driveRequest(
    `${DRIVE_API}/files/${fileId}?fields=id,name,size,modifiedTime,md5Checksum`
  );
  if (!res.ok) return null;
  return res.json();
}

// Download file content
async function downloadFile(fileId) {
  const res = await driveRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error('Drive download failed: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Download file content as JSON
async function downloadJSON(fileId) {
  const buf = await downloadFile(fileId);
  return JSON.parse(buf.toString('utf8'));
}

// Upload a new file (multipart for small files)
async function createFile(name, content, mimeType) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf.length > 5 * 1024 * 1024) {
    return createFileResumable(name, buf, mimeType);
  }
  const boundary = 'neo_boundary_' + crypto.randomBytes(8).toString('hex');
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const res = await driveRequest(`${DRIVE_UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Drive create failed: ' + res.status + ' ' + text);
  }
  return res.json();
}

// Update an existing file's content
async function updateFile(fileId, content, mimeType) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (buf.length > 5 * 1024 * 1024) {
    return updateFileResumable(fileId, buf, mimeType);
  }
  const res = await driveRequest(
    `${DRIVE_UPLOAD}/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType || 'application/octet-stream' },
      body: buf
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Drive update failed: ' + res.status + ' ' + text);
  }
  return res.json();
}

// Delete a file
async function deleteFile(fileId) {
  const res = await driveRequest(`${DRIVE_API}/files/${fileId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error('Drive delete failed: ' + res.status);
  return true;
}

// ---------------------------------------------------------------------------
// Resumable uploads (for files > 5 MB, mainly cover images)
// ---------------------------------------------------------------------------

async function createFileResumable(name, buf, mimeType) {
  const token = await getAccessToken();
  const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
  const initRes = await netFetch(
    `${DRIVE_UPLOAD}/files?uploadType=resumable`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(buf.length)
      },
      body: metadata
    }
  );
  if (!initRes.ok) throw new Error('Drive resumable init failed: ' + initRes.status);
  const uploadUrl = initRes.headers.get('location');
  return resumableUpload(uploadUrl, buf, mimeType);
}

async function updateFileResumable(fileId, buf, mimeType) {
  const token = await getAccessToken();
  const initRes = await netFetch(
    `${DRIVE_UPLOAD}/files/${fileId}?uploadType=resumable`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(buf.length)
      },
      body: '{}'
    }
  );
  if (!initRes.ok) throw new Error('Drive resumable update init failed: ' + initRes.status);
  const uploadUrl = initRes.headers.get('location');
  return resumableUpload(uploadUrl, buf, mimeType);
}

async function resumableUpload(uploadUrl, buf, mimeType, retries = 0) {
  const res = await netFetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buf.length)
    },
    body: buf
  });
  if (res.ok) return res.json();
  if ((res.status >= 500 || res.status === 408) && retries < 5) {
    await sleep(Math.min(1000 * Math.pow(2, retries), 32000) + Math.random() * 1000);
    return resumableUpload(uploadUrl, buf, mimeType, retries + 1);
  }
  const text = await res.text();
  throw new Error('Resumable upload failed: ' + res.status + ' ' + text);
}

// ---------------------------------------------------------------------------
// Convenience: find-or-create by name
// ---------------------------------------------------------------------------

async function findFileByName(name) {
  const files = await listFiles(`name='${name.replace(/'/g, "\\'")}'`);
  return files.length ? files[0] : null;
}

async function uploadOrUpdate(name, content, mimeType) {
  const existing = await findFileByName(name);
  if (existing) {
    return updateFile(existing.id, content, mimeType);
  }
  return createFile(name, content, mimeType);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Use Electron's net.fetch when available (respects system proxy), fall back
// to global fetch (Node 18+)
function netFetch(url, options) {
  try {
    const { net } = require('electron');
    if (net && net.fetch) return net.fetch(url, options);
  } catch { /* outside Electron, or too early */ }
  return fetch(url, options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Config
  setClientId,
  setClientSecret,
  getClientId,
  setTokenCallbacks,

  // Auth
  authorize,
  getAccessToken,
  revokeTokens,
  isSignedIn,
  getAccountEmail,

  // Drive operations
  listFiles,
  getFileMeta,
  downloadFile,
  downloadJSON,
  createFile,
  updateFile,
  deleteFile,
  findFileByName,
  uploadOrUpdate,

  // For testing
  _setAccessToken(token, expiry) { _accessToken = token; _tokenExpiry = expiry; }
};
