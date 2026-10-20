# Verifying dsh-prime

`dsh-prime` adds a **`prime` agent mode** to DeepSeek Harness: a preset that wires
prime-agent's harness out of shipped DSH packages, plus the one piece DSH does not
have — the Continual Harness (`/refine`).

Everything below was run on the authoring machine. Re-run it; do not take the
claims on faith. If any step disagrees, that is the finding.

## What to check

| # | Claim | How |
|---|---|---|
| 1 | The patch is well-formed and **every package it names resolves** | `npm run check` |
| 2 | The scoped store, `/refine`, entry editing, and the `/prime/api` route behave as described | `npm run check` |
| 3 | Installing it registers the mode with the **real** Loader | `--dump-config` |
| 4 | The mode is **self-contained** — it does not disturb a profile | inspect `package.json`, `cordis.patch.yml` |
| 5 | No `@deepseek-ai/*` import in the new code | read `index.js`, `client.js` |
| 6 | Scope isolation is real: a session note never leaks into another session | `npm run check` |
| 7 | A wrong entry can be **corrected in place**, not duplicated beside | `npm run check` |
| 8 | An edit with no evidence is refused | `npm run check` |

## 0. Prerequisites

```powershell
# dsh must be on PATH
dsh --help | Select-Object -First 5
```

If `dsh` is not found, use the absolute path:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

Node 20+ is needed for the tests. A bundled copy lives at
`...\resources\runtime\bin\node.exe` if `node` is not on PATH.

## 1-2. Static and unit checks

```powershell
cd dsh-prime
npm run check
```

Expected:

```
dsh-prime self-check: ok
dsh-prime patch ok: preset "prime", 40 rows, all resolvable
ALL PRIME CHECKS PASSED
```

What the three files prove:

- **`test/validate-patch.mjs`** parses `cordis.patch.yml`, then checks every row's
  package name against the real `node_modules` on disk (subpath exports
  included), and rejects duplicate Loader row ids. A typo'd package name is a
  declarative bundle's dominant failure mode, so this matters more than it looks.
  If the harness is installed somewhere unusual, point it there:
  `$env:DSH_APP_DIR = "...\resources\app\dsh\node_modules"`.
- **`test/self-check.mjs`** drives `apply()` through a stub context: store
  round-trip, dedup, the 200-note cap, `--list`/`--clear`, corrupt-file
  degradation (a corrupt store must render as empty, not throw), entry editing,
  the evidence gate, the review gate, and the `/prime/api` route end to end —
  including its guards (wrong method → 405, cross-origin → 403, unknown op and
  empty note → 400, no active session → 409). It also asserts the client
  contract: `dsh.client.platform`, `exports["./client"]`, and that `client.js`
  is a plain `__ModuleLoader__` factory with no ES imports and no host runtime
  imports.
- **`test/scope-check.mjs`** proves the two layers are genuinely separate
  stores: a `session` note is invisible to a second session, and `workspace` is
  shared by matching cwd and invisible to a different cwd. It also proves the
  section is stable across conversation states, that the rendered section does
  not change per turn, that relevance ranking ignores injected context, and that
  a duplicate is rejected.

## 3-4. Install into a throwaway profile and inspect the real Loader tree

This is the end-to-end proof. It never touches your working profile.

```powershell
# --- pick a scratch profile name ---
$prof = "prime-review"

# clear any previous run (only needed if you have run this before)
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\$prof" -ErrorAction SilentlyContinue

# scaffold it from a shipped profile. NOTE: this THROWS if the profile already
# exists -- omit --from-default-profile on a re-run.
dsh --profile $prof --from-default-profile web --dump-config > $null

# install the bundle from this directory
dsh plugin --profile $prof add "$(Get-Location)"

# print the composed config tree
dsh --profile $prof --dump-config > "$env:TEMP\prime-dump.txt"
```

Now assert the findings:

```powershell
$t = Get-Content "$env:TEMP\prime-dump.txt" -Raw

"attribution section present : " + $t.Contains("# == dsh-prime")
"preset-prime row present    : " + $t.Contains("preset-prime")
"config.id is prime          : " + ($t -match "(?m)^\s+id: prime\s*$")
"bundle's own row mounted    : " + $t.Contains("name: dsh-prime")

# Scope to the bundle's OWN section -- other presets legitimately share the
# declaration package name, so counting tree-wide proves nothing.
$i  = $t.IndexOf("# == dsh-prime")
$sect = $t.Substring($i)
$nxt  = [regex]::Match($sect.Substring(10), "(?m)^# == ")
if ($nxt.Success) { $sect = $sect.Substring(0, $nxt.Index + 10) }
"preset declarations in sect : " + ([regex]::Matches($sect, "name: '@deepseek-ai/dsh-agent-preset'").Count)
"plugin rows in section      : " + ([regex]::Matches($sect, "(?m)^\s+- id: ").Count)
"groups in section           : " + ([regex]::Matches($sect, "name: cordis:group").Count)

# and it must not have damaged the profile
$p = Get-Content "$env:USERPROFILE\.dsh\profiles\$prof\package.json" -Raw | ConvertFrom-Json
"bundles                     : " + ($p.dsh.profile.bundles -join ", ")
```

