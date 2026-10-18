/**
 * Prime Continual Harness — agent half.
 *
 * Mounted *inside* the `prime` preset so the tool is scoped to agents that joined
 * that mode; the root `dsh-prime` row owns the `/refine` command, the prompt
 * section, and the `/prime/api` route. The split is load-bearing: a root row's
 * `tools.register` publishes into every mode's catalog, not just Prime's.
 *
 * One call carries a whole refinement: the mode presents tools as PTC, so the
 * agent writes a program and hands over every finding at once, the way
 * prime-agent's refinement writes the harness in a single pass rather than one
 * entry per round trip.
 *
 * Built by hand, with no bare imports. A linked plugin resolves its own imports
 * from its own directory, and the profile's node_modules carries no
 * `@deepseek-ai/*` packages, so `defineTool` is unreachable. This is the shape
 * `tools.register` validates: `output.render` is required, and whatever
 * `execute` returns is validated against `output.schema` before rendering.
 * @module dsh-prime/tool
 */
import crypto from "node:crypto";
import {
  KINDS,
  MAX_ENTRIES,
  REPL_TOOL_NAME,
  SCOPES,
  SECTION_NAME,
  SECTION_ORDER,
  TOOL_NAME,
  ensureWindowsSandboxRunner,
  entryRef,
  evalPythonRepl,
  load,
  loadAll,
  loadConfig,
  recordPassSnapshot,
  registerSkillsInvalidator,
  removeEntry,
  render,
  resetPythonRepl,
  updateEntry,
  upsert,
} from "./index.js";

const name = "prime-tool";
const inject = ["tools", "systemPrompt"];

/**
 * Findings accepted in one call. Enforced here rather than in the schema: the
 * registry's supported JSON Schema subset is `type | oneOf | properties |
 * required | additionalProperties | items | enum | const`, so `maxItems` would be
 * rejected or ignored. The ceiling exists because every finding echoes a line
 * back, and an unbounded array would flood the turn it belongs to.
 */
const MAX_FINDINGS = 20;

/* The three edits a pass may make. Add is the default so a model that omits the
 * field still records rather than being rejected. */
const ACTIONS = ["add", "update", "delete"];

const DESCRIPTION =
  "Maintain the continual harness: durable findings that survive compaction and reach future sessions. " +
  "Send every edit of one pass in a SINGLE call — this tool takes an array — never one call per edit. " +
  "Every edit needs the evidence that prompted it: the operator's words, or what you observed. " +
  "When an entry is wrong or no longer holds, UPDATE it by its ref, or DELETE it. Never add a second entry beside a wrong one: two entries that disagree are worse than one that is stale. " +
  "Do NOT pass a scope: the operator selects the memory layer, and the prompt section reports which one is active. " +
  "Prefer no edit over a speculative one, and never restate the current task or repeat what the harness already says.";

/**
 * Register the agent-facing way to write the harness.
 * @param ctx - the preset's agent-scoped context, carrying the tool registry.
 */
