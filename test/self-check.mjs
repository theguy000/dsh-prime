/**
 * Runnable check for the two things generated code can get wrong here: the
 * durable store round-trip behind `/refine`, and the shape of the mode's patch.
 * Run: node test/self-check.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Same resolution as validate-patch.mjs, so the shared checks below import real
 * harness packages rather than fixtures. */
function resolveDshAppDir() {
	if (process.env.DSH_APP_DIR && fs.existsSync(process.env.DSH_APP_DIR)) return process.env.DSH_APP_DIR;
	const baseRes = path.join(
		process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
		"Programs",
		"DeepSeek Harness",
		"resources",
	);
	const unpackedApp = path.join(baseRes, "app", "dsh", "node_modules");
	if (fs.existsSync(unpackedApp)) return unpackedApp;
	const asarFile = path.join(baseRes, "app.asar");
	const withRawAsar = (fn) => { const p = process.noAsar; process.noAsar = true; try { return fn(); } finally { process.noAsar = p; } };
	if (withRawAsar(() => fs.existsSync(asarFile))) {
		const cacheRoot = path.join(os.tmpdir(), "dsh-prime-asar-cache-" + withRawAsar(() => fs.statSync(asarFile).mtimeMs));
		const cachedNm = path.join(cacheRoot, "dsh", "node_modules");
		if (fs.existsSync(path.join(cachedNm, "@deepseek-ai", "dsh-tools", "lib", "index.js"))) return cachedNm;
		const prevNoAsar = process.noAsar; process.noAsar = true;
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
				return cachedNm;
			}
		} finally {
			fs.closeSync(fd);
			process.noAsar = prevNoAsar;
		}
	}
	return unpackedApp;
}
const APP = resolveDshAppDir();

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prime-check-"));
process.env.DSH_HOME = temp;

const { apply, inject, name, loadConfig } = await import("../index.js");

const registered = { commands: [], sections: [], events: [], effects: [], routes: [], warns: [] };
const services = {
	goals: { get: () => ({ objective: "ship the scoped harness" }) },
};
/* `webServer` arrives as a PROPERTY because this plugin now declares it in
 * `inject`: cordis resolves an injected service onto the context and hands the
 * plugin nothing else. A fake `ctx.get("webServer")` would fake success and hide
 * the very failure that shipped — the route silently never mounted, and the
 * panel answered 405 from the static fallback for every request. */
const ctx = {
	systemPrompt: { section: (s) => void registered.sections.push(s) },
	commands: { register: (d) => void registered.commands.push(d) },
	on: (type, handler) => void registered.events.push({ type, handler }),
	effect: (fn) => void registered.effects.push(fn),
	webServer: { register: (route) => (registered.routes.push(route), () => void registered.routes.pop()) },
	logger: { warn: (m) => void registered.warns.push(String(m)) },
	get: (id) => services[id],
};

apply(ctx);

// The host half registers the command and the http route, and nothing else: the
// prompt section belongs to the preset half, so a mode without the tool never
// receives an instruction naming one.
assert.equal(name, "prime-memory");
/* Array form is load-bearing: an object inject is a name->config map in cordis,
 * so {required, optional} would wait forever on literal "required"/"optional" services. */
/* `webServer` must be DECLARED, not probed. An undeclared service is absent from
 * the context, so `ctx.get("webServer")` returned undefined during boot and the
 * route below never registered — the failure reproduced against a live harness. */
assert.deepEqual(inject, ["commands", "webServer"]);
assert.equal(registered.commands.length, 1);
assert.equal(registered.sections.length, 0, "the section belongs to the preset half");
assert.equal(registered.effects.length, 1, "the http route is registered and disposed through ctx.effect");
/* Effects are lazy: the service lookup happens when this runs, not in apply(). */
const dispose = registered.effects[0]();
assert.equal(registered.routes.length, 1, "the route mounts when the effect runs");
assert.equal(typeof dispose, "function", "the effect returns a disposer");
assert.equal(registered.routes[0].kind, "exact");
assert.equal(registered.routes[0].path, "/prime/api");

// The agent half is a separate preset row; its definition is hand-built because a
// linked plugin cannot resolve `@deepseek-ai/dsh-tools`, so assert the shape
// `tools.register` validates and that a round-trip actually writes.
const toolDefs = [];
const toolSections = [];
const { apply: applyTool, inject: toolInject, name: toolName } = await import("../tool.js");
assert.equal(toolName, "prime-tool");
assert.deepEqual(toolInject, ["tools", "systemPrompt"]);
applyTool({
  tools: { register: (definition) => void toolDefs.push(definition) },
  systemPrompt: { section: (definition) => void toolSections.push(definition) },
});
assert.equal(toolDefs.length, 2, "the preset half registers harness_refine and python_repl");
assert.equal(toolSections.length, 1, "the preset half owns the prompt section");
const tool = toolDefs[0];
const replTool = toolDefs[1];
const section = toolSections[0];

const agent = { session: { id: "s1", header: { cwd: "C:/work/proj" }, deriveMessages: () => [] } };
/* Mirrors dsh-commands' normalizeResult: the registry rejects a bare string,
 * and an error result must carry non-empty text. Guards the contract that
 * broke `/refine` with `handler must return a CommandResult`. */
