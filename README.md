<p align="center">
  <img src="apps/bamboo-clipboard-ui/ui/assets/pandaclip-logo.png" alt="PandaClip" width="320">
</p>

# PandaClip

One local-first MCP server + a desktop activity lens. No daemons, no cloud, SQLite everywhere.

`@panda-mcp/pandaclip` is a single server with four tool families:

| Family | Tools | What it does |
|---|---|---|
| 📋 clipboard | `clip_*`, `snippet_*`, `channel_*` | Clipboard history (TTL classes, tag/contains filters), permanent named snippets, channel label-lanes, secret screening |
| ⚡ cache | `cache_*` | Namespaced cache with TTLs, canonical hash keys, invalidation, stats |
| 🎋 bamboo | `workspace_*`, `entry_*`, `stalk_*`, `bamboo_find`, `organize_scan` | Contextual file organizer overlay: tags, notes, and metadata on files you already have — nothing is moved or copied |
| 🌱 garden | `garden_*` | Knowledge graph: plant/grow/prune nodes, typed edges, BFS traverse, per-node history |

All data lives under `~/.panda/<area>/` (override with `PANDA_HOME`). One
registration, one process, 40 tools.

## How it works

PandaClip is a single stdio MCP server (TypeScript). Your agent's MCP client
spawns it, it exposes the 40 tools, and every tool is a small, deterministic
operation on a plain SQLite database — one store per family under
`~/.panda/<area>/`, WAL mode, no background daemons, no network, no cloud.
Nothing happens unless a tool is called:

- **clipboard** — `clip_push` appends to history with TTL classes, tag/contains
  filters, and secret screening (obvious keys and tokens are refused before
  they are ever stored). Snippets are permanent named clips; channels are named
  label lanes inside the same local store, so an agent can be pointed at
  exactly the clip you mean.
- **cache** — a namespaced TTL cache with canonical hash keys, for expensive
  lookups an agent shouldn't repeat.
- **bamboo** — tags, notes, and metadata overlaid on files you already have,
  in place; nothing is moved or copied.
- **garden** — a typed knowledge graph: plant/grow/prune nodes, typed edges,
  BFS traversal, per-node history.

The desktop lens reads those same stores from the other side. The Electron app
spawns a read-only watcher child on your system Node (>= 22.5 — it needs
`node:sqlite`'s WAL-aware reads), which polls the stores plus any sources you
configure, diffs against the last state, and streams change events as NDJSON
up to the live feed. The server stays the sole writer; the lens can only look.

## The desktop lens

`apps/bamboo-clipboard-ui/` is an installable Electron app: a live, read-only
feed of what your agents are doing. Out of the box it watches the clipboard
store (clips, snippets, channels). Three more sources are **blank slots** you
can point at your own stores in `~/.panda/config.json`:

```json
{
  "lens": {
    "notes": { "dir": "~/my-notes", "skipDirs": ["drafts"] },
    "git":   { "dir": "~/code" },
    "kg":    { "db": "~/.local/share/kg/facts.sqlite3",
               "vectors": "~/.local/share/kg/vectors.sqlite3",
               "groupKeys": ["project"],
               "typeLabels": { "journal_entry": "journal written" } }
  }
}
```

`notes` feeds markdown edits, `git` feeds new commits from repos under the
dir, and `kg` understands a knowledge-graph on-disk layout (a triples DB
plus a vector store). The optional `kg` keys shape how vector-store records
appear in the feed: `groupKeys`/`tagKeys` pick metadata fields for the title
and tags, and `typeLabels`/`idPrefixLabels` map a record's type field or id
prefix to a friendly label — unset, records show generically.
Unconfigured slots are simply off. The watcher is strictly read-only.
Requires a system Node.js >= 22.5. Run with
`npm start --workspace pandaclip`.

## Inspired by jacobian-lens

The lens borrows its shape from Anthropic's **jacobian-lens** — companion code
to the paper *"Verbalizable Representations Form a Global Workspace in LMs"* —
which reads a transformer's internal activations to surface what the model is
disposed to say before it says it. PandaClip applies the same move one level up
the stack: instead of weights and gradients, it gives you a live, read-only
window onto what your agents are *doing* in the moment — every clip, cache
write, planted fact, note edit, and commit surfaces in the feed as it happens.
A model lens reads the model's working state; PandaClip reads your agents'.

## Better together with magpie-search

PandaClip deliberately ships **no search engine**. Pair it with
[magpie-search](https://github.com/xfloukiex-lab/magpie-search) ([PyPI](https://pypi.org/project/magpie-search/), `npx -y magpie-search-mcp`) and the two
cover each other: magpie finds things (transcripts, history, deep lookup),
PandaClip holds things (clipboard, cache, file overlay, knowledge graph).

In practice the pairing looks like this: magpie-search **finds** — it fans out
over transcripts, local files, and the web and brings back the answer.
PandaClip **keeps** — `cache_put` the expensive lookup so it isn't repeated,
`clip_push` the excerpt that mattered, `garden_plant` the durable fact with a
typed edge to what it relates to. Next session that fact is one
`garden_search` away instead of a fresh search, and the lens shows the whole
loop happening live.

Run them side by side as separate MCP servers — there is no code coupling and
neither requires the other. Without magpie, everything still works; your agent
just does its lookups manually.

## Develop

```sh
npm install
npm run build
npm test
```

## Use (Claude Code / Desktop)

See `examples/mcp-config.json`. Point the entry at
`servers/pandaclip/dist/index.js` (or `npx @panda-mcp/pandaclip` once published).

## Design rules

- One server; the four families share only `@panda-mcp/core` (SQLite helpers) and the `~/.panda/` home.
- Tool names are literal (`cache_get`, not `feed_panda`); panda theming stays in docs.
- Cache is an optimization, never a source of truth.

---

## About

**PandaClip is built by [VektorGeist LLC](https://vektorgeist.com).**

We build local-first tools for people who run their own AI. PandaClip is the
working-state toolbox; our agent platform is at **[vektorgeist.com](https://vektorgeist.com)**.

- Website: **[vektorgeist.com](https://vektorgeist.com)**
- Contact: **floukie@vektorgeist.com**
- Issues & contributions: open an issue or PR on this repository.

## License

Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
Copyright © 2026 VektorGeist LLC.

*"PandaClip" and the panda mark are trademarks of VektorGeist LLC. The code is
open under Apache-2.0; the brand and name are reserved.*
