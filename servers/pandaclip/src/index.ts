#!/usr/bin/env node
// PandaClip — the whole panda toolbox as ONE MCP server.
// Four tool families, one process, one registration:
//   clip_* / snippet_* / channel_*  — clipboard history & snippets
//   cache_*                         — namespaced TTL cache
//   workspace_* / entry_* / stalk_* / bamboo_find — file-organizer overlay
//   garden_*                        — knowledge graph
// Data layout on disk is unchanged from the split servers (~/.panda/<area>/),
// so existing databases keep working.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";
import { ok, err } from "@vektorgeist/panda-core";
import { ClipStore } from "./store/clipStore.js";
import { CacheStore, hashKey } from "./store/cacheStore.js";
import { BambooStore } from "./store/bambooStore.js";
import { GardenStore } from "./store/gardenStore.js";

const clips = new ClipStore();
const cache = new CacheStore();
const bamboo = new BambooStore();
const garden = new GardenStore(process.env.PANDA_GARDEN ?? "default");
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "pandaclip", version });

const wrap = (fn: () => unknown) => {
  try {
    return ok(fn());
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
};

/* ================= clipboard: history, snippets, channels ================= */

server.registerTool(
  "clip_push",
  {
    description:
      "Add an entry to the clipboard. ttl_class: ephemeral (24h, default), session (7d), pinned (never expires). Credential-looking content is refused.",
    inputSchema: {
      content: z.string(),
      label: z.string().optional(),
      channel: z.string().optional(),
      ttl_class: z.enum(["ephemeral", "session", "pinned"]).optional(),
      tags: z.array(z.string()).optional(),
      content_type: z.string().optional(),
      source: z.string().optional(),
    },
  },
  (a) =>
    wrap(() =>
      clips.push({
        content: a.content,
        label: a.label,
        channel: a.channel,
        ttlClass: a.ttl_class,
        tags: a.tags,
        contentType: a.content_type,
        source: a.source,
      }),
    ),
);

server.registerTool(
  "clip_history",
  {
    description:
      "Recent clipboard entries, newest first. Filter by channel, tag, or a contains substring (matches content/label).",
    inputSchema: {
      channel: z.string().optional(),
      tag: z.string().optional(),
      contains: z.string().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    },
  },
  (a) => ok(clips.history(a)),
);

server.registerTool(
  "clip_get",
  { description: "Fetch one clipboard entry by id.", inputSchema: { id: z.string() } },
  ({ id }) => {
    const entry = clips.get(id);
    return entry ? ok(entry) : err(`no entry ${id}`);
  },
);

server.registerTool(
  "clip_pin",
  { description: "Pin an entry so it never expires.", inputSchema: { id: z.string() } },
  ({ id }) => (clips.pin(id) ? ok({ pinned: id }) : err(`no entry ${id}`)),
);

server.registerTool(
  "clip_delete",
  { description: "Delete a clipboard entry.", inputSchema: { id: z.string() } },
  ({ id }) => (clips.deleteById(id) ? ok({ deleted: id }) : err(`no entry ${id}`)),
);

server.registerTool(
  "snippet_save",
  {
    description: "Save (or overwrite) a named permanent snippet.",
    inputSchema: { name: z.string(), content: z.string(), label: z.string().optional() },
  },
  ({ name, content, label }) => wrap(() => clips.push({ content, label, snippetName: name })),
);

server.registerTool(
  "snippet_get",
  { description: "Fetch a snippet by name.", inputSchema: { name: z.string() } },
  ({ name }) => {
    const s = clips.getSnippet(name);
    return s ? ok(s) : err(`no snippet '${name}'`);
  },
);

server.registerTool("snippet_list", { description: "List all saved snippets.", inputSchema: {} }, () =>
  ok(clips.listSnippets()),
);

server.registerTool(
  "channel_send",
  {
    description:
      "Put a payload in a named channel — a label lane inside this machine's clipboard (session-class TTL).",
    inputSchema: { channel: z.string(), content: z.string(), label: z.string().optional(), source: z.string().optional() },
  },
  ({ channel, content, label, source }) =>
    wrap(() => clips.push({ content, channel, label, source, ttlClass: "session" })),
);

server.registerTool(
  "channel_peek",
  {
    description: "Read a channel's pending entries without consuming them.",
    inputSchema: { channel: z.string(), limit: z.number().int().positive().optional() },
  },
  ({ channel, limit }) => ok(clips.channelPeek(channel, limit)),
);

server.registerTool(
  "channel_take",
  {
    description: "Take (read + consume) the oldest pending entry from a channel. Returns null when empty.",
    inputSchema: { channel: z.string() },
  },
  ({ channel }) => ok(clips.channelTake(channel)),
);

/* ================= cache: namespaced TTL cache ================= */

server.registerTool(
  "cache_get",
  {
    description: "Get a cached value. Returns {hit:false} on miss or expiry.",
    inputSchema: { namespace: z.string(), key: z.string() },
  },
  ({ namespace, key }) => {
    const hit = cache.get(namespace, key);
    return ok(hit ? { hit: true, ...hit } : { hit: false });
  },
);

server.registerTool(
  "cache_set",
  {
    description:
      "Store a value. ttl_seconds overrides the namespace default; omit both for a permanent entry.",
    inputSchema: {
      namespace: z.string(),
      key: z.string(),
      value: z.string(),
      ttl_seconds: z.number().int().positive().optional(),
      content_type: z.string().optional(),
    },
  },
  ({ namespace, key, value, ttl_seconds, content_type }) => {
    cache.set(namespace, key, value, { ttlSeconds: ttl_seconds, contentType: content_type });
    return ok({ stored: true, namespace, key });
  },
);

server.registerTool(
  "cache_hash_key",
  {
    description:
      "Canonical cache key (sorted-key SHA-256) from arbitrary JSON — use so 'same prompt+params' always hits.",
    inputSchema: { payload: z.unknown() },
  },
  ({ payload }) => ok({ key: hashKey(payload) }),
);

server.registerTool(
  "cache_invalidate",
  {
    description: "Delete entries by exact key or key prefix within a namespace.",
    inputSchema: {
      namespace: z.string(),
      key: z.string().optional(),
      prefix: z.string().optional(),
    },
  },
  ({ namespace, key, prefix }) => {
    if (key == null && prefix == null) return err("provide key or prefix (use cache_flush for the whole namespace)");
    return ok({ removed: cache.invalidate(namespace, { key, prefix }) });
  },
);

server.registerTool(
  "cache_flush",
  {
    description: "Delete ALL entries in a namespace.",
    inputSchema: { namespace: z.string() },
  },
  ({ namespace }) => ok({ removed: cache.flush(namespace) }),
);

server.registerTool(
  "cache_namespace_configure",
  {
    description: "Set per-namespace policy: default TTL seconds (null = permanent).",
    inputSchema: {
      namespace: z.string(),
      default_ttl_seconds: z.number().int().positive().nullable().optional(),
    },
  },
  ({ namespace, default_ttl_seconds }) => {
    cache.configureNamespace(namespace, { defaultTtlSeconds: default_ttl_seconds ?? null });
    return ok({ configured: namespace });
  },
);

server.registerTool(
  "cache_stats",
  {
    description: "Entry counts, bytes, and hit totals per namespace.",
    inputSchema: { namespace: z.string().optional() },
  },
  ({ namespace }) => ok(cache.stats(namespace)),
);

/* ================= bamboo: file-organizer overlay ================= */

server.registerTool(
  "workspace_create",
  {
    description: "Register a directory as a named Bamboo workspace (metadata overlay — files are never modified).",
    inputSchema: { name: z.string(), root_path: z.string(), description: z.string().optional() },
  },
  ({ name, root_path, description }) => wrap(() => bamboo.createWorkspace(name, root_path, description)),
);

server.registerTool("workspace_list", { description: "List all workspaces.", inputSchema: {} }, () =>
  ok(bamboo.listWorkspaces()),
);

server.registerTool(
  "workspace_open",
  {
    description: "Open a workspace: top-level outline, pinned entries, recently seen, stalks, counts.",
    inputSchema: { name: z.string() },
  },
  ({ name }) => wrap(() => bamboo.open(name)),
);

server.registerTool(
  "organize_scan",
  {
    description:
      "Reconcile a workspace against disk: discover new files/dirs, refresh existing, flag missing. Run after workspace_create and whenever files changed.",
    inputSchema: { workspace: z.string(), max_depth: z.number().int().positive().optional() },
  },
  ({ workspace, max_depth }) => wrap(() => bamboo.scan(workspace, { maxDepth: max_depth })),
);

server.registerTool(
  "entry_tag",
  {
    description: "Add tags to a file/dir entry (by workspace-relative path).",
    inputSchema: { workspace: z.string(), rel_path: z.string(), tags: z.array(z.string()).min(1) },
  },
  ({ workspace, rel_path, tags }) => wrap(() => bamboo.tag(workspace, rel_path, tags)),
);

server.registerTool(
  "entry_annotate",
  {
    description: "Set free-text notes on an entry (replaces existing notes).",
    inputSchema: { workspace: z.string(), rel_path: z.string(), notes: z.string() },
  },
  ({ workspace, rel_path, notes }) => wrap(() => bamboo.annotate(workspace, rel_path, notes)),
);

server.registerTool(
  "entry_meta_set",
  {
    description: "Set a key/value metadata pair on an entry.",
    inputSchema: { workspace: z.string(), rel_path: z.string(), key: z.string(), value: z.string() },
  },
  ({ workspace, rel_path, key, value }) => wrap(() => bamboo.setMeta(workspace, rel_path, key, value)),
);

server.registerTool(
  "entry_pin",
  {
    description: "Pin/unpin an entry so it surfaces in workspace_open.",
    inputSchema: { workspace: z.string(), rel_path: z.string(), pinned: z.boolean() },
  },
  ({ workspace, rel_path, pinned }) => wrap(() => bamboo.setPinned(workspace, rel_path, pinned)),
);

server.registerTool(
  "bamboo_find",
  {
    description:
      "Find entries by FTS query (over path/notes/tags) or by exact tag. Metadata search only — not file-content search.",
    inputSchema: {
      workspace: z.string(),
      query: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  ({ workspace, query, tag, limit }) => wrap(() => bamboo.find(workspace, { query, tag, limit })),
);

server.registerTool(
  "stalk_create",
  {
    description: "Create a stalk — a logical collection within a workspace that can span physical directories.",
    inputSchema: { workspace: z.string(), name: z.string(), description: z.string().optional() },
  },
  ({ workspace, name, description }) => wrap(() => bamboo.createStalk(workspace, name, description)),
);

server.registerTool(
  "stalk_assign",
  {
    description: "Assign entries (by rel_path) to a stalk.",
    inputSchema: { workspace: z.string(), stalk: z.string(), rel_paths: z.array(z.string()).min(1) },
  },
  ({ workspace, stalk, rel_paths }) => wrap(() => ({ assigned: bamboo.assignToStalk(workspace, stalk, rel_paths) })),
);

server.registerTool(
  "stalk_list",
  {
    description: "List a stalk's member entries.",
    inputSchema: { workspace: z.string(), stalk: z.string() },
  },
  ({ workspace, stalk }) => wrap(() => bamboo.listStalk(workspace, stalk)),
);

/* ================= garden: knowledge graph ================= */

const sourceSchema = z.object({ kind: z.string(), ref: z.string() });

server.registerTool(
  "garden_plant",
  {
    description: "Create a knowledge node (starts as stage 'seed'). Optional provenance sources.",
    inputSchema: {
      title: z.string(),
      content: z.string().optional(),
      type: z.string().optional(),
      importance: z.number().int().min(1).max(5).optional(),
      sources: z.array(sourceSchema).optional(),
    },
  },
  (a) => wrap(() => garden.plant(a)),
);

server.registerTool(
  "garden_grow",
  {
    description:
      "Update a node's title/content/stage/importance. Stages: seed -> shoot -> bamboo. Every grow records a history version.",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      content: z.string().optional(),
      stage: z.enum(["seed", "shoot", "bamboo"]).optional(),
      importance: z.number().int().min(1).max(5).optional(),
      change_note: z.string().optional(),
    },
  },
  ({ id, change_note, ...rest }) => wrap(() => garden.grow(id, { ...rest, changeNote: change_note })),
);

server.registerTool(
  "garden_prune",
  {
    description: "Soft-delete a node (with its edges) or a single edge, with a reason. Nothing is hard-deleted.",
    inputSchema: { node_id: z.string().optional(), edge_id: z.string().optional(), reason: z.string().optional() },
  },
  ({ node_id, edge_id, reason }) => wrap(() => garden.prune({ nodeId: node_id, edgeId: edge_id, reason })),
);

server.registerTool(
  "garden_connect",
  {
    description: "Create a typed directed edge (root) between two nodes, e.g. rel='depends_on'.",
    inputSchema: {
      src: z.string(),
      dst: z.string(),
      rel: z.string(),
      weight: z.number().optional(),
      note: z.string().optional(),
    },
  },
  ({ src, dst, rel, weight, note }) => wrap(() => garden.connect(src, dst, rel, { weight, note })),
);

server.registerTool(
  "garden_disconnect",
  {
    description: "Prune the edge(s) matching src -> dst with the given rel.",
    inputSchema: { src: z.string(), dst: z.string(), rel: z.string() },
  },
  ({ src, dst, rel }) => ok({ pruned_edges: garden.disconnect(src, dst, rel) }),
);

server.registerTool(
  "garden_neighbors",
  {
    description: "1-hop neighbors of a node, optionally filtered by rel and direction.",
    inputSchema: {
      id: z.string(),
      rel: z.string().optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
    },
  },
  ({ id, rel, direction }) => wrap(() => garden.neighbors(id, { rel, direction })),
);

server.registerTool(
  "garden_traverse",
  {
    description: "BFS subgraph from a node to a depth (default 2, max 6), optional rel filter.",
    inputSchema: { id: z.string(), depth: z.number().int().positive().optional(), rel: z.string().optional() },
  },
  ({ id, depth, rel }) => wrap(() => garden.traverse(id, { depth, rel })),
);

server.registerTool(
  "garden_search",
  {
    description: "Full-text search over node titles and content, with optional type/stage filters.",
    inputSchema: {
      query: z.string(),
      type: z.string().optional(),
      stage: z.enum(["seed", "shoot", "bamboo"]).optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  ({ query, ...opts }) => wrap(() => garden.search(query, opts)),
);

server.registerTool(
  "garden_node_history",
  { description: "All recorded versions of a node.", inputSchema: { id: z.string() } },
  ({ id }) => ok(garden.history(id)),
);

server.registerTool(
  "garden_stats",
  {
    description: "What needs gardening: counts by stage/type, live edges, orphan nodes, stale seeds (30d).",
    inputSchema: {},
  },
  () => ok(garden.stats()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
