# Git sync for your NEO Library (personal branch)

This branch syncs the **NEO Library** folder with a git remote using the `git` on your PATH and your normal credentials (SSH agent, Git Credential Manager, etc.). NEO does not store passwords or tokens for git.

Settings live in Electron `userData/settings.json`:

- `gitSyncRemote` — e.g. `git@github.com:you/neo-library.git`
- `gitSyncBranch` — default `main`

The library folder gets a `.git` directory and a `.gitignore` (Backups, Exports, snapshots, temp files, etc.).

## Menu

- **Sync → Set Git Remote…** — save remote URL and branch; initializes git in the library if needed.
- **Sync → Sync Now** (Ctrl+Shift+S) — flush open saves, then `git add`, `commit` if needed, `pull --rebase`, `push`.
- **Sync → Git Status…** — short status and another Sync Now button.

On success, NEO calls `refreshFromDisk()` so pulled chapters show up without restarting.

## First machine (library already on disk)

1. Create an empty **private** repository on GitHub (no README).
2. In NEO: **Set Git Remote…** → paste the clone URL → Save.
3. **Sync Now** → first commit of your library and push.

## Second machine

**Recommended:** clone the remote into your library location, then point NEO at it.

```bash
git clone git@github.com:you/neo-library.git "$HOME/Documents/NEO Library"
```

In NEO, **File → Library Folder…** if your library path differs. Set the same remote in **Set Git Remote…** (NEO will attach `origin` if the clone already has it).

**If you already copied files by hand:** you may need a one-time fix outside NEO (`git pull --rebase --allow-unrelated-histories`, or reset one side to match the other). This branch does not merge unrelated histories automatically.

## Conflicts and auth

- If `pull --rebase` stops on a conflict, resolve in git (or your editor), then run `git rebase --continue` and **Sync Now** again—or finish push from a terminal.
- If push/pull fails with auth errors, sign in with `gh auth login`, `git credential`, or SSH keys the same way you would for any other repo.

## Requirements

- Git installed and on PATH (`git --version` in a terminal).
- Do not run two copies of NEO on the **same** library folder at once (same rule as always).
