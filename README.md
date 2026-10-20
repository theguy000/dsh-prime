# dsh-prime

A `prime` agent mode for DeepSeek Harness ? an **RLM-style** mode in the sense
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) uses the term ? plus the
piece DSH does not ship out of the box: the **Continual Harness** and a
**persistent per-session Python RLM REPL**.

**Programmatic tool calling & persistent Python REPL.** The model works through
code by default (`python_repl` + `mode: native`) and has a stateful `python_repl` tool backed by a
persistent per-session Python 3 process. Context lives in variables (`ctx`,
`messages`, `goal`, `workspace`, `store`), top-level `await` is enabled, and
subagents, harness state, and host tools are callable directly from Python
(`await rlm("...")`, `rlm.spawn()`, `rlm.harness.*`, `await tools.<name>(**kwargs)`).

**The Continual Harness.** Durable, scoped, versioned memory the agent maintains
itself and that outlives compaction. Facts, prompt rules, reusable skills, and
subagent role specs are recorded with the evidence that prompted them; every
entry carries an 8-character `ref` the agent (or operator) can use to update,
pin, or delete it in place; every write snapshots `before`/`after` state for
instant `--rollback`; and both layers (`session` and `workspace`) are
re-injected into every Prime prompt.

### How far the RLM comparison goes

| prime-agent | dsh-prime |
|---|---|
| Programmatic tool and subagent calls from code | **Same** ? `await tools.<name>(args)` in Node PTC + `await tools.<name>(**kwargs)` in `python_repl` |
| Persistent REPL: context lives in variables across calls | **Full** ? `python_repl` keeps a persistent Python 3 kernel per session with `ctx` (including pre-compaction turns), `messages`, `goal`, `workspace`, and disk-backed `store` |
| `rlm.spawn()` handles, replies over `agent_message` | **Full** ? `rlm.spawn()` / `await rlm(..., role=...)`, `rlm.list_subagents()`, `rlm.send_message()`, `rlm.interrupt()`, and `agent_message.send()` |
| Continual Harness: scoped, refined, versioned state | **Full** ? two scopes (`session`, `workspace`), 4 component kinds (`memory`, `prompt`, `skill`, `subagent`), `add`/`update`/`delete`/`pin` by 8-char `ref`, evidence gate, and before/after snapshots with `--diff` and `--rollback` |

Select **Prime** in Web/Desktop from the agent-preset picker, or make it the
default by patching the profile:

```yaml
- id: agent-preset-registry
  config:
    default: prime
```

## Design

**Parity is composition plus a focused RLM & Continual Harness runtime.** DSH
already ships most prime-agent surfaces; `cordis.patch.yml` is a declarative
`@deepseek-ai/dsh-agent-preset` declaration that wires those shipped packages
together, while `index.js`, `tool.js`, and `client.js` provide the Continual
Harness, the persistent Python REPL bridge, dynamic skill/subagent projection,
and the Settings ? **Prime Harness** management UI.

A preset's `config.plugins` list is never merged with another preset's, so the
mode is self-contained and cannot be perturbed by edits to `standard` or `ptc`.

## Parity matrix

