/**
 * prime:continual-harness — scoped, ranked, compaction-surviving refinement memory.
 *
 * Scope layers:
 *   session   — this session only (the default)
 *   workspace — every session sharing this cwd
 *
 * Entries live on disk, so they outlive compaction by construction. The section
 * is re-rendered on every prompt assembly, and ranking is query-driven from the
 * live message list (mirrors prime-agent harness_digest.rs weights).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export const name = "prime-memory";
/* cordis Inject.resolve has no required/optional concept: an OBJECT inject is a
 * name->config map, so {required, optional} waits forever on services literally
 * named "required"/"optional". Only hard deps belong here; optional services are
 * read defensively through ctx.get() at their use sites. */
/* `webServer` is declared, not probed: cordis hands a plugin its services
 * through `inject`, and `ctx.get("webServer")` returns undefined for anything
 * this list does not name — an EMPTY resolved service table was measured during
 * boot, and the route below silently never mounted. The shipped
 * `dsh-host-frontend-static` names its services the same way. */
export const inject = ["commands", "webServer"];

export const MAX_ENTRIES = 200;
export const MAX_SNAPSHOTS = 25;
export const SECTION_ORDER = 9500;
export const SECTION_NAME = "prime:continual-harness";
/* The section is never empty: an empty harness is exactly when the capture
 * instruction matters most, so it ships on every turn the mode is active.
 * It is registered from the preset half, not here, so modes that have no
 * `harness_refine` tool never see an instruction naming one. */
/* Two jobs, and the first one is the one that gets forgotten. A harness that only
 * explains how to RECORD reads as a notebook: a session observed the answer sitting
 * in this section and went to grep the repository anyway, because nothing told it
 * the entries were settled. The trust clause has to come first, and it has to say
 * what to do with a hit, not merely that the entries exist. */
const HARNESS_INSTRUCTION = [
  "These are established facts recorded earlier in this work. Treat them as already verified: when one answers the operator's question, answer from it rather than re-deriving the answer from the code.",
  "Read the source only when nothing here covers the question, or when the code may have changed since the fact was recorded.",
  "Each line starts with its 8-character ref and optional [kind:name] tag: `memory` (default) is a verified fact, `[prompt]` is a standing behavioral rule you must obey on every turn, `[skill:name]` is a reusable workflow registered in the skill catalog, and `[subagent:name]` is a specialist role spec you can spawn with `rlm.spawn(task, role='name')` or apply when delegating.",
  "When an entry is wrong or no longer holds, UPDATE it by that ref or DELETE it — never record a second entry beside it. Two entries that disagree are worse than one that is stale.",
  "Record durable facts with `harness_refine` in the same turn the operator states them — a preference, a correction, a constraint, a reusable tactic. Do not wait for `/refine` or for compaction: what stays only in the conversation is lost when the history is condensed.",
  /* The model does not choose a layer. It guessed badly when it did — a real
   * session split one sentence across both layers — and the choice belongs to the
   * operator anyway, who can see which memory they are looking at. */
  "You do not choose where a fact is stored; the operator does, and the line below says which layer is currently selected. You always READ both layers. You only WRITE to the selected one.",
  "Your primary programmatic execution and orchestration environment is `python_repl` (a persistent per-session Python 3 RLM kernel). Prefer `python_repl` for multi-step inspection, programmatic tool calling (`await tools.<name>(**kwargs)`), context-as-a-variable (`ctx`, `messages`, `store`), and subagent/harness orchestration (`await rlm(task, name=..., role=...)`, `rlm.spawn`, `rlm.list_subagents`, `agent_message.send`, `rlm.harness`)."
].join(" ");
const TOP_K = 12;
const CHAR_BUDGET = 4000;
const API_PATH = "/prime/api";
/* prime-agent AutoRefineGates: compact: true, cooldown 20 min. */
const COOLDOWN_MS = 20 * 60 * 1000;
/* Two scopes only. `global` was dropped: a machine-wide layer shares one
 * bucket between every repository on the box, and the operator's own words for
 * the middle layer are "workspace", not "project". `workspace` means every
 * session whose cwd is this directory — the same footing the term has in the
 * rest of the harness. */
export const SCOPES = ["session", "workspace"];
export const KINDS = ["memory", "prompt", "skill", "subagent"];
/* The middle scope's on-disk key still says `project-`. Renaming it would orphan
 * every existing `project-<sha1(cwd)>.json` file instead of reading it, which is
 * a worse trade than a filename that lags its label. */
const LEGACY_SCOPE_PREFIX = "project-";
/* The model records through this tool and never through the slash command:
 * only the operator can run a command, so the prompt and the tool must agree
 * on one name. Declared here because this module owns the shared surface. */
export const TOOL_NAME = "harness_refine";
export const REPL_TOOL_NAME = "python_repl";
/* The preset this plugin's agent-facing half is mounted in. The auto-refine hook
 * must name it: the root plane sees every session in the process, so without
 * this the hook would inject a refinement turn into `standard`, `ptc`, and every
 * other mode — modes that have no harness and no `harness_refine` tool. */
export const PRESET_ID = "prime";
/* Key of the registry's own preset projection; the same string
 * `@deepseek-ai/dsh-agent-preset-registry` writes on `agent-preset/selected`. */
const PRESET_PROJECTION = "agentPreset";
/* Accepted on input so a habit or an old note does not become a hard error:
 * `project` still resolves to `workspace`, and `global` is named explicitly so
 * the refusal can say the layer was removed rather than that it was mistyped. */
const SCOPE_ALIASES = { project: "workspace", workspace: "workspace", session: "session", global: "global" };

/* ---------- paths ---------- */

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
function rootDir() {
  return path.join(homeDir(), "prime");
}
function sessionCwd(agent) {
  /* cwd is the storage-backend key for the workspace layer; absolute by contract. */
  try {
    const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return path.resolve(cwd);
  } catch { /* header unavailable */ }
  return process.cwd();
}
/**
 * The session whose harness this agent reads and writes.
 *
 * Normally the agent's own session. A delegated child is different: it is a
 * fork of its parent, spawned to run one refinement pass, and its own session id
 * is a throwaway nobody reads. Resolving to that id made every finding a child
 * wrote land in a file the parent never opens — a silent loss rather than an
 * error, because the write itself succeeds.
 *
 * The child's session header already records `parentSession` (set by the
 * subagent runtime when it seeds the child), so this needs no plugin-side
 * bookkeeping and no model cooperation.
 * @param agent - live agent, possibly a delegated child.
 * @returns the durable session id whose store this agent owns.
 */
export function storeSessionId(agent) {
  try {
    const header = agent && agent.session && agent.session.header;
    /* Only one level: a pass runs one delegation deep, and following a chain
     * further would silently attribute a grandchild's writes to its grandparent. */
    if (header && typeof header.parentSession === "string" && header.parentSession) return header.parentSession;
    if (agent && agent.session && typeof agent.session.id === "string") return agent.session.id;
  } catch { /* no session */ }
  return undefined;
}
function scopeKey(scope, agent) {
  if (scope === "workspace") {
    return LEGACY_SCOPE_PREFIX + crypto.createHash("sha1").update(sessionCwd(agent)).digest("hex").slice(0, 16);
  }
  const id = storeSessionId(agent) || "default";
  return "session-" + id.replace(/[^\w.-]/g, "_").slice(0, 80);
}
function scopeFile(scope, agent) {
  return path.join(rootDir(), scopeKey(scope, agent) + ".json");
}
function replStoreFile(agent) {
  return path.join(rootDir(), "repl-" + scopeKey("session", agent) + ".json");
}
function configFile() {
  return path.join(rootDir(), "config.json");
}

