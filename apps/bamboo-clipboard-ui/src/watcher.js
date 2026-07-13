// Read-only multi-source activity watcher. Runs under the SYSTEM node (>=22.5,
// needs node:sqlite) as a child of the Electron main process; emits NDJSON on
// stdout. It NEVER writes to any watched store.
//
// Sources are BLANK SLOTS configured in ~/.panda/config.json under "lens".
// Out of the box PandaClip's OWN stores are watched (clipboard, cache, garden
// knowledge graph); point the other slots at your own stores:
//
//   {
//     "lens": {
//       "notes": { "dir": "~/my-notes", "skipDirs": ["drafts"] },  // *.md edit feed
//       "git":   { "dir": "~/code" },                              // repos -> commit feed
//       "kg":    { "db": "~/.local/share/kg/facts.sqlite3",
//                  "vectors": "~/.local/share/kg/vectors.sqlite3",
//                  "groupKeys": ["project"], "tagKeys": ["topic"],
//                  "typeLabels": { "journal_entry": "journal written" } }
//     }
//   }
//
// "kg" understands a knowledge-graph on-disk layout (a triples db + a vector
// store). The optional kg keys shape how vector-store records are shown:
// groupKeys/tagKeys pick metadata fields for the title/tags; typeLabels (by the
// record's type field) and idPrefixLabels (by record-id prefix) map records to
// feed labels. All of them are optional — unset, records show generically.
"use strict";

const { DatabaseSync } = require("node:sqlite");
const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const HOME = os.homedir();
const PANDA_HOME = process.env.PANDA_HOME ?? path.join(HOME, ".panda");
const CLIP_DB = path.join(PANDA_HOME, "clipboard", "clip.db");
const CACHE_DB = path.join(PANDA_HOME, "cache", "cache.db");
const GARDEN_DIR = path.join(PANDA_HOME, "garden");

function expand(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  return path.resolve(p.replace(/^~(?=$|[/\\])/, HOME));
}

function lensConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(PANDA_HOME, "config.json"), "utf8"));
    return cfg && typeof cfg.lens === "object" && cfg.lens ? cfg.lens : {};
  } catch { return {}; }
}

const LENS = lensConfig();
const KG_DB = expand(LENS.kg?.db);
const VECTORS_DB = expand(LENS.kg?.vectors);
const NOTES_DIR = expand(LENS.notes?.dir);
const PROJECTS_DIR = expand(LENS.git?.dir);
const KG_GROUP_KEYS = Array.isArray(LENS.kg?.groupKeys) ? LENS.kg.groupKeys : [];
const KG_TAG_KEYS = Array.isArray(LENS.kg?.tagKeys) ? LENS.kg.tagKeys : [];
const KG_TYPE_FIELD = typeof LENS.kg?.typeField === "string" ? LENS.kg.typeField : "type";
const KG_TYPE_LABELS = LENS.kg?.typeLabels && typeof LENS.kg.typeLabels === "object" ? LENS.kg.typeLabels : {};
const KG_ID_PREFIX_LABELS = LENS.kg?.idPrefixLabels && typeof LENS.kg.idPrefixLabels === "object" ? LENS.kg.idPrefixLabels : {};
const NOTES_SKIP = new Set(Array.isArray(LENS.notes?.skipDirs) ? LENS.notes.skipDirs : []);

const startedAt = Date.now();
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rel = (p) => "~/" + path.relative(HOME, p).split(path.sep).join("/");

function openRO(file) {
  return new DatabaseSync(file, { readOnly: true });
}

/* ---------------- clipboard ---------------- */
const clipState = new Map(); // id -> state
let clipBaselined = false;

function rowState(r) {
  if (r.consumed_at) return "consumed";
  if (r.pinned) return "pinned";
  return "live";
}

