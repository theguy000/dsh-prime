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
import {
  MAX_ENTRIES,
  SCOPES,
  SECTION_NAME,
  SECTION_ORDER,
  TOOL_NAME,
  loadAll,
  loadConfig,
  removeEntry,
  render,
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
  /* Scope-aware registration: this reaches only agents that joined the Prime
   * preset, which is why it lives here and not in the root half. `context` is
   * `{ agent, scope, signal }`, and the agent carries the live message list the
   * ranking reads. */
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
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
        const r = action === "add"
          ? upsert(scope, agent, finding.text, "tool", finding.evidence)
          : action === "update"
            ? updateEntry(scope, agent, finding.ref, finding.text, finding.evidence)
            : removeEntry(scope, agent, finding.ref);
        if (r.ok && action === "add") { recorded++; lines.push("added  [" + scope + "] " + label); }
        else if (r.ok && action === "update") { updated++; lines.push("updated " + r.ref + " " + label); }
        else if (r.ok && action === "delete") { deleted++; lines.push("deleted " + r.ref + " " + label); }
        else lines.push("skip [" + action + "] " + r.error + ": " + label);
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
}

export { inject, name };
