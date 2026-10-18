/**
 * Runnable check that every package the mode names actually resolves, and that
 * the patch is a well-formed Loader patch list. Typos in a declarative bundle are
 * the dominant failure mode and the self-check's regexes cannot see them.
 *
 * Run: node test/validate-patch.mjs
 * Override the harness install with DSH_APP_DIR when it lives elsewhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

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
	if (fs.existsSync(asarFile)) {
		const cacheRoot = path.join(os.tmpdir(), "dsh-prime-asar-cache-" + fs.statSync(asarFile).mtimeMs);
		const cachedNm = path.join(cacheRoot, "dsh", "node_modules");
		if (fs.existsSync(path.join(cachedNm, "@deepseek-ai", "dsh-tools", "lib", "index.js"))) return cachedNm;
	}
	return unpackedApp;
}
const APP = resolveDshAppDir();
assert.ok(fs.existsSync(APP), `harness node_modules not found at ${APP}; set DSH_APP_DIR`);

const yaml = createRequire(path.join(APP, "noop.cjs"))("js-yaml");
// The Loader evaluates `!!js` itself; quote those scalars so plain YAML keeps them.
const doc = yaml.load(fs.readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8").replace(/!!js (.+)$/gm, '"JS: $1"'));

assert.ok(Array.isArray(doc), "a patch file is a top-level array");
assert.equal(doc.length, 1);
// The host row sits at the root of the insert list (dsh-client-modules only scans the
// root plane), so locate the preset by name rather than by position.
const preset = doc[0].insert.find((row) => row.name === "@deepseek-ai/dsh-agent-preset");
assert.ok(preset, "the bundle declares an agent preset");
assert.equal(preset.name, "@deepseek-ai/dsh-agent-preset");
assert.match(preset.config.id, /^[a-z0-9-]+$/, "preset ids are lowercase, digits, and hyphens");
assert.ok(Number.isInteger(preset.config.order), "preset order must be an integer");
assert.ok(Array.isArray(preset.config.plugins), "a preset declares its plugin list");

// Walk the root rows and the preset's nested groups, rejecting duplicate Loader row ids.
const rows = [];
(function walk(list, depth) {
	const seen = new Set();
	for (const row of list) {
		assert.ok(row.id, "every row needs an id");
		assert.equal(seen.has(row.id), false, `duplicate row id: ${row.id}`);
		seen.add(row.id);
		rows.push({ depth, id: row.id, name: row.name });
		if (Array.isArray(row.config)) walk(row.config, depth + 1);
	}
})([...doc[0].insert, ...preset.config.plugins], 0);

// A row name is a package, a package subpath export, or the bundle's own entry.
const unresolvable = [];
for (const row of rows) {
	const self = path.dirname(new URL("../package.json", import.meta.url).pathname).split("/").pop();
	if (row.name === "cordis:group" || row.name === self || row.name.startsWith(`${self}/`)) continue;
	const segments = row.name.split("/");
	const root = row.name.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
	const subpath = segments.slice(row.name.startsWith("@") ? 2 : 1).join("/");
	const dir = path.join(APP, root);
	if (!fs.existsSync(dir)) {
		unresolvable.push(`${row.id}: package ${root} is not installed`);
		continue;
	}
	if (subpath) {
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		const declared = Object.keys(manifest.exports ?? {}).some((key) => key === `./${subpath}` || key.startsWith(`./${subpath}/`));
		if (!declared) unresolvable.push(`${row.id}: ${row.name} is not an exported subpath`);
	}
}
assert.deepEqual(unresolvable, [], `unresolvable rows:\n${unresolvable.join("\n")}`);

// The agent half hand-builds its tool definition because a linked plugin cannot
// resolve `@deepseek-ai/dsh-tools`. Run the real validators the registry uses, so
// a hand-written schema cannot drift out of the supported subset unnoticed.
{
	process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "prime-patch-"));
	const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(path.join(APP, "@deepseek-ai", "dsh-tools", "lib", "index.js")).href);
	const { apply } = await import("../tool.js");
	const definitions = [];
	const sections = [];
	apply({
		tools: { register: (definition) => void definitions.push(definition) },
		systemPrompt: { section: (definition) => void sections.push(definition) },
	});
	assert.equal(sections.length, 1, "the preset half registers the prompt section");
	const tool = definitions[0];
	assertSupportedJsonSchema(tool.parameters);
	assertSupportedJsonSchema(tool.output.schema);
	const replTool = definitions.find((d) => d.name === "python_repl");
	assert.ok(replTool, "the preset half also registers python_repl");
	assertSupportedJsonSchema(replTool.parameters);
	assertSupportedJsonSchema(replTool.output.schema);
	assert.deepEqual(validateJsonSchemaValue(replTool.parameters, { code: "1 + 1" }, ""), [], "well-formed python_repl args must be accepted");
	assert.ok(validateJsonSchemaValue(replTool.parameters, {}, "").length > 0, "missing code must be rejected");

	const agent = { session: { id: "s", header: { cwd: "C:/work/p" }, deriveMessages: () => [] } };
	const args = {
		findings: [
			{ action: "add", text: "a durable finding", evidence: "the operator said so" },
			{ action: "delete", ref: "abc12345", evidence: "removing a stale entry" },
		],
	};
	assert.deepEqual(validateJsonSchemaValue(tool.parameters, args, ""), [], "a well-formed batch must be accepted");
	assert.ok(validateJsonSchemaValue(tool.parameters, {}, "").length > 0, "a missing required argument must be rejected");
	/* `action` and `evidence` are schema-required on every edit. The per-action rules
	 * (text for add/update, ref for update/delete) cannot be expressed in this schema
	 * subset and are enforced in execute() — covered in self-check.mjs. */
	assert.ok(validateJsonSchemaValue(tool.parameters, { findings: [{ text: "x" }] }, "").length > 0, "an edit without action and evidence must be rejected");
	assert.ok(validateJsonSchemaValue(tool.parameters, { findings: [{ action: "upsert", text: "x", evidence: "y" }] }, "").length > 0, "an out-of-enum action must be rejected");
	/* No scope property exists at all: the operator selects the layer and the model
	 * cannot name one. `additionalProperties: false` is what enforces that. */
	assert.ok(validateJsonSchemaValue(tool.parameters, { findings: [{ action: "add", text: "x", evidence: "y", scope: "workspace" }] }, "").length > 0, "a model-supplied scope must be rejected");

	const value = tool.execute(args, { agent });
	assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, "value"), [], "the returned value must satisfy its own output schema");
	const blocks = tool.output.render({}, value);
	assert.ok(Array.isArray(blocks) && blocks.some((b) => b.type === "text" && b.text.length > 0), "render must return content blocks");
	fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true });
}

// The auto-refine gate reads a session projection by key, so the key must be the
// one the registry really registers; a rename there would silently disable it.
{
	const { agentPresetProjectionDefinition } = await import(
		pathToFileURL(path.join(APP, "@deepseek-ai", "dsh-agent-preset-registry", "lib", "index.js")).href,
	);
	const { PRESET_ID } = await import("../index.js");
	assert.equal(agentPresetProjectionDefinition.key, "agentPreset", "the gate reads the registry's registered projection key");
	assert.equal(PRESET_ID, preset.config.id, "the gate must name the preset this patch declares");
}

console.log(`dsh-prime patch ok: preset "${preset.config.id}", ${rows.length} rows, all resolvable`);