function pollClipboard() {
  if (!fs.existsSync(CLIP_DB)) return;
  const db = openRO(CLIP_DB);
  try {
    const rows = db
      .prepare(`SELECT e.*, (SELECT group_concat(tag) FROM tags t WHERE t.entry_id = e.id) AS tag_csv
                FROM entries e ORDER BY e.created_at DESC LIMIT 500`)
      .all();
    const entries = rows.map((r) => ({
      id: r.id,
      preview: String(r.content ?? "").slice(0, 200),
      full: String(r.content ?? "").slice(0, 4000),
      label: r.label,
      source: r.source,
      channel: r.channel,
      snippetName: r.snippet_name,
      createdAt: Number(r.created_at),
      tags: r.tag_csv ? String(r.tag_csv).split(",") : [],
      state: rowState(r),
    }));
    const events = [];
    for (const e of entries) {
      const prev = clipState.get(e.id);
      if (prev === undefined) {
        if (clipBaselined) {
          events.push({
            kind: e.snippetName ? "snippet_saved" : e.channel ? "channel_send" : "clip",
            title: e.label ?? (e.snippetName ? `snippet ${e.snippetName}` : e.channel ? `#${e.channel}` : "clip"),
            body: e.preview, full: e.full, source: e.source, channel: e.channel, tags: e.tags, ts: e.createdAt,
          });
        }
      } else if (prev !== e.state) {
        events.push({ kind: e.state, title: e.label ?? e.snippetName ?? (e.channel ? `#${e.channel}` : "clip"), body: e.preview, full: e.full, source: e.source, channel: e.channel, ts: Date.now() });
      }
      clipState.set(e.id, e.state);
    }
    const liveIds = new Set(entries.map((e) => e.id));
    for (const id of clipState.keys()) {
      if (!liveIds.has(id)) { clipState.delete(id); if (clipBaselined) events.push({ kind: "expired", title: "clip expired", ts: Date.now() }); }
    }
    clipBaselined = true;
    for (const ev of events) emit({ type: "event", src: "clipboard", ...ev });
    emit({ type: "clipboard_snapshot", entries });
  } finally { db.close(); }
}

/* ---------------- cache: PandaClip's own TTL cache ---------------- */
let cacheMaxTs = null;

function pollCache() {
  if (!fs.existsSync(CACHE_DB)) return;
  const db = openRO(CACHE_DB);
  try {
    const max = db.prepare("SELECT max(created_at) m FROM entries").get()?.m ?? 0;
    if (cacheMaxTs !== null && max > cacheMaxTs) {
      const rows = db
        .prepare("SELECT namespace, key, content_type, size, created_at FROM entries WHERE created_at > ? ORDER BY created_at LIMIT 20")
        .all(cacheMaxTs);
      for (const r of rows) {
        // value is deliberately NOT shown — cached payloads can be sensitive
        emit({ type: "event", src: "cache", kind: "cache_write", title: `cache · ${r.namespace}`,
          body: `${r.key} (${r.content_type}, ${r.size} B)`, ts: Number(r.created_at) });
      }
    }
    cacheMaxTs = max;
  } finally { db.close(); }
}

/* ---------------- garden: PandaClip's own knowledge graph ---------------- */
const gardenMaxTs = new Map(); // db file -> max created_at

function gardenDbs() {
  if (!fs.existsSync(GARDEN_DIR)) return [];
  try {
    return fs.readdirSync(GARDEN_DIR).filter((f) => f.endsWith(".db")).map((f) => path.join(GARDEN_DIR, f));
  } catch { return []; }
}

function gardenEvent(r, gardenName) {
  const where = gardenName === "default" ? r.type : `${gardenName}/${r.type}`;
  return {
    kind: "fact_planted", title: `planted · ${where}`,
    body: String(r.title ?? "").slice(0, 200),
    full: String(r.content ?? r.title ?? "").slice(0, 4000),
    tags: [r.stage].filter(Boolean),
  };
}

function pollGarden() {
  for (const file of gardenDbs()) {
    let db;
    try { db = openRO(file); } catch { continue; }
    try {
      const max = db.prepare("SELECT max(created_at) m FROM nodes").get()?.m ?? 0;
      const prev = gardenMaxTs.get(file);
      if (prev !== undefined && max > prev) {
        const rows = db
          .prepare("SELECT id, type, title, content, stage, created_at FROM nodes WHERE created_at > ? ORDER BY created_at LIMIT 20")
          .all(prev);
        const g = path.basename(file, ".db");
        for (const r of rows) emit({ type: "event", src: "kg", ts: Number(r.created_at), ...gardenEvent(r, g) });
      }
      gardenMaxTs.set(file, max);
    } finally { db.close(); }
  }
}

/* ---------------- knowledge graph: triples (triples + vectors layout) ---------------- */
let kgSeen = null; // Set of triple ids (bounded by query LIMIT)

function pollKg() {
  if (!KG_DB || !fs.existsSync(KG_DB)) return;
  const db = openRO(KG_DB);
  try {
    const rows = db.prepare("SELECT id, subject, predicate, object, extracted_at FROM triples ORDER BY extracted_at DESC LIMIT 100").all();
    const ids = new Set(rows.map((r) => r.id));
    if (kgSeen) {
      for (const r of rows) {
        if (!kgSeen.has(r.id)) {
          emit({ type: "event", src: "kg", kind: "kg_fact", title: "KG fact",
            body: `${r.subject} — ${r.predicate} — ${String(r.object).slice(0, 160)}`, ts: Date.now() });
        }
      }
    }
    kgSeen = ids;
  } finally { db.close(); }
}

/* ---------------- knowledge graph: vector-store records (chroma layout) ---------------- */
let vectorsMaxId = null;