export function apply(ctx) {
  ensureWindowsSandboxRunner(ctx);
  /* Scope-aware registration: this reaches only agents that joined the Prime
   * preset, which is why it lives here and not in the root half. `context` is
   * `{ agent, scope, signal }`, and the agent carries the live message list the
   * ranking reads. */
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      const agent = (context && context.agent) || null;
      try {
        /* Both layers, never just the configured default: the default decides what
         * a new entry is SCOPEd to, not which entries are visible. */
        return render(loadAll(agent), agent);
      } catch {
        return "";
      }
    },
  });

  try {
    const skillsSvc = ctx.get ? ctx.get("skills") : null;
    if (skillsSvc && typeof skillsSvc.registerProvider === "function") {
      skillsSvc.registerProvider((control) => {
        registerSkillsInvalidator(() => control.invalidate());
        const providerName = "prime-harness";
        const buildCandidates = (options) => {
          const cwd = (options && options.cwd) || process.cwd();
          const scopeAgent = (options && options.scope) || { session: { id: "default", header: { cwd } } };
          return loadAll(scopeAgent).filter((e) => e && e.kind === "skill" && e.text).map((e) => {
            const rawSlug = String(e.name || e.text.split(/[:.\n]/)[0] || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
            const sName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rawSlug) ? rawSlug : "prime-skill-" + entryRef(e);
            const desc = e.text.split("\n")[0].slice(0, 160).trim() || "Refined continual-harness skill.";
            return {
              name: sName, description: desc, invocation: { modelInvocable: true, userInvocable: true },
              source: "prime-" + (e.scope || "workspace"), provider: providerName, rank: 220,
              locator: { entry: e, name: sName, description: desc },
            };
          });
        };
        return {
          name: providerName,
          list: (options) => Promise.resolve(buildCandidates(options)),
          get: (c) => Promise.resolve(c?.locator?.entry ? {
            name: c.locator.name, description: c.locator.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: c.source, provider: providerName, content: c.locator.entry.text,
          } : undefined),
        };
      });
    }
  } catch {}

  try {
    if (typeof ctx.on === "function") {
      ctx.on("agent/disposed", ({ agent }) => { if (agent) resetPythonRepl(agent); });
    }
  } catch {}

  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        findings: {
          type: "array",
          description: "Every edit from this pass, most durable first.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              action: {
                type: "string",
                enum: ACTIONS,
                description: "add a new entry (default), update an existing one by ref, or delete one by ref.",
              },
              kind: {
                type: "string",
                enum: KINDS,
                description: "Component kind: memory (default), prompt, skill, or subagent.",
              },
              name: {
                type: "string",
                description: "Optional kebab-case identifier when kind is skill or subagent.",
              },
              pinned: {
                type: "boolean",
                description: "Optional flag to pin this entry to the top of the prompt section.",
              },
              text: {
                type: "string",
                description: "The finding, as one self-contained sentence that still makes sense without this conversation. Required for add and update; ignored for delete.",
              },
              ref: {
                type: "string",
                description: "The 8-character ref shown at the start of the entry being updated or deleted.",
              },
              evidence: {
                type: "string",
                description: "What prompted this edit — the operator's words, or what you saw. Required for add and update; an entry that cannot cite its evidence does not belong in the harness.",
              },
            },
            required: ["action", "evidence"],
          },
        },
      },
      required: ["findings"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recorded: { type: "integer" },
          updated: { type: "integer" },
          deleted: { type: "integer" },
          skipped: { type: "integer" },
          text: { type: "string" },
        },
        required: ["recorded", "updated", "deleted", "skipped", "text"],
      },
      /* Content blocks, not a string: the registry projects this return straight
       * into the tool result and a consumer calls `.some()` on it, so a bare
       * string fails the turn with `content.some is not a function`. */
      render: (args, value) => [{ type: "text", text: value.text }],
    },
    /* `exec.agent` is the calling agent — the same scope key the command uses. */
    execute: (args, exec) => {
      const agent = exec && exec.agent;
      const findings = args.findings;
      const empty = { recorded: 0, updated: 0, deleted: 0, skipped: 0 };
      if (findings.length === 0) {
        return Object.assign({}, empty, { text: "nothing to do: findings was empty" });
      }
      if (findings.length > MAX_FINDINGS) {
        return Object.assign({}, empty, {
          skipped: findings.length,
          text:
            "nothing applied: " + findings.length + " edits in one call exceeds the limit of " + MAX_FINDINGS +
            "; split the pass so a rejected batch is never half-written",
        });
      }
      const fallback = loadConfig().defaultScope;
      const beforeByScope = new Map();
      for (const s of SCOPES) beforeByScope.set(s, load(s, agent));
      const touchedScopes = new Set();
      const lines = [];
      let recorded = 0;
      let updated = 0;
      let deleted = 0;
      for (const finding of findings) {
        /* One layer, chosen by the operator. A finding that names a scope anyway is
         * ignored rather than honoured: the model used to guess wrong, and the
         * operator can see which memory they are looking at. */
        const scope = fallback;
        const action = ACTIONS.includes(finding.action) ? finding.action : "add";
        const label = String(finding.text || finding.ref || "").slice(0, 56);
        /* The evidence rule is the gate. A finding that cannot say what prompted
         * it is not a durable fact, it is a guess, and a store full of guesses is
         * what makes the section stop being worth trusting. */
        if (action !== "delete" && !String(finding.evidence || "").trim()) {
          lines.push("skip [" + action + "] no evidence given: " + label);
          continue;
        }
        if (action === "add" && !String(finding.text || "").trim()) {
          lines.push("skip [add] no text given");
          continue;
        }
        if (action !== "add" && !String(finding.ref || "").trim()) {
          lines.push("skip [" + action + "] no ref given: " + label);
          continue;
        }
        const opts = { kind: finding.kind, name: finding.name, pinned: finding.pinned, skipSnapshot: true };
        const r = action === "add"
          ? upsert(scope, agent, finding.text, "tool", finding.evidence, opts)
          : action === "update"
            ? updateEntry(scope, agent, finding.ref, finding.text, finding.evidence, opts)
            : removeEntry(scope, agent, finding.ref, { skipSnapshot: true });
        if (r.ok && action === "add") { recorded++; touchedScopes.add(r.scope || scope); lines.push("added  [" + scope + "] " + label); }
        else if (r.ok && action === "update") { updated++; touchedScopes.add(r.scope || scope); lines.push("updated " + r.ref + " " + label); }
        else if (r.ok && action === "delete") { deleted++; touchedScopes.add(r.scope || scope); lines.push("deleted " + r.ref + " " + label); }
        else lines.push("skip [" + action + "] " + r.error + ": " + label);
      }
      for (const s of touchedScopes) {
        recordPassSnapshot(s, agent, beforeByScope.get(s) || [], "tool:harness_refine (+" + recorded + " ~" + updated + " -" + deleted + ")");
      }
      const applied = recorded + updated + deleted;
      return {
        recorded,
        updated,
        deleted,
        skipped: findings.length - applied,
        text:
          "added " + recorded + ", updated " + updated + ", deleted " + deleted +
          ", skipped " + (findings.length - applied) + " of " + findings.length +
          " (each harness holds at most " + MAX_ENTRIES + ")\n" + lines.join("\n"),
      };
    },
  });

  ctx.tools.register({
    name: REPL_TOOL_NAME,
    description:
      "Execute Python code in the session's persistent RLM REPL (`prime-agent` parity). " +
      "Variables, functions, classes, and imports persist across calls in the same session, top-level `await` is supported, and the final expression value is returned as `result` and bound to `_`. " +
      "Built-in globals synced on every call: `ctx` (full session transcript including pre-compaction turns), `messages`, `goal`, `workspace`, `store` (persistent JSON dict), " +
      "`rlm` (`rlm.spawn`/`await rlm(...)`, `rlm.list_subagents()`, `rlm.send_message`, `rlm.interrupt`, `rlm.harness.{list,add,update,delete,snapshots,rollback,diff}`), " +
      "`agent_message` (`agent_message.send(message, receiver_name)`), and `tools` (`await tools.<name>(**kwargs)`).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          description: "Python 3 code to execute in the persistent session REPL.",
        },
        reset: {
          type: "boolean",
          description: "Optional flag to reset the persistent Python REPL namespace before executing `code`.",
        },
        timeout_ms: {
          type: "integer",
          description: "Optional execution timeout in milliseconds (default 120000).",
        },
        set_vars: {
          type: "object",
          additionalProperties: true,
          description: "Optional JSON variables to bind in the persistent Python namespace (and `store`) before executing `code`.",
        },
      },
      required: ["code"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          stdout: { type: "string" },
          stderr: { type: "string" },
          result: { description: "Lossless JSON value of the final expression, or null." },
          variables: { type: "array", items: { type: "string" } },
          error: { type: "string" },
          text: { type: "string" },
        },
        required: ["ok", "stdout", "stderr", "result", "variables", "text"],
      },
      render: (args, value) => [{ type: "text", text: value.text }],
    },
    execute: async (args, exec) => {
      const agent = (exec && exec.agent) || null;
      const signal = (exec && exec.signal) || new AbortController().signal;
      const subagentsSvc = ctx.get ? ctx.get("subagents") : null;
      const spawnedMap = new Map();

      const resolveTargetAgentId = async (nameOrId) => {
        const target = String(nameOrId || "").trim();
        if (!target) throw new Error("agent_id / receiver_name must be non-empty");
        if ((target === "main" || target === "parent") && agent?.session?.header?.parentSession) return agent.session.header.parentSession;
        if (spawnedMap.has(target)) return spawnedMap.get(target);
        if (subagentsSvc && agent?.session && typeof subagentsSvc.listDescendants === "function") {
          try {
            const list = await subagentsSvc.listDescendants(agent.session.id, signal);
            const hit = (list || []).find((item) => item.id === target || item.label === target);
            if (hit) return hit.id;
          } catch {}
        }
        return target;
      };

      return await evalPythonRepl(agent, args, {
        spawnSubagent: async (req) => {
          if (!subagentsSvc || typeof subagentsSvc.startActivation !== "function") throw new Error("subagent service is unavailable");
          if (!agent) throw new Error("rlm.spawn requires a live calling agent");
          const label = String(req.name || "rlm-subagent").slice(0, 64);
          const agentOptions = req.provider && req.model ? { provider: String(req.provider), model: String(req.model) } : undefined;
          const maxDepth = typeof subagentsSvc.resolveMaxDepth === "function" ? subagentsSvc.resolveMaxDepth(undefined) : undefined;
          const act = await subagentsSvc.startActivation({
            provider: req.fork ? "fork" : "spawn",
            label,
            delivery: "parent",
            signal,
            request: {
              ...(req.cwd ? { cwd: String(req.cwd) } : {}),
              prompt: [{ type: "text", text: String(req.prompt || "") }],
              parent: agent,
              ...(agentOptions ? { agentOptions } : {}),
              ...(maxDepth !== undefined ? { maxDepth } : {}),
            },
          });
          spawnedMap.set(label, act.childId);
          return { id: act.childId, subagentId: act.childId, name: label, provider: req.fork ? "fork" : "spawn", status: "started" };
        },
        listSubagents: async () => {
          if (!subagentsSvc || !agent?.session || typeof subagentsSvc.listDescendants !== "function") return [];
          const list = await subagentsSvc.listDescendants(agent.session.id, signal);
          return (list || []).map((item) => ({ id: item.id, name: item.label || item.id, mode: item.mode || item.kind || "continuable", activity: item.activity || "unknown", depth: item.depth ?? 1 }));
        },
        sendMessage: async (targetNameOrId, message) => {
          if (!subagentsSvc || typeof subagentsSvc.sendMessage !== "function" || !agent) throw new Error("subagents.sendMessage is unavailable");
          const targetId = await resolveTargetAgentId(targetNameOrId);
          const messageId = await subagentsSvc.sendMessage(agent, targetId, [{ type: "text", text: String(message || "") }], { signal });
          return { ok: true, agentId: targetId, messageId };
        },
        interruptSubagent: async (targetNameOrId) => {
          if (!subagentsSvc || typeof subagentsSvc.interrupt !== "function" || !agent) throw new Error("subagents.interrupt is unavailable");
          const targetId = await resolveTargetAgentId(targetNameOrId);
          subagentsSvc.interrupt(targetId, { kind: "ancestor", agent });
          return { ok: true, agentId: targetId, accepted: true };
        },
        callTool: async (toolName, toolArgs) => {
          if (toolName === REPL_TOOL_NAME || toolName === "run_code") throw new Error("cannot recursively call " + toolName + " from inside python_repl");
          if (typeof ctx.tools.execute === "function") {
            const callId = String((exec && exec.callId) || "repl") + ":py:" + crypto.randomUUID().slice(0, 8);
            const res = await ctx.tools.execute({ callId, rootCallId: (exec && exec.rootCallId) || callId, name: toolName, arguments: toolArgs || {}, ...(agent ? { agent } : {}), ...(exec?.token ? { parent: exec.token } : {}), signal });
            if (res.isError) throw new Error(res.error?.message || "tool call failed");
            return res.value;
          }
          if (typeof ctx.tools.get === "function") {
            const def = ctx.tools.get(toolName, agent);
            if (!def || typeof def.execute !== "function") throw new Error("unknown tool: " + toolName);
            return await def.execute(toolArgs || {}, exec || { agent, signal });
          }
          throw new Error("tools registry unavailable");
        },
      });
    },
  });
}

export { inject, name };