/* ---------- io ---------- */

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + crypto.randomUUID().slice(0, 8) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
export function loadConfig() {
  const cfg = readJson(configFile(), {});
  const def = SCOPES.includes(cfg.defaultScope) ? cfg.defaultScope : "session";
  return {
    defaultScope: def,
    autoRefineOnCompact: cfg.autoRefineOnCompact !== false,
    topK: Number.isInteger(cfg.topK) && cfg.topK > 0 ? Math.min(cfg.topK, 50) : TOP_K,
  };
}
export function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  if (!SCOPES.includes(next.defaultScope)) next.defaultScope = "session";
  writeJson(configFile(), next);
  return next;
}
const cloneEntries = (arr) => (Array.isArray(arr) ? arr : []).map((e) => Object.assign({}, e));
function readScopeDoc(scope, agent) {
  const resolved = normalizeScope(scope, "session");
  const doc = readJson(scopeFile(resolved, agent), { entries: [], snapshots: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.text === "string") : [];
  const snapshots = Array.isArray(doc.snapshots) ? doc.snapshots.filter((s) => s && typeof s.id === "string" && Array.isArray(s.before)) : [];
  return { resolved, entries, snapshots };
}
export function load(scope, agent) { return readScopeDoc(scope, agent).entries; }
export function loadSnapshots(scope, agent) { return readScopeDoc(scope, agent).snapshots; }
export function save(scope, agent, entries, snapshotMeta) {
  const { resolved, snapshots } = readScopeDoc(scope, agent);
  const next = snapshots.slice();
  if (snapshotMeta && Array.isArray(snapshotMeta.before)) {
    const id = snapshotMeta.id || crypto.randomUUID();
    next.push({
      id, ref: String(id).slice(0, REF_LENGTH), createdAt: snapshotMeta.createdAt || Date.now(),
      reason: String(snapshotMeta.reason || "update"), beforeCount: snapshotMeta.before.length,
      afterCount: Array.isArray(entries) ? entries.length : 0,
      diff: snapshotMeta.diff || computeDiffCounts(snapshotMeta.before, entries),
      before: cloneEntries(snapshotMeta.before), after: cloneEntries(entries),
    });
    while (next.length > MAX_SNAPSHOTS) next.shift();
  }
  const cwdMeta = resolved === "workspace" ? sessionCwd(agent) : undefined;
  writeJson(scopeFile(resolved, agent), {
    version: 3,
    scope: resolved,
    ...(cwdMeta ? { cwd: cwdMeta } : {}),
    entries,
    snapshots: next,
  });
  if (skillsInvalidator) { try { skillsInvalidator(); } catch {} }
}
let skillsInvalidator = null;
export function registerSkillsInvalidator(fn) { skillsInvalidator = typeof fn === "function" ? fn : null; }

/* ---------- which session is the operator in? ---------- */

/**
 * Last activity per session. The settings page is GLOBAL while every store below
 * `session` is keyed by a session or a folder, so the page has to be told which
 * one it is looking at. It cannot see the chat, and the host process cwd is the
 * application's launch directory — so a panel that resolved either scope from it
 * read an unrelated file and reported an empty harness.
 * @type {Map<string, {id: string, cwd: string, at: number}>}
 */
const lastActive = new Map();
/* Bound the map: one entry per session opened in this process, oldest evicted. */
const MAX_TRACKED_SESSIONS = 128;

/**
 * Record that a session was just active.
 * @param session - the session object a `session/event` carried.
 */
export function rememberSession(session) {
  try {
    if (!session || typeof session.id !== "string") return;
    lastActive.delete(session.id);
    lastActive.set(session.id, { id: session.id, cwd: sessionCwd({ session }), at: Date.now() });
    while (lastActive.size > MAX_TRACKED_SESSIONS) {
      lastActive.delete(lastActive.keys().next().value);
    }
  } catch { /* a session without a header is not worth tracking */ }
}

/**
 * The session the operator is most likely looking at: most recently active, else
 * the newest live top-level agent on a cold boot where no event has fired yet.
 * @param ctx - plugin context, used to reach the agent registry.
 * @returns `{ id, cwd }`, or null when the harness has no session at all.
 */
export function resolveActiveSession(ctx) {
  /* `rememberSession` re-inserts on every event, so the map is ordered by how
   * recently each session was touched and the last entry is the current one. The
   * comparison uses `>=` for that reason: two events landing in the same
   * millisecond must still resolve to the later one, and a clock tie is otherwise
   * a coin flip. */
  let newest = null;
  for (const record of lastActive.values()) {
    if (newest === null || record.at >= newest.at) newest = record;
  }
  if (newest !== null) return { id: newest.id, cwd: newest.cwd };
  try {
    const agents = ctx && ctx.get ? ctx.get("agents") : null;
    if (!agents || typeof agents.roots !== "function") return null;
    let best = null;
    for (const agent of agents.roots()) {
      const session = agent && agent.session;
      if (!session || typeof session.id !== "string") continue;
      const createdAt = (session.header && session.header.createdAt) || 0;
      if (best === null || createdAt > best.createdAt) best = { id: session.id, cwd: sessionCwd(agent), createdAt };
    }
    return best === null ? null : { id: best.id, cwd: best.cwd };
  } catch { return null; }
}

/**
 * Resolve any scope spelling to a live layer.
 * @param scope - a scope name, including a retired one.
 * @param fallback - value for an unknown name.
 * @returns a member of {@link SCOPES}.
 */
export function normalizeScope(scope, fallback) {
  const named = SCOPE_ALIASES[String(scope || "").toLowerCase()];
  return SCOPES.includes(named) ? named : fallback;
}
export function normalizeKind(kind, fallback = "memory") {
  const k = String(kind || "").trim().toLowerCase();
  return KINDS.includes(k) ? k : fallback;
}

/* ---------- ranking (prime harness_digest.rs parity) ---------- */

const STOP = new Set(["the","and","for","with","that","this","from","you","are","was","have","has","not","but","all","can","will","into","your","our","its","they","them","then","than","when","what","which","there","here","how","why","who","use","用","的","了","和","是","在","我","你","他","这","那","就","都","也"]);

function terms(text, out) {
  if (out.length >= 48) return;
  const found = String(text || "").toLowerCase().match(/[a-z0-9_+-]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
  for (const t of found) {
    if (out.length >= 48) break;
    if (!STOP.has(t)) out.push(t);
  }
}

function messageText(msg) {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** Live messages for this agent, newest last. deriveMessages() already drops compacted history. */
function liveMessages(agent) {
  try {
    const session = agent && agent.session;
    if (session && typeof session.deriveMessages === "function") return session.deriveMessages() || [];
  } catch { /* session gone */ }
  return [];
}

/* The goals service, when mounted; prime weights the goal objective highest. */
let goalsApi = null;

/* The message kinds that carry the operator's or the model's own words.
 * Everything else in the feed is injected context — runtime policy, the skill
 * catalog, the time snapshot, plugin bootstraps — and it is enormous. A session
 * had all four land in the last-4 window at once, which pushed the operator's
 * actual question out of it and demoted the entry that answered it to fifth of
 * seven, behind Tuxler notes that shared no subject with the question. */
const SPEAKER_KINDS = new Set(["user", "model"]);

/**
 * Whether a message carries words a human or the model actually wrote.
 * @param msg - one live message.
 * @returns true for operator/model turns and for frames with no provenance.
 */
function isSpeaker(msg) {
  const source = msg && msg.source;
  /* Absent provenance is an older or synthetic frame; treating it as the
   * operator's keeps the function total rather than silently going blind. */
  if (!source || typeof source.kind !== "string") return true;
  return SPEAKER_KINDS.has(source.kind);
}

/** Query weights: goal objective 3.0, then last 4 operator/model texts 2.0/1.5/1.0/1.0. */
function queryTerms(agent, extra) {
  const weighted = [];
  try {
    const objective = goalsApi && agent ? goalsApi.get(agent)?.objective : null;
    if (typeof objective === "string" && objective.trim()) weighted.push([objective, 3]);
  } catch { /* no goal for this agent */ }
  /* Filter BEFORE the window, or injected context consumes it. */
  const recent = liveMessages(agent)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && isSpeaker(m))
    .slice(-4)
    .reverse();
  const weights = [2, 1.5, 1, 1];
  recent.forEach((m, i) => weighted.push([messageText(m), weights[i]]));
  if (extra) weighted.push([extra, 2.5]);
  const out = [];
  const seen = new Set();
  for (const [text, weight] of weighted) {
    const bucket = [];
    terms(text, bucket);
    for (const t of bucket) {
      const prev = seen.has(t) ? out.find((x) => x.term === t) : null;
      if (prev) { prev.weight = Math.max(prev.weight, weight); continue; }
      if (out.length >= 48) break;
      const rec = { term: t, weight };
      out.push(rec);
      seen.add(t);
    }
  }
  return out;
}

export function rank(entries, agent, extra) {
  const q = queryTerms(agent, extra);
  if (q.length === 0) {
    return entries.slice().sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (b.createdAt - a.createdAt));
  }
  const scored = entries.map((e) => {
    const hay = (String(e.name || "") + " " + String(e.text || "")).toLowerCase();
    let score = 0;
    for (const { term, weight } of q) if (hay.includes(term)) score += weight;
    if (e.pinned) score += 100;
    return { entry: e, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.entry.createdAt - a.entry.createdAt));
  return scored.map((s) => s.entry);
}

/**
 * Order entries for the prompt: pinned first, then newest first.
 *
 * Deliberately NOT query-ranked. `rank` reorders as the conversation moves,
 * which rewrites the section — and a system prompt that changes invalidates the
 * whole request prefix, so every turn reprocesses the entire transcript instead
 * of extending a cached prefix. Measured: a one-turn session composed two
 * different prompts because the order shifted between steps. Recency is stable,
 * and when the budget or `topK` has to cut, it keeps the entries most likely to
 * still be true.
 *
 * `rank` still drives `/refine --list`, where re-ordering is free.
 * @param entries - the harness entries.
 * @returns a new array in prompt order.
 */
export function promptOrder(entries) {
  return entries.slice().sort((a, b) =>
    (Number(!!b.pinned) - Number(!!a.pinned)) ||
    (Number((b && b.kind) === "prompt") - Number((a && a.kind) === "prompt")) ||
    (b.createdAt - a.createdAt));
}

/** @returns `YYYY-MM-DD` for an entry timestamp, or empty when unusable. */
function entryDate(createdAt) {
  const at = Number(createdAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  try { return new Date(at).toISOString().slice(0, 10); } catch { return ""; }
}

/* What the operator's selection means, in the model's terms. */
const SCOPE_OUTCOME = {
  session: "this conversation only — a new chat will not see it",
  workspace: "this workspace — every chat in this folder sees it",
};

function formatEntryTag(e) {
  const kind = e && e.kind && e.kind !== "memory" ? e.kind : "";
  const n = e && e.name ? String(e.name).trim() : "";
  return !kind && !n ? "" : "[" + (kind && n ? kind + ":" + n : kind || n) + "] ";
}
export function render(entries, agent, extra) {
  const cfg = loadConfig();
  const target = "New entries are saved to the " + cfg.defaultScope + " layer (" +
    (SCOPE_OUTCOME[cfg.defaultScope] || SCOPE_OUTCOME.session) + ").";
  const out = ["## Continual harness (prime)", "", HARNESS_INSTRUCTION, target];
  const picked = promptOrder(entries).slice(0, cfg.topK).filter((e) => e && e.text);
  let used = 0;
  const lines = [];
  for (const e of picked) {
    /* The date is what makes "may have changed since" actionable: the trust
     * clause asks the model to judge staleness, and without a date it can only
     * guess. */
    const date = entryDate(e.createdAt);
    /* The ref rides every line so a wrong entry can be named and fixed in the
     * same pass that notices it. Without it the model can only append a
     * correction beside the mistake — which is how contradictions accumulate. */
    const ref = entryRef(e);
    const line = "- " + (ref ? ref + " " : "") + (date ? "[" + date + "] " : "") + formatEntryTag(e) + e.text;
    if (used + line.length > CHAR_BUDGET) break;
    used += line.length;
    lines.push(line);
  }
  /* "Recorded:" reads as a log of what happened; these are the settled answers
   * the instruction above tells the model to rely on. The label has to agree with
   * that instruction, or the section contradicts itself. */
  if (lines.length > 0) out.push("", "Established:", ...lines);
  return out.join("\n");
}

/* ---------- writes ---------- */

function computeDiffCounts(before, after) {
  const bMap = new Map((before || []).map((e) => [e.id, e]));
  const aMap = new Map((after || []).map((e) => [e.id, e]));
  let added = 0, updated = 0, deleted = 0;
  for (const [id, entry] of aMap) {
    const p = bMap.get(id);
    if (!p) added++;
    else if (p.text !== entry.text || p.kind !== entry.kind || p.name !== entry.name || !!p.pinned !== !!entry.pinned) updated++;
  }
  for (const id of bMap.keys()) if (!aMap.has(id)) deleted++;
  return { added, updated, deleted };
}
export function upsert(scope, agent, text, origin, evidence, opts) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "empty refinement" };
  const entries = load(scope, agent);
  const before = cloneEntries(entries);
  if (entries.some((e) => e.text === trimmed)) return { ok: false, error: "already recorded" };
  if (entries.length >= MAX_ENTRIES) return { ok: false, error: "harness full (" + MAX_ENTRIES + "); run /refine --clear" };
  const now = Date.now();
  const kind = normalizeKind(opts && opts.kind, "memory");
  const entryName = opts && typeof opts.name === "string" && opts.name.trim() ? opts.name.trim() : undefined;
  const created = {
    id: crypto.randomUUID(), text: trimmed, createdAt: now, updatedAt: now, origin: origin || "command",
    ...(kind !== "memory" ? { kind } : {}), ...(entryName ? { name: entryName } : {}),
    ...(opts && opts.pinned ? { pinned: true } : {}), ...(evidence ? { evidence: String(evidence).trim() } : {}),
  };
  entries.push(created);
  save(scope, agent, entries, (opts && opts.skipSnapshot) ? undefined : { reason: (origin || "command") + ":add", before, diff: { added: 1, updated: 0, deleted: 0 } });
  return { ok: true, count: entries.length, scope: normalizeScope(scope, "session"), ref: entryRef(created), entry: created };
}

/* The handle a reader uses to name one entry. Eight characters of a UUID are
 * enough to be unambiguous in a store capped at MAX_ENTRIES and short enough to
 * carry on every rendered line without eating the prompt. */
export const REF_LENGTH = 8;

/**
 * Both layers, each entry tagged with the layer it lives in.
 *
 * The section must show both. Rendering only the configured default meant a fact
 * the agent recorded at workspace scope was written and then never displayed
 * while the default stayed on session — recorded and invisible, which reads to
 * the operator as the memory simply not working. prime-agent merges global and
 * local for the same reason.
 * @param agent - the session whose cwd/id keys the layers.
 * @returns entries from every layer, tagged with their scope.
 */
export function loadAll(agent) {
  const out = [];
  for (const scope of SCOPES) {
    for (const entry of load(scope, agent)) out.push(Object.assign({}, entry, { scope }));
  }
  return out;
}

/**
 * Locate the layer holding a ref, preferring the requested one.
 *
 * A ref is unique across layers, so an edit should not fail because the caller
 * guessed the wrong layer. Guessing wrong is a mistake the model cannot see: the
 * rendered section does not say which layer a line came from.
 * @param agent - the session whose cwd/id keys the layers.
 * @param preferred - the layer the caller asked for.
 * @param ref - the entry handle.
 * @returns `{ ok: true, scope, entry }` or `{ ok: false, error }`.
 */
export function locateEntry(agent, preferred, ref) {
  const first = normalizeScope(preferred, "session");
  const order = [first, ...SCOPES.filter((s) => s !== first)];
  let ambiguous = null;
  for (const scope of order) {
    const found = findEntry(load(scope, agent), ref);
    if (found.ok) return { ok: true, scope, entry: found.entry };
    if (/matches \d+ entries/.test(String(found.error))) ambiguous = found.error;
  }
  if (ambiguous) return { ok: false, error: ambiguous };
  return { ok: false, error: "no entry with ref " + String(ref || "").trim() };
}

/**
 * The short handle for one entry.
 * @param entry - a stored entry.
 * @returns its first {@link REF_LENGTH} id characters.
 */
export function entryRef(entry) {
  return String((entry && entry.id) || "").slice(0, REF_LENGTH);
}

/**
 * Find one entry by handle.
 *
 * Accepts the short ref the prompt renders or the full id, so a caller that
 * pasted either works. A ref matching two entries is an error naming the count
 * rather than a silent pick: guessing here would edit the wrong memory.
 * @param entries - the entries to search.
 * @param ref - a ref or full id.
 * @returns `{ ok: true, entry }` or `{ ok: false, error }`.
 */
export function findEntry(entries, ref) {
  const wanted = String(ref || "").trim().toLowerCase();
  if (!wanted) return { ok: false, error: "no ref given" };
  const exact = entries.filter((e) => String(e.id).toLowerCase() === wanted);
  if (exact.length === 1) return { ok: true, entry: exact[0] };
  const prefixed = entries.filter((e) => String(e.id).toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return { ok: true, entry: prefixed[0] };
  if (prefixed.length > 1) {
    return { ok: false, error: "ref " + wanted + " matches " + prefixed.length + " entries; use more characters" };
  }
  return { ok: false, error: "no entry with ref " + wanted };
}

/**
 * Rewrite one entry in place.
 *
 * The id and creation time survive, so an update corrects the memory instead of
 * adding a second one beside it — which is exactly how a store ends up holding
 * two entries that contradict each other.
 * @param scope - the harness layer.
 * @param agent - the session whose cwd/id keys that layer.
 * @param ref - the entry handle.
 * @param text - the corrected text.
 * @param evidence - what prompted the correction.
 * @returns `{ ok, error? }`.
 */
export function updateEntry(scope, agent, ref, text, evidence, opts) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "empty replacement text" };
  const located = locateEntry(agent, scope, ref);
  if (!located.ok) return located;
  const entries = load(located.scope, agent);
  const before = cloneEntries(entries);
  const found = findEntry(entries, ref);
  if (!found.ok) return found;
  if (entries.some((e) => e !== found.entry && e.text === trimmed)) return { ok: false, error: "another entry already says that" };
  found.entry.text = trimmed;
  found.entry.updatedAt = Date.now();
  if (evidence) found.entry.evidence = String(evidence).trim();
  if (opts && opts.kind !== undefined) {
    const k = normalizeKind(opts.kind, "memory");
    if (k === "memory") delete found.entry.kind; else found.entry.kind = k;
  }
  if (opts && opts.name !== undefined) {
    const n = String(opts.name || "").trim();
    if (n) found.entry.name = n; else delete found.entry.name;
  }
  if (opts && typeof opts.pinned === "boolean") {
    if (opts.pinned) found.entry.pinned = true; else delete found.entry.pinned;
  }
  save(located.scope, agent, entries, (opts && opts.skipSnapshot) ? undefined : { reason: "update:" + entryRef(found.entry), before, diff: { added: 0, updated: 1, deleted: 0 } });
  return { ok: true, count: entries.length, scope: located.scope, ref: entryRef(found.entry), entry: found.entry };
}
export function pinEntry(scope, agent, ref, pinned = true, opts) {
  const located = locateEntry(agent, scope, ref);
  if (!located.ok) return located;
  const entries = load(located.scope, agent);
  const before = cloneEntries(entries);
  const found = findEntry(entries, ref);
  if (!found.ok) return found;
  if (pinned) found.entry.pinned = true; else delete found.entry.pinned;
  found.entry.updatedAt = Date.now();
  save(located.scope, agent, entries, (opts && opts.skipSnapshot) ? undefined : { reason: (pinned ? "pin:" : "unpin:") + entryRef(found.entry), before, diff: { added: 0, updated: 1, deleted: 0 } });
  return { ok: true, count: entries.length, scope: located.scope, ref: entryRef(found.entry), pinned: !!found.entry.pinned, entry: found.entry };
}