Source of truth for the left column: [prime-agent README](https://github.com/PrimeIntellect-ai/prime-agent#readme).

| prime-agent capability | DSH realization | Status |
|---|---|---|
| "Everything is programmatic" ? model tool is a persistent REPL | `dsh-agent-tool-presentation` with `mode: ptc`, `dsh-tool-workflow` over `dsh-workflow-ptc`, a persistent shell (`dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent`), **plus** `python_repl` (stateful per-session Python 3 RLM kernel with `ctx`, `messages`, `store`, `rlm.*`, and `tools.*`) | **Full** |
| `rlm.spawn(...)` subagents returning results programmatically | `dsh-tool-subagent` (`provider: spawn`) + `dsh-tool-subagent-fork` (`provider: fork`) + `python_repl`'s `rlm.spawn(..., role=...)` / `rlm.send_message` / `agent_message.send` | **Full** |
| `/refine` ? harness improves itself, base prompt immutable, snapshots roll back | **`dsh-prime`** (this plugin): durable store + `/refine` command + `harness_refine` tool + 4 component kinds + in-place update/delete/pin by `ref` + before/after snapshots with `--rollback` and `--diff` + post-compaction auto-refine | **Full** |
| Skills are executable packages; skill creator | `dsh-skill-filesystem` + `dsh-tool-skill` + dynamic `prime-harness` skill provider exposing `kind: "skill"` harness entries to the live skill catalog | **Full** |
| Sessions run in the background; reattach later | `dsh-jobs-local` + `dsh-tool-jobs` + session persistence; children outlive their parent turn | **Partial** ? no detach/reattach outside the app |
| Agents communicate directly | `rlm.send_message` / `agent_message.send` in `python_repl` + `dsh-tool-subagent-control`; `dsh-experimental-agent-team` available if peer-roster UX is preferred | **Full** (via RLM/subagent messaging; see Note 1) |
| Automatic compaction | `compaction` group: `dsh-compaction-basic`, `dsh-command-compact`, `dsh-compaction-tool-result-pruner` | **Full** |
| Persistent goals (`/goal`) | `dsh-command-goal` + `dsh-tool-goal` over `dsh-goal` | **Full** |
| Bounded autonomous mode (`/autonomous`) with budgets | `dsh-goal-round-driver` + `maxGoalRounds` cap + `dsh-tool-ralph` fresh-agent loop | **Partial** ? no user-defined quality gates (see Note 2) |
| Heartbeats and schedules (`/heartbeat`, `prime-agent schedule`) | `dsh-time-context` + `dsh-tool-schedule` over `dsh-schedule` | **Full** |
| Long tasks keep moving across turns | goals + compaction + retained/continuable subagents + schedule + persistent REPL `store` | **Full** |
| Clipboard over SSH/tmux, custom certificate authorities | Not mode concerns; DSH handles these at the deployment/transport layer | N/A |

## The continual harness

`/refine` with no argument runs a **refinement pass**: the agent reviews the
conversation and records what should outlive it. `/refine <note>` records a
note directly. Entries live on disk, so they outlive compaction by
construction, and the prompt section is re-rendered on every assembly.

**A pass behaves like a built-in command.** A bare `/refine` runs the pass as a
**forked subagent** with `delivery: "caller"`: the child is seeded with this
session's completed-turn prefix, so it reads the same conversation at cached
rates, and it sends no `subagent-settled` message, so the parent opens no second
turn. The `command/run` row shimmers for the whole pass and settles once with
`command/done` — the `/compact` shape, with no turn, thinking block, or tool call
between the command and its result.

**The running label says "Refining…".** `GenericCommandCard` hardcodes
`t("command.running")`, and neither escape hatch is open to a plugin: the
`runningSummary` prop reaches only the internal compaction card, and
`locale.register` rejects a second `chat`/`en` dictionary. So `client.js`
registers a keyed `conversation.chat.commandview` entry for `refine` — the same
supported mechanism `/compact` uses — rendering the identical structure from the
identical primitives (`DisclosureRow` + `TextShimmer` + `IconApiOutlineRegular`).
The row looks and shimmers exactly like the built-in one; only the words differ.

**Each pass is its own row in the subagent list.** `startActivation` catalogs the
child unconditionally — `delivery: "caller"` suppresses the settlement *message*,
not the catalog entry — so passes are already visible there. The label carries
the time, making that list a pass history:

**The row reports what actually happened, not that the child returned.** A child
that ends normally without recording anything is a success by `stopReason` and a
lie by outcome, so the handler compares the store's snapshot count before and
after the child runs and says either `refined … (N pass snapshots recorded)` or
`the pass found nothing durable to record`. Nothing durable is a legitimate
answer; claiming a refinement that did not occur is not.

The child's `harness_refine` writes land in the **parent's** store, not the
child's: a delegated child's session header records `parentSession`, and
`storeSessionId` follows it back. Without that, every finding landed in a file
nobody reads — a silent loss, because the write itself succeeds.

Two paths stay in-process. Flag queries (`--list`, `--diff`, `--snapshots`, …)
never start an agent at all. The post-compaction hook keeps its own in-turn
pass, because a fork's seed stops at the last `turn/end` and that hook fires
immediately after a compaction replaces the surface. That in-turn pass carries
`source: { kind: "prime-refine" }`, not `user`, so Chat draws the collapsed
turn-trigger notice rather than an operator bubble, and `isSpeaker` stops reading
the pass's boilerplate as the operator's own words. It is also bound to the exact
turn it opens, so an operator turn settling while it is still queued cannot
settle the row early.

The agent writes through the `harness_refine` tool (or `rlm.harness.*` inside
`python_repl`), never the slash command ? a slash command is operator-only, so
the triggers below all name the tool.

**The section asserts its own authority, and it has to.** The section opens
with *"Treat them as already verified: when one answers the operator's question,
answer from it rather than re-deriving the answer from the code"*, and says to
read source only when nothing covers the question or the fact may have gone
stale. The heading is `Established:`, because `Recorded:` reads as a log.

**Capture is eager, not a rescue.** The prompt section carries a standing
instruction to record a durable fact in the same turn the operator states it,
because a preference that only lives in the conversation is gone once the
history is condensed. The manual `/refine` command and post-compaction hook are
backstops for what the eager path missed.

**In-place correction by `ref`, 4 component kinds, and snapshots.** Every rendered
line starts with its 8-character `ref` handle, creation date, and optional
`[kind:name]` tag:

```text
- 31725ce5 [2026-10-17] [prompt:routing] Always declare Route: fast-path before routine edits.
```

When an entry is wrong or superseded, the model updates or deletes it by `ref`
(`action: "update" | "delete"`) instead of appending a contradictory entry
beside it. Every entry has one of four component kinds:

- `memory` (default) ? durable facts, constraints, and findings.
- `prompt` ? standing behavioral or routing rules obeyed on every turn and
  prioritized ahead of unpinned `memory` notes so routine facts never evict them.
- `skill` ? reusable workflows dynamically registered into DSH's live `skills`
  service (`prime-harness` provider) so `tool-skill` and `/` triggers can invoke
  them immediately.
- `subagent` ? reusable subagent role specifications that `rlm.spawn(..., role="<name|ref>")`
  automatically prepends to the spawned subagent's task prompt.

**One call carries the whole pass, and every pass is snapshotted.** `harness_refine`
takes `findings: [...]` (up to 20 edits per call; an oversized batch is rejected
atomically so a pass is never half-written). Every mutation records a bounded
`before`/`after` snapshot (`MAX_SNAPSHOTS = 25`) with `+added ~updated -deleted`
diff counts, so any pass or edit can be inspected with `/refine --diff [<ref>]`
and undone in one step with `/refine --rollback [<ref>]`.

### Scopes & CLI usage

Two layers. The operator selects the write target in Settings ? **Prime Harness**,
and **the agent never chooses**: everything it records goes to the selected
layer. It always *reads* both.

| Scope | Reach | Stored as |
|---|---|---|
| `session` (default) | this conversation only | `~/.dsh/prime/session-<id>.json` |
| `workspace` | every session sharing this working directory | `~/.dsh/prime/project-<sha1(cwd)>.json` |

```text
/refine                                            # refinement pass, default scope
/refine workspace                                  # refinement pass, workspace scope
/refine prefer composition over a new abstraction
/refine workspace --kind prompt always run checks before committing
/refine workspace --kind skill --name lint-check Run npm run check before git commit.
/refine --list
/refine --clear
/refine --snapshots                                # list before/after snapshots
/refine --rollback [<ref>]                         # roll back to the latest or named snapshot
/refine --diff [<ref>]                             # inspect before/after diff of a pass
/refine --pin <ref> / --unpin <ref>                # pin or unpin an entry by ref
/refine --edit <ref> <new text>                    # update an entry in place by ref
/refine --delete <ref>                             # delete an entry by ref
/refine --reset-repl                               # reset the session's persistent Python REPL
```

### Ranking & prompt-cache stability

Relevance ranking mirrors prime-agent's `harness_digest.rs`: the goal objective
is weighted `3.0`, then the last four user/assistant speaker messages
(`source.kind` filtered before windowing so injected runtime context cannot
crowd out the operator's words) are weighted `2.0 / 1.5 / 1.0 / 1.0`, up to 48
query terms, with `pinned` entries boosted by `+100`.

In the system prompt, entry order is **pinned-first, then `prompt`-kind rules,
then newest-first** (`promptOrder`) within a `topK = 12` / `4000`-character
budget rather than query-reordered on every turn, keeping the LLM KV-cache
prefix stable across steps. `rank` drives `/refine --list` and the Settings UI.

## Persistent Python REPL (`python_repl`)

Alongside DSH's Node PTC runtime (`run_code`), Prime mounts `python_repl`: a
stateful, per-session Python 3 kernel with top-level `await` and a bidirectional
JSON-RPC bridge back to the host.

- **Persistent namespace & disk store:** Variables, functions, classes, and
  imports survive across turns within the session. Any JSON-serializable key
  written to `store["key"] = value` (or passed via `set_vars`) is persisted to
  `~/.dsh/prime/repl-session-<id>.json` across restarts.
- **Compaction-surviving transcript (`ctx` & `messages`):** Before each evaluation,
  `extractSessionContext` reads `session.snapshotEvents()` (marking compacted
  frames with `compacted: true`), so Python code can search and analyze the
  entire conversation even after context compaction drops older turns from the
  model prompt.
- **Programmatic RLM & tool bridge:**
  - `await rlm("task", name="worker", role="auditor", fork=False)` or `rlm.spawn(...)`
  - `await rlm.list_subagents()`, `await rlm.send_message(id_or_name, msg)`, `await rlm.interrupt(id_or_name)`
  - `await agent_message.send(msg, receiver_name="main")`
  - `await rlm.harness.list(scope=None, kind=None)`, `.add(...)`, `.update(...)`, `.delete(...)`, `.snapshots()`, `.rollback()`, `.diff()`
  - `await tools.<tool_name>(**kwargs)` ? invokes any registered DSH tool on the calling agent.

## Windows Desktop ConPTY & Sandbox Bridge

In DeepSeek Harness Desktop on Windows, `process.execPath` is `DeepSeek Harness.exe`
(an Electron binary linked with `/SUBSYSTEM:WINDOWS`), and `@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`
lives inside `resources/app.asar`. While pipe-based subprocesses inherit
handles normally, `dsh-terminal-bash` (`persistent-pwsh`) spawns its shell via
`node-pty` (`CreatePseudoConsole` / ConPTY). Windows ConPTY does not attach a
`WINDOWS_GUI` subsystem executable to a pseudo-console, which otherwise causes
`persistent-pwsh` under `workspace-write` to exit immediately with
`Error: PTY shell exited during startup`.

`ensureWindowsSandboxRunner` in `index.js` automatically bridges this on
Windows Desktop by extracting the sandbox runner and native `koffi` bindings to
a versioned temp cache and pointing `sandbox.internals.windowsAclRunnerArgs` at
DSH's bundled `/SUBSYSTEM:CONSOLE` Node binary
(`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`).

## Settings UI

Settings ? **Prime Harness** (registered by `client.js` using
`@deepseek-ai/dsh-client-ui-primitives`) talks to `POST /prime/api` and provides:

- **Default Write Scope & Workspaces Browser:** Switch between **This conversation**
  (`session`) and **Workspaces** (`workspace`). In Workspaces view, a full
  workspace selector lists every known repository on cold boot (discovered from
  live sessions, DSH `storages`, and `~/.dsh/prime/project-*.json` files) with
  entry counts, so you can inspect, add, edit, or roll back any workspace's
  memory even when no chat is currently open.
- **Component Kinds & Entry Controls:** Filter and add entries by kind
  (`Memory`, `Prompt`, `Skill`, `Subagent`), pin/unpin entries to the top of the
  prompt section, edit entry text/kind/name in place, or delete individual
  entries.
- **Snapshot History, Diff & Rollback:** Inspect every recorded pass (`+added ~updated -deleted`),
  view its before/after diff inline, and roll back with one click.
- **Persistent Python REPL Status:** View active kernel state, evaluation count,
  live variable names, persisted `store` keys, and reset the kernel.

## Verifying

```sh
npm run check
```

| Check | Covers |
|---|---|
| `test/self-check.mjs` | store round-trip, `/refine` flags, `harness_refine` batch/evidence/update/delete contract, `python_repl` persistent namespace + `store` + RLM subagent/tool/harness RPC bridge + dynamic `skills` provider, preset-gated post-compaction hook, `/prime/api` route end-to-end, and client bundle invariants |
| `test/validate-patch.mjs` | every row in `cordis.patch.yml` resolves against the installed DSH bundle tree, and both `harness_refine` and `python_repl` schemas pass `@deepseek-ai/dsh-tools`'s validators |
| `test/scope-check.mjs` | scope isolation (`session` vs `workspace`), retired `project` and `global` spellings, deduplication, capacity cap, and goal/query-weighted ranking |

## Layout

| File | Role |
|---|---|
| `cordis.patch.yml` | Declarative `dsh-prime` root row + self-contained `preset-prime` (`Prime`) agent preset |
| `index.js` | Continual Harness host half (scoped stores, snapshots/rollback/diff, ranking, `/refine`, preset-gated post-compaction hook, persistent `python_repl` kernel & RPC bridge, Windows ConPTY sandbox bridge, `/prime/api`) |
| `tool.js` | Agent-scoped half mounted inside `preset-prime`: `prime:continual-harness` prompt section, `harness_refine` tool, `python_repl` tool, and dynamic `prime-harness` skill provider |
| `client.js` | Settings ? **Prime Harness** UI (`__ModuleLoader__` bundle using `@deepseek-ai/dsh-client-ui-primitives`, no build step) |
| `test/self-check.mjs` | End-to-end host, tool, `python_repl`, RLM bridge, API route, and client contract tests |
| `test/validate-patch.mjs` | Bundle row resolution and `@deepseek-ai/dsh-tools` JSON schema validation |
| `test/scope-check.mjs` | Scope isolation, aliases, deduplication, cap, and relevance ranking tests |
