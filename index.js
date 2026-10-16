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
  "Each line starts with its 8-character ref. When an entry is wrong or no longer holds, UPDATE it by that ref or DELETE it — never record a second entry beside it. Two entries that disagree are worse than one that is stale.",
  "Record durable facts with `harness_refine` in the same turn the operator states them — a preference, a correction, a constraint, a reusable tactic. Do not wait for `/refine` or for compaction: what stays only in the conversation is lost when the history is condensed.",
  "Scope each one: workspace for a rule about this codebase, session for this conversation.",
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
/* The middle scope's on-disk key still says `project-`. Renaming it would orphan
 * every existing `project-<sha1(cwd)>.json` file instead of reading it, which is
 * a worse trade than a filename that lags its label. */
const LEGACY_SCOPE_PREFIX = "project-";
/* The model records through this tool and never through the slash command:
 * only the operator can run a command, so the prompt and the tool must agree
 * on one name. Declared here because this module owns the shared surface. */
export const TOOL_NAME = "harness_refine";
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
function scopeKey(scope, agent) {
  if (scope === "workspace") {
    return LEGACY_SCOPE_PREFIX + crypto.createHash("sha1").update(sessionCwd(agent)).digest("hex").slice(0, 16);
  }
  let id = "default";
  try {
    if (agent && agent.session && typeof agent.session.id === "string") id = agent.session.id;
  } catch { /* no session */ }
  return "session-" + id.replace(/[^\w.-]/g, "_").slice(0, 80);
}
function scopeFile(scope, agent) {
  return path.join(rootDir(), scopeKey(scope, agent) + ".json");
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
  const tmp = file + "." + process.pid + ".tmp";
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
export function load(scope, agent) {
  const doc = readJson(scopeFile(normalizeScope(scope, "session"), agent), { entries: [] });
  const entries = Array.isArray(doc.entries) ? doc.entries.filter((e) => e && typeof e.text === "string") : [];
  return entries;
}
export function save(scope, agent, entries) {
  const resolved = normalizeScope(scope, "session");
  writeJson(scopeFile(resolved, agent), { version: 2, scope: resolved, entries });
}

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
    return entries.slice().sort((a, b) => b.createdAt - a.createdAt);
  }
  const scored = entries.map((e) => {
    const hay = String(e.text).toLowerCase();
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
    (Number(!!b.pinned) - Number(!!a.pinned)) || (b.createdAt - a.createdAt));
}

/** @returns `YYYY-MM-DD` for an entry timestamp, or empty when unusable. */
function entryDate(createdAt) {
  const at = Number(createdAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  try { return new Date(at).toISOString().slice(0, 10); } catch { return ""; }
}

export function render(entries, agent, extra) {
  const cfg = loadConfig();
  const out = ["## Continual harness (prime)", "", HARNESS_INSTRUCTION];
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
    const line = "- " + (ref ? ref + " " : "") + (date ? "[" + date + "] " : "") + e.text;
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

export function upsert(scope, agent, text, origin, evidence) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "empty refinement" };
  const entries = load(scope, agent);
  if (entries.some((e) => e.text === trimmed)) return { ok: false, error: "already recorded" };
  if (entries.length >= MAX_ENTRIES) return { ok: false, error: "harness full (" + MAX_ENTRIES + "); run /refine --clear" };
  const now = Date.now();
  entries.push({
    id: crypto.randomUUID(),
    text: trimmed,
    createdAt: now,
    updatedAt: now,
    origin: origin || "command",
    ...(evidence ? { evidence: String(evidence).trim() } : {}),
  });
  save(scope, agent, entries);
  return { ok: true, count: entries.length, scope };
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
export function updateEntry(scope, agent, ref, text, evidence) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { ok: false, error: "empty replacement text" };
  const located = locateEntry(agent, scope, ref);
  if (!located.ok) return located;
  const entries = load(located.scope, agent);
  const found = findEntry(entries, ref);
  if (!found.ok) return found;
  if (entries.some((e) => e !== found.entry && e.text === trimmed)) {
    return { ok: false, error: "another entry already says that" };
  }
  found.entry.text = trimmed;
  found.entry.updatedAt = Date.now();
  if (evidence) found.entry.evidence = String(evidence).trim();
  save(located.scope, agent, entries);
  return { ok: true, count: entries.length, scope: located.scope, ref: entryRef(found.entry) };
}

/**
 * Delete one entry.
 * @param scope - the harness layer.
 * @param agent - the session whose cwd/id keys that layer.
 * @param ref - the entry handle.
 * @returns `{ ok, error? }`.
 */
export function removeEntry(scope, agent, ref) {
  const located = locateEntry(agent, scope, ref);
  if (!located.ok) return located;
  const entries = load(located.scope, agent);
  const found = findEntry(entries, ref);
  if (!found.ok) return found;
  const kept = entries.filter((e) => e !== found.entry);
  save(located.scope, agent, kept);
  return { ok: true, count: kept.length, scope: located.scope, ref: entryRef(found.entry) };
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
    "If something is durable, make every edit in ONE call to `" + TOOL_NAME + "`. Each edit carries its own scope and the evidence that prompted it; an edit without evidence is refused.",
    "If an entry is now wrong, UPDATE it by its ref, or DELETE it. Do not add a second entry beside it: two entries that disagree are worse than one that is stale.",
    "Prefer no edit over a speculative one, and do not restate anything already in the harness.",
    "Do not narrate this pass: reply with one line saying what you changed, or that nothing was durable.",
  ].join("\n\n");
}

