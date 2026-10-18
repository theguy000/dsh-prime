# dsh-prime

A `prime` agent mode for DeepSeek Harness — an **RLM-style** mode in the sense
prime-agent uses the term — plus the one piece DSH does not ship: the
**Continual Harness**.

**Programmatic tool calling.** The model writes code that calls tools —
`await tools.harness_refine({ findings })` — instead of emitting one tool call per
round trip. Subagents are tools too, so a single step can fan out from inside a
program. This is the mode's default presentation, not an add-on.

**The Continual Harness.** Durable, scoped memory the agent maintains itself,
that outlives compaction. Facts are recorded when the operator states them, each
carrying the evidence that prompted it; every entry has a handle the agent can use
to correct or delete it; both layers are re-injected into every prompt; and the
agent is told to answer from them rather than re-derive what it already knows.

### How far the RLM comparison goes

| prime-agent | dsh-prime |
|---|---|
| Programmatic tool and subagent calls from code | **Same** - `await tools.<name>(args)` in PTC + `tools.<name>(**kwargs)` in `python_repl` |
| Persistent REPL: context lives in variables across calls | **Full** - `python_repl` keeps a persistent Python kernel per session with `ctx`, `messages`, and `store` variables |
| `rlm.spawn()` handles, replies over `agent_message` | **Full** - `rlm.spawn()` / `await rlm(...)`, `rlm.list_subagents()`, `rlm.send_message()`, and `agent_message.send()` |
| Continual Harness: scoped, refined, versioned state | **Full** - two scopes, 4 component kinds (`memory`, `prompt`, `skill`, `subagent`), create/update/delete/pin, evidence gate, and before/after snapshots with instant `--rollback` |
Select it in Web/Desktop from the agent-preset picker, or make it the default by
patching the profile:

```yaml
- id: agent-preset-registry
  config:
    default: prime
```

## Design

**Parity is composition, not reimplementation.** DSH already ships almost every
prime-agent surface; this bundle is a declarative `@deepseek-ai/dsh-agent-preset`
declaration that wires the shipped packages together, plus ~120 lines of host code
for the Continual Harness. There is no vendored copy of anything.

A preset's `config.plugins` list is never merged with another preset's, so the
mode is self-contained and cannot be perturbed by edits to `standard` or `ptc`.

## Parity matrix