function recordShape(meta, recordId) {
  const prefixLabel = Object.entries(KG_ID_PREFIX_LABELS).find(([p]) => String(recordId).startsWith(p))?.[1];
  const label = KG_TYPE_LABELS[meta[KG_TYPE_FIELD]] ?? prefixLabel ?? "record";
  const group = KG_GROUP_KEYS.map((k) => meta[k]).filter(Boolean).join("/");
  return {
    kind: "kg_record", label,
    title: group ? `${label} · ${group}` : label,
    body: String(meta["chroma:document"] ?? "").slice(0, 200),
    full: String(meta["chroma:document"] ?? "").slice(0, 4000),
    tags: KG_TAG_KEYS.map((k) => meta[k]).filter(Boolean),
  };
}

function pollVectors() {
  if (!VECTORS_DB || !fs.existsSync(VECTORS_DB)) return;
  const db = openRO(VECTORS_DB);
  try {
    const max = db.prepare("SELECT max(id) m FROM embeddings").get()?.m ?? 0;
    if (vectorsMaxId !== null && max > vectorsMaxId) {
      const rows = db.prepare("SELECT id, embedding_id FROM embeddings WHERE id > ? ORDER BY id LIMIT 20").all(vectorsMaxId);
      const metaStmt = db.prepare("SELECT key, string_value FROM embedding_metadata WHERE id = ?");
      for (const r of rows) {
        const meta = Object.fromEntries(metaStmt.all(r.id).map((m) => [m.key, m.string_value]));
        emit({ type: "event", src: "kg", ts: Date.now(), ...recordShape(meta, r.embedding_id) });
      }
    }
    vectorsMaxId = max;
  } finally { db.close(); }
}

/* ---------------- notes tree (*.md) ---------------- */
const noteMtimes = new Map(); // file -> mtimeMs
let notesBaselined = false;

function readNote(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    return txt.length > 6000 ? txt.slice(0, 6000) + "\n\n… (truncated)" : txt;
  } catch { return "(could not read file)"; }
}

function scanNotes(dir, depth = 0) {
  if (depth > 5) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name.startsWith(".") || it.name === "node_modules" || NOTES_SKIP.has(it.name)) continue;
    const abs = path.join(dir, it.name);
    if (it.isDirectory()) scanNotes(abs, depth + 1);
    else if (it.name.endsWith(".md")) {
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const prev = noteMtimes.get(abs);
      if (prev !== undefined && st.mtimeMs > prev && notesBaselined) {
        emit({ type: "event", src: "notes", kind: "note_edit", title: "note updated", body: rel(abs), full: readNote(abs), ts: Date.now() });
      }
      noteMtimes.set(abs, st.mtimeMs);
    }
  }
}

function pollNotes() { if (!NOTES_DIR) return; scanNotes(NOTES_DIR); notesBaselined = true; }

/* ---------------- git repos under the configured dir ---------------- */
const repoHeads = new Map(); // repoDir -> head hash
let repoList = [];
let repoBaselined = false;

function findRepos() {
  if (!PROJECTS_DIR) return;
  let items;
  try { items = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  repoList = items
    .filter((it) => it.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, it.name, ".git")))
    .map((it) => path.join(PROJECTS_DIR, it.name));
}

function headOf(repo) {
  try {
    const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const refPath = path.join(repo, ".git", head.slice(5).trim().split("/").join(path.sep));
    if (fs.existsSync(refPath)) return fs.readFileSync(refPath, "utf8").trim();
    const packed = path.join(repo, ".git", "packed-refs");
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(head.slice(5).trim()));
      if (line) return line.split(" ")[0];
    }
  } catch { /* ignore */ }
  return null;
}

function pollGit() {
  for (const repo of repoList) {
    const h = headOf(repo);
    if (!h) continue;
    const prev = repoHeads.get(repo);
    repoHeads.set(repo, h);
    if (prev && prev !== h && repoBaselined) {
      execFile("git", ["-C", repo, "log", "--format=%h %s", `${prev}..${h}`, "-n", "5"], { timeout: 8000 }, (err, out) => {
        const name = path.basename(repo);
        const lines = err || !out.trim() ? ["(new head)"] : out.trim().split("\n");
        for (const l of lines.reverse()) {
          emit({ type: "event", src: "code", kind: "commit", title: `commit · ${name}`, body: l, ts: Date.now() });
        }
      });
    }
  }
  repoBaselined = true;
}

