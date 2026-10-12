// git-sync/run.js — git push/pull for the NEO Library folder (main process only)
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 1024 * 1024;

const LIBRARY_GITIGNORE = `Backups/
Exports/
_catalog.txt
neo-errors.log
**/*.tmp
**/*.bak
.DS_Store
Thumbs.db
Sync Trash/
snapshots/
`;

function isRemotePlausible(remote) {
  if (!remote || typeof remote !== 'string') return false;
  const s = remote.trim();
  if (s.length < 4) return false;
  return (
    /^git@[^:]+:[^\s]+$/.test(s) ||
    /^https?:\/\/[^\s]+$/.test(s) ||
    /^ssh:\/\/[^\s]+$/.test(s) ||
    /^[A-Za-z]:\\/.test(s) ||
    /^\/[^\s]+$/.test(s)
  );
}

async function git(cwd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        timeout: opts.timeout || GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }
    );
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    const msg = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n').trim();
    return { ok: false, error: msg || String(err), code: err.code };
  }
}

async function isGitAvailable() {
  const r = await git(process.cwd(), ['--version'], { timeout: 10000 });
  return r.ok;
}

function isRepo(libraryDir) {
  return fs.existsSync(path.join(libraryDir, '.git'));
}

function writeLibraryGitignore(libraryDir) {
  const file = path.join(libraryDir, '.gitignore');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, LIBRARY_GITIGNORE, 'utf8');
  }
}

async function ensureRepo(libraryDir, remote, branch) {
  const br = (branch || 'main').trim() || 'main';
  if (!isRepo(libraryDir)) {
    const init = await git(libraryDir, ['init', '-b', br]);
    if (!init.ok) return init;
    writeLibraryGitignore(libraryDir);
    const addRemote = await git(libraryDir, ['remote', 'add', 'origin', remote.trim()]);
    if (!addRemote.ok) return addRemote;
  } else {
    // ensure origin points at configured remote
    const hasOrigin = await git(libraryDir, ['remote', 'get-url', 'origin']);
    if (!hasOrigin.ok) {
      const addRemote = await git(libraryDir, ['remote', 'add', 'origin', remote.trim()]);
      if (!addRemote.ok) return addRemote;
    } else if (hasOrigin.stdout.trim() !== remote.trim()) {
      const set = await git(libraryDir, ['remote', 'set-url', 'origin', remote.trim()]);
      if (!set.ok) return set;
    }
  }
  return { ok: true };
}

async function parseStatus(libraryDir, branch) {
  const out = {
    configured: true,
    isRepo: isRepo(libraryDir),
    branch: branch || 'main',
    dirty: false,
    ahead: 0,
    behind: 0,
    statusLine: '',
    porcelain: ''
  };
  if (!out.isRepo) return out;

  const sb = await git(libraryDir, ['status', '-sb']);
  if (sb.ok) {
    out.statusLine = sb.stdout.split('\n')[0] || '';
    const m = out.statusLine.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
    if (m) {
      if (m[1]) out.ahead = parseInt(m[1], 10);
      if (m[2]) out.behind = parseInt(m[2], 10);
    }
  }

  const por = await git(libraryDir, ['status', '--porcelain']);
  if (por.ok) {
    out.porcelain = por.stdout.trim();
    out.dirty = out.porcelain.length > 0;
  }
  return out;
}

async function getStatus(libraryDir, settings) {
  const remote = settings.gitSyncRemote || '';
  const branch = (settings.gitSyncBranch || 'main').trim() || 'main';
  const gitOk = await isGitAvailable();

  const base = {
    configured: !!remote.trim(),
    remote: remote.trim(),
    branch,
    gitAvailable: gitOk,
    isRepo: isRepo(libraryDir),
    dirty: false,
    ahead: 0,
    behind: 0,
    statusLine: '',
    porcelain: ''
  };

  if (!base.configured || !base.isRepo) return base;
  const parsed = await parseStatus(libraryDir, branch);
  return { ...base, ...parsed, configured: true };
}

async function syncNow(libraryDir, settings) {
  const remote = (settings.gitSyncRemote || '').trim();
  const branch = (settings.gitSyncBranch || 'main').trim() || 'main';

  if (!remote) {
    return { ok: false, error: 'No git remote configured. Use Sync → Set Git Remote…' };
  }
  if (!isRemotePlausible(remote)) {
    return { ok: false, error: 'Remote URL does not look valid.' };
  }

  const avail = await isGitAvailable();
  if (!avail) {
    return { ok: false, error: 'git was not found on PATH. Install Git and try again.' };
  }

  const ensured = await ensureRepo(libraryDir, remote, branch);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error || 'Could not initialize git repository.' };
  }

  const add = await git(libraryDir, ['add', '-A']);
  if (!add.ok) return { ok: false, error: add.error };

  let committed = false;
  const diff = await git(libraryDir, ['diff', '--cached', '--quiet']);
  // diff --cached --quiet exits 1 when there are staged changes
  if (diff.code === 1 || (diff.ok === false && diff.code === 1)) {
    const msg = 'NEO sync ' + new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const commit = await git(libraryDir, ['commit', '-m', msg]);
    if (!commit.ok) return { ok: false, error: commit.error };
    committed = true;
  } else if (!diff.ok && diff.code !== 1) {
    return { ok: false, error: diff.error };
  }

  const pull = await git(libraryDir, ['pull', '--rebase', 'origin', branch]);
  if (!pull.ok) {
    const firstPush = /couldn't find remote ref|Could not read from remote|no such branch|does not have/i.test(pull.error || '');
    if (!firstPush) {
      return { ok: false, error: pull.error, committed };
    }
  }

  const push = await git(libraryDir, ['push', '-u', 'origin', branch]);
  if (!push.ok) {
    return { ok: false, error: push.error, committed };
  }

  return { ok: true, committed, detail: (pull.stdout + '\n' + push.stdout).trim() };
}

module.exports = {
  isGitAvailable,
  isRemotePlausible,
  isRepo,
  ensureRepo,
  getStatus,
  syncNow,
  writeLibraryGitignore,
  LIBRARY_GITIGNORE
};