const asCommandResult = (value) => {
	assert.equal(typeof value, "object", "a command handler must return a CommandResult object");
	assert.ok(value && "kind" in value, "a CommandResult must carry `kind`");
	assert.ok(value.kind === "success" || value.kind === "error", `unknown CommandResult kind ${String(value.kind)}`);
	assert.equal(typeof value.text, "string", "CommandResult text must be a string");
	if (value.kind === "error") assert.ok(value.text.trim().length > 0, "error text must be non-empty");
	return value.text;
};
assert.throws(() => asCommandResult("a bare string"), /CommandResult/, "the guard itself must reject a bare string");
const refine = (rawInput, a = agent) => asCommandResult(registered.commands[0].handler({ rawInput, agent: a }));

assert.equal(registered.commands[0].name, "refine");
/* A bare `/refine` runs a refinement pass rather than printing usage: it queues
 * one turn telling the agent to record findings, and refuses to stack a second
 * while that pass is in flight. */
{
	const sent = [];
	/* The real driver opens the turn *synchronously* from inside `followup` — the
	 * session log reads agent/inbox/spliced -> turn/start -> command/done — so the
	 * slot must be claimed before followup, and re-armed when the turn ends. */
	const emit = (event) => registered.events.find((e) => e.type === "session/event").handler({ id: "s1" }, event);
	const runnable = {
		...agent,
		followup: (message) => {
			sent.push(message);
			emit({ type: "turn/start" });
		},
	};

	assert.match(refine("", runnable), /^refining the session harness/);
	assert.equal(sent.length, 1, "the pass is queued exactly once");
	assert.equal(sent[0].role, "user");
	assert.equal(sent[0].source.kind, "user", "MessageSourceMap is closed, so an invented kind throws");
	assert.match(sent[0].content[0].text, /harness_refine/, "the pass names the tool that records findings");
	assert.match(sent[0].content[0].text, /ONE call/, "the pass must ask for a single batch call");
	/* The prompt section already carries the digest on every assembly, so the pass
	 * must not repeat it. */
	assert.ok(!/Current harness digest|## Continual harness/.test(sent[0].content[0].text), "the pass must not duplicate the digest");
	assert.match(refine("", runnable), /already queued/, "an in-flight pass cannot be stacked");
	emit({ type: "turn/end" });
	assert.match(refine("", runnable), /^refining the session harness/, "the pass finishing re-arms the command");
	emit({ type: "turn/end" });
	assert.equal(sent.length, 2);
}
assert.match(refine("--help"), /^usage:/);
assert.match(refine("--nope"), /unknown flag/, "a typo must not become a recorded note");

/* ---- the post-compaction hook only refines the preset that mounts the harness ----
 * The hook is registered on the *root* plane because the `/refine` command is,
 * and cordis reaches every listener whose scope does not carry a filter: a
 * session event publishes with `entry.emitCtx`, and `EventsService.dispatch`
 * only applies `Context.filter` when the dispatch carries a filtered `this`.
 * So the registration cannot scope itself and the handler must gate on the
 * session's own preset — otherwise `/compact` in `standard` or `ptc` injected a
 * refinement turn into a mode with no harness and no `harness_refine` tool. */
{
	const { presetOf, onCompaction, PRESET_ID } = await import("../index.js");
	assert.equal(PRESET_ID, "prime");

	/* The projection the registry actually writes, used as the fixture so the key
	 * cannot drift from the package that owns it. */
	const { agentPresetProjectionDefinition } = await import(
		pathToFileURL(path.join(APP, "@deepseek-ai", "dsh-agent-preset-registry", "lib", "index.js")).href,
	);
	assert.equal(agentPresetProjectionDefinition.key, "agentPreset", "the gate reads the registry's own projection key");
	/* A session that switched preset while still blank reports the composition it
	 * really mounted, which is why the projection is read instead of the header. */
	assert.equal(agentPresetProjectionDefinition.init({ agentPreset: "ptc" }), "ptc");
	assert.equal(agentPresetProjectionDefinition.apply("ptc", { type: "agent-preset/selected", data: { agentPreset: "prime" } }), "prime");
	assert.equal(agentPresetProjectionDefinition.init({}), null, "a header without a preset projects null");

	const warns = [];
	const mkCtx = (projections) => ({
		logger: { warn: (m) => void warns.push(m) },
		get: (id) => (id === "agents" ? { get: () => undefined } : undefined),
		...(projections ? { sessionProjections: projections } : {}),
	});
	const atPreset = (id) => ({ stateOf: (_session, key) => (key === "agentPreset" ? id : undefined) });

	/* The gate itself, over every shipped preset. */
	for (const preset of ["standard", "ptc", "minimal", "cordis"]) {
		assert.notEqual(preset, PRESET_ID);
		assert.equal(presetOf(mkCtx(atPreset(preset)), null, { id: "s" }), preset);
	}
	assert.equal(presetOf(mkCtx(atPreset("prime")), null, { id: "s" }), "prime");
	/* No projection API at all is reported distinctly from "another preset": it means
	 * auto-refine is dead for every session, which must not pass in silence. */
	assert.equal(presetOf(mkCtx(null), null, { id: "s" }), null);
	assert.equal(presetOf(mkCtx({}), null, { id: "s" }), null);
	/* The fallback: the projection has no opinion yet (a session whose projections
	 * are still warming), so the registry is asked which mount the agent joined. */
	const presetsApi = (id) => ({ composedPreset: () => id });
	const withPresets = (id, projections) => ({
		logger: { warn: () => {} },
		get: (name) => (name === "agentPresets" ? presetsApi(id) : undefined),
		...(projections === undefined ? {} : { sessionProjections: projections }),
	});
	assert.equal(presetOf(withPresets("prime", { stateOf: () => null }), null, { id: "s" }), "prime", "a null projection falls back to the mount lookup");
	assert.equal(presetOf(withPresets("ptc", { stateOf: () => null }), null, { id: "s" }), "ptc");
	assert.equal(presetOf(withPresets("prime", null), null, { id: "s" }), "prime", "no projection registry at all still falls back");
	/* A projection that answers must win over the mount lookup, since it is the
	 * value the mode picker shows. */
	assert.equal(presetOf(withPresets("ptc", atPreset("prime")), null, { id: "s" }), "prime");

	const followups = [];
	/* One agent per session, keyed by id, so the per-session cooldown is exercised
	 * rather than one agent standing in for all of them. */
	const liveAgents = new Map();
	for (const sid of ["s1", "s2", "s3"]) {
		liveAgents.set(sid, { session: { id: sid }, followup: (m) => void followups.push({ sid, m }) });
	}
	const liveCtx = (preset, sid = "s1") => ({
		logger: { warn: (m) => void warns.push(m) },
		sessionProjections: atPreset(preset),
		get: (id) => (id === "agents" ? { get: (want) => liveAgents.get(want) } : undefined),
	});

	/* The exact bug: `/compact` in a PTC session must not queue a refinement. */
	onCompaction(liveCtx("ptc"), { id: "s1" });
	assert.equal(followups.length, 0, "a ptc session must not be refined");
	assert.deepEqual(warns, [], "another preset is not a warning");
	onCompaction(liveCtx("standard"), { id: "s1" });
	assert.equal(followups.length, 0, "a standard session must not be refined");

	/* Settled operator turns, which is what opens the review gate. A `turn/end`
	 * reaching the handler is a turn the operator's activity produced. */
	const sessionEvent = registered.events.filter((e) => e.type === "session/event").pop().handler;
	const settle = (sid) => sessionEvent({ id: sid }, { type: "turn/end" });

	/* The review gate: a pass earns a whole turn only when the operator has said
	 * something since the last one. A fresh session proves it — nothing has set
	 * this session's cooldown yet, so the gate is the only thing that can refuse. */
	onCompaction(liveCtx("prime", "s3"), { id: "s3" });
	assert.equal(followups.length, 0, "nothing new since the last pass means no pass");
	settle("s3");
	onCompaction(liveCtx("prime", "s3"), { id: "s3" });
	assert.equal(followups.length, 1, "a settled operator turn opens the gate");
	assert.equal(followups[0].sid, "s3");
	assert.match(followups[0].m.content[0].text, /^\[prime auto-refine\] Context was compacted\./);
	assert.match(followups[0].m.content[0].text, /harness_refine/);
	assert.match(followups[0].m.content[0].text, /Decide first whether/, "the pass reviews before it records");

	/* The 20-minute window is per session: one session compacting must not spend
	 * another session's cooldown, and must not re-arm its own. */
	onCompaction(liveCtx("prime", "s3"), { id: "s3" });
	assert.equal(followups.length, 1, "a second compaction inside the window is not re-queued");
	settle("s2");
	onCompaction(liveCtx("prime", "s2"), { id: "s2" });
	assert.equal(followups.length, 2, "the cooldown is per session, not per process");
	assert.equal(followups[1].sid, "s2");

	/* An unresolvable preset means auto-refine is dead everywhere, so it says so
	 * rather than failing quietly. */
	const before = warns.length;
	const queuedSoFar = followups.length;
	settle("s1");
	onCompaction(mkCtx(null), { id: "s1" });
	assert.equal(followups.length, queuedSoFar, "no preset means no refinement");
	assert.equal(warns.length, before + 1, "an unresolvable preset is reported");
	assert.match(warns[before], /could not be resolved/);

	/* A manual `/refine` is not gated: the operator asking IS the reason, and a
	 * session with no settled turns proves the gate is not what let it through. */
	const manual = { session: { id: "manual-1" }, followup: (m) => void followups.push({ sid: "manual-1", m }) };
	assert.match(refine("", manual), /^refining the session harness/, "a manual pass skips the review gate");
}
assert.equal(registered.commands[0].handler({ rawInput: "", agent }).kind, "error", "no live agent is a reported error, not a string");
assert.equal(section.name, "prime:continual-harness");
assert.ok(Number.isFinite(section.order));
/* An empty harness is exactly when the capture instruction matters most, so the
 * section renders unconditionally rather than costing nothing while empty. */
assert.match(section.text({ agent }), /harness_refine/, "an empty harness still carries the instruction");
assert.match(section.text({ agent }), /lost when the history is condensed/, "and says why it cannot wait");
assert.match(section.text({ agent: null }), /harness_refine/, "a missing agent still renders the instruction");

// Ranking parity: the goal objective (weight 3.0) beats an unrelated recent message.
{
	const gAgent = {
		session: {
			id: "g1",
			header: { cwd: "C:/work/proj" },
			deriveMessages: () => [{ role: "user", content: [{ type: "text", text: "unrelated chatter about css" }] }],
		},
	};
	refine("scoped harness ship checklist", gAgent);
	assert.equal(refine("--list", gAgent).split("\n").pop(), "- scoped harness ship checklist");
	refine("--clear", gAgent);
}

assert.match(refine("--help"), /^usage:/);
assert.match(refine("--list"), /is empty/);
assert.match(refine("Prefer composition over new code."), /recorded in session harness \(1\/200\)/);
assert.match(refine("Prefer composition over new code."), /already recorded/);

const rendered = section.text({ agent });
assert.match(rendered, /## Continual harness/);
assert.match(rendered, /Prefer composition over new code\./);

// Entries are objects on disk (so they carry ids and timestamps for ranking).
const store = JSON.parse(fs.readFileSync(path.join(temp, "prime", "session-s1.json"), "utf8"));
assert.equal(store.entries.length, 1);
assert.equal(store.entries[0].text, "Prefer composition over new code.");
assert.ok(store.entries[0].id, "each entry carries an id");

// The scope defaults to session and is persisted for the settings UI to read back.
assert.equal(loadConfig().defaultScope, "session");

assert.match(refine("--clear"), /cleared harness/);
assert.match(section.text({ agent }), /harness_refine/, "clearing leaves the instruction in place");
assert.equal(refine("--list"), "harness (session) is empty");

// A corrupt store degrades to an empty section instead of throwing.
fs.writeFileSync(path.join(temp, "prime", "session-s1.json"), "{ not json");
assert.match(section.text({ agent }), /harness_refine/, "a corrupt store degrades to instruction-only");

// The mode patch declares one self-contained preset with the new plugin in it.
const patch = fs.readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
assert.match(patch, /id: preset-prime/);
assert.match(patch, /name: '@deepseek-ai\/dsh-agent-preset'/);
assert.match(patch, /id: prime\n(?:.|\n)*?order: 3/);
assert.match(patch, /name: 'dsh-prime'/);
/* Presentation is what makes this prime-agent's model rather than a native tool
 * loop: the agent writes code that calls tools. `mode: ptc` needs the
 * `ptcRuntime` service, so a deployment without it fails the whole preset. */
assert.match(patch, /dsh-agent-tool-presentation[\s\S]{0,140}mode: native/, "the mode must present tools natively so python_repl is a first-class tool");
for (const row of [
	"@deepseek-ai/dsh-tool-pwsh-persistent",
	"@deepseek-ai/dsh-tool-bash-persistent",
	"@deepseek-ai/dsh-terminal",
	"@deepseek-ai/dsh-workflow-ptc",
	"@deepseek-ai/dsh-tool-workflow",
	"@deepseek-ai/dsh-tool-ralph",
	"@deepseek-ai/dsh-tool-schedule",
	"@deepseek-ai/dsh-time-context",
	"@deepseek-ai/dsh-command-goal",
]) {
	assert.ok(patch.includes(row), `prime mode must mount ${row}`);
}
// Agent Teams would double-register `list_agents` and `interrupt_agent`, which the
// delegation group already owns, so the mode must not mount it.
assert.ok(!patch.includes("experimental-tool-agent-team"), "team tools collide with the global subagent controls");
assert.ok(!/\t/.test(patch), "patch file must use spaces, not tabs");

// The client half is discovered from package.json, not from the bundle patch.
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(manifest.dsh.client.platform, "web");
assert.equal(manifest.exports["./client"], "./client.js");
/* External rows are placed before this bundle; the atoms must be named there. */
assert.deepEqual(manifest.dsh.client.external, ["@deepseek-ai/dsh-client-ui-primitives"]);
const client = fs.readFileSync(new URL("../client.js", import.meta.url), "utf8");
assert.match(client, /__ModuleLoader__\.load/);
assert.match(client, /settings\.section/);
/* The panel uses the harness's own atoms rather than restyled native controls, so
 * a `<select>`/`<input type=checkbox>` creeping back in is a regression. */
assert.match(client, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/, "the panel loads the harness UI atoms");
assert.match(client, /SegmentedControl/, "the scope picker is the harness control");
assert.ok(!/<select|h\("select"/.test(client), "no restyled native select");
assert.ok(!/type: "checkbox"/.test(client), "no restyled native checkbox");
assert.ok(!/^import\s/m.test(client), "the client bundle must be a plain module-loader factory, not an ES module");
assert.ok(!/from "@deepseek-ai\//.test(client), "the client bundle must not import host packages at runtime");

// The definition is hand-built, so assert the shape `tools.register` validates
// and that one batch actually writes.
{
	assert.equal(tool.name, "harness_refine");
	assert.equal(typeof tool.output.render, "function", "tools.register requires output.render");
	assert.equal(tool.output.schema.type, "object");
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(tool.parameters.required, ["findings"], "one call carries the whole pass");
	/* The model cannot choose a layer. It guessed badly when it could — a real
	 * session split one sentence across both — and the choice belongs to the
	 * operator, who can see which memory they are looking at. */
	assert.equal(
		tool.parameters.properties.findings.items.properties.scope,
		undefined,
		"the tool must not offer a scope: the operator selects the layer",
	);
	const guidance = section.text({ agent });
	assert.match(guidance, /You do not choose where a fact is stored/);
	assert.match(guidance, /You always READ both layers/);
	/* And every rendering names the layer currently selected, or the model cannot
	 * report where a fact went. */
	assert.match(guidance, /New entries are saved to the (session|workspace) layer/);
	assert.ok(!/\bglobal\b/.test(guidance), "the removed layer is not advertised to the model");

	/** @returns the tool result for one batch, through the real execute(). */
	const run = (findings) => tool.execute({ findings }, { agent });
	/* Every edit carries evidence; a fixture without it is rejected by the gate. */
	const ev = (text, extra) => Object.assign({ action: "add", text, evidence: "the operator said so" }, extra || {});

	/* One call carries the whole pass, and a duplicate inside the batch is
	 * reported per finding rather than dropping or throwing the batch. */
	const out = run([
			ev("the probe records an entry"),
			ev("a second finding rides the same call"),
			ev("the probe records an entry"),
		]);
	assert.equal(out.recorded, 2, "both distinct findings are written by one call");
	assert.equal(out.skipped, 1, "the duplicate is counted, not silently dropped");
	assert.match(out.text, /already recorded/, "the skipped line names the reason");
	const blocks = tool.output.render({}, out);
	assert.ok(Array.isArray(blocks), "render returns content blocks, not a string");
	assert.deepEqual(blocks, [{ type: "text", text: out.text }], "each block is { type, text }");
	/* The exact expressions that consumed a bare string and threw
	 * `content.some is not a function`. */
	assert.ok(blocks.some((b) => b.type === "text" && b.text.length > 0), "presenters call .some() over the blocks");
	assert.ok(blocks.every((b) => b.type !== "text" || b.text.trim().length > 0), "text blocks must be non-empty");
	/* Every declared output field is present, so the return validates against its own schema. */
	assert.deepEqual(Object.keys(out).sort(), Object.keys(tool.output.schema.properties).sort());

	const allDup = run([ev("the probe records an entry")]);
	assert.equal(allDup.recorded, 0);
	assert.equal(allDup.skipped, 1);
	/* A missing scope falls back to the configured default, per finding. */
	assert.equal(run([ev("no explicit scope")]).recorded, 1);
	assert.match(tool.execute({ findings: [] }, { agent }).text, /findings was empty/);
	/* The ceiling lives in code because `maxItems` is outside the registry's
	 * supported JSON Schema subset, so the schema cannot express it. */
	const tooMany = run(Array.from({ length: 21 }, (_, i) => ev("finding " + i)));
	assert.equal(tooMany.recorded, 0, "an oversized batch writes nothing rather than half of itself");
	assert.match(tooMany.text, /exceeds the limit/);

	/* ---- the evidence gate ---- */
	/* A finding that cannot say what prompted it is a guess, and a store full of
	 * guesses is what makes the section stop being worth trusting. */
	{
		const noEvidence = run([{ action: "add", text: "unsupported claim" }]);
		assert.equal(noEvidence.recorded, 0, "an entry with no evidence is refused");
		assert.equal(noEvidence.skipped, 1);
		assert.match(noEvidence.text, /no evidence given/);
		assert.match(noEvidence.text, /unsupported claim/, "the refusal names what was refused");
		assert.equal(run([{ action: "add", text: "blank evidence", evidence: "   " }]).recorded, 0, "whitespace is not evidence");
	}

	/* ---- update and delete by ref ---- */
	/* The fix for a store holding two entries that contradict each other: correct
	 * the entry that is wrong instead of adding a third. */
	{
		const { load: loadStore, entryRef, saveConfig: setScope } = await import("../index.js");
		const fresh = { session: { id: "edit-1", header: { cwd: "C:/work/edit" }, deriveMessages: () => [] } };
		const scoped = (findings) => tool.execute({ findings }, { agent: fresh });

		/* The operator selects the layer; the tool no longer asks the model. */
		setScope({ defaultScope: "workspace" });
		/* A finding that names a layer anyway must be ignored, not honoured. Without
		 * this the suite cannot tell the two behaviours apart: nothing else in it
		 * passes a scope, so a build that let the model choose would pass too. */
		{
			/* Its own folder, so this probe cannot be confused with the block below. */
			const sneaky = { session: { id: "edit-sneak", header: { cwd: "C:/work/sneak" }, deriveMessages: () => [] } };
			tool.execute({ findings: [{ action: "add", text: "a model-chosen layer", evidence: "x", scope: "session" }] }, { agent: sneaky });
			assert.equal(loadStore("session", sneaky).length, 0, "the model cannot write to the other layer by naming it");
			assert.equal(loadStore("workspace", sneaky).length, 1, "it goes to the operator's selected layer instead");
		}
		scoped([{ action: "add", text: "the pool switch sits below the tab section", evidence: "operator" }]);
		const stored = loadStore("workspace", fresh);
		assert.equal(stored.length, 1);
		const ref = entryRef(stored[0]);
		assert.equal(ref.length, 8, "the rendered handle is 8 characters");
		const createdAt = stored[0].createdAt;

		/* The rendered line carries that exact handle, or the model cannot name it. */
		assert.ok(section.text({ agent: fresh }).includes(ref), "the section renders the ref the tool accepts");

		/* Update: same entry, corrected, with its history intact. */
		const upd = scoped([{ action: "update", ref, text: "the pool switch sits inside the client view", evidence: "operator corrected it" }]);
		assert.equal(upd.updated, 1);
		const after = loadStore("workspace", fresh);
		assert.equal(after.length, 1, "an update corrects in place rather than appending");
		assert.equal(after[0].text, "the pool switch sits inside the client view");
		assert.equal(after[0].id, stored[0].id, "the id survives");
		assert.equal(after[0].createdAt, createdAt, "so does the creation time");
		assert.ok(after[0].updatedAt >= createdAt, "and updatedAt moves");
		assert.equal(after[0].evidence, "operator corrected it");

		/* A full id works too, so a caller that pasted the long form is not punished. */
		assert.equal(scoped([{ action: "update", ref: stored[0].id, text: "by full id", evidence: "x" }]).updated, 1);

		/* An unknown ref is refused, never silently turned into an append. */
		const missing = scoped([{ action: "delete", ref: "deadbeef" }]);
		assert.equal(missing.deleted, 0);
		assert.match(missing.text, /no entry with ref/);
		assert.equal(loadStore("workspace", fresh).length, 1, "a failed edit changes nothing");

		/* Update still refuses to duplicate another entry's text. */
		scoped([{ action: "add", text: "a different fact", evidence: "operator" }]);
		const clash = scoped([{ action: "update", ref, text: "a different fact", evidence: "x" }]);
		assert.equal(clash.updated, 0);
		assert.match(clash.text, /already says that/);

		/* Delete takes exactly the named entry. */
		assert.equal(scoped([{ action: "delete", ref }]).deleted, 1);
		const left = loadStore("workspace", fresh);
		assert.equal(left.length, 1);
		assert.equal(left[0].text, "a different fact", "the wrong entry was not taken");
		/* Delete needs no evidence: removing something is not a claim. */
		assert.equal(scoped([{ action: "delete", ref: left[0].id.slice(0, 8) }]).deleted, 1);
		/* Restore the layer this file started on, so later blocks are not reading a
		 * setting this one changed. */
		setScope({ defaultScope: "session" });
		assert.equal(loadStore("workspace", fresh).length, 0);
	}

	/* ---- one bad edit does not sink the good ones ---- */
	{
		const mixed = run([ev("a good edit"), { action: "add", text: "a bad edit" }, ev("another good edit")]);
		assert.equal(mixed.recorded, 2, "the valid edits in a batch still land");
		assert.equal(mixed.skipped, 1, "and the invalid one is reported, not fatal");
		assert.deepEqual(Object.keys(mixed).sort(), Object.keys(tool.output.schema.properties).sort());
	}
}

// The settings UI talks to the plugin through this route only.
{
	const route = registered.routes[0];
	const invoke = async (body, opts = {}) => {
		const res = {
			status: 0,
			headers: null,
			payload: "",
			writeHead(status, headers) { this.status = status; this.headers = headers; },
			end(chunk) { this.payload = chunk; },
		};
		const req = {
			method: opts.method || "POST",
			headers: { host: opts.host || "127.0.0.1:19387" },
			socket: { remoteAddress: opts.remote || "127.0.0.1" },
			on(event, cb) {
				if (event === "data") cb(JSON.stringify(body));
				if (event === "end") cb();
				return req;
			},
		};
		await Promise.resolve(route.handler(req, res));
		return { status: res.status, json: JSON.parse(res.payload) };
	};

	const got = await invoke({ op: "get" });
	assert.equal(got.status, 200);
	assert.equal(got.json.config.defaultScope, "session");
	assert.deepEqual(got.json.scopes, ["session", "workspace"]);
	assert.ok(Array.isArray(got.json.entries) && Array.isArray(got.json.ranked), "get returns entries plus their ranking");

	/* The panel lists one layer while the agent reads all of them, so every response
	 * reports the count in each — otherwise an entry the operator cannot see reads as
	 * an entry that was never recorded. */
	{
		/* Counts are compared against their own baseline: earlier blocks in this file
		 * write to the same layers, so an absolute number would assert the fixture's
		 * history rather than the behaviour. */
		const beforeWs = (await invoke({ op: "get", scope: "workspace" })).json;
		/* Assert the field itself first, so a missing one fails by name instead of
		 * throwing a TypeError from the line below it. */
		assert.ok(beforeWs.counts, "every response reports each layer's count");
		assert.deepEqual(Object.keys(beforeWs.counts).sort(), ["session", "workspace"], "every layer is counted");
		const wsBefore = beforeWs.counts.workspace;
		const sessionBefore = beforeWs.counts.session;
		await invoke({ op: "add", scope: "session", text: "a session-only note" });
		const mixed = (await invoke({ op: "get", scope: "workspace" })).json;
		assert.equal(mixed.scope, "workspace", "the listed layer is still the requested one");
		assert.equal(mixed.counts.session, sessionBefore + 1, "the other layer's count follows its own store");
		assert.equal(mixed.counts.workspace, wsBefore, "and this layer is untouched by a write to the other");
		await invoke({ op: "clear", scope: "session" });
	}

	assert.equal((await invoke({ op: "add", scope: "workspace", text: "ui added note" })).status, 200);
	assert.equal((await invoke({ op: "get", scope: "workspace" })).json.entries.length, 1);
	assert.equal((await invoke({ op: "setScope", scope: "workspace" })).json.config.defaultScope, "workspace");
	assert.equal(loadConfig().defaultScope, "workspace", "scope choice persists to disk");
	assert.equal((await invoke({ op: "clear", scope: "workspace" })).json.entries.length, 0);
	/* `global` is gone: a stale panel or a habit must not resurrect the layer. */
	assert.equal((await invoke({ op: "get", scope: "global" })).json.scope, "workspace", "a removed scope falls back to the configured default");

	// Guardrails: wrong method, cross-origin, unknown op, bad json.
	assert.equal((await invoke({}, { method: "GET" })).status, 405);
	assert.equal((await invoke({ op: "get" }, { host: "evil.example", remote: "10.0.0.9" })).status, 403);
	assert.equal((await invoke({ op: "nope" })).status, 400);
	assert.equal((await invoke({ op: "add", text: "" })).status, 400, "an empty note is rejected");
}


/* ---- the settings panel must read the session the operator is in ----
 * The page is global while every store below `session` is keyed by a session or
 * a folder. Without resolution the panel fell back to the host process cwd and a
 * literal "default" session id, so `session` read `session-default.json` and
 * `workspace` read the application's launch directory. Both showed an empty
 * harness while the real store held entries — indistinguishable from data loss. */
{
	const { rememberSession, resolveActiveSession, load: loadStore } = await import("../index.js");
	const liveRoots = [];
	const panelCtx = {
		logger: { warn: () => {} },
		get: (id) => (id === "agents" ? { roots: () => liveRoots } : undefined),
	};
	const sessionEvent = registered.events.filter((e) => e.type === "session/event").pop().handler;
	const realSession = { id: "session-abc123", header: { cwd: "C:/work/real-workspace", createdAt: 1 } };

	/* Cold start: the event feed is empty at boot, so the live-agent fallback
	 * answers. A separate module instance is the only way to observe a fresh
	 * tracker without a test-only reset hatch in the shipped module. */
	const fresh = await import("../index.js?cold-start");
	const coldCtx = { get: (id) => (id === "agents" ? { roots: () => [{ session: realSession }] } : undefined) };
	assert.equal(fresh.resolveActiveSession(coldCtx).id, "session-abc123", "the fallback reads a live root agent");
	/* `sessionCwd` canonicalises, so compare against the resolved form. */
	assert.equal(fresh.resolveActiveSession(coldCtx).cwd, path.resolve("C:/work/real-workspace"), "and its cwd comes from the session header, never the process cwd");
	assert.equal(fresh.resolveActiveSession({ get: () => undefined }), null, "no registry and no feed resolves to nothing");
	assert.equal(fresh.resolveActiveSession({ get: () => ({ roots: () => [] }) }), null, "and an empty registry likewise");

	/* Warm: the event feed is authoritative and follows the newest activity. */
	/* And the feed outranks the registry once anything has fired. */
	liveRoots.push({ session: { id: "session-registry-only", header: { cwd: "C:/work/registry", createdAt: 99 } } });
	sessionEvent({ id: "session-older", header: { cwd: "C:/work/older" } }, { type: "turn/start" });
	assert.equal(resolveActiveSession(panelCtx).id, "session-older", "the newest activity wins");
	assert.notEqual(resolveActiveSession(panelCtx).id, "session-registry-only", "the feed outranks the cold-start fallback");
	sessionEvent(realSession, { type: "turn/start" });
	assert.equal(resolveActiveSession(panelCtx).id, "session-abc123", "and it follows activity back");
	rememberSession(null);
	rememberSession({ id: 5 });
	assert.equal(resolveActiveSession(panelCtx).id, "session-abc123", "a malformed session is ignored, not recorded");

	/* The route the panel calls resolves both scopes through that session. */
	const route = registered.routes[0];
	const panel = async (body) => {
		const res = { status: 0, payload: "", writeHead(s) { this.status = s; }, end(c) { this.payload = c; } };
		const req = {
			method: "POST",
			headers: { host: "127.0.0.1:19387" },
			socket: { remoteAddress: "127.0.0.1" },
			on(event, cb) { if (event === "data") cb(JSON.stringify(body)); if (event === "end") cb(); return req; },
		};
		await Promise.resolve(route.handler(req, res));
		return { status: res.status, json: JSON.parse(res.payload) };
	};

	const got = await panel({ op: "get", scope: "session" });
	assert.equal(got.json.active.id, "session-abc123", "the panel reports which session it read");
	assert.equal(got.json.active.cwd, path.resolve("C:/work/real-workspace"));

	/* A write lands in THIS session, never in a file named for a placeholder. */
	assert.equal((await panel({ op: "add", scope: "session", text: "recorded from the panel" })).status, 200);
	/* `scopeKey` reads `agent.session.id`, so the store helpers take an AGENT. */
	const realAgent = { session: realSession };
	assert.equal(loadStore("session", realAgent).length, 1, "the write reached the real session key");
	assert.equal(loadStore("session", { session: { id: "default" } }).length, 0, "and never a placeholder key");
	assert.equal(fs.existsSync(path.join(temp, "prime", "session-default.json")), false, "no placeholder store was created");

	const ws = await panel({ op: "get", scope: "workspace" });
	assert.equal(ws.json.active.cwd, path.resolve("C:/work/real-workspace"), "the workspace scope reads the active folder");
	assert.equal((await panel({ op: "add", scope: "workspace", text: "workspace note from the panel" })).status, 200);
	assert.equal(loadStore("workspace", realAgent).length, 1);
	assert.equal(loadStore("workspace", { session: { header: { cwd: "C:/somewhere/else" } } }).length, 0, "and only that folder");
}

{
	assert.equal(replTool.name, "python_repl");
	assert.equal(typeof replTool.output.render, "function");
	assert.deepEqual(replTool.parameters.required, ["code"]);

	const spawnedCalls = [];
	const sentMessages = [];
	const interruptedIds = [];
	const customToolCalls = [];
	const replDefs = [];
	const registeredSkillProviders = [];

	applyTool({
		tools: {
			register: (d) => void replDefs.push(d),
			execute: async (call) => {
				customToolCalls.push(call);
				return { isError: false, value: { echoed: call.arguments, tool: call.name } };
			},
		},
		systemPrompt: { section: () => {} },
		get: (svc) => {
			if (svc === "subagents") {
				return {
					resolveMaxDepth: () => 2,
					startActivation: async (spec) => {
						spawnedCalls.push(spec);
						return { childId: "sub-" + spawnedCalls.length };
					},
					listDescendants: async () => spawnedCalls.map((s, idx) => ({
						id: "sub-" + (idx + 1), label: s.label, mode: "continuable", activity: "running", depth: 1,
					})),
					sendMessage: async (_sender, targetId, content) => {
						sentMessages.push({ targetId, text: content[0].text });
						return "msg-" + sentMessages.length;
					},
					interrupt: (targetId) => { interruptedIds.push(targetId); },
				};
			}
			if (svc === "skills") {
				return {
					registerProvider: (factory) => {
						registeredSkillProviders.push(factory({ invalidate: () => {} }));
						return () => {};
					},
				};
			}
			return undefined;
		},
	});

	assert.equal(registeredSkillProviders.length, 1);
	const pyTool = replDefs.find((d) => d.name === "python_repl");
	const refTool = replDefs.find((d) => d.name === "harness_refine");
	const replAgent = {
		session: {
			id: "repl-s1",
			header: { cwd: process.cwd(), parentSession: "parent-root-1" },
			deriveMessages: () => [
				{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "build the RLM persistent kernel" }] },
				{ role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "working on the RLM kernel now" }] },
			],
		},
	};

	const r1 = await pyTool.execute({
		code: "import asyncio\nawait asyncio.sleep(0.005)\ncounter = 41\ncounter + 1",
		set_vars: { seeded_key: "alpha" },
	}, { agent: replAgent });
	assert.equal(r1.ok, true, "first python_repl eval succeeds: " + (r1.stderr || ""));
	assert.equal(r1.result, 42);
	assert.ok(r1.variables.includes("counter") && r1.variables.includes("seeded_key"));

	const r2 = await pyTool.execute({
		code: "counter += 8\nstore['saved'] = counter\n{'counter': counter, 'prev': _, 'has_ctx': 'RLM persistent kernel' in ctx, 'msg_count': len(messages), 'seeded': store.get('seeded_key')}",
	}, { agent: replAgent });
	assert.equal(r2.ok, true);
	assert.deepEqual(r2.result, { counter: 49, prev: 42, has_ctx: true, msg_count: 2, seeded: "alpha" });

	refTool.execute({
		findings: [
			{ action: "add", kind: "subagent", name: "auditor", text: "Check auth invariants carefully.", evidence: "operator defined auditor role" },
			{ action: "add", kind: "skill", name: "lint-check", text: "Run linter before commit.", evidence: "operator workflow" },
		],
	}, { agent: replAgent });

	const skillList = await registeredSkillProviders[0].list({ cwd: process.cwd(), scope: replAgent });
	assert.ok(skillList.some((s) => s.name === "lint-check"));

	const r3 = await pyTool.execute({
		code: [
			"h1 = await rlm('Audit login flow', name='audit-worker', role='auditor')",
			"h2 = rlm.spawn('Forked check', name='fork-worker', fork=True)",
			"subs = await rlm.list_subagents()",
			"await agent_message.send('focus on token expiry', receiver_name='audit-worker')",
			"await rlm.interrupt('fork-worker')",
			"t_res = await tools.read_file(path='README.md')",
			"h_add = await rlm.harness.add('Python REPL verified', evidence='self-check')",
			"h_list = await rlm.harness.list()",
			"{'h1': h1.id, 'h2': h2['id'], 'sub_count': len(subs), 'tool_echo': t_res['tool'], 'harness_count': len(h_list)}",
		].join("\n"),
	}, { agent: replAgent });
	assert.equal(r3.ok, true, "RLM bridge succeeds: " + (r3.stderr || ""));
	assert.equal(r3.result.h1, "sub-1");
	assert.equal(r3.result.h2, "sub-2");
	assert.equal(r3.result.sub_count, 2);
	assert.equal(r3.result.tool_echo, "read_file");
	assert.ok(r3.result.harness_count >= 3);
	assert.match(spawnedCalls[0].request.prompt[0].text, /\[Subagent Role: auditor\]/);
	assert.equal(spawnedCalls[1].provider, "fork");
	assert.deepEqual(sentMessages[0], { targetId: "sub-1", text: "focus on token expiry" });
	assert.deepEqual(interruptedIds, ["sub-2"]);

	const { resetPythonRepl } = await import("../index.js");
	resetPythonRepl(replAgent);
}


{
const { ensurePrimeFullAccess } = await import("../index.js");
const appended = [];
const mkSess = (id, preset) => ({
id,
header: preset ? { agentPreset: preset } : {},
append: (type, data) => void appended.push({ id, type, data }),
});
const fakeCtx = { get: () => undefined };
assert.equal(ensurePrimeFullAccess(fakeCtx, mkSess("std-1", "standard"), null), false, "standard preset stays in default workspace-write");
assert.equal(appended.length, 0);
assert.equal(ensurePrimeFullAccess(fakeCtx, mkSess("prime-1", "prime"), null), true, "prime preset auto-promotes to danger-full-access");
assert.equal(appended.some((e) => e.id === "prime-1" && e.type === "sandbox/mode" && e.data.mode === "danger-full-access"), true);
assert.equal(ensurePrimeFullAccess(fakeCtx, mkSess("prime-1", "prime"), null), false, "only promotes once per session so manual overrides stick");
}

fs.rmSync(temp, { recursive: true, force: true });
console.log("dsh-prime self-check: ok");