Expected: the four probes `True`, and **inside the section** exactly
**1** preset declaration, **40** plugin rows, and **3** groups, with `dsh-prime`
appearing **once**, at the end of the bundle list.

Why scoped: counting `'@deepseek-ai/dsh-agent-preset'` across the whole tree gives
`5` — the shipped `standard`, `ptc`, and others use that package too.
Counting tree-wide therefore proves nothing about this bundle.

## 5. Read the new code

`index.js` is the only new host logic, and `client.js` the only new UI logic.
Three things to confirm:

1. **Neither imports `@deepseek-ai/*` at runtime.** An installed bundle resolves
   against the *profile's* `node_modules`, which carries no `@deepseek-ai/*`
   runtime packages — importing one would break at load time. Grep for `from "@`
   in each:

   ```powershell
   Select-String -Path .\index.js, .\client.js -Pattern 'from "@'
   ```

   Expected: no output. (`client.js` calls `require("react")` and
   `require("@deepseek-ai/dsh-client-ui-primitives")`; `react` is a baseline seed
   the loader always provides, and `primitives` is a shipped bundle already in
   the client module graph — its row is named in `dsh.client.external` so the
   graph places it first.)

2. **`/refine` cannot corrupt the workspace.** It writes JSON under
   `$DSH_HOME\prime\` via a temp-file rename swap, and degrades to an empty
   list rather than throwing when a file is unreadable. It never writes inside
   the project checkout.

3. **The UI's one route is defended.** `/prime/api` accepts `POST` only and
   rejects cross-origin requests before touching the store.

## Try it in the UI (optional)

1. Install into your real profile: `dsh plugin --profile desktop add "$(Get-Location)"`
2. Restart DeepSeek Harness (a reload is not enough — the bundle list is read at boot).
3. Settings -> agent preset -> select **Prime**.
4. Run `/refine the reviewer should be able to explain what this mode does`, then
   `/refine --list`. The note must survive a restart.
5. Open Settings -> **Prime Harness**. Switch the scope to **This workspace**,
   add a note, switch back to **This conversation**: the two lists must be
   different. The conversation list still shows step 4's note; the workspace
   list shows only the new one. Each row prints its 8-character ref, its date,
   and the evidence behind it.
6. Trigger a compaction. A forked `refine` row appears **only if the session has
   taken 15 model steps since the last pass** (manual or automatic). The child
   reads the completed-turn prefix — the history the compaction is about to
   replace — and opens by asking whether anything is durable at all; "nothing
   durable" is a normal answer.
7. Ask the agent to correct an entry it already recorded. It must **update the
   entry by its ref**, not add a second one beside it — check with
   `/refine --list` that the count did not grow. Two entries that disagree are
   the failure this exists to prevent.

To revert: `dsh plugin --profile desktop remove dsh-prime`

## What is deliberately *not* claimed

Read `README.md` -> "How far the RLM comparison goes" before scoring parity.
These are **not** at parity, and the README says so plainly:

1. **No persistent REPL.** `dsh-ptc-runtime-node` reports "each call runs in a
   fresh Node process", so nothing survives between calls. prime-agent's
   "context as a variable" needs a namespace that lives across steps. A
   persistent worker is deferred until a case needs it, not ruled out.
2. **No separate review call.** prime-agent reviews a pending refinement with its
   own model invocation and only an approving review runs it. Here the review is
   the pass itself — the gate decides *whether* to run one, but a pass that
   concludes "nothing durable" still costs a turn.
3. **Agent Teams is not mounted** — its `list_agents` / `interrupt_agent`
   double-register against `dsh-tool-subagent-control`, and its peer-roster is
   not prime's model. The opt-in path is a comment in `cordis.patch.yml`.
4. **Quality gates** — prime's `/autonomous` runs user-defined gates; DSH's round
   driver stops at its budget. This needs a round-driver seam, not a config row.

The `/refine` command surface remains: a bare `/refine` runs a pass,
`/refine <note>` records, `/refine --list`, `/refine --clear`. Entry editing
happens through the `harness_refine` tool, which the agent calls.

Rollback via stored before/after snapshots is also not built — prime-agent has
it, and it was deliberately deferred here.

Parity here is **composition, not reimplementation**: 39 of 40 rows mount shipped
`@deepseek-ai/*` packages; only `dsh-prime` and `dsh-prime/tool` are new code. The
claim to test is therefore "does it compose correctly", not "is it a faithful
reimplementation".

## Reporting a finding

Please include: the exact command, the full output, the step number above, and
your DSH version / OS. A disagreement between what this document predicts and
what you observe is the most valuable thing you can send back.