/**
 * Delete one entry.
 * @param scope - the harness layer.
 * @param agent - the session whose cwd/id keys that layer.
 * @param ref - the entry handle.
 * @returns `{ ok, error? }`.
 */
export function removeEntry(scope, agent, ref, opts) {
  const located = locateEntry(agent, scope, ref);
  if (!located.ok) return located;
  const entries = load(located.scope, agent);
  const before = cloneEntries(entries);
  const found = findEntry(entries, ref);
  if (!found.ok) return found;
  const kept = entries.filter((e) => e !== found.entry);
  save(located.scope, agent, kept, (opts && opts.skipSnapshot) ? undefined : { reason: "delete:" + entryRef(found.entry), before, diff: { added: 0, updated: 0, deleted: 1 } });
  return { ok: true, count: kept.length, scope: located.scope, ref: entryRef(found.entry) };
}
export function recordPassSnapshot(scope, agent, beforeEntries, reason) {
  const current = load(scope, agent);
  const diff = computeDiffCounts(beforeEntries, current);
  if (!diff.added && !diff.updated && !diff.deleted) return null;
  save(scope, agent, current, { reason: reason || ("pass (+" + diff.added + " ~" + diff.updated + " -" + diff.deleted + ")"), before: beforeEntries, diff });
  return loadSnapshots(scope, agent).at(-1) || null;
}
export function findSnapshot(snapshots, ref) {
  if (!Array.isArray(snapshots) || !snapshots.length) return { ok: false, error: "no snapshots recorded yet" };
  const w = String(ref || "").trim().toLowerCase();
  if (!w) return { ok: true, snapshot: snapshots[snapshots.length - 1] };
  const exact = snapshots.filter((s) => String(s.id).toLowerCase() === w || String(s.ref || "").toLowerCase() === w);
  if (exact.length === 1) return { ok: true, snapshot: exact[0] };
  const pref = snapshots.filter((s) => String(s.id).toLowerCase().startsWith(w));
  if (pref.length === 1) return { ok: true, snapshot: pref[0] };
  return { ok: false, error: pref.length > 1 ? "snapshot ref " + w + " matches " + pref.length + " snapshots" : "no snapshot with ref " + w };
}
export function rollbackSnapshot(scope, agent, snapshotRef) {
  const resolved = normalizeScope(scope, "session");
  const { entries, snapshots } = readScopeDoc(resolved, agent);
  const found = findSnapshot(snapshots, snapshotRef);
  if (!found.ok) return found;
  const restored = cloneEntries(found.snapshot.before);
  const ref = entryRef(found.snapshot);
  save(resolved, agent, restored, { reason: "rollback:" + ref, before: entries, diff: computeDiffCounts(entries, restored) });
  return { ok: true, scope: resolved, ref, restoredCount: restored.length, previousCount: entries.length, entries: restored };
}
export function diffSnapshot(scope, agent, snapshotRef) {
  const resolved = normalizeScope(scope, "session");
  const found = findSnapshot(readScopeDoc(resolved, agent).snapshots, snapshotRef);
  if (!found.ok) return found;
  const snap = found.snapshot;
  const before = snap.before || [], after = snap.after || load(resolved, agent);
  const bMap = new Map(before.map((e) => [e.id, e])), aMap = new Map(after.map((e) => [e.id, e]));
  const lines = [];
  for (const [id, e] of aMap) {
    const p = bMap.get(id);
    if (!p) lines.push("+ " + entryRef(e) + " " + formatEntryTag(e) + e.text);
    else if (p.text !== e.text || p.kind !== e.kind || p.name !== e.name || !!p.pinned !== !!e.pinned) {
      lines.push("~ " + entryRef(e) + " before: " + p.text, "  " + entryRef(e) + " after:  " + formatEntryTag(e) + e.text);
    }
  }
  for (const [id, p] of bMap) if (!aMap.has(id)) lines.push("- " + entryRef(p) + " " + formatEntryTag(p) + p.text);
  return {
    ok: true, scope: resolved, ref: entryRef(snap), reason: snap.reason || "update",
    createdAt: snap.createdAt, beforeCount: before.length, afterCount: after.length, lines,
    text: "snapshot " + entryRef(snap) + " (" + (snap.reason || "update") + ", " + before.length + " -> " + after.length + " entries):\n" + (lines.length ? lines.join("\n") : "(no entry changes)"),
  };
}

const USAGE = "usage: /refine [session|workspace] [<note>] — no note runs a refinement pass; /refine --list; /refine --clear";

/**
 * Parse a refinement command. The scope is an optional leading token (prime's
 * own `/refine workspace` shape), so note text is never rewritten mid-sentence.
 * `project` is accepted as a synonym for `workspace`, and `removed` reports a
 * scope the harness no longer has so the caller can say why.
 * @returns scope, the remaining note body, and any removed scope named.
 */
export function parseRefine(rawInput) {
  const raw = String(rawInput || "").trim();
  const cfg = loadConfig();
  const parts = raw.split(/\s+/);
  let scope = cfg.defaultScope;
  let removed = null;
  let head = (parts[0] || "").toLowerCase();
  if (head === "global") {
    /* Only a leading bare word is read as a scope, so a note that merely starts
     * with "global" mid-sentence is still a note. */
    removed = head;
    parts.shift();
  } else if (SCOPE_ALIASES[head] !== undefined) {
    scope = SCOPE_ALIASES[head];
    parts.shift();
  }
  return { scope, body: parts.join(" ").trim(), raw, removed };
}

/* dsh-commands validates handler results at the registry boundary
 * (`normalizeResult`): a bare string is rejected with `handler must return a
 * CommandResult`, and an error result must carry non-empty text. Every path
 * below therefore returns an explicit result object. */
const ok = (text) => ({ kind: "success", text });
const err = (text) => ({ kind: "error", text });

/* ---------- refinement passes ---------- */

/** Sessions with a refinement turn already queued, so a repeated `/refine`
 *  cannot stack duplicate passes. Cleared when the queued turn actually starts. */
const refining = new Set();

/* Resolvers for in-flight passes, keyed the same way as `refining`.
 *
 * A `/refine` invocation awaits its own pass, so the command row stays live —
 * shimmering — until the turn it started settles, then settles once with the
 * outcome. Without this the handler returns in the same tick, `command/done`
 * lands immediately, and the row claims "refining…" while a second, unrelated
 * turn does the actual work below it.
 *
 * Registered for every pass, including the post-compaction hook's: an unawaited
 * promise costs nothing, and making the registration conditional would put the
 * "am I awaited?" decision at the call site that is most likely to forget it. */
const refineWaiters = new Map();

/* The turn number each in-flight pass occupies.
 *
 * `refining` says a pass is queued; it does not say the pass's turn has begun.
 * `/refine` can be invoked while the agent is mid-turn, and `followup` then
 * parks the message until that turn settles — so releasing on the next
 * `turn/end` would settle the command row before the pass ran. Only the turn
 * this pass actually opens may release it. */
const refineTurns = new Map();

/**
 * The instruction behind both triggers — `/refine` with no note, and the
 * post-compaction hook. Recording goes through `TOOL_NAME` because the agent
 * cannot run slash commands; only the operator can.
 * @returns the message text for one refinement turn.
 */
