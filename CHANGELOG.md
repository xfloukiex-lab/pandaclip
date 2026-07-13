# Changelog

## 1.0.4 — 2026-07-12

- Desktop lens ships for **Windows, Linux, and macOS**: GitHub Actions release
  workflow builds NSIS installer, AppImage + deb, and dmg + zip natively on
  every tag. All installers unsigned (OS warnings expected).
- Tray icon is platform-aware (`.ico` on Windows, `.png` elsewhere) — fixes the
  tray on Linux/macOS.

## 1.0.3 — 2026-07-12

- Desktop lens now watches PandaClip's **own cache and garden stores out of the
  box** (like it already watched the clipboard): cache writes and planted facts
  stream into the feed live. New teal cache accent + "cache writes" counter.
  Cached values are deliberately not displayed — only namespace/key/size.

## 1.0.2 — 2026-07-12

- First public release: GitHub + npm (`@panda-mcp/core`, `@panda-mcp/pandaclip`).
- Apache-2.0 LICENSE added; npm publish metadata on both packages.
- README: how it works, the jacobian-lens inspiration, and the magpie-search
  pairing workflow.

## 1.0.1 — 2026-07-11

- Desktop lens: Projects / Channels / Snippets side panels are individually
  collapsible (click a panel header to expand or minimize it).

## 1.0.0 — 2026-07-09

- PandaClip: the four Panda MCP servers collapsed into ONE server — 40 tools
  in four families (clipboard, cache, bamboo file overlay, garden knowledge
  graph), one process, one registration.
- Desktop activity lens (Electron): live read-only feed with configurable
  blank-slot sources (notes, git, knowledge graph), hover overlay, tray icon.
