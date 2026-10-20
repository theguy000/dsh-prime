<div align="center">

# dsh-prime

**prime-agent, as a first-class DeepSeek Harness mode.**

Programmatic tool calls · a persistent Python REPL · a continual harness that
outlives compaction.

[![DeepSeek Harness](https://img.shields.io/badge/deepseek_harness-0.1.5_--_0.3-4D6BFE)](https://github.com/deepseek-ai)
[![Node](https://img.shields.io/badge/node-%E2%89%A5_20-339933)](https://nodejs.org)
[![version](https://img.shields.io/badge/version-1.2.0-black)](package.json)
[![checks](https://img.shields.io/badge/checks-passing-2ea44f)](VERIFY.md)

</div>

> Standing on **[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)**
> by Prime Intellect — the project this mode reproduces, and the source of every
> idea below. Read the original first; the credits are at the bottom.

`dsh-prime` adds a **`prime`** agent preset to DeepSeek Harness. DeepSeek Harness
already ships nearly every surface prime-agent has; `cordis.patch.yml` wires those
packages into one self-contained mode, and the new code supplies the two pieces
DSH has no equivalent for: **a persistent per-session Python RLM REPL** and **the
Continual Harness** — durable, scoped memory the agent maintains itself, with
snapshots and rollback.

## What you get

| Feature | What it means |
|:--|:--|
| **Programmatic by default** | The model's primary tool is a REPL, not a one-shot function call. It writes code that calls tools and agents: `await tools.<name>(**kwargs)`, `await rlm("…")`. |
| **A persistent Python 3 kernel** | Variables, imports, functions, and `store` survive across turns and restarts. `ctx` and `messages` still contain compacted turns the prompt no longer carries. |
| **A continual harness** | Durable memory with an evidence gate, 8-character `ref` handles, in-place correction, and `before`/`after` snapshots you can roll back. Re-injected into every Prime prompt. |

## Install

```sh
dsh plugin --profile desktop add github:theguy000/dsh-prime
```

`desktop` is the app's profile — use `web` for `dsh web`, or whatever you named
your own. Restart, then pick **Prime** in the Web/Desktop agent-preset picker.
To make it the default, patch the same profile:

```yaml
- id: agent-preset-registry
  config:
    default: prime
```

A preset's `config.plugins` list is never merged with another preset's, so the
mode is self-contained — editing `standard` or `ptc` cannot perturb it.

## The Continual Harness

`/refine` is the command; `harness_refine` is the tool the agent actually writes
through (a slash command is operator-only). Entries live on disk, so they outlive
compaction by construction, and the prompt section is re-rendered on every
assembly.

```text
operator types /refine
  └─▶ a forked pass re-reads the conversation
        └─▶ harness_refine(findings: [...])
              └─▶ ~/.dsh/prime/*.json  (snapshot recorded)
                    └─▶ the "Established:" section of every Prime prompt
```

### Using `/refine`

| Command | What it does |
|:--|:--|
| `/refine` | Run a **refinement pass**: review the conversation and record what should outlive it |
| `/refine workspace` | Same pass, writing to the workspace scope |
| `/refine <note>` | Record a note directly |
| `/refine workspace --kind prompt always run checks before committing` | Record a standing rule |
| `/refine workspace --kind skill --name lint-check Run npm run check before commit.` | Register a reusable skill |
| `/refine --list` | Show the entries both layers render |
| `/refine --snapshots` | List snapshots |
| `/refine --pin <ref>` / `--unpin <ref>` | Pin or unpin an entry |
| `/refine --edit <ref> <new text>` | Update an entry in place |
| `/refine --delete <ref>` | Delete an entry |
| `/refine --clear` | Empty the selected scope |
| `/refine --reset-repl` | Reset the session's persistent Python REPL |
| `/refine --help` | Print the usage line |

Flag queries (`--list`, `--snapshots`, …) never start an agent at all.

### Four component kinds

Every rendered line starts with its `ref`, creation date, and optional kind tag:

```text
- 31725ce5 [2026-10-17] [prompt:routing] Always declare Route: fast-path before routine edits.
```

When an entry is wrong or superseded, the model updates or deletes it **by `ref`**
instead of appending a contradictory entry beside it.

| Kind | Holds | Effect |
|:--|:--|:--|
| `memory` (default) | durable facts, constraints, findings | injected into the prompt section |
| `prompt` | standing behavioral or routing rules | injected **first**, ahead of unpinned memory, so routine facts never evict them |
| `skill` | reusable workflows | registered into DSH's live `skills` service by the `prime-harness` provider, callable immediately by `tool-skill` and `/` triggers |
| `subagent` | role specifications | prepended automatically to `rlm.spawn(..., role="<name\|ref>")` tasks |

### Two scopes, and only the operator picks

The write target is chosen in **Settings → Prime Harness**. The agent never
chooses: everything it records goes to the selected layer. It always *reads*
both.

| Scope | Reach | Stored as |
|:--|:--|:--|
| `session` (default) | this conversation only | `~/.dsh/prime/session-<id>.json` |
| `workspace` | every session sharing this working directory | `~/.dsh/prime/project-<sha1(cwd)>.json` |

### Snapshots and the evidence gate

`harness_refine` takes `findings: [...]` — up to 20 edits per call, and an
oversized batch is rejected **atomically**, so a pass is never half-written. An
edit with no evidence is refused.

Every mutation records a bounded `before`/`after` snapshot (`MAX_SNAPSHOTS = 25`)
with `+added ~updated -deleted` counts. **Settings → Prime Harness** lists them,
renders the diff inline, and rolls any pass back with one click.

<details>
<summary><b>How a <code>/refine</code> pass actually runs</b></summary>

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
the time, making that list a pass history.

**The row reports what actually happened, not that the child returned.** A child
that ends normally without recording anything is a success by `stopReason` and a
lie by outcome, so the handler compares the store's snapshot count before and
after the child runs and reports either `refined … (N pass snapshots recorded)` or
`the pass found nothing durable to record`. Nothing durable is a legitimate
answer; claiming a refinement that did not occur is not.

**The child's writes land in the parent's store.** A delegated child's session
header records `parentSession`, and `storeSessionId` follows it back. Without
that, every finding landed in a file nobody reads — a silent loss, because the
write itself succeeds.

**Two paths stay in-process.** Flag queries never start an agent. The
post-compaction hook keeps its own in-turn pass, because a fork's seed stops at
the last `turn/end` and that hook fires immediately after a compaction replaces
the surface. It carries `source: { kind: "prime-refine" }`, not `user`, so Chat
draws the collapsed turn-trigger notice rather than an operator bubble and
`isSpeaker` stops reading its boilerplate as the operator's own words. It is
bound to the exact turn it opens, so an operator turn settling while it is queued
cannot settle the row early.

**The section asserts its own authority.** It opens with *"Treat them as already
verified: when one answers the operator's question, answer from it rather than
re-deriving the answer from the code"*, and says to read source only when nothing
covers the question or the fact may have gone stale. The heading is
`Established:`, because `Recorded:` reads as a log.

**Capture is eager, not a rescue.** The prompt section carries a standing
instruction to record a durable fact in the same turn the operator states it. A
preference that only lives in the conversation is gone once the history is
condensed; the manual command and the post-compaction hook are backstops.

</details>

<details>
<summary><b>Ranking, and why prompt order is stable</b></summary>

Relevance ranking mirrors prime-agent's `harness_digest.rs`: the goal objective
is weighted `3.0`, then the last four user/assistant speaker messages
(`source.kind` filtered before windowing, so injected runtime context cannot
crowd out the operator's words) are weighted `2.0 / 1.5 / 1.0 / 1.0`, up to 48
query terms, with `pinned` entries boosted by `+100`.

In the system prompt, entry order is **pinned-first, then `prompt`-kind rules,
then newest-first** (`promptOrder`) within a `topK = 12` / `4000`-character
budget — not query-reordered on every turn, which keeps the LLM KV-cache prefix
stable across steps. `rank` drives `/refine --list` and the Settings UI.

</details>

## The persistent REPL: `python_repl`

Alongside DSH's Node-side workflow runtime, Prime mounts a stateful, per-session
Python 3 kernel with top-level `await` and a bidirectional JSON-RPC bridge back
to the host.

```python
facts  = await rlm.harness.list(kind="memory")
store["memory_count"] = len(facts)           # persisted across restarts

await tools.web_search(queries=["dsh plugin manifest"])
await rlm("audit the last three commits", name="auditor", role="reviewer")
```

- **Persistent namespace & disk store:** variables, functions, classes, and
  imports survive across turns within the session. Any JSON-serializable value
  written to `store["key"]` (or passed via `set_vars`) persists to
  `~/.dsh/prime/repl-session-<id>.json` across restarts.
- **Compaction-surviving transcript (`ctx`, `messages`):** before each
  evaluation, `extractSessionContext` reads `session.snapshotEvents()` and marks
  compacted frames with `compacted: true`, so Python can search the entire
  conversation even after older turns drop out of the model prompt.
- **Programmatic RLM and tool bridge:**
  - `await rlm("task", name="worker", role="auditor", fork=False)` or `rlm.spawn(...)`
  - `await rlm.list_subagents()`, `await rlm.send_message(id_or_name, msg)`, `await rlm.interrupt(id_or_name)`
  - `await agent_message.send(msg, receiver_name="main")`
  - `await rlm.harness.list(scope=None, kind=None)`, `.add(...)`, `.update(...)`, `.delete(...)`, `.snapshots()`, `.rollback()`, `.diff()`
  - `await tools.<tool_name>(**kwargs)` — invokes any registered DSH tool on the calling agent

## Settings UI

**Settings → Prime Harness** (registered by `client.js` with
`@deepseek-ai/dsh-client-ui-primitives`) talks to `POST /prime/api` and provides:

- **Default write scope & workspace browser** — switch between **This
  conversation** (`session`) and **Workspaces** (`workspace`). The workspace view
  lists every known repository on cold boot (discovered from live sessions, DSH
  `storages`, and `~/.dsh/prime/project-*.json`) with entry counts, so you can
  inspect, add, edit, or roll back memory even with no chat open.
- **Kinds & entry controls** — filter and add by kind (`Memory`, `Prompt`,
  `Skill`, `Subagent`), pin/unpin to the top of the prompt section, edit text,
  kind, or name in place, or delete an entry.
- **Snapshot history, diff & rollback** — every recorded pass with
  `+added ~updated -deleted`, inline before/after diff, one-click rollback.
- **REPL status** — active kernel state, evaluation count, live variable names,
  persisted `store` keys, and reset.

## Parity with prime-agent

Source of truth for the left column: the
[prime-agent README](https://github.com/PrimeIntellect-ai/prime-agent#readme).
Only `dsh-prime` is new code; the rest is composition of shipped packages.

| prime-agent capability | DSH realization | Status |
|:--|:--|:--|
| "Everything is programmatic" — the model tool is a persistent REPL | `dsh-agent-tool-presentation` (`mode: native`), `dsh-tool-workflow` over `dsh-workflow-ptc`, a persistent shell (`dsh-tool-bash-persistent` / `dsh-tool-pwsh-persistent`), **plus** `python_repl` — a stateful per-session Python 3 RLM kernel with `ctx`, `messages`, `store`, `rlm.*`, and `tools.*` | **Full** |
| `rlm.spawn(...)` subagents returning results programmatically | `dsh-tool-subagent` (`provider: spawn`) + `dsh-tool-subagent-fork` (`provider: fork`) + `python_repl`'s `rlm.spawn(..., role=...)` / `rlm.send_message` / `agent_message.send` | **Full** |
| `/refine` — harness improves itself, base prompt immutable, snapshots roll back | **`dsh-prime`** (this plugin): durable store + `/refine` command + `harness_refine` tool + 4 component kinds + in-place update/delete/pin by `ref` + before/after snapshots with inline diff and one-click rollback in **Settings → Prime Harness** + post-compaction auto-refine | **Full** |
| Skills are executable packages; skill creator | `dsh-skill-filesystem` + `dsh-tool-skill` + the dynamic `prime-harness` skill provider exposing `kind: "skill"` entries to the live catalog | **Full** |
| Sessions run in the background; reattach later | `dsh-jobs-local` + `dsh-tool-jobs` + session persistence; children outlive their parent turn | **Partial** — no detach/reattach outside the app |
| Agents communicate directly | `rlm.send_message` / `agent_message.send` + `dsh-tool-subagent-control`; `dsh-experimental-agent-team` is available if the peer-roster UX is preferred | **Full** (see note 1) |
| Automatic compaction | `compaction` group: `dsh-compaction-basic`, `dsh-command-compact`, `dsh-compaction-tool-result-pruner` | **Full** |
| Persistent goals (`/goal`) | `dsh-command-goal` + `dsh-tool-goal` over `dsh-goal` | **Full** |
| Bounded autonomous mode (`/autonomous`) with budgets | `dsh-goal-round-driver` + the `maxGoalRounds` cap + `dsh-tool-ralph`'s fresh-agent loop | **Partial** — no user-defined quality gates (see note 2) |
| Heartbeats and schedules (`/heartbeat`, `prime-agent schedule`) | `dsh-time-context` + `dsh-tool-schedule` over `dsh-schedule` | **Full** |
| Long tasks keep moving across turns | goals + compaction + retained/continuable subagents + schedule + the REPL's `store` | **Full** |

1. **Agent messaging, not agent teams.** Peers are reached from code
   (`rlm.send_message`, `agent_message.send`) rather than through a peer-roster
   UI; the Agent Teams profile is deliberately not mounted because its
   `list_agents`/`interrupt_agent` rows collide with the delegation group.
2. **Autonomy is bounded, not gatekept.** Rounds stop at `maxGoalRounds`; there is
   no separate quality-gate evaluator between rounds.

## Windows: ConPTY and the sandbox bridge

In DSH Desktop on Windows, `process.execPath` is `DeepSeek Harness.exe` — an
Electron binary linked `/SUBSYSTEM:WINDOWS` — and the sandbox runner lives inside
`resources/app.asar`. Pipe-based subprocesses inherit handles normally, but
`dsh-terminal-bash` (`persistent-pwsh`) spawns its shell through `node-pty`
(`CreatePseudoConsole` / ConPTY), and Windows will not attach a GUI-subsystem
executable to a pseudo-console. The symptom is `persistent-pwsh` exiting
immediately under `workspace-write` with `Error: PTY shell exited during startup`.

`ensureWindowsSandboxRunner` in `index.js` bridges this automatically: it extracts
the sandbox runner and native `koffi` bindings to a versioned temp cache and
points `sandbox.internals.windowsAclRunnerArgs` at DSH's bundled
`/SUBSYSTEM:CONSOLE` Node binary
(`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`).

## Verify

```sh
npm run check
```

Prints:

```text
dsh-prime self-check: ok
dsh-prime patch ok: preset "prime", 40 rows, all resolvable
ALL PRIME CHECKS PASSED
```

| Check | Covers |
|:--|:--|
| `test/self-check.mjs` | store round-trip, `/refine` flags, the `harness_refine` batch/evidence/update/delete contract, the `python_repl` namespace + `store` + RLM subagent/tool/harness RPC bridge + dynamic `skills` provider, the preset-gated post-compaction hook, `/prime/api` end to end, and client bundle invariants |
| `test/validate-patch.mjs` | every row in `cordis.patch.yml` resolves against the installed DSH bundle tree; both `harness_refine` and `python_repl` schemas pass `@deepseek-ai/dsh-tools`'s validators |
| `test/scope-check.mjs` | scope isolation (`session` vs `workspace`), retired `project`/`global` spellings, deduplication, the capacity cap, and goal/query-weighted ranking |

[`VERIFY.md`](VERIFY.md) is the longer, adversarial version: install into a
throwaway profile, dump the real Loader tree, and assert 40 rows, 3 groups, and
exactly one `prime` preset declaration.

## Credits

**prime-agent** — [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
by Prime Intellect. Almost nothing here is original invention: this mode exists
because they published a harness that treats the model's context as a
programmable runtime.