function refinementPrompt(lead) {
  /* The digest is deliberately absent: the `prime:continual-harness` prompt
   * section already carries it, ranked the same way, on every assembly —
   * repeating it here only duplicates context the model is about to receive. */
  /* Review first, then act — the ordering IS the mechanism. A prompt that opens
   * with "collect them" makes the pass a hunt for things to write; one that opens
   * with the decision makes "nothing was durable" a legitimate answer. prime-agent
   * orders its own trigger the same way: gates, then review, then the refinement. */
  return [
    lead,
    "Decide first whether this conversation holds anything durable at all: an operator preference, a correction, a constraint, or a decision and its reason. Nothing is a normal answer — if the conversation was routine, say so and stop.",
    "Also sweep for durable facts that were never recorded, not only this decision's outcome.",
    "If something is durable, make every edit in ONE call to `" + TOOL_NAME + "`. Set `kind` appropriately: `memory` for facts/constraints, `prompt` for standing behavioral or routing rules, `skill` (with kebab-case `name`) for reusable procedures, or `subagent` (with kebab-case `name`) for reusable specialist roles. Each edit carries the evidence that prompted it; an edit without evidence is refused. Do not pass a scope — the operator selected the layer.",
    "If an entry is now wrong, UPDATE it by its ref, or DELETE it. Do not add a second entry beside it: two entries that disagree are worse than one that is stale.",
    "Prefer no edit over a speculative one, and do not restate anything already in the harness.",
    "Do not narrate this pass: reply with one line saying what you changed, or that nothing was durable.",
  ].join("\n\n");
}

/**
 * Queue one refinement turn onto the agent's next turn.
 * @param agent - live agent whose next turn runs the pass.
 * @param lead - opening line of the pass instruction.
 * @returns `{ok: true}` once queued, else an `error` for the caller to report.
 */
function queueRefinement(agent, lead) {
  if (!agent || typeof agent.followup !== "function") return { ok: false, error: "no live agent in this session yet" };
  const key = scopeKey("session", agent);
  if (refining.has(key)) return { ok: false, error: "a refinement pass is already queued for this session" };
  /* Claim the slot BEFORE queueing. `followup` wakes the driver synchronously,
   * so the turn it opens appends `turn/start` and can settle inside this call —
   * claiming afterwards leaves the guard set forever and every later `/refine`
   * and every post-compaction pass is refused. */
  refining.add(key);
  /* Always registered: whether anyone awaits it is the caller's business, and an
   * unawaited promise costs nothing. Registering only for operator invocations
   * would mean the hook has to say so, and the hook is the caller that forgets. */
  let resolveWaiter;
  refineWaiters.set(key, { promise: new Promise((resolve) => { resolveWaiter = resolve; }), resolve: () => resolveWaiter() });
  try {
    agent.followup({
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: refinementPrompt(lead) }],
      /* Not `user`. `MessageSourceMap` is closed in TypeScript only — the runtime
       * admits any non-empty kind (and the format layer preserves it, refusing
       * only the retired `plugin` wrapper), which is how `/goal` rounds and
       * schedules carry their own. Chat keys its renderer on this field alone:
       * `kind: "user"` draws an operator bubble, anything else draws the
       * collapsed turn-trigger notice, so the pass stops looking typed.
       * It also keeps `isSpeaker` from reading machine boilerplate as the
       * operator's own words and spending a query slot on it. */
      source: { kind: "prime-refine" },
    });
  } catch (error) {
    refining.delete(key);
    /* Drop the waiter too, or an awaited invocation never settles and the
     * command row shimmers forever. */
    refineWaiters.delete(key);
    return { ok: false, error: (error && error.message) || String(error) };
  }
  return { ok: true };
}

/** Settle the pass queued for this key, if any. Safe to call when none is. */
function releaseRefinement(key) {
  refineTurns.delete(key);
  const waiter = refineWaiters.get(key);
  if (!waiter) return;
  refineWaiters.delete(key);
  waiter.resolve();
}

/**
 * Resolve when the pass queued for this agent settles, so the command row can
 * stay live until the work it started has actually run.
 * @returns a promise, or undefined when no pass is queued.
 */
function passSettled(agent) {
  const waiter = agent ? refineWaiters.get(scopeKey("session", agent)) : undefined;
  return waiter ? waiter.promise : undefined;
}

/** The provider name the fork path needs; the preset mounts it as `subagent_fork`. */
const FORK_PROVIDER = "fork";

/** @returns the subagents service when this profile can run a forked pass. */
function forkService(ctx) {
  try {
    const subagents = ctx.get ? ctx.get("subagents") : null;
    if (!subagents || typeof subagents.startActivation !== "function") return null;
    if (typeof subagents.getProvider === "function" && !subagents.getProvider(FORK_PROVIDER)) return null;
    return subagents;
  } catch { return null; }
}

/**
 * Run one refinement pass as a forked subagent instead of an in-turn followup.
 *
 * The child is seeded with this session's completed-turn prefix, so it reads the
 * same conversation at cached rates. `delivery: "caller"` is what makes this look
 * like a built-in command: the child sends no `subagent-settled` message, so the
 * parent opens no second turn and the only thing the operator sees is the
 * command row it is already watching.
 *
 * The child's `harness_refine` writes land in THIS session's store, not the
 * child's — `storeSessionId` resolves through the child header's `parentSession`.
 * @returns a settled `CommandResult` for the command row.
 */
async function runForkedPass(ctx, agent, signal, scope) {
  const subagents = forkService(ctx);
  if (!subagents) return err("refine: the fork subagent provider is unavailable in this profile");
  /* The fork does not open a turn, so the `turn/end` re-arm never fires for it —
   * this guard is the ONLY thing that stops a second `/refine` stacking passes. */
  const key = scopeKey("session", agent);
  if (refining.has(key)) return err("refine: a refinement pass is already queued for this session");
  refining.add(key);
  /* Read the baseline BEFORE the child can write. A child that ends normally
   * without recording anything is a success by `stopReason` and a lie by
   * outcome; comparing snapshots is what makes the row report the difference. */
  const before = loadSnapshots(scope, agent).length;
  let receipt;
  try {
    receipt = await subagents.startActivation({
      provider: FORK_PROVIDER,
      /* Time-stamped so the subagent list reads as a pass history instead of N
       * identical "prime refine" rows — the child is already cataloged there
       * (catalog admission is unconditional; `delivery: "caller"` only
       * suppresses the settlement message), so the label is the whole fix. */
      label: "refine " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
      request: {
        parent: agent,
        prompt: [{ type: "text", text: refinementPrompt("Refine the continual harness now: review this conversation and record what should outlive it.") }],
      },
      signal,
      delivery: "caller",
    });
  } catch (error) {
    refining.delete(key);
    return err("refine: " + ((error && error.message) || String(error)));
  }
  try {
    const terminal = await receipt.result;
    if (terminal && terminal.stopReason === "error") return err("refine: the refinement subagent failed; nothing was recorded");
    const after = loadSnapshots(scope, agent).length;
    /* "Nothing durable" is a legitimate answer, not a failure — say which one
     * happened instead of claiming a refinement that did not occur. */
    if (after === before) return ok("the pass found nothing durable to record in the " + scope + " harness.");
    return ok("refined the " + scope + " harness (" + (after - before) + " pass snapshot" + (after - before === 1 ? "" : "s") + " recorded).");
  } catch (error) {
    return err("refine: " + ((error && error.message) || String(error)));
  } finally {
    /* Release here, not on a turn boundary: a forked pass opens no turn, so
     * nothing else would ever clear the slot. */
    refining.delete(key);
    try { receipt.dispose(); } catch { /* already disposed */ }
  }
}

export function refine(rawInput, agent) {
  const { scope, body, removed } = parseRefine(rawInput);
  /* The `global` layer was removed rather than hidden, so a command that still
   * names it gets a reason and the path to its old entries — not a silent write
   * into a layer nothing renders any more. */
  if (removed === "global") {
    return err(
      "refine: the global scope was removed; use session or workspace.\n" +
      "Anything already in the global harness is still at `" + path.join(rootDir(), "global.json") +
      "` — re-record what still matters with /refine workspace <note>.",
    );
  }
  if (body === "--list") {
    const entries = load(scope, agent);
    if (!entries.length) return ok("harness (" + scope + ") is empty");
    return ok("harness (" + scope + "):\n" + rank(entries, agent).map((e) => "- " + formatEntryTag(e) + e.text).join("\n"));
  }
  if (body === "--clear") {
    const prev = load(scope, agent);
    save(scope, agent, [], prev.length ? { reason: "command:clear", before: prev, diff: { added: 0, updated: 0, deleted: prev.length } } : undefined);
    return ok("cleared harness (" + scope + ")");
  }
  if (body === "--snapshots" || body === "--history") {
    const snaps = loadSnapshots(scope, agent);
    if (!snaps.length) return ok("no snapshots recorded for " + scope + " harness");
    return ok("snapshots (" + scope + "):\n" + snaps.slice().reverse().map((s) => {
      const d = entryDate(s.createdAt), df = s.diff || { added: 0, updated: 0, deleted: 0 };
      return "- " + entryRef(s) + (d ? " [" + d + "]" : "") + " " + (s.reason || "update") + " (" + s.beforeCount + " -> " + s.afterCount + "; +" + df.added + " ~" + df.updated + " -" + df.deleted + ")";
    }).join("\n"));
  }
  if (body.startsWith("--pin ") || body.startsWith("--unpin ")) {
    const isPin = body.startsWith("--pin ");
    const targetRef = body.replace(/^--(un)?pin\b/, "").trim();
    if (!targetRef) return err("refine: no ref given\n" + USAGE);
    const res = pinEntry(scope, agent, targetRef, isPin);
    return res.ok ? ok((isPin ? "pinned " : "unpinned ") + res.ref + " in " + res.scope + " harness") : err("refine: " + res.error);
  }
  if (body.startsWith("--delete ") || body.startsWith("--rm ")) {
    const targetRef = body.replace(/^--(delete|rm)\b/, "").trim();
    if (!targetRef) return err("refine: no ref given\n" + USAGE);
    const res = removeEntry(scope, agent, targetRef);
    return res.ok ? ok("deleted " + res.ref + " from " + res.scope + " harness (" + res.count + "/" + MAX_ENTRIES + ")") : err("refine: " + res.error);
  }
  if (body.startsWith("--edit ")) {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(body.replace(/^--edit\b/, "").trim());
    if (!m) return err("refine: usage: /refine [scope] --edit <ref> <new text>");
    const res = updateEntry(scope, agent, m[1], m[2], "edited via /refine --edit");
    return res.ok ? ok("updated " + res.ref + " in " + res.scope + " harness") : err("refine: " + res.error);
  }
  if (body === "--reset-repl") {
    resetPythonRepl(agent);
    return ok("reset persistent RLM Python REPL for this session");
  }
  /* A bare `/refine` is the refinement pass itself, not a usage error. The
   * handler awaits the pass through `passSettled()`; the result itself stays a
   * plain `CommandResult`, because the registry validates that shape. */
  if (!body) {
    const queued = queueRefinement(agent, "Refine the continual harness now: review this conversation and record what should outlive it.");
    if (!queued.ok) return err("refine: " + queued.error);
    return ok("refining the " + scope + " harness.");
  }
  if (body === "--help") return err(USAGE);
  let cmdKind = "memory";
  let cmdName;
  let noteBody = body;
  while (noteBody.startsWith("--kind ") || noteBody.startsWith("--name ")) {
    if (noteBody.startsWith("--kind ")) {
      const m = /^--kind\s+(\S+)\s*([\s\S]*)$/.exec(noteBody);
      if (!m || !KINDS.includes(m[1].toLowerCase())) return err("refine: --kind must be one of " + KINDS.join(", "));
      cmdKind = m[1].toLowerCase();
      noteBody = m[2].trim();
    } else if (noteBody.startsWith("--name ")) {
      const m = /^--name\s+(\S+)\s*([\s\S]*)$/.exec(noteBody);
      if (!m) return err("refine: usage: /refine [--kind <kind>] [--name <name>] <note>");
      cmdName = m[1].trim();
      noteBody = m[2].trim();
    }
  }
  if (noteBody.startsWith("--")) return err("refine: unknown flag " + noteBody.split(/\s+/)[0] + "\n" + USAGE);
  const r = upsert(scope, agent, noteBody, "command", undefined, { kind: cmdKind, name: cmdName });
  if (!r.ok) return err("refine: " + r.error);
  return ok("recorded in " + scope + " harness (" + r.count + "/" + MAX_ENTRIES + ")");
}