Source of truth for the left column: [prime-agent README](https://github.com/PrimeIntellect-ai/prime-agent#readme).

| prime-agent capability | DSH realization | Status |
|---|---|---|
| "Everything is programmatic" — model tool is a persistent REPL | `dsh-agent-tool-presentation` with `mode: ptc`, so the agent writes code that calls tools instead of calling one tool per step; `dsh-tool-workflow` over `dsh-workflow-ptc` for sandboxed orchestration, plus a persistent shell so cwd/env carry across calls | **Partial** — the JS PTC runtime, not an IPython kernel (see Gap 1) |
| `rlm.spawn(...)` subagents returning results programmatically | `dsh-tool-subagent` (`provider: spawn`) + `dsh-tool-subagent-fork` (`provider: fork`), both `backgroundMode: continuable`; orchestratable from PTC | Full |
| `/refine` — harness improves itself, base prompt immutable, snapshots roll back | **`dsh-prime`** (this plugin): durable store + `/refine` command + scoped layers + relevance ranking + post-compaction re-injection and auto-refine | **Full** for refine/scope/ranking/auto-refine; **not built** for rollback (not requested) |
| Skills are executable packages; skill creator | `dsh-skill-filesystem` + `dsh-tool-skill`; skills are directories with their own manifests and scripts | Full |
| Sessions run in the background; reattach later | `dsh-jobs-local` + `dsh-tool-jobs` + session persistence; children outlive their parent turn | **Partial** — no detach/reattach outside the app |
| Agents communicate directly | `dsh-experimental-agent-team` + `dsh-experimental-tool-agent-team` | Available, **not mounted** (see Gap 2) |
| Automatic compaction | `compaction` group: `dsh-compaction-basic`, `dsh-command-compact`, `dsh-compaction-tool-result-pruner` | Full |
| Persistent goals (`/goal`) | `dsh-command-goal` + `dsh-tool-goal` over `dsh-goal` | Full |
| Bounded autonomous mode (`/autonomous`) with budgets | `dsh-goal-round-driver` + `maxGoalRounds` cap + `dsh-tool-ralph` fresh-agent loop | **Partial** — no user-defined quality gates (see Gap 3) |
| Heartbeats and schedules (`/heartbeat`, `prime-agent schedule`) | `dsh-time-context` + `dsh-schedule` | Full |
| Long tasks keep moving across turns | goals + compaction + retained/continuable subagents + schedule | Full |
| Clipboard over SSH/tmux, custom certificate authorities | Not mode concerns; DSH handles these at the deployment/transport layer | N/A |

## The continual harness

`/refine` with no argument runs a **refinement pass**: the agent reviews the
conversation and records what should outlive it. `/refine <note>` records a
note directly. Entries live on disk, so they outlive compaction by
construction, and the prompt section is re-rendered on every assembly.

The agent writes through the `harness_refine` tool, not the command — a slash
command is operator-only, so the triggers below all name the tool.

**The section asserts its own authority, and it has to.** The entries answer
questions; a section that only explains how to *record* reads as a notebook, and
one session proved the difference. Its composed system prompt contained, verbatim:

> Clients tab bar is reserved exclusively for VPN client tabs; client-specific
> controls (like the Residential vs Data Center pool switch) belong below the tab
> section...

and the agent still grepped the repository for the answer and read
`ui/appwindow.slint`. Delivery was never the problem — nothing had told it the
entry was settled, so it treated a note as a lead to check. The section now opens
with *"Treat them as already verified: when one answers the operator's question,
answer from it rather than re-deriving the answer from the code"*, and says to
read source only when nothing covers the question or the fact may have gone
stale. The heading is `Established:`, because `Recorded:` reads as a log.

**Capture is eager, not a rescue.** The prompt section carries a standing
instruction to record a durable fact in the same turn the operator states it,
because a preference that only lives in the conversation is gone once the
history is condensed — the summarizer is asked to keep user preferences and
still drops them, and a fact mentioned once reads as stale on the next pass.
The two triggers below are backstops for what the eager path missed; neither
runs before the loss, so neither can recover from it.

Both clauses cost roughly 212 tokens on every Prime turn.

**Known gap: the harness cannot correct itself entry-by-entry.** `upsert` rejects
an exact duplicate and nothing else, so a restated or refined fact lands beside
the entry it supersedes. The workspace store already holds two findings about the
same tab bar that disagree on where the pool switch belongs. Contradictory
entries are worse than missing ones: the trust clause above depends on the list
being reliable, and `/refine --clear` is the only way to remove one.

**One call carries the whole pass.** The tool takes `findings: [...]`, each item
carrying its own scope, so a refinement is a single write instead of one round
trip per entry — prime-agent's shape, where one pass rewrites the harness whole.
The mode also presents tools as PTC, so the agent writes a program that hands the
array over. A batch is capped at 20 findings because every item echoes a line
back; over the cap nothing is written, so a rejected batch is never half-applied.

### Scopes

Two layers. The operator selects one in Settings → **Prime Harness**, and **the
agent never chooses**: everything it records goes to the selected layer. It always
*reads* both.

| Scope | Reach | Stored as |
|---|---|---|
| `session` (default) | this conversation only | `~/.dsh/prime/session-<id>.json` |
| `workspace` | every session sharing this working directory | `~/.dsh/prime/project-<sha1(cwd)>.json` |

`global` was removed: one machine-wide bucket shares a single store between every
repository on the box, which is the opposite of scoped memory. Naming it is an
error that says so and points at the old file, rather than a silent write into a
layer nothing renders.

The workspace store keeps its original `project-` filename. Renaming it would
orphan every existing file instead of reading it, which is a worse trade than a
filename that lags its label. The old `project` spelling still resolves to
`workspace`, so a habit or an old note is not a hard error.

```
/refine                                    # refinement pass, default scope
/refine workspace                          # refinement pass, workspace scope
/refine prefer composition over a new abstraction
/refine workspace the daemon reads config from .dsh/prime
/refine --list
/refine --clear
/refine --snapshots                        # list before/after snapshots
/refine --rollback [<ref>]                 # roll back to the latest or named snapshot
/refine --diff [<ref>]                     # inspect before/after diff of a pass
/refine --pin <ref> / --unpin <ref>        # pin or unpin an entry by ref
/refine --edit <ref> <new text>            # update an entry in place by ref
/refine --delete <ref>                     # delete an entry by ref
/refine --reset-repl                       # reset the session's persistent Python REPL
```

A refinement pass queues exactly one turn; a second `/refine` before that turn
starts is refused, so repeated submission cannot stack duplicate passes.

The scope is an optional *leading* token, so note text is never rewritten
mid-sentence. The default comes from `~/.dsh/prime/config.json` and is what the
settings picker changes. `--list` and `--clear` act on the selected scope.

### Ranking

Relevance mirrors prime-agent's `harness_digest.rs`: the goal objective is
weighted `3.0`, then the last four user/assistant texts `2.0/1.5/1.0/1.0`, at
most 48 query terms, entries scored by term hits and topped up by recency
(`pinned` entries first). The rendered section keeps the top `12` within a
`4000`-character budget.

### The section is stable on purpose

Entry order is pinned-first then newest-first — **not** query-ranked. Query-aware
ordering rewrites the section as the conversation moves, and a system prompt that
changes invalidates the whole request prefix, so every step reprocesses the
entire transcript instead of extending a cached one. Measured: a one-turn session
composed two different prompts because the order shifted between steps.
`rank` still drives `/refine --list`, where re-ordering costs nothing.

The trade-off: past `topK` entries, the section keeps the newest rather than the
most relevant, and a relevant-but-old entry can be cut. Pin what must survive.

### Entries carry their date

`- [2026-10-17] the fact`. The trust clause tells the model to read source when a
fact "may have changed since" — without a date that is not a judgment it can make,
only a guess. An entry with no usable timestamp renders without one.

### What the digest is measured against

Relevance ranking reads the last four messages the operator or the model wrote.
Injected context does not count. A DSH prompt carries several large injected
messages — runtime policy, the skill catalog, the time snapshot, plugin
bootstraps — and a real session had four of them land inside that four-message
window at once. The operator's question fell out of it, the ranking read the skill
catalog as the query, and the entry that answered the question dropped to fifth of
seven behind notes that shared no subject with it. Messages are filtered by
`source.kind` **before** the window is taken; `user` and `model` are the speakers,
and a frame with no recorded source still counts so older logs do not go blind.

### After compaction

`session/event` → `compaction/end` is the trigger. The handler defers one
microtask, because the surface replacement that drops the compacted history
lands *after* `compaction/end`. It then hands the agent a follow-up turn
containing the current digest and an instruction to record anything durable.
Armed only when the goal is `compact`, with a per-session 20-minute cooldown —
the same gates as prime's `AutoRefineGates`. Turn it off in Settings.

**The hook is gated on the session's preset, and it has to be.** `/refine` is a
root-plane row, so its `session/event` listener is registered on the root
context — and cordis only applies `Context.filter` when a dispatch carries a
filtered `this`, which these session events do not. Every session in the
process therefore reaches this handler, including `standard`, `ptc`, `minimal`,
and `cordis`. Without the gate, `/compact` in any of those modes injected a
refinement turn into an agent that has no harness digest and no
`harness_refine` tool to record with.

The gate reads the `agentPreset` **session projection** — the same value
`@deepseek-ai/dsh-agent-preset-registry` maintains to answer the mode picker, so
a session that switched preset while still blank reports the composition it
really mounted rather than its creation header. It falls back to
`agentPresets.composedPreset(agent.ctx)`, and only a session that resolves to
neither reads as *unresolved* — which is logged, because that state means
auto-refine is dead for every session rather than merely out of scope.

## Settings UI

Settings → **Prime Harness** (a `settings.section` row registered by
`client.js`) offers the scope picker, the entry list in rank order, add/remove,
a two-step clear, the auto-refine toggle, and a refresh. It talks to the host
over exactly one route, `POST /prime/api`, which rejects non-`POST` methods and
cross-origin requests.

Controls come from `@deepseek-ai/dsh-client-ui-primitives` — `SegmentedControl`
for the scope, `Switch` for auto-refine, `Button`/`Input` for the rest — so the
page matches every other Settings page instead of restyling native elements. Two
scope options never needed a dropdown.

**The panel must be told which session it is looking at.** This page is global
while every store below `session` is keyed by a session or a folder. Resolving
those from the host process fell back to `process.cwd()` and the literal id
`default`, so `session` read `session-default.json` and `workspace` read the
*application's launch directory*. Both rendered an empty harness while the real
store held entries — a silent, confident lie about data loss.

The host now resolves the active session from the `session/event` feed it already
subscribes to (falling back to the newest live root agent on a cold boot) and
returns it as `active: { id, cwd }` on every response, so the panel can print the
folder or conversation it is showing. With nothing to resolve, `get` returns an
empty list *and* `active: null`, and writes are refused with `409` rather than
saved somewhere arbitrary.

**The route must be mounted from inside `ctx.effect`, and `webServer` must be
`inject`ed.** Cordis resolves a plugin's services through its `inject` list and
puts them on the context; `ctx.get("webServer")` returns undefined for anything
that list does not name. This plugin activates while the root bootstrap is still
walking the bundle list and the host webserver is declared later in that same
list, so an `apply`-time lookup returned null and the route silently never
mounted — the panel's every request answered `405` from the static fallback.
That was invisible to unit tests whose fake `ctx` answered `get("webServer")`
regardless. The suite now hands the service over as a property, exactly as the
runtime does.

## Verifying

```sh
npm run check
```

Three checks, all runnable offline:

| Check | Covers |
|---|---|
| `test/self-check.mjs` | store round-trip, `/refine` behaviour (notes, refinement passes, the re-arm guard, flags), the `harness_refine` tool contract, scope routing, goal-weighted ranking, the compaction hook's preset gate across every shipped preset, the per-session cooldown, corrupt-store degradation, the `/prime/api` route end to end (including its guards), the mode declaration, and the client-bundle contract |
| `test/validate-patch.mjs` | every row in the preset resolves in the bundle's own section, and the hand-built tool definition passes the registry's real schema validators |
| `test/scope-check.mjs` | scope isolation (session vs workspace), the retired `project` and `global` spellings, dedup, cap, and that relevance outranks recency |

To confirm the mode composes into the real Loader tree:

```sh
dsh --profile <name> --dump-config
```

## Honest gaps

1. **No IPython kernel.** The mode selects `mode: ptc` on
   `@deepseek-ai/dsh-agent-tool-presentation`, so the agent works through code by
   default rather than one tool call per step. But that runtime is Node, not
   Python: `dsh-workflow-ptc` runs over `dsh-ptc-runtime-node`, and
   `dsh-experimental-ptc-runtime-python` is not in this build. prime-agent's
   IPython kernel is also *stateful* — variables persist between calls — while the
   PTC runtime executes a fresh program per call, so carry state in the persistent
   shell instead. Same seam, different language and lifetime.

   `mode: ptc` waits for the `ptcRuntime` service. `@deepseek-ai/dsh-base`
   composes `dsh-ptc-runtime-node`, so it resolves in any profile that includes
   base — but a deployment that omits it fails the whole preset at mount, and
   Prime disappears from the mode picker. `mode: native` or `both` are the
   fallbacks.
2. **Agent Teams is not mounted.** Its `list_agents` and `interrupt_agent`
   double-register against `dsh-tool-subagent-control`, and its peer-roster UX is
   not prime's model — prime delegates from code. To opt in, remove
   `tool-subagent-control` and `tool-subagent-list-agents` and mount
   `@deepseek-ai/dsh-experimental-agent-team-profile` in this preset instead.
3. **Quality gates.** prime's `/autonomous` can run user-defined gates; DSH's
   round driver stops at its budget without a gate hook. Not built here because it
   needs a round-driver seam, not a config row.

## Layout

| File | Role |
|---|---|
| `cordis.patch.yml` | The mode: one self-contained `preset-prime` declaration |
| `index.js` | Continual Harness host half (`/refine`, scoped stores, ranking, refinement passes, the preset-gated post-compaction hook, `/prime/api`) |
| `tool.js` | Continual Harness agent half: the `harness_refine` tool **and** the prompt section, both mounted inside the preset so they stay scoped to Prime |
| `client.js` | Settings → Prime Harness panel (plain `__ModuleLoader__` bundle, no build step) |
| `test/self-check.mjs` | Host behaviour + mode + client-bundle contract |
| `test/scope-check.mjs` | Scope isolation, retired scope spellings, dedup, cap, ranking |
| `test/validate-patch.mjs` | Every preset row resolves |

`client.js` is discovered from `dsh.client` in `package.json` and served from
`/plugins/<entry-id>/client.js`; it needs no bundle-patch row of its own. It is
plain `React.createElement` — no JSX, no bundler — because the client half must
ship pre-built. It requires only `react` and imports no host package at runtime.

The prompt section lives in `tool.js`, not `index.js`, because prompt sections
are scope-aware: a root registration would instruct every mode in the process —
redteam included — to call a tool only Prime mounts.

`index.js` imports only `node:*`, and `tool.js` imports only `./index.js`. An
installed bundle resolves against the profile's `node_modules`, which carries
no `@deepseek-ai/*` runtime packages — importing one would break at load time.
That is also why `tool.js` hand-builds its definition instead of calling
`defineTool`: the helper is unreachable, and `tools.register` only requires
`output.render` plus a value that satisfies `output.schema`.

### Memory only reaches Prime sessions

The harness is mounted by the `prime` preset, so `standard`, `ptc`, `minimal`,
and `cordis` sessions have no harness section and no `harness_refine` tool. A
durable finding recorded from a Prime chat is *not* visible in a plain chat, even
in the same folder — the folder scope decides which sessions **share** a layer,
while the preset decides which sessions **read** it at all. Verified against
session logs: a `ptc` session that never switched preset composed a system prompt
with no harness section, so its agent had no choice but to re-derive the answer
from the repository.
