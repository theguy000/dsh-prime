
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Isolate the store before importing the plugin. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-"));
process.env.DSH_HOME = tmp;

/* Relative, not an absolute path: a hardcoded location makes the suite test the
 * committed tree even when it is run from a copy, which silently defeats every
 * revert-proof check. */
const m = await import(new URL("../index.js", import.meta.url).href);

const mkAgent = (sid, cwd, msgs) => ({
  session: { id: sid, header: { cwd }, deriveMessages: () => msgs },
});

const u = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const a = mkAgent("s1", "C:/work/proj-a", [u("deploy the rust daemon to staging")]);
const b = mkAgent("s2", "C:/work/proj-a", [u("rust daemon crashes on startup")]);
const c = mkAgent("s3", "C:/work/other", [u("unrelated python work")]);

// --- scope isolation ---
assert.ok(m.refine("rust daemon deploy needs systemd unit", a).text.includes("recorded"));
assert.equal(m.load("session", a).length, 1);
assert.equal(m.load("session", b).length, 0, "session scope must not leak across sessions");
assert.equal(m.load("workspace", a).length, 0, "workspace store separate from session store");

m.refine("workspace workspace uses cargo layout", b);
assert.equal(m.load("workspace", b).length, 1);
assert.equal(m.load("workspace", a).length, 1, "same cwd shares the workspace layer");
assert.equal(m.load("workspace", c).length, 0, "different cwd is a different workspace");

// --- dedup + clear ---
assert.ok(m.refine("rust daemon deploy needs systemd unit", a).text.includes("already recorded"));
assert.ok(m.refine("--clear", a).text.includes("cleared"));
assert.equal(m.load("session", a).length, 0);

// --- retired spellings stay readable, not silently misrouted ---
// `project` was this layer's old name: the same file, so a note recorded under
// the old spelling is still what the operator meant.
assert.equal(m.load("project", a).length, 1, "the retired `project` spelling reads the workspace layer");
assert.ok(m.refine("session a note about the workspace layer", a).text.includes("recorded"));
assert.equal(m.load("workspace", a).length, 1, "a session note does not land in the workspace layer");
// `global` was removed outright: naming it reports a reason and writes nothing,
// rather than falling through to session and quietly recording in the wrong place.
{
	const gone = m.refine("global shared note", a);
	assert.equal(gone.kind, "error", "the removed scope is an error, not a silent write");
	assert.match(gone.text, /global scope was removed/);
	assert.match(gone.text, /global\.json/, "the error names where the old entries still are");
	assert.equal(m.load("session", a).length, 1, "the refused command recorded nothing");
	// `load("global")` normalises to the fallback, so the honest check is the file
	// itself: the removed layer must have no store here at all.
	assert.equal(fs.existsSync(path.join(tmp, "prime", "global.json")), false, "and never resurrected the removed layer");
}
assert.equal(m.normalizeScope("project", "session"), "workspace");
assert.equal(m.normalizeScope("global", "session"), "session", "a retired layer normalises to the fallback, never to itself");

// --- ranking: query-relevant entry must outrank an irrelevant newer one ---
const entries = [];
for (let i = 0; i < 6; i++) entries.push({ id: "x" + i, text: "filler note " + i, createdAt: Date.now() + i });
entries.push({ id: "hit", text: "rust daemon deploy needs systemd unit", createdAt: 1 });
const ranked = m.rank(entries, a);
assert.equal(ranked[0].id, "hit", "relevance beats recency, got " + ranked[0].id);