/* ---------- compaction ---------- */

/** Last auto-refine per session. Session-keyed, not process-wide: the hook is
 *  reached by every session in the process, and one session compacting must not
 *  spend another session's cooldown. */
const lastAutoRefine = new Map();

/* Operator turns settled since the last refinement pass, per session. prime-agent
 * reviews before refining so a pass only runs when something changed; this is the
 * cheap half of that — a pass is never queued onto a conversation that has said
 * nothing new since the previous one, which would spend a whole turn to discover
 * nothing was durable. */
const settledTurns = new Map();

/**
 * The preset this session actually runs, read through the registry's own
 * `agentPreset` session projection — the same value it reads to answer the mode
 * picker, so a session that switched preset before its first turn reports the
 * composition it really mounted.
 * @returns the preset id, or `null` when no projection API is reachable.
 */
export function presetOf(ctx, agent, session) {
  /* Preferred: the projection the registry maintains, read straight off the
   * session. It is already computed, so this costs nothing extra. */
  try {
    const projections = (ctx && ctx.sessionProjections) || (ctx.get && ctx.get("sessionProjections"));
    if (projections && typeof projections.stateOf === "function") {
      const id = projections.stateOf(session, PRESET_PROJECTION);
      /* A projection with no opinion yet is not an answer: falling through to the
       * mount lookup is what keeps a warming session from reading as "unknown",
       * which the caller treats as a broken deployment. */
      if (typeof id === "string") return id;
    }
  } catch { /* fall through to the mount lookup */ }
  /* Fallback: ask the registry which mount this agent joined. */
  try {
    const presets = ctx.get && ctx.get("agentPresets");
    if (!presets || typeof presets.composedPreset !== "function") return null;
    const id = presets.composedPreset(agent && agent.ctx);
    return typeof id === "string" ? id : null;
  } catch { return null; }
}

/** Whether this session's cooldown window has elapsed. */
function cooldownOpen(key) {
  const last = lastAutoRefine.get(key);
  return last === undefined || Date.now() - last >= COOLDOWN_MS;
}

/** Post-compaction hook: re-rank the harness and let the model refine it without a user turn. */
export function onCompaction(ctx, session) {
  const cfg = loadConfig();
  if (!cfg.autoRefineOnCompact) return;
  let agent = null;
  try {
    agent = ctx.get && ctx.get("agents") ? ctx.get("agents").get(session.id) : null;
  } catch { agent = null; }
  const preset = presetOf(ctx, agent, session);
  /* Only the preset that mounts the harness may be refined. This hook lives on
   * the root plane because the command does, and a root listener is reached by
   * every session in the process: without this check, `/compact` in `standard`,
   * `ptc`, or `minimal` injected a refinement turn into a mode that has no
   * harness digest and no `harness_refine` tool to record with. */
  if (preset === null) {
    ctx.logger.warn("prime: auto-refine skipped; the session preset could not be resolved (no agentPreset projection)");
    return;
  }
  if (preset !== PRESET_ID) return;
  if (!agent || typeof agent.followup !== "function") return;
  const key = scopeKey("session", agent);
  if (!cooldownOpen(key)) return;
  /* The gate: nothing the operator said since the last pass means there is nothing
   * new to be durable about. A manual `/refine` skips this deliberately — the
   * operator asking for a pass is reason enough. */
  if ((settledTurns.get(key) || 0) === 0) return;
  settledTurns.set(key, 0);
  /* Spend the window before queueing: `followup` runs the turn's opening events
   * synchronously, so a compaction that lands during the queue would otherwise
   * re-enter here with the old timestamp still open. */
  lastAutoRefine.set(key, Date.now());
  /* Each session's entry is bounded below; nothing else prunes this map. */
  if (lastAutoRefine.size > 256) {
    for (const [k, at] of lastAutoRefine) if (Date.now() - at >= COOLDOWN_MS) lastAutoRefine.delete(k);
  }
  /* Shares the `/refine` path, so the two triggers cannot drift apart. */
  const queued = queueRefinement(agent, "[prime auto-refine] Context was compacted.");
  /* A skipped pass is otherwise invisible; this is the only trace it leaves. */
  if (!queued.ok) ctx.logger.warn("prime: post-compaction refinement not queued: " + queued.error);
}

