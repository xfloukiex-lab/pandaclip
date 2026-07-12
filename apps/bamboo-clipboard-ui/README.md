# PandaClip (desktop lens)

The live desktop face for the **pandaclip** MCP server. Leave it open and watch
agent activity stream in as it happens — no clicking, no refresh.

## What it shows

- **Live activity feed** — every new clip / channel send / snippet / consume /
  pin / expire animates in the moment it hits the store, plus (if configured)
  knowledge-graph records, note edits, and git commits.
- **Projects** — repos under your configured code dir with their latest commit.
- **Channels** — named label lanes inside the local clipboard, with pending
  counts and what's waiting in each.
- **Snippets** — named reusable entries.
- **Hover overlay** — a frameless always-on-top mini-feed (tray icon,
  Ctrl+Alt+L, or the 🐼 header button).

## How it works

Read-only watcher. The Electron main process spawns `src/watcher.js` as a child
of your system Node (>= 22.5 — it needs `node:sqlite`, whose reads see WAL
writes immediately). The watcher polls the clipboard store and any lens sources
configured in `~/.panda/config.json`, diffs against the last state, and streams
change events as NDJSON, which main forwards to the renderer over a
contextIsolated preload bridge. Nothing is written back — the MCP server stays
the single writer, so the app can never corrupt or race it.

## Run

```
npm install            # from repo root (workspaces)
npm start --workspace pandaclip
```

## Package (Windows installer)

```
npm run dist --workspace pandaclip   # electron-builder → NSIS installer in dist/
```

Note: if the in-workspace build fails to find `app-builder-bin`, stage `src/`,
`ui/`, and `package.json` into a standalone folder outside the monorepo and run
`npm install --include=optional && npx electron-builder --win nsis` there.