/**
 * Queue one refinement turn onto the agent's next turn.
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
  try {
    agent.followup({
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: refinementPrompt(lead) }],
      /* MessageSourceMap is a closed union, so an invented kind throws at the
       * session boundary; `user` is its only generic member. */
      source: { kind: "user" },
    });
  } catch (error) {
    refining.delete(key);
    return { ok: false, error: (error && error.message) || String(error) };
  }
  return { ok: true };
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
    return ok("harness (" + scope + "):\n" + rank(entries, agent).map((e) => "- " + e.text).join("\n"));
  }
  if (body === "--clear") {
    save(scope, agent, []);
    return ok("cleared harness (" + scope + ")");
  }
  /* A bare `/refine` is the refinement pass itself, not a usage error. */
  if (!body) {
    const queued = queueRefinement(agent, "Refine the continual harness now: review this conversation and record what should outlive it.");
    if (!queued.ok) return err("refine: " + queued.error);
    return ok("refining the " + scope + " harness; the result lands in /refine --list.");
  }
  if (body === "--help") return err(USAGE);
  if (body.startsWith("--")) return err("refine: unknown flag " + body.split(/\s+/)[0] + "\n" + USAGE);
  const r = upsert(scope, agent, body, "command");
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
function isLoopback(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function handleApi(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
  /* The desktop shell loops back on both transports; anything else is rejected. */
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  if (!isLoopback(req) && !hostLocal) return sendJson(res, 403, { ok: false, error: "cross-origin request rejected" });
  return readBody(req).then((raw) => {
    let req2 = {};
    try { req2 = raw.trim() ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { ok: false, error: "invalid json" }); }
    const cfg = loadConfig();
    /* Same alias handling as the command, so the panel and `/refine` cannot
     * disagree about which harness a scope names. `global` normalises to the
     * unknown bucket and therefore falls back to the configured default. */
    const scope = normalizeScope(req2.scope, cfg.defaultScope);
    /* Both panel scopes are keyed by the session, so both need one. A synthetic
     * agent carrying the resolved id and cwd is what `scopeKey` reads, which
     * keeps one resolution rule for the command and the panel alike. With no
     * session there is nothing honest to show, and the panel says so rather than
     * listing an unrelated folder's entries. */
    const active = resolveActiveSession(ctx);
    const agent = active === null ? null : { session: { id: active.id, header: { cwd: active.cwd } } };
    const withActive = (payload) => Object.assign({ active }, payload);
    switch (req2.op) {
      case "get": {
        /* With no session to key by, reading `session-default` would report whatever
         * an unrelated file happens to hold under the label of the current chat. */
        if (agent === null) return sendJson(res, 200, withActive({ ok: true, config: cfg, scope, scopes: SCOPES, entries: [], ranked: [] }));
        const entries = load(scope, agent);
        return sendJson(res, 200, withActive({ ok: true, config: cfg, scope, scopes: SCOPES, entries, ranked: rank(entries, agent).map((e) => e.id) }));
      }
      case "setScope":
        return sendJson(res, 200, withActive({ ok: true, config: saveConfig({ defaultScope: scope }) }));
      case "setAuto":
        return sendJson(res, 200, withActive({ ok: true, config: saveConfig({ autoRefineOnCompact: !!req2.value }) }));
      case "add": {
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        /* The operator typing it into the panel IS the evidence, so record that
         * rather than leaving the field absent on entries that have one. */
        const r = upsert(scope, agent, req2.text, "ui", req2.evidence || "added from the settings panel");
        return sendJson(res, r.ok ? 200 : 400, withActive(Object.assign({ ok: r.ok }, r, { entries: load(scope, agent) })));
      }
      case "remove": {
        const entries = load(scope, agent).filter((e) => e.id !== req2.id);
        save(scope, agent, entries);
        return sendJson(res, 200, withActive({ ok: true, entries }));
      }
      case "clear": {
        /* Clearing a scope that resolves to the wrong folder would delete the wrong
         * memory, so an unresolved target is refused rather than guessed at. */
        if (agent === null) return sendJson(res, 409, { ok: false, error: "no active session yet; open a chat first" });
        save(scope, agent, []);
        return sendJson(res, 200, withActive({ ok: true, entries: [] }));
      }
      default:
        return sendJson(res, 400, { ok: false, error: "unknown op" });
    }
  }).catch((e) => sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }));
}

/* ---------- plugin ---------- */

export function apply(ctx, config) {
  const cfg = Object.assign(loadConfig(), config || {});
  if (SCOPES.includes(cfg.defaultScope)) saveConfig({ defaultScope: cfg.defaultScope });

  /* The prompt section lives in the preset half (`./tool.js`): it names a tool
   * only that half mounts, and prompt sections are scope-aware, so registering
   * here would instruct every mode in the process — redteam included — to call
   * a tool it does not have. */
  ctx.commands.register({
    name: "refine",
    description: "Record a durable finding in the prime continual harness (scoped session|workspace).",
    handler: (invocation) => refine(invocation && invocation.rawInput, invocation && invocation.agent),
  });

  /* Compaction survival: entries are on disk; this re-injects + offers auto-refine. */
  try { goalsApi = ctx.get ? ctx.get("goals") : null; } catch { goalsApi = null; }

  ctx.on("session/event", (session, event) => {
    if (!session) return;
    /* Every event, before any filtering: this is what lets the settings panel
     * name the folder it is showing instead of guessing from the process cwd. */
    rememberSession(session);
    if (!event) return;
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
      refining.delete(key);
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
    };
  }, "prime: /prime/api route");
}