/* ---------- http bridge (kept dependency-free, same shape as dsh-purge) ---------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
export function extractSessionContext(agent) {
  const messages = [];
  try {
    const session = agent && agent.session;
    const surfaceNodes = session && session.surface && Array.isArray(session.surface.nodes) ? new Set(session.surface.nodes) : null;
    if (session && typeof session.snapshotEvents === "function") {
      for (const ev of session.snapshotEvents() || []) {
        if (!ev) continue;
        if (ev.type === "user/message" && ev.data && isSpeaker(ev.data)) {
          const text = messageText(ev.data);
          if (text) messages.push({ seq: ev.seq ?? messages.length, role: "user", text, compacted: surfaceNodes ? !surfaceNodes.has(ev.seq) : false });
        } else if (ev.type === "assistant/message" && ev.data && ev.data.message) {
          const text = messageText(ev.data.message);
          if (text) messages.push({ seq: ev.seq ?? messages.length, role: "assistant", text, compacted: surfaceNodes ? !surfaceNodes.has(ev.seq) : false });
        }
      }
    }
    if (messages.length === 0) {
      liveMessages(agent).forEach((m, idx) => {
        if (!m || (m.role !== "user" && m.role !== "assistant") || !isSpeaker(m)) return;
        const text = messageText(m);
        if (text) messages.push({ seq: idx, role: m.role, text, compacted: false });
      });
    }
  } catch {}
  const ctxText = messages.map((m) => "[" + m.role + (m.compacted ? ":compacted" : "") + "]\n" + m.text).join("\n\n");
  let goal = null;
  try {
    const obj = goalsApi && agent ? goalsApi.get(agent)?.objective : null;
    if (typeof obj === "string" && obj.trim()) goal = obj.trim();
  } catch { goal = null; }
  return { ctx: ctxText, messages, goal, workspace: sessionCwd(agent) };
}

export function loadReplStore(agent) {
  const doc = readJson(replStoreFile(agent), { store: {} });
  return doc && doc.store && typeof doc.store === "object" && !Array.isArray(doc.store) ? doc.store : {};
}
export function saveReplStore(agent, store) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return {};
  writeJson(replStoreFile(agent), { version: 1, updatedAt: Date.now(), store });
  return store;
}

let cachedPythonExe = undefined;
export function findPythonExecutable() {
  if (cachedPythonExe !== undefined) return cachedPythonExe;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const relPy = path.join("Programs", "DeepSeek Harness", "resources", "runtime", "primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python3");
  const candidates = [
    process.env.DSH_PYTHON,
    path.join(localAppData, relPy),
    ...(process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]),
  ].filter(Boolean);
  for (const cmd of candidates) {
    try {
      if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) continue;
      const probe = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 4000, windowsHide: true });
      if (probe.status === 0 && String(probe.stdout || "").trim() === "3") return (cachedPythonExe = cmd);
    } catch {}
  }
  return (cachedPythonExe = null);
}

const CMD_PREFIX = "\x00DSH_CMD:";
const RPC_PREFIX = "\x00DSH_RPC:";
const REPLY_PREFIX = "\x00DSH_REPLY:";
const DONE_PREFIX = "\x00DSH_DONE:";
const READY_LINE = "\x00DSH_READY";

const PYTHON_WORKER_SCRIPT = [
  "import ast, asyncio, io, json, os, sys, traceback",
  "_in, _out = sys.__stdin__, sys.__stdout__",
  "_CMD, _RPC, _REPLY, _DONE, _READY = '\\x00DSH_CMD:', '\\x00DSH_RPC:', '\\x00DSH_REPLY:', '\\x00DSH_DONE:', '\\x00DSH_READY'",
  "class AwaitableDict(dict):",
  "    def __getattr__(self, k):",
  "        try: return self[k]",
  "        except KeyError: raise AttributeError(k)",
  "    def __await__(self):",
  "        async def _c(): return self",
  "        return _c().__await__()",
  "class AwaitableList(list):",
  "    def __await__(self):",
  "        async def _c(): return self",
  "        return _c().__await__()",
  "class AwaitableStr(str):",
  "    def __await__(self):",
  "        async def _c(): return str(self)",
  "        return _c().__await__()",
  "class AwaitableInt(int):",
  "    def __await__(self):",
  "        async def _c(): return int(self)",
  "        return _c().__await__()",
  "class AwaitableFloat(float):",
  "    def __await__(self):",
  "        async def _c(): return float(self)",
  "        return _c().__await__()",
  "def _wrap(v):",
  "    if isinstance(v, dict): return AwaitableDict({k: _wrap(x) for k, x in v.items()})",
  "    if isinstance(v, list): return AwaitableList([_wrap(x) for x in v])",
  "    if isinstance(v, str): return AwaitableStr(v)",
  "    if isinstance(v, bool): return v",
  "    if isinstance(v, int): return AwaitableInt(v)",
  "    if isinstance(v, float): return AwaitableFloat(v)",
  "    return v",
  "_seq = 0",
  "def _rpc(method, params):",
  "    global _seq; _seq += 1",
  "    _out.write(_RPC + json.dumps({'id': _seq, 'method': method, 'params': params}) + '\\n'); _out.flush()",
  "    while True:",
  "        l = _in.readline()",
  "        if not l: raise RuntimeError('RLM host channel closed')",
  "        if l.startswith(_REPLY):",
  "            r = json.loads(l[len(_REPLY):])",
  "            if not r.get('ok'): raise RuntimeError(r.get('error') or 'RLM RPC failed')",
  "            return _wrap(r.get('value'))",
  "class _Harness:",
  "    def list(self, scope=None, kind=None): return _rpc('harness.list', {'scope': scope, 'kind': kind})",
  "    def add(self, text, evidence='recorded from python_repl', kind='memory', name=None, pinned=False):",
  "        return _rpc('harness.add', {'text': text, 'evidence': evidence, 'kind': kind, 'name': name, 'pinned': bool(pinned)})",
  "    def update(self, ref, text, evidence='updated from python_repl', kind=None, name=None, pinned=None):",
  "        return _rpc('harness.update', {'ref': ref, 'text': text, 'evidence': evidence, 'kind': kind, 'name': name, 'pinned': pinned})",
  "    def delete(self, ref): return _rpc('harness.delete', {'ref': ref})",
  "    def snapshots(self, scope=None): return _rpc('harness.snapshots', {'scope': scope})",
  "    def rollback(self, ref=None, scope=None): return _rpc('harness.rollback', {'ref': ref, 'scope': scope})",
  "    def diff(self, ref=None, scope=None): return _rpc('harness.diff', {'ref': ref, 'scope': scope})",
  "class _Rlm:",
  "    def __init__(self): self.harness = _Harness()",
  "    def __call__(self, prompt, name=None, model=None, provider=None, fork=False, cwd=None, role=None):",
  "        return self.spawn(prompt, name=name, model=model, provider=provider, fork=fork, cwd=cwd, role=role)",
  "    def spawn(self, prompt, name=None, model=None, provider=None, fork=False, cwd=None, role=None):",
  "        return _rpc('rlm.spawn', {'prompt': prompt, 'name': name, 'model': model, 'provider': provider, 'fork': bool(fork), 'cwd': cwd, 'role': role})",
  "    def list_subagents(self): return _rpc('rlm.list_subagents', {})",
  "    def send_message(self, agent_id, message): return _rpc('rlm.send_message', {'agent_id': agent_id, 'message': message})",
  "    def interrupt(self, agent_id): return _rpc('rlm.interrupt', {'agent_id': agent_id})",
  "    def tool(self, name, *a, **kw): return _rpc('tool', {'name': name, 'args': a[0] if (a and isinstance(a[0], dict) and not kw) else dict(kw)})",
  "class _AgentMsg:",
  "    def send(self, message, receiver_name='main'): return _rpc('rlm.send_message', {'agent_id': receiver_name, 'message': message})",
  "class _Tools:",
  "    def __getattr__(self, n): return lambda *a, **kw: _rpc('tool', {'name': n, 'args': a[0] if (a and isinstance(a[0], dict) and not kw) else dict(kw)})",
  "    def __getitem__(self, n): return getattr(self, n)",
  "def _jsonable(v):",
  "    if v is None or isinstance(v, (bool, int, float, str)): return v",
  "    if isinstance(v, (list, tuple)): return [_jsonable(x) for x in v[:200]]",
  "    if isinstance(v, dict): return {str(k): _jsonable(val) for k, val in list(v.items())[:200]}",
  "    return repr(v)",
  "_RES = {'__builtins__','__name__','__doc__','__package__','__loader__','__spec__','ctx','messages','goal','workspace','store','rlm','agent_message','tools','_'}",
  "def _mk(): return {'__name__':'__main__','ctx':'','messages':[],'goal':None,'workspace':os.getcwd(),'store':{},'rlm':_Rlm(),'agent_message':_AgentMsg(),'tools':_Tools(),'_':None}",
  "_ns, _loop, _cwd_init = _mk(), asyncio.new_event_loop(), False",
  "asyncio.set_event_loop(_loop)",
  "async def _eval(code, ns):",
  "    mod = ast.parse(code, filename='<python_repl>', mode='exec')",
  "    last = ast.Expression(mod.body.pop().value) if (mod.body and isinstance(mod.body[-1], ast.Expr)) else None",
  "    ast.fix_missing_locations(mod)",
  "    c = eval(compile(mod, '<python_repl>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), ns, ns)",
  "    if asyncio.iscoroutine(c): await c",
  "    if last is None: return None",
  "    ast.fix_missing_locations(last)",
  "    v = eval(compile(last, '<python_repl>', 'eval', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), ns, ns)",
  "    if asyncio.iscoroutine(v): v = await v",
  "    ns['_'] = v; return v",
  "_out.write(_READY + '\\n'); _out.flush()",
  "while True:",
  "    line = _in.readline()",
  "    if not line: break",
  "    if not line.startswith(_CMD): continue",
  "    cmd = json.loads(line[len(_CMD):])",
  "    if cmd.get('reset'): _ns, _cwd_init = _mk(), False",
  "    if cmd.get('cwd') and not _cwd_init:",
  "        try: os.chdir(cmd['cwd']); _cwd_init = True",
  "        except Exception: pass",
  "    cx = cmd.get('context') or {}",
  "    _ns['ctx'], _ns['messages'], _ns['goal'], _ns['workspace'] = cx.get('ctx',''), cx.get('messages',[]), cx.get('goal'), cx.get('workspace') or os.getcwd()",
  "    if isinstance(cx.get('store'), dict):",
  "        if not isinstance(_ns.get('store'), dict): _ns['store'] = {}",
  "        for k, v in cx['store'].items(): _ns['store'].setdefault(k, v)",
  "    if isinstance(cmd.get('set_vars'), dict):",
  "        for k, v in cmd['set_vars'].items():",
  "            _ns[k] = v",
  "            if isinstance(_ns.get('store'), dict): _ns['store'][k] = v",
  "    ob, eb, ok_f, err_t, res_v = io.StringIO(), io.StringIO(), True, None, None",
  "    sys.stdout, sys.stderr = ob, eb",
  "    try: res_v = _jsonable(_loop.run_until_complete(_eval(cmd.get('code') or '', _ns)))",
  "    except BaseException as ex: ok_f = False; err_t = f'{type(ex).__name__}: {ex}'; eb.write(traceback.format_exc())",
  "    finally: sys.stdout, sys.stderr = _out, sys.__stderr__",
  "    uv = sorted([k for k, v in _ns.items() if k not in _RES and not k.startswith('_') and not hasattr(v, '__spec__')])",
  "    st = {}",
  "    if isinstance(_ns.get('store'), dict):",
  "        for k, v in _ns['store'].items():",
  "            try: json.dumps(v); st[str(k)] = v",
  "            except Exception: st[str(k)] = repr(v)",
  "    _out.write(_DONE + json.dumps({'id':cmd.get('id'),'ok':ok_f,'stdout':ob.getvalue(),'stderr':eb.getvalue(),'result':res_v,'variables':uv,'store':st,**({'error':err_t} if err_t else {})}) + '\\n'); _out.flush()",
].join("\n");

const replKernels = new Map();
class ReplKernel {
  constructor(sessionKey, pythonExe) {
    this.sessionKey = sessionKey; this.pythonExe = pythonExe;
    this.proc = null; this.active = null; this.buffer = ""; this.evalCount = 0; this.variables = [];
  }
  ensureStarted(cwd) {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.readyPromise;
    this.buffer = "";
    this.readyPromise = new Promise((resolve, reject) => {
      const proc = spawn(this.pythonExe, ["-u", "-c", PYTHON_WORKER_SCRIPT], {
        cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
        env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = proc;
      let settledReady = false;
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, idx).replace(/\r$/, "");
          this.buffer = this.buffer.slice(idx + 1);
          if (!settledReady && line === READY_LINE) { settledReady = true; resolve(); continue; }
          this.onLine(line);
        }
      });
      proc.on("error", (err) => {
        if (!settledReady) { settledReady = true; reject(err); }
        if (this.active) { const cur = this.active; this.active = null; cur.reject(err); }
      });
      proc.on("close", (code) => {
        this.proc = null;
        if (!settledReady) { settledReady = true; reject(new Error("Python REPL exited (" + code + ")")); }
        if (this.active) { const cur = this.active; this.active = null; cur.reject(new Error("Python REPL exited (" + code + ")")); }
      });
    });
    return this.readyPromise;
  }
  onLine(line) {
    if (!this.active) return;
    if (line.startsWith(RPC_PREFIX)) {
      let req;
      try { req = JSON.parse(line.slice(RPC_PREFIX.length)); } catch (e) { return this.sendReply({ id: 0, ok: false, error: e.message }); }
      Promise.resolve().then(() => this.active.onRpc(req.method, req.params || {})).then(
        (value) => this.sendReply({ id: req.id, ok: true, value: value === undefined ? null : value }),
        (error) => this.sendReply({ id: req.id, ok: false, error: (error && error.message) || String(error) }),
      );
      return;
    }
    if (line.startsWith(DONE_PREFIX)) {
      const cur = this.active; this.active = null;
      try {
        const data = JSON.parse(line.slice(DONE_PREFIX.length));
        this.variables = Array.isArray(data.variables) ? data.variables : [];
        cur.resolve(data);
      } catch (e) { cur.reject(e); }
    }
  }
  sendReply(payload) {
    if (this.proc && this.proc.stdin && !this.proc.killed) {
      try { this.proc.stdin.write(REPLY_PREFIX + JSON.stringify(payload) + "\n"); } catch {}
    }
  }
  async evaluate(cmdPayload, onRpc, timeoutMs = 120000) {
    if (this.active) throw new Error("persistent Python REPL is busy");
    await this.ensureStarted(cmdPayload.cwd);
    const id = ++this.evalCount;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.active && this.active.id === id) {
          this.active = null; this.dispose();
          resolve({ id, ok: false, stdout: "", stderr: "Timed out after " + timeoutMs + "ms", result: null, variables: [], store: cmdPayload.context?.store || {}, error: "TimeoutError" });
        }
      }, timeoutMs);
      this.active = {
        id, onRpc,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      try { this.proc.stdin.write(CMD_PREFIX + JSON.stringify(Object.assign({}, cmdPayload, { id })) + "\n"); }
      catch (e) { clearTimeout(timer); this.active = null; reject(e); }
    });
  }
  dispose() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    this.active = null; this.variables = [];
  }
}

export function resetPythonRepl(agent) {
  const key = scopeKey("session", agent);
  const kernel = replKernels.get(key);
  if (kernel) { kernel.dispose(); replKernels.delete(key); }
  return { ok: true, sessionKey: key };
}
export function getReplStatus(agent) {
  const key = scopeKey("session", agent);
  const kernel = replKernels.get(key);
  const store = loadReplStore(agent);
  return {
    active: Boolean(kernel && kernel.proc && !kernel.proc.killed),
    evalCount: kernel ? kernel.evalCount : 0,
    variables: kernel ? kernel.variables : [],
    storeKeys: Object.keys(store),
    pythonExecutable: findPythonExecutable(),
  };
}
export function disposeAllRepls() {
  for (const k of replKernels.values()) k.dispose();
  replKernels.clear();
}

export async function evalPythonRepl(agent, args, bridge = {}) {
  const py = findPythonExecutable();
  if (!py) return { ok: false, stdout: "", stderr: "Python 3 not found", result: null, variables: [], error: "Python 3 unavailable", text: "Error: Python 3 executable not found." };
  const key = scopeKey("session", agent);
  let kernel = replKernels.get(key);
  if (!kernel) replKernels.set(key, (kernel = new ReplKernel(key, py)));
  const context = extractSessionContext(agent);
  context.store = loadReplStore(agent);

  const handleRpc = async (method, params) => {
    const defaultScope = loadConfig().defaultScope;
    switch (method) {
      case "harness.list": {
        const entries = params.scope ? load(params.scope, agent) : loadAll(agent);
        return (params.kind ? entries.filter((e) => (e.kind || "memory") === params.kind) : entries).map((e) => Object.assign({}, e, { ref: entryRef(e), kind: e.kind || "memory" }));
      }
      case "harness.add": {
        const r = upsert(defaultScope, agent, params.text, "rlm", params.evidence || "recorded from python_repl", { kind: params.kind, name: params.name, pinned: params.pinned });
        if (!r.ok) throw new Error(r.error);
        return { ok: true, ref: r.ref, scope: r.scope, count: r.count };
      }
      case "harness.update": {
        const r = updateEntry(defaultScope, agent, params.ref, params.text, params.evidence || "updated from python_repl", { kind: params.kind ?? undefined, name: params.name ?? undefined, pinned: typeof params.pinned === "boolean" ? params.pinned : undefined });
        if (!r.ok) throw new Error(r.error);
        return { ok: true, ref: r.ref, scope: r.scope, count: r.count };
      }
      case "harness.delete": {
        const r = removeEntry(defaultScope, agent, params.ref);
        if (!r.ok) throw new Error(r.error);
        return { ok: true, ref: r.ref, scope: r.scope, count: r.count };
      }
      case "harness.snapshots":
        return summarizeSnapshots(params.scope ? normalizeScope(params.scope, defaultScope) : defaultScope, agent);
      case "harness.rollback": {
        const r = rollbackSnapshot(params.scope ? normalizeScope(params.scope, defaultScope) : defaultScope, agent, params.ref);
        if (!r.ok) throw new Error(r.error);
        return { ok: true, ref: r.ref, scope: r.scope, restoredCount: r.restoredCount };
      }
      case "harness.diff": {
        const r = diffSnapshot(params.scope ? normalizeScope(params.scope, defaultScope) : defaultScope, agent, params.ref);
        if (!r.ok) throw new Error(r.error);
        return { ok: true, ref: r.ref, scope: r.scope, lines: r.lines, text: r.text };
      }
      case "rlm.spawn": {
        if (typeof bridge.spawnSubagent !== "function") throw new Error("subagent service unavailable");
        let promptText = String(params.prompt || "");
        if (params.role) {
          const roleSpec = loadAll(agent).find((e) => e.kind === "subagent" && (e.name === params.role || entryRef(e) === params.role));
          if (roleSpec) promptText = "[Subagent Role: " + (roleSpec.name || params.role) + "]\n" + roleSpec.text + "\n\n[Task]\n" + promptText;
        }
        return await bridge.spawnSubagent({ prompt: promptText, name: params.name || params.role || "rlm-subagent", model: params.model || undefined, provider: params.provider || undefined, fork: Boolean(params.fork), cwd: params.cwd || undefined });
      }
      case "rlm.list_subagents":
        return typeof bridge.listSubagents === "function" ? await bridge.listSubagents() : [];
      case "rlm.send_message":
        if (typeof bridge.sendMessage !== "function") throw new Error("subagent messaging unavailable");
        return await bridge.sendMessage(String(params.agent_id || ""), String(params.message || ""));
      case "rlm.interrupt":
        if (typeof bridge.interruptSubagent !== "function") throw new Error("subagent service unavailable");
        return await bridge.interruptSubagent(String(params.agent_id || ""));
      case "tool":
        if (typeof bridge.callTool !== "function") throw new Error("tool bridge unavailable");
        return await bridge.callTool(String(params.name || ""), params.args || {});
      default:
        throw new Error("unknown RLM RPC: " + method);
    }
  };

  const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? Math.min(args.timeout_ms, 600000) : 120000;
  const outcome = await kernel.evaluate({ code: String(args.code || ""), reset: Boolean(args.reset), cwd: context.workspace, context, set_vars: args.set_vars && typeof args.set_vars === "object" ? args.set_vars : undefined }, handleRpc, timeoutMs);
  if (outcome.store && typeof outcome.store === "object") saveReplStore(agent, outcome.store);
  const parts = [];
  if (outcome.stdout && outcome.stdout.trim()) parts.push(outcome.stdout.replace(/\n$/, ""));
  if (outcome.result !== null && outcome.result !== undefined) parts.push(typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result, null, 2));
  if (outcome.stderr && outcome.stderr.trim()) parts.push(outcome.stderr.replace(/\n$/, ""));
  return {
    ok: Boolean(outcome.ok),
    stdout: String(outcome.stdout || ""),
    stderr: String(outcome.stderr || ""),
    result: outcome.result === undefined ? null : outcome.result,
    variables: Array.isArray(outcome.variables) ? outcome.variables : [],
    ...(outcome.error ? { error: String(outcome.error) } : {}),
    text: parts.length > 0 ? parts.join("\n") : "(python_repl completed with no output)",
  };
}

function isLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function summarizeSnapshots(scope, agent) {
  if (!agent) return [];
  return loadSnapshots(scope, agent).slice().reverse().map((s) => ({
    id: s.id,
    ref: entryRef(s),
    createdAt: s.createdAt,
    reason: s.reason || "update",
    beforeCount: s.beforeCount,
    afterCount: s.afterCount,
    diff: s.diff || { added: 0, updated: 0, deleted: 0 },
  }));
}

function collectWorkspaces(ctx, active) {
  const byKey = new Map();
  const addCwd = (rawCwd, isCurrent = false) => {
    if (typeof rawCwd !== "string" || !rawCwd.trim()) return;
    let cwd;
    try { cwd = path.resolve(rawCwd.trim()); } catch { return; }
    const fakeAgent = { session: { id: (active && active.id) || "default", header: { cwd } } };
    const key = scopeKey("workspace", fakeAgent);
    const existing = byKey.get(key);
    if (existing) {
      if (isCurrent) existing.isCurrent = true;
      return;
    }
    const entries = load("workspace", fakeAgent);
    byKey.set(key, {
      key,
      cwd,
      name: path.basename(cwd) || cwd,
      isCurrent: Boolean(isCurrent),
      count: entries.length,
      entries,
      ranked: rank(entries, fakeAgent).map((e) => e.id),
      snapshots: summarizeSnapshots("workspace", fakeAgent),
    });
  };

  if (active && active.cwd) addCwd(active.cwd, true);
  for (const rec of lastActive.values()) if (rec && rec.cwd) addCwd(rec.cwd, Boolean(active && rec.cwd === active.cwd));

  try {
    const sessions = ctx && ctx.get ? ctx.get("sessions") : null;
    if (sessions && typeof sessions.list === "function") {
      for (const s of sessions.list()) if (s?.header?.cwd) addCwd(s.header.cwd, Boolean(active && path.resolve(s.header.cwd) === active.cwd));
    }
  } catch {}

  try {
    const agents = ctx && ctx.get ? ctx.get("agents") : null;
    if (agents && typeof agents.roots === "function") {
      for (const a of agents.roots()) if (a?.session?.header?.cwd) addCwd(a.session.header.cwd, Boolean(active && path.resolve(a.session.header.cwd) === active.cwd));
    }
  } catch {}

  /* Also scan persisted DSH storages/workspaces and prime project-*.json files so
   * every workspace appears on cold boot before any turn runs. */
  try {
    const storagesDir = path.join(homeDir(), "storages");
    if (fs.existsSync(storagesDir)) {
      for (const entry of fs.readdirSync(storagesDir, { withFileTypes: true })) {
        const full = path.join(storagesDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const raw = fs.readFileSync(full, "utf8");
          for (const m of raw.matchAll(/"(?:cwd|path|root|directory)"\s*:\s*"([^"]+)"/g)) {
            const candidate = m[1].replace(/\\\\/g, "\\");
            if (path.isAbsolute(candidate) && fs.existsSync(candidate)) addCwd(candidate, Boolean(active && path.resolve(candidate) === active.cwd));
          }
        } else if (entry.isDirectory()) {
          for (const sub of fs.readdirSync(full)) {
            if (!sub.endsWith(".json")) continue;
            const raw = fs.readFileSync(path.join(full, sub), "utf8");
            for (const m of raw.matchAll(/"(?:cwd|path|root|directory)"\s*:\s*"([^"]+)"/g)) {
              const candidate = m[1].replace(/\\\\/g, "\\");
              if (path.isAbsolute(candidate) && fs.existsSync(candidate)) addCwd(candidate, Boolean(active && path.resolve(candidate) === active.cwd));
            }
          }
        }
      }
    }
  } catch {}

  try {
    const dir = rootDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(LEGACY_SCOPE_PREFIX) || !f.endsWith(".json")) continue;
        const key = f.slice(0, -5);
        if (byKey.has(key)) continue;
        const doc = readJson(path.join(dir, f), {});
        if (typeof doc.cwd === "string" && doc.cwd.trim()) {
          addCwd(doc.cwd, Boolean(active && path.resolve(doc.cwd) === active.cwd));
        } else {
          const entries = Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.text === "string") : [];
          if (!entries.length) continue;
          byKey.set(key, {
            key,
            cwd: "",
            name: "Workspace (" + key.replace(LEGACY_SCOPE_PREFIX, "").slice(0, 8) + ")",
            isCurrent: false,
            count: entries.length,
            entries,
            ranked: entries.map((e) => e.id),
            snapshots: Array.isArray(doc.snapshots) ? doc.snapshots.slice().reverse().map((s) => ({
              id: s.id,
              ref: entryRef(s),
              createdAt: s.createdAt,
              reason: s.reason || "update",
              beforeCount: s.beforeCount,
              afterCount: s.afterCount,
              diff: s.diff || { added: 0, updated: 0, deleted: 0 },
            })) : [],
          });
        }
      }
    }
  } catch {}

  return [...byKey.values()].sort((a, b) => (Number(b.isCurrent) - Number(a.isCurrent)) || (b.count - a.count) || a.name.localeCompare(b.name));
}