// --- ranking must read the operator's words, not the injected context ---
// A real session put all four of these in the last-4 window at once, pushing the
// operator's question out of it. The ranking then read the skill catalog as the
// query and demoted the entry that answered the question to fifth of seven.
{
	const injected = (source, text) => ({ role: "user", source: { kind: source }, content: [{ type: "text", text }] });
	const polluted = mkAgent("r9", "C:/work/proj-a", []);
	polluted.session.deriveMessages = () => [
		{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "what is the clients tab bar reserved for" }] },
		injected("runtime-context", "runtime policy sandbox approval file policy full access"),
		injected("skill-catalog", "code review plan design docs research widget scaffold exercise"),
		injected("time-context", "time sampled asia dhaka elapsed since preceding message"),
		injected("plugin:aegis", "aegis routing bootstrap fast path reason note skill discipline"),
	];
	const corpus = [
		{ id: "answer", text: "the clients tab bar is reserved for switching vpn clients", createdAt: 1 },
		{ id: "noise", text: "runtime policy sandbox approval skill catalog code review plan design", createdAt: 99 },
	];
	assert.equal(
		m.rank(corpus, polluted)[0].id,
		"answer",
		"injected context must not outrank the operator's own question",
	);
	// And a frame with no provenance still counts, so older logs do not go blind.
	const noSource = mkAgent("r10", "C:/work/proj-a", [{ role: "user", content: [{ type: "text", text: "rust daemon deploy" }] }]);
	assert.equal(m.rank([{ id: "h2", text: "rust daemon deploy needs systemd unit", createdAt: 1 }, { id: "n2", text: "unrelated", createdAt: 2 }], noSource)[0].id, "h2");
}

// --- the rendered section must be STABLE across conversation states ---
// Query-ranked ordering rewrites the section as the conversation moves, and a
// system prompt that changes invalidates the whole request prefix. Measured: a
// one-turn session composed two different prompts because the order shifted.
{
	const asksAboutRust = mkAgent("st1", "C:/work/proj-a", [u("rust daemon deploy needs systemd unit")]);
	const asksAboutCss = mkAgent("st2", "C:/work/proj-a", [u("unrelated chatter about css and layout")]);
	const corpus = [
		{ id: "old", text: "rust daemon deploy needs systemd unit", createdAt: 1000 },
		{ id: "new", text: "css layout prefers flex", createdAt: 9000 },
	];
	assert.equal(
		m.render(corpus, asksAboutRust),
		m.render(corpus, asksAboutCss),
		"the section must not depend on what the conversation currently says",
	);
	// Newest first, so a budget cut keeps what is most likely still true.
	const built = m.promptOrder(corpus).map((e) => e.id).join(",");
	assert.equal(built, "new,old");
	const pinned = m.promptOrder([
		{ id: "a", text: "x", createdAt: 9 },
		{ id: "b", text: "y", createdAt: 1, pinned: true },
	]).map((e) => e.id).join(",");
	assert.equal(pinned, "b,a", "a pinned entry stays on top");
	// And every rendered entry carries a date, so "may have changed since" is a
	// judgment the model can actually make.
	// Realistic ids: the line carries the 8-character handle the tool accepts.
	const dated = m.render([{ id: "aaaa1111bbbb", text: "a dated fact", createdAt: Date.UTC(2026, 9, 17) }], asksAboutCss);
	assert.match(dated, /- aaaa1111 \[2026-10-17\] a dated fact/);
	// An entry with no usable timestamp still renders, without a broken date.
	const undated = m.render([{ id: "cccc2222dddd", text: "an undated fact", createdAt: 0 }], asksAboutCss);
	assert.match(undated, /^- cccc2222 an undated fact$/m);
}

// --- pinned wins, out-of-scope text ignored ---
const r2 = m.rank([{ id: "p", text: "zzz nothing", createdAt: 2, pinned: true }, { id: "h", text: "rust daemon", createdAt: 3 }], a);
assert.equal(r2[0].id, "p");