/* ---------------- startup backfill: show the EXISTING world, not just deltas ---------------- */
function backfill() {
  const items = [];
  // recent vector-store records
  if (VECTORS_DB && fs.existsSync(VECTORS_DB)) {
    const db = openRO(VECTORS_DB);
    try {
      const rows = db.prepare("SELECT id, embedding_id, created_at FROM embeddings ORDER BY id DESC LIMIT 12").all();
      const metaStmt = db.prepare("SELECT key, string_value FROM embedding_metadata WHERE id = ?");
      for (const r of rows) {
        const meta = Object.fromEntries(metaStmt.all(r.id).map((m) => [m.key, m.string_value]));
        items.push({ src: "kg", ts: Date.parse(r.created_at + "Z") || Date.now(), ...recordShape(meta, r.embedding_id) });
      }
    } finally { db.close(); }
  }
  // recent garden plantings
  for (const file of gardenDbs()) {
    let db;
    try { db = openRO(file); } catch { continue; }
    try {
      const g = path.basename(file, ".db");
      for (const r of db.prepare("SELECT id, type, title, content, stage, created_at FROM nodes WHERE pruned_at IS NULL ORDER BY created_at DESC LIMIT 8").all()) {
        items.push({ src: "kg", ts: Number(r.created_at), ...gardenEvent(r, g) });
      }
    } finally { db.close(); }
  }
  // recent cache writes
  if (fs.existsSync(CACHE_DB)) {
    const db = openRO(CACHE_DB);
    try {
      for (const r of db.prepare("SELECT namespace, key, content_type, size, created_at FROM entries ORDER BY created_at DESC LIMIT 6").all()) {
        items.push({ src: "cache", kind: "cache_write", title: `cache · ${r.namespace}`,
          body: `${r.key} (${r.content_type}, ${r.size} B)`, ts: Number(r.created_at) });
      }
    } finally { db.close(); }
  }
  // recent KG facts
  if (KG_DB && fs.existsSync(KG_DB)) {
    const db = openRO(KG_DB);
    try {
      for (const r of db.prepare("SELECT subject, predicate, object, extracted_at FROM triples ORDER BY extracted_at DESC LIMIT 8").all()) {
        items.push({ src: "kg", kind: "kg_fact", title: "KG fact",
          body: `${r.subject} — ${r.predicate} — ${String(r.object).slice(0, 160)}`,
          ts: Date.parse(r.extracted_at + "Z") || Date.now() });
      }
    } finally { db.close(); }
  }
  // most recently edited notes
  items.push(...[...noteMtimes.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([f, mt]) => ({ src: "notes", kind: "note_edit", title: "note", body: rel(f), full: readNote(f), ts: mt })));
  // recent clips
  if (fs.existsSync(CLIP_DB)) {
    const db = openRO(CLIP_DB);
    try {
      for (const r of db.prepare("SELECT * FROM entries ORDER BY created_at DESC LIMIT 10").all()) {
        items.push({ src: "clipboard",
          kind: r.snippet_name ? "snippet_saved" : r.channel ? "channel_send" : "clip",
          title: r.label ?? r.snippet_name ?? (r.channel ? `#${r.channel}` : "clip"),
          body: String(r.content ?? "").slice(0, 200), full: String(r.content ?? "").slice(0, 4000),
          source: r.source, channel: r.channel, ts: Number(r.created_at) });
      }
    } finally { db.close(); }
  }
  items.sort((a, b) => a.ts - b.ts); // oldest first; renderer prepends → newest on top
  for (const it of items) emit({ type: "event", backfill: true, ...it });
}

/* ---------------- projects panel: every repo + its latest commit ---------------- */
function emitProjects() {
  let pending = repoList.length;
  const projects = [];
  if (!pending) return;
  for (const repo of repoList) {
    execFile("git", ["-C", repo, "log", "-1", "--format=%ct\t%h\t%s"], { timeout: 8000 }, (err, out) => {
      if (!err && out.trim()) {
        const [ct, h, s] = out.trim().split("\t");
        projects.push({ name: path.basename(repo), lastTs: Number(ct) * 1000, hash: h, msg: s });
      } else {
        projects.push({ name: path.basename(repo), lastTs: 0, hash: null, msg: null });
      }
      if (--pending === 0) {
        projects.sort((a, b) => b.lastTs - a.lastTs);
        emit({ type: "projects", projects });
      }
    });
  }
}

/* ---------------- loop ---------------- */
function safe(fn) { try { fn(); } catch (e) { emit({ type: "warn", src: "watcher", body: String(e.message) }); } }

findRepos();
safe(pollClipboard); safe(pollCache); safe(pollGarden); safe(pollKg); safe(pollVectors); safe(pollNotes); safe(pollGit);
safe(backfill); safe(emitProjects);
const activeSources = ["clipboard", "cache", "kg", ...(NOTES_DIR ? ["notes"] : []), ...(PROJECTS_DIR ? ["code"] : [])];
emit({ type: "ready", sources: activeSources, startedAt });
setInterval(() => safe(emitProjects), 60000);

setInterval(() => safe(pollClipboard), 1000);
setInterval(() => { safe(pollCache); safe(pollGarden); safe(pollKg); safe(pollVectors); }, 2000);
setInterval(() => safe(pollNotes), 2500);
setInterval(() => safe(pollGit), 5000);
setInterval(findRepos, 60000);