function handleApi(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  if (!isLoopback(req) && !hostLocal) return sendJson(res, 403, { ok: false, error: "cross-origin request rejected" });
  return readBody(req).then((raw) => {
    let req2 = {};
    try { req2 = raw.trim() ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { ok: false, error: "invalid json" }); }
    const cfg = loadConfig();
    const scope = normalizeScope(req2.scope, cfg.defaultScope);
    let active = resolveActiveSession(ctx);
    if (typeof req2.sessionId === "string" && req2.sessionId.trim()) {
      const wantId = req2.sessionId.trim();
      try {
        const s = ctx?.get?.("sessions")?.get?.(wantId) || ctx?.get?.("agents")?.get?.(wantId)?.session;
        if (s && typeof s.id === "string") {
          rememberSession(s);
          active = { id: s.id, cwd: sessionCwd({ session: s }) };
        }
      } catch {}
    }
    const hasExplicitCwd = typeof req2.cwd === "string" && req2.cwd.trim().length > 0;
    const targetCwd = hasExplicitCwd ? path.resolve(req2.cwd.trim()) : (active ? active.cwd : null);
    const agent = (active === null && !hasExplicitCwd) ? null : {
      session: {
        id: (active && active.id) || "default",
        header: { cwd: targetCwd || process.cwd() },
      },
    };
    const counts = {};
    for (const layer of SCOPES) counts[layer] = agent === null ? 0 : load(layer, agent).length;
    const withActive = (payload) => Object.assign({
      active,
      counts,
      workspaces: collectWorkspaces(ctx, active),
      snapshots: summarizeSnapshots(scope, agent),
      repl: agent ? getReplStatus(agent) : null,
    }, payload);
    switch (req2.op) {
      case "get": {
        if (agent === null) return sendJson(res, 200, withActive({ ok: true, config: cfg, scope, scopes: SCOPES, kinds: KINDS, entries: [], ranked: [] }));
        const entries = load(scope, agent);
        return sendJson(res, 200, withActive({ ok: true, config: cfg, scope, scopes: SCOPES, kinds: KINDS, entries, ranked: rank(entries, agent).map((e) => e.id) }));
      }
      case "setScope":
        return sendJson(res, 200, withActive({ ok: true, config: saveConfig({ defaultScope: scope }) }));
      case "setAuto":
        return sendJson(res, 200, withActive({ ok: true, config: saveConfig({ autoRefineOnCompact: !!req2.value }) }));
      case "add": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const r = upsert(scope, agent, req2.text, "ui", req2.evidence || "added from the settings panel", { kind: req2.kind, name: req2.name, pinned: req2.pinned });
        counts[scope] = load(scope, agent).length;
        const entries = load(scope, agent);
        return sendJson(res, r.ok ? 200 : 400, withActive(Object.assign({ ok: r.ok }, r, { entries, ranked: rank(entries, agent).map((e) => e.id) })));
      }
      case "update": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const r = updateEntry(scope, agent, req2.ref || req2.id, req2.text, req2.evidence || "updated from the settings panel", { kind: req2.kind, name: req2.name, pinned: req2.pinned });
        counts[scope] = load(scope, agent).length;
        const entries = load(scope, agent);
        return sendJson(res, r.ok ? 200 : 400, withActive(Object.assign({ ok: r.ok }, r, { entries, ranked: rank(entries, agent).map((e) => e.id) })));
      }
      case "pin": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const r = pinEntry(scope, agent, req2.ref || req2.id, Boolean(req2.pinned));
        const entries = load(scope, agent);
        return sendJson(res, r.ok ? 200 : 400, withActive(Object.assign({ ok: r.ok }, r, { entries, ranked: rank(entries, agent).map((e) => e.id) })));
      }
      case "remove": {
        if (agent !== null) {
          removeEntry(scope, agent, req2.id || req2.ref);
          counts[scope] = load(scope, agent).length;
        }
        const entries = agent === null ? [] : load(scope, agent);
        return sendJson(res, 200, withActive({ ok: true, entries, ranked: agent === null ? [] : rank(entries, agent).map((e) => e.id) }));
      }
      case "clear": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const prev = load(scope, agent);
        save(scope, agent, [], prev.length > 0 ? { reason: "ui:clear", before: prev, diff: { added: 0, updated: 0, deleted: prev.length } } : undefined);
        counts[scope] = 0;
        return sendJson(res, 200, withActive({ ok: true, entries: [], ranked: [] }));
      }
      case "rollback": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const r = rollbackSnapshot(scope, agent, req2.ref || req2.id);
        counts[scope] = load(scope, agent).length;
        const entries = load(scope, agent);
        return sendJson(res, r.ok ? 200 : 400, withActive(Object.assign({ ok: r.ok }, r, { entries, ranked: rank(entries, agent).map((e) => e.id) })));
      }
      case "diff": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        const r = diffSnapshot(scope, agent, req2.ref || req2.id);
        return sendJson(res, r.ok ? 200 : 400, withActive(r));
      }
      case "resetRepl": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        resetPythonRepl(agent);
        return sendJson(res, 200, withActive({ ok: true }));
      }
      default:
        return sendJson(res, 400, { ok: false, error: "unknown op" });
    }
  }).catch((e) => sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }));
}
/* ---------- plugin ---------- */


