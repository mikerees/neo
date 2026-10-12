// sync/env.js — read GOOGLE_CLIENT_ID from .env files (no dotenv dependency)
'use strict';

const fs = require('fs');
const path = require('path');

// Parse KEY=VALUE lines; supports optional single/double quotes around values.
function parseEnvFile(content) {
  const out = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readEnvFile(filePath) {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Where a writer can drop a .env without touching AppData (e.g. locked-down work laptops).
function dotEnvPaths({ appRoot, libraryDir }) {
  const paths = [];
  if (appRoot) paths.push(path.join(appRoot, '.env'));
  try {
    if (process.execPath) paths.push(path.join(path.dirname(process.execPath), '.env'));
  } catch { /* ignore */ }
  if (libraryDir) paths.push(path.join(libraryDir, '.env'));
  // De-dupe while preserving order
  const seen = new Set();
  return paths.filter((p) => {
    const norm = path.resolve(p);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
}

function oauthFromParsed(parsed) {
  if (!parsed) return null;
  const clientId = String(parsed.GOOGLE_CLIENT_ID || parsed.google_client_id || '').trim();
  const clientSecret = String(parsed.GOOGLE_CLIENT_SECRET || parsed.google_client_secret || '').trim();
  if (!clientId) return null;
  return { clientId, clientSecret: clientSecret || null };
}

/** First .env file that defines GOOGLE_CLIENT_ID */
function resolveOAuthFromDotEnv(opts = {}) {
  for (const file of dotEnvPaths(opts)) {
    const parsed = readEnvFile(file);
    const creds = oauthFromParsed(parsed);
    if (creds) return creds;
  }
  return null;
}

/**
 * Client ID + optional secret (Web OAuth clients need a secret; Desktop + PKCE does not).
 * Shell env wins per field; missing fields are filled from .env files.
 */
function resolveOAuthCredentials(opts = {}) {
  const fromDot = resolveOAuthFromDotEnv(opts);
  const clientId = (process.env.GOOGLE_CLIENT_ID && String(process.env.GOOGLE_CLIENT_ID).trim())
    || (fromDot && fromDot.clientId)
    || '';
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET && String(process.env.GOOGLE_CLIENT_SECRET).trim())
    || (fromDot && fromDot.clientSecret)
    || '';
  return {
    clientId: clientId || null,
    clientSecret: clientSecret || null
  };
}

/** @deprecated use resolveOAuthCredentials */
function resolveGoogleClientId(opts = {}) {
  return resolveOAuthCredentials(opts).clientId;
}

module.exports = {
  parseEnvFile,
  dotEnvPaths,
  oauthFromParsed,
  resolveOAuthFromDotEnv,
  resolveOAuthCredentials,
  resolveGoogleClientId
};
