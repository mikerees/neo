// sync/sync-ipc.js — IPC handler registrations for sync:* channels
// Called from main.js at startup. All sync operations stay in the main process.
'use strict';

const { ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

const SC = require('./crypto.js');
const Drive = require('./drive.js');
const Engine = require('./engine.js');
const State = require('./state.js');
const SyncEnv = require('./env.js');

// ---------------------------------------------------------------------------
// Setup — called once from main.js after the app is ready
// ---------------------------------------------------------------------------

function register({ libraryDir, appRoot, sendToWindow, logError, readSecret, writeSecret }) {

  // Initialise paths
  State.setStatePath(app.getPath('userData'));

  // Load Google client ID from config
  loadOAuthConfig({
    userDataDir: app.getPath('userData'),
    appRoot: appRoot || path.join(__dirname, '..'),
    libraryDir
  });

  // Set up Drive token callbacks using NEO's existing safeStorage secret system
  Drive.setTokenCallbacks(
    async (tokens) => writeSecret('syncTokens', JSON.stringify(tokens)),
    async () => {
      const raw = readSecret('syncTokens');
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    }
  );

  // Try to restore the master key from safeStorage cache
  const cachedKey = readSecret('syncMasterKey');
  if (cachedKey) {
    try {
      const mk = Buffer.from(cachedKey, 'base64');
      if (mk.length === SC.KEY_LEN) {
        Engine.init({ masterKey: mk, libraryDir, sendStatus: sendToWindow, logError });
      }
    } catch { /* not fatal: user will be prompted */ }
  } else {
    Engine.init({ masterKey: null, libraryDir, sendStatus: sendToWindow, logError });
  }

  // ------ sync:status ------
  ipcMain.handle('sync:status', () => {
    return Engine.getStatus();
  });

  // ------ sync:signIn ------
  ipcMain.handle('sync:signIn', async () => {
    try {
      const result = await Drive.authorize();
      const state = State.readState();
      state.accountEmail = result.email;
      State.writeState(state);
      return { ok: true, email: result.email };
    } catch (err) {
      logError('sync signIn', err);
      return { error: err.message };
    }
  });

  // ------ sync:setup (first device) ------
  ipcMain.handle('sync:setup', async (_e, password) => {
    try {
      if (!password || password.length < 1) return { error: 'Password is required' };

      // Check if a keyfile already exists on Drive
      const existing = await Drive.findFileByName('keyfile.json');
      if (existing) {
        return { error: 'Sync data already exists on this Google account. Use "Connect to Existing Sync" instead.' };
      }

      // Generate master key and keyfile
      const { masterKey, keyfile } = SC.createKeyfile(password);
      const recoveryKey = SC.recoveryKeyFromMaster(masterKey);

      // Upload keyfile to Drive
      await Drive.createFile('keyfile.json', JSON.stringify(keyfile, null, 2), 'application/json');

      // Cache master key locally
      writeSecret('syncMasterKey', masterKey.toString('base64'));

      // Initialize engine
      Engine.init({ masterKey, libraryDir, sendStatus: sendToWindow, logError });

      // Enable sync
      const state = State.readState();
      state.enabled = true;
      State.writeState(state);

      // Initial upload (in background, non-blocking)
      Engine.initialUpload((done, total) => {
        sendToWindow({ type: 'syncStatus', state: 'syncing', detail: `Uploading ${done} of ${total}` });
      }).catch((err) => {
        logError('sync initial upload', err);
        sendToWindow({ type: 'syncStatus', state: 'error', detail: err.message });
      });

      // Rebuild menu to show sync items
      sendToWindow({ type: 'syncEnabled' });

      return { ok: true, recoveryKey };
    } catch (err) {
      logError('sync setup', err);
      return { error: err.message };
    }
  });

  // ------ sync:connect (second device) ------
  ipcMain.handle('sync:connect', async (_e, password) => {
    try {
      if (!password || password.length < 1) return { error: 'Password is required' };

      // Find keyfile on Drive
      const keyfileEntry = await Drive.findFileByName('keyfile.json');
      if (!keyfileEntry) {
        return { error: 'No sync data found on this Google account. Use "Set Up Sync" on your first device.' };
      }

      // Download and open keyfile
      const keyfile = await Drive.downloadJSON(keyfileEntry.id);
      let masterKey;
      try {
        masterKey = SC.openKeyfile(keyfile, password);
      } catch {
        return { error: 'Wrong password. If you have lost your password, use your recovery key.' };
      }

      // Cache master key locally
      writeSecret('syncMasterKey', masterKey.toString('base64'));

      // Initialize engine
      Engine.init({ masterKey, libraryDir, sendStatus: sendToWindow, logError });

      // Enable sync
      const state = State.readState();
      state.enabled = true;
      State.writeState(state);

      // Initial pull (in background)
      Engine.syncPull().then((result) => {
        sendToWindow({ type: 'syncStatus', state: 'synced', detail: `Downloaded ${result.downloaded} files` });
      }).catch((err) => {
        logError('sync initial pull', err);
        sendToWindow({ type: 'syncStatus', state: 'error', detail: err.message });
      });

      sendToWindow({ type: 'syncEnabled' });
      return { ok: true };
    } catch (err) {
      logError('sync connect', err);
      return { error: err.message };
    }
  });

  // ------ sync:now ------
  ipcMain.handle('sync:now', async () => {
    try {
      if (!Engine.isReady()) return { error: 'Sync is not set up' };
      // Let pending chapter:write IPC messages from a flushAllSaves() in
      // the renderer be handled before we start the sync.
      await new Promise((resolve) => setImmediate(resolve));
      const result = await Engine.syncAll();
      return { ok: true, ...result };
    } catch (err) {
      logError('sync now', err);
      return { error: err.message };
    }
  });

  // ------ sync:changePassword ------
  ipcMain.handle('sync:changePassword', async (_e, oldPassword, newPassword) => {
    try {
      if (!newPassword || newPassword.length < 1) return { error: 'New password is required' };

      // Download current keyfile
      const keyfileEntry = await Drive.findFileByName('keyfile.json');
      if (!keyfileEntry) return { error: 'No keyfile found on Drive' };
      const keyfile = await Drive.downloadJSON(keyfileEntry.id);

      // Verify old password
      let masterKey;
      try {
        masterKey = SC.openKeyfile(keyfile, oldPassword);
      } catch {
        return { error: 'Current password is incorrect' };
      }

      // Re-wrap with new password
      const newKeyfile = SC.rekeyKeyfile(masterKey, newPassword);
      await Drive.updateFile(keyfileEntry.id,
        Buffer.from(JSON.stringify(newKeyfile, null, 2)),
        'application/json'
      );

      const recoveryKey = SC.recoveryKeyFromMaster(masterKey);
      return { ok: true, recoveryKey };
    } catch (err) {
      logError('sync changePassword', err);
      return { error: err.message };
    }
  });

  // ------ sync:recoveryKey ------
  ipcMain.handle('sync:recoveryKey', async (_e, password) => {
    try {
      const keyfileEntry = await Drive.findFileByName('keyfile.json');
      if (!keyfileEntry) return { error: 'No keyfile found' };
      const keyfile = await Drive.downloadJSON(keyfileEntry.id);
      let masterKey;
      try { masterKey = SC.openKeyfile(keyfile, password); } catch {
        return { error: 'Wrong password' };
      }
      return { key: SC.recoveryKeyFromMaster(masterKey) };
    } catch (err) {
      logError('sync recoveryKey', err);
      return { error: err.message };
    }
  });

  // ------ sync:recover (use recovery key to set new password) ------
  ipcMain.handle('sync:recover', async (_e, recoveryKey, newPassword) => {
    try {
      let masterKey;
      try { masterKey = SC.masterFromRecoveryKey(recoveryKey); } catch {
        return { error: 'Invalid recovery key' };
      }

      // Re-wrap and upload
      const newKeyfile = SC.rekeyKeyfile(masterKey, newPassword);
      const keyfileEntry = await Drive.findFileByName('keyfile.json');
      if (keyfileEntry) {
        await Drive.updateFile(keyfileEntry.id,
          Buffer.from(JSON.stringify(newKeyfile, null, 2)),
          'application/json'
        );
      } else {
        await Drive.createFile('keyfile.json',
          JSON.stringify(newKeyfile, null, 2),
          'application/json'
        );
      }

      // Cache and init
      writeSecret('syncMasterKey', masterKey.toString('base64'));
      Engine.init({ masterKey, libraryDir, sendStatus: sendToWindow, logError });

      const state = State.readState();
      state.enabled = true;
      State.writeState(state);

      return { ok: true };
    } catch (err) {
      logError('sync recover', err);
      return { error: err.message };
    }
  });

  // ------ sync:signOut ------
  ipcMain.handle('sync:signOut', async (_e, opts) => {
    try {
      // Optionally delete all remote data
      if (opts && opts.removeRemote) {
        try {
          const files = await Drive.listFiles();
          for (const f of files) await Drive.deleteFile(f.id);
        } catch (err) {
          logError('sync signOut cleanup', err);
        }
      }

      await Drive.revokeTokens();
      writeSecret('syncMasterKey', '');
      writeSecret('syncTokens', '');
      Engine.setMasterKey(null);

      const state = State.readState();
      state.enabled = false;
      state.accountEmail = null;
      State.writeState(state);

      sendToWindow({ type: 'syncDisabled' });
      return { ok: true };
    } catch (err) {
      logError('sync signOut', err);
      return { error: err.message };
    }
  });

  // ------ sync:resolveConflict ------
  ipcMain.handle('sync:resolveConflict', async (_e, _objectId, _keep) => {
    // keep: 'local' or 'remote'
    // For now, conflicts are resolved by the user manually reviewing
    // the conflict files. This handler is a placeholder for v2.
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Hook for save handlers: called after a successful disk write in main.js
// ---------------------------------------------------------------------------

function onFileSaved(relativePath) {
  if (!Engine.isReady()) return;
  const state = State.readState();
  if (!state.enabled) return;
  Engine.enqueueSync(relativePath);
}

function onFileDeleted(relativePath) {
  if (!Engine.isReady()) return;
  const state = State.readState();
  if (!state.enabled) return;
  Engine.pushTombstone(relativePath).catch(() => {
    // logged inside pushTombstone
  });
}

// Trigger a pull (on app launch, window focus)
let _lastPull = 0;
const PULL_COOLDOWN_MS = 60000;

function triggerPull() {
  if (!Engine.isReady()) return;
  const state = State.readState();
  if (!state.enabled) return;
  const now = Date.now();
  if (now - _lastPull < PULL_COOLDOWN_MS) return;
  _lastPull = now;
  Engine.syncPull().catch(() => {});
}

// Sync state query (for menu visibility)
function isSyncEnabled() {
  try {
    const state = State.readState();
    return state.enabled;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Client ID loader
// ---------------------------------------------------------------------------

function loadOAuthConfig({ userDataDir, appRoot, libraryDir }) {
  let { clientId, clientSecret } = SyncEnv.resolveOAuthCredentials({ appRoot, libraryDir });
  if (!clientId) {
    const configPath = path.join(userDataDir, 'sync-config.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.clientId) clientId = cfg.clientId;
      if (cfg.clientSecret) clientSecret = cfg.clientSecret;
    } catch { /* no config file */ }
  }
  if (clientId) Drive.setClientId(clientId);
  if (clientSecret) Drive.setClientSecret(clientSecret);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  register,
  onFileSaved,
  onFileDeleted,
  triggerPull,
  isSyncEnabled
};