// --- render: the capture instruction is unconditional; entries are budgeted on top ---
assert.match(m.render([], a), /^## Continual harness \(prime\)/);
assert.match(m.render([], a), /harness_refine/, "an empty harness still instructs capture");
assert.ok(!m.render([], a).includes("Established:"), "an empty harness lists nothing");
assert.match(m.render(entries, a), /Established:/, "entries land under an Established heading");
/* The section must claim its entries are settled. A section that only explains how
 * to record reads as a notebook, and a session that had the answer in front of it
 * still went to grep the repository for it. */
assert.match(m.render([], a), /Treat them as already verified/, "the section asserts its entries are settled");
assert.match(m.render([], a), /instead of re-deriving|rather than re-deriving/, "and says what a hit means: answer from it");
assert.ok(m.render(entries, a).includes("rust daemon deploy needs systemd unit"));

// --- config round-trip and scope validation ---
assert.equal(m.loadConfig().defaultScope, "session");
assert.equal(m.saveConfig({ defaultScope: "workspace" }).defaultScope, "workspace");
assert.equal(m.saveConfig({ defaultScope: "bogus" }).defaultScope, "session", "invalid scope falls back");
m.saveConfig({ defaultScope: "session" });

// --- corrupt store must not throw ---
// Scopes are emptied through the flag, so nothing here depends on whatever a
// previous stage happened to leave set as the default.
m.refine("session --clear", a);
m.refine("workspace --clear", a);
assert.deepEqual(m.load("session", a), []);
assert.deepEqual(m.load("workspace", a), []);
fs.mkdirSync(path.join(tmp, "prime"), { recursive: true });
fs.writeFileSync(path.join(tmp, "prime", "config.json"), "{ not json");
assert.equal(m.loadConfig().defaultScope, "session", "a corrupt config falls back to session");
assert.deepEqual(m.load("session", a), [], "a corrupt config leaves stores readable");
assert.equal(m.render([], a).includes("harness_refine"), true, "and still renders the capture instruction");

// --- snapshots, diff, rollback, pin, and 4 component kinds ---
{
	m.refine("session --clear", a);
	m.refine("session first durable fact", a);
	m.refine("session second durable fact", a);
	assert.equal(m.load("session", a).length, 2);
	assert.ok(m.loadSnapshots("session", a).length >= 2, "each mutation records a before/after snapshot");
	assert.match(m.refine("session --snapshots", a).text, /snapshots \(session\):/);

	// Diff and rollback are Settings/RPC operations, not slash flags: a snapshot
	// needs a ref, and a slash command cannot carry one. The functions below are
	// the same ones `/prime/api` calls.
	assert.match(m.diffSnapshot("session", a).text, /\+ [0-9a-f]{8} second durable fact/);

	const rb = m.rollbackSnapshot("session", a);
	assert.equal(rb.ok, true);
	assert.equal(m.load("session", a).length, 1);
	assert.equal(m.load("session", a)[0].text, "first durable fact");

	const rbUndo = m.rollbackSnapshot("session", a);
	assert.equal(rbUndo.ok, true);
	assert.equal(m.load("session", a).length, 2);

	const ref0 = m.entryRef(m.load("session", a)[0]);
	assert.equal(m.refine("session --pin " + ref0, a).kind, "success");
	assert.equal(m.load("session", a)[0].pinned, true);
	assert.equal(m.refine("session --unpin " + ref0, a).kind, "success");
	assert.equal(Boolean(m.load("session", a)[0].pinned), false);
	assert.equal(m.refine("session --edit " + ref0 + " first durable fact updated", a).kind, "success");
	assert.equal(m.load("session", a)[0].text, "first durable fact updated");
	assert.equal(m.refine("session --delete " + ref0, a).kind, "success");
	assert.equal(m.load("session", a).length, 1);

	m.upsert("session", a, "Always verify schemas before committing.", "tool", "operator rule", { kind: "prompt" });
	m.upsert("session", a, "Run cargo check --workspace before tests.", "tool", "workflow", { kind: "skill", name: "cargo-verify" });
	m.upsert("session", a, "Security reviewer focusing on auth boundaries.", "tool", "team", { kind: "subagent", name: "sec-reviewer" });
	const renderedKinds = m.render(m.load("session", a), a);
	assert.match(renderedKinds, /\[prompt\] Always verify schemas before committing\./);
	assert.match(renderedKinds, /\[skill:cargo-verify\] Run cargo check --workspace before tests\./);
	assert.match(renderedKinds, /\[subagent:sec-reviewer\] Security reviewer focusing on auth boundaries\./);
	m.refine("session --clear", a);
}

console.log("ALL PRIME CHECKS PASSED");
console.log("files:", fs.readdirSync(path.join(tmp, "prime")).sort().join(", "));