function withRawAsar(fn) {
  const prev = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prev;
  }
}

let windowsSandboxPatched = false;
export function ensureWindowsSandboxRunner(ctx) {
  if (process.platform !== "win32") return false;
  try {
    const sandbox = (ctx && ctx.sandbox) || (ctx && ctx.get && ctx.get("sandbox"));
    if (!sandbox || !sandbox.internals) return false;
    if (Array.isArray(sandbox.internals.windowsAclRunnerArgs) && sandbox.internals.windowsAclRunnerArgs.length > 0) return true;
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const candidates = [
      path.join(path.dirname(process.execPath), "resources"),
      path.join(localAppData, "Programs", "DeepSeek Harness", "resources"),
    ];
    const baseRes = withRawAsar(() => candidates.find((d) => fs.existsSync(path.join(d, "app.asar"))));
    if (!baseRes) return false;
    const dshNode = path.join(baseRes, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe");
    const asarFile = path.join(baseRes, "app.asar");
    if (!withRawAsar(() => fs.existsSync(dshNode) && fs.existsSync(asarFile))) return false;
    const realTmp = (process.env.LOCALAPPDATA && fs.existsSync(path.join(process.env.LOCALAPPDATA, "Temp")))
      ? path.join(process.env.LOCALAPPDATA, "Temp")
      : os.tmpdir();
    const asarMtime = withRawAsar(() => fs.statSync(asarFile).mtimeMs);
    const cacheRoot = path.join(realTmp, "dsh-prime-asar-cache-" + asarMtime);
    const cachedNm = path.join(cacheRoot, "dsh", "node_modules");
    const runnerPath = path.join(cachedNm, "@deepseek-ai", "dsh-sandbox-windows-acl", "lib", "runner.js");
    if (!fs.existsSync(runnerPath)) {
      withRawAsar(() => {
        const fd = fs.openSync(asarFile, "r");
        try {
          const hdr = Buffer.alloc(16);
          fs.readSync(fd, hdr, 0, 16, 0);
          const headerSize = hdr.readUInt32LE(4), jsonSize = hdr.readUInt32LE(12);
          const jsonBuf = Buffer.alloc(jsonSize);
          fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
          const tree = JSON.parse(jsonBuf.toString("utf8"));
          const dataBase = 8 + headerSize;
          const nmNode = tree?.files?.dsh?.files?.node_modules;
          if (nmNode?.files) {
            const extractNode = (node, relPath) => {
              if (node.files) {
                for (const [k, child] of Object.entries(node.files)) {
                  if (k === ".bin" || /\.(node|wasm|dll|exe)$/i.test(k)) continue;
                  extractNode(child, path.join(relPath, k));
                }
                return;
              }
              if (!/\.(c?js|mjs|json)$/i.test(relPath)) return;
              const dest = path.join(cachedNm, relPath);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              if (node.unpacked) {
                const src = path.join(baseRes, "app.asar.unpacked", "dsh", "node_modules", relPath);
                if (fs.existsSync(src)) fs.copyFileSync(src, dest);
                return;
              }
              const size = Number(node.size || 0), offset = dataBase + Number(node.offset || 0);
              const buf = Buffer.alloc(size);
              fs.readSync(fd, buf, 0, size, offset);
              fs.writeFileSync(dest, buf);
            };
            extractNode(nmNode, "");
          }
        } finally {
          fs.closeSync(fd);
        }
      });
    }
    const unpackedNm = path.join(baseRes, "app.asar.unpacked", "dsh", "node_modules");
    for (const mod of ["@koromix", "koffi"]) {
      const src = path.join(unpackedNm, mod), dst = path.join(cachedNm, mod);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.cpSync(src, dst, { recursive: true, force: true }); } catch {}
      }
    }
    if (!fs.existsSync(runnerPath)) return false;
    sandbox.internals.windowsAclRunnerArgs = [dshNode, runnerPath];
    windowsSandboxPatched = true;
    return true;
  } catch (err) {
    try { ctx?.logger?.warn?.("[dsh-prime] ensureWindowsSandboxRunner failed: " + (err?.message || err)); } catch {}
    return false;
  }
}

export function apply(ctx, config) {
  ensureWindowsSandboxRunner(ctx);
  const cfg = Object.assign(loadConfig(), config || {});
  if (SCOPES.includes(cfg.defaultScope)) saveConfig({ defaultScope: cfg.defaultScope });

  /* The prompt section lives in the preset half (`./tool.js`): it names a tool
   * only that half mounts, and prompt sections are scope-aware, so registering
   * here would instruct every mode in the process — redteam included — to call
   * a tool it does not have. */
  ctx.commands.register({
    name: "refine",
    description: "Record a durable finding in the prime continual harness (scoped session|workspace).",
    /* A refinement pass outlives the invocation: the row stays live (and
     * shimmering) until the turn it started settles, then settles once with
     * `command/done`. Every other branch returns a plain result and settles
     * immediately. The started pass appends `command/run` before this handler
     * runs, so the shimmer begins at once rather than only after the turn. */
    handler: (invocation) => {
      const agent = invocation && invocation.agent;
      const rawInput = invocation && invocation.rawInput;
      /* Only a bare `/refine` is a pass, and only a pass can be forked. Flag
       * queries (`--list`, `--snapshots`, …) stay synchronous and local, and so does
       * `/refine global` — it parses to an empty body but is a removed-scope
       * error, not a pass. */
      const parsed = parseRefine(rawInput);
      if (parsed.body === "" && parsed.removed === null && agent && forkService(ctx)) {
        /* The fork path: one row, shimmering until the child settles, and no
         * second turn because the child delivers to its caller. */
        return runForkedPass(ctx, agent, invocation.signal, parsed.scope);
      }
      /* Compare identity across the call: `/refine --list` while a pass is in
       * flight must NOT park on that pass. Only a waiter this invocation created
       * is the one to await. */
      const before = passSettled(agent);
      const result = refine(rawInput, agent);
      const after = passSettled(agent);
      /* `dsh-commands` awaits `Promise.resolve(output)` either way, so returning
       * the bare result for every non-pass branch costs nothing and keeps when
       * the row settles obvious. */
      return after && after !== before ? after.then(() => result) : result;
    },
  });

  /* Compaction survival: entries are on disk; this re-injects + offers auto-refine. */
  try { goalsApi = ctx.get ? ctx.get("goals") : null; } catch { goalsApi = null; }

  ctx.on("session/event", (session, event) => {
    if (!session) return;
    /* Every event, before any filtering: this is what lets the settings panel
     * name the folder it is showing instead of guessing from the process cwd. */
    rememberSession(session);
    if (!windowsSandboxPatched) ensureWindowsSandboxRunner(ctx);
    if (!event) return;
    /* Bind a pass to the exact turn it opens. The first `turn/start` after the
     * message was queued is that turn: `followup` either wakes the driver with
     * it or parks it as the next turn, and nothing else may interleave. */
    if (event.type === "turn/start") {
      const key = scopeKey("session", { session });
      if (refining.has(key) && !refineTurns.has(key)) refineTurns.set(key, event.data && event.data.turn);
      return;
    }
    /* The pass is over once its turn ends, which re-arms `/refine`. Re-arming on
     * `turn/start` would clear the slot before the pass had even run. */
    if (event.type === "turn/end") {
      const key = scopeKey("session", { session });
      /* A turn ending while a pass is in flight IS the pass. Every other settled
       * turn is the operator's, and only those justify another pass. */
      if (!refining.has(key)) {
        settledTurns.set(key, (settledTurns.get(key) || 0) + 1);
        if (settledTurns.size > 256) {
          for (const [k, n] of settledTurns) if (n === 0) settledTurns.delete(k);
        }
      }
      const passTurn = refineTurns.get(key);
      const endedTurn = event.data && event.data.turn;
      const isPass = refining.has(key) && (passTurn === undefined || passTurn === endedTurn);
      refining.delete(key);
      /* A pass waiting on its turn to begin is NOT released by an operator turn
       * ending — that would settle the row before the work ran. A pass whose turn
       * was never bound is released, or a cancelled start would shimmer forever. */
      if (isPass) releaseRefinement(key);
      return;
    }
    if (event.type !== "compaction/end") return;
    /* surface replacement lands after compaction/end; defer one microtask batch. */
    Promise.resolve().then(() => {
      try { onCompaction(ctx, session); } catch { /* never break the event feed */ }
    });
  });

  /* Resolve `webServer` inside the effect, never during apply. This plugin
   * activates while the root bootstrap is still walking the bundle list, and the
   * host webserver is declared later in that same list — so at apply time the
   * lookup returns null and a route registered here is silently never mounted.
   * Measured, not assumed: a diagnostic printed `webServer=NULL` on every boot
   * while `/prime/api` answered 405 from the static fallback. */
  ctx.effect(() => {
    ensureWindowsSandboxRunner(ctx);
    const server = ctx.webServer;
    if (!server || typeof server.register !== "function") {
      /* Reached only by a deployment with no host webserver at all. The settings
       * panel is the only consumer, so the mode still works; say so once. */
      try { ctx.logger.warn("prime: no webServer service; the settings panel route is not mounted"); } catch { /* no logger */ }
      return;
    }
    const dispose = server.register({
      kind: "exact",
      path: API_PATH,
      handler: (req, res) => handleApi(ctx, req, res),
    });
    return () => {
      if (typeof dispose === "function") dispose();
      disposeAllRepls();
    };
  }, "prime: /prime/api route");
}
