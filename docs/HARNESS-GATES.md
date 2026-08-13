# Harness Gates & Agent Failure Modes

Hard checks the MCP endpoints should enforce, and behavioral rules the agent
definitions should carry, to stop the class of failure where **the harness reports
success while the game loaded the wrong thing** — and the agent then burns hours
diagnosing a phantom code bug.

Written after a 2026-08-12 session that spent ~13 launch cycles "root-causing" a
`ColoredText.ResetStaticData` NRE as a Core regression. It was neither a bug nor new:
the agent's `configure_active_mods` calls had omitted the base game `ludeon.rimworld`,
and a stale deployed `TestRunner` copy masked the actual fix. Both traps were already
documented in agent memory and both were re-derived the hard way. This has happened
before, so the durable fix is **gates at the endpoints**, not more prose.

Each item is tagged **[MCP gate]** (the endpoint should enforce/refuse/warn) or
**[Agent rule]** (belongs in the agent definition). The check condition is written
concretely so it can be implemented directly.

> **Implementation status (2026-08-13).** The MCP-side gates below are now implemented in
> `server/src/tools/testing.ts` (G1, plus the shared `checkModlistDrift`/fingerprint used by
> G4/G5), `server/src/tools/rimworldDev.ts` (G2, G3, G4, G5, G6, G7), and
> `server/src/tools/defValidate.ts` (G8). Concretely:
> - **G1** — `configure_active_mods` injects `ludeon.rimworld` when absent (implied by any DLC),
>   reports the official block, and writes a modlist fingerprint next to `ModsConfig.xml`.
> - **G5/G4** — `checkModlistDrift` compares the on-disk modlist to that fingerprint; `launch_rimworld`
>   and `run_rimworld_tests` warn before launching, and the launch first-pass flags a POST-recovery list.
> - **G6** — `deploy_rimworld_mods` reports whether the deployed assembly hash actually changed;
>   `launch_rimworld` warns when a real (non-symlink) deployed copy is older than the repo build.
> - **G7** — `classifyLog` attaches a `diagnosis[]` for the base-game-absent and stale-cross-mod signatures.
> - **G2/G3** — `run_rimworld_tests` refuses to call an empty run a pass (`testsSeen > 0` required) and
>   emits a `diagnosis`; `runStage` reconciles `launch.exited` against a live `RimWorldWin64.exe`.
> - **G8** — `validate_mod_defs` splits refs whose namespace matches a declared dependency into
>   `resolvedViaDependency` instead of `unresolved`.
>
> The **agent-definition rules (R1–R6)** below remain guidance for the agent, not code.

---

## Priority order

The three that turn a "fails" into a "lies" — implement these first:

1. **G1** — `configure_active_mods` refuses a base-game-less modlist. *(Prevents the entire class outright.)*
2. **G5** — `run_rimworld_tests` detects ModsConfig drift (RimWorld reset it) before launching.
3. **G6** — deploy/launch warns when the **loaded** mod copy is older than the repo build.

Everything else reduces diagnosis time; these three prevent the false-green.

---

## A. MCP endpoint gates

### G1 — `configure_active_mods`: base game is mandatory  ⭐ highest leverage
- **Symptom:** RimWorld crashes at play-data load with `Could not find parent node "BaseMentalState"` / `"BaseStoryteller"` and a `ColoredText.ResetStaticData` NRE, then resets ModsConfig to safe mode.
- **Wrong signal the tool gave:** returned `"Successfully configured"` and a resolved list beginning `["brrainz.harmony","rimsynapse.core"...]` — with **no `ludeon.rimworld`**. The description's "resolving official-first" was read as "adds the base game for you." It does not; `enableDlc` toggles DLC flags but never adds the base game.
- **Check:** after resolving the active list, assert `resolved.includes("ludeon.rimworld")`. If absent → **auto-inject it at the front of the official block, or hard-fail** with:
  `"ludeon.rimworld (base game) not in active mods — RimWorld cannot load and will reset to safe mode. Auto-added." (or refuse)`
- **Also:** enabling any DLC (`enableDlc`) without the base game is incoherent — treat DLC-enable as implying `ludeon.rimworld`.
- **Also:** the return payload should make the official block explicit, e.g. `officialActive: ["ludeon.rimworld", ...dlcs]`, so a caller/agent can see at a glance whether the base game is present.

### G2 — Success payloads must not lead with a reassuring field when the run was empty
- **Symptom:** `run_rimworld_tests` returned `build.ok:true` while `launch.ok:false`, `sawSummary:false`, 0 cases. The green build anchored the agent toward "code is fine, environment is weird."
- **Check:** when `sawSummary:false`, surface a top-level hard error with a cause hint rather than a payload whose first field is `build.ok:true`. Suggested:
  `error: "NO TESTS RAN — sawSummary:false. Likely: TestRunner not in active mods, or game reset to safe mode (base game missing?). Build success does NOT mean tests ran."`
- **Rule of thumb the endpoint should encode:** *a run is only valid when `sawSummary:true` AND `passed + failed == announced`.*

### G3 — `launch.exited` must reflect the real game process
- **Symptom:** `launch.exited:true, elapsedSec:290` reported while `RimWorldWin64.exe` was still alive (hung on the safe-mode modal), holding a lock on `Player.log`.
- **Wrong signal:** the harness tracked a launcher/wrapper that returned; the detached game kept running.
- **Check:** before reporting `exited`, poll for a live `RimWorldWin64.exe`. Report one of:
  `exited: true (process gone)` | `wrapper returned; RimWorldWin64.exe still alive (PID <n>) — likely hung on a dialog`.
- **Bonus:** if `Player.log` is locked on read, that itself proves the game is still alive — surface it instead of failing `readlog` with a raw IOException.

### G4 — Env-check must not report the post-reset modlist as if it were the run's modlist
- **Symptom:** the launch env-check printed `"Active modlist: 6 mods (last odyssey)"` — the list **after** RimWorld's safe-mode recovery, not what the crashing first pass loaded. It pointed the agent at "DLCs are involved" when they weren't.
- **Check:** capture the modlist from the **first** load attempt. If RimWorld rewrote `ModsConfig` mid-run (safe-mode recovery), flag it explicitly:
  `"modlist was reset to safe mode during this run; the list shown is POST-recovery, not what crashed."`

### G5 — `run_rimworld_tests` must detect ModsConfig drift before launching  ⭐
- **Symptom:** the NRE made RimWorld overwrite `ModsConfig.xml` down to vanilla **on disk**. The agent's *next* run then loaded 6 vanilla mods, ran nothing, exited fast — looking like a clean pass. The config was being clobbered between runs and nothing said so.
- **Check:** persist the last-configured modlist (hash it). At the start of `run_rimworld_tests`/`launch_rimworld`, compare the on-disk `ModsConfig.xml` to it. On mismatch:
  `"ModsConfig.xml changed since you configured it (RimWorld likely reset it to safe mode after a prior crash). Re-run configure_active_mods before launching."` — and refuse, or re-assert the intended config automatically.

### G6 — Deploy/launch must expose staleness of the LOADED copy  ⭐
- **Symptom:** `deploy_rimworld_mods` reported `"Compilation successful / Deployment successful"` while (a) the built DLL was byte-identical (no-op build) and (b) the game loads `Mods/TestRunner`, a **stale real-folder copy** two days old — so a validated fix never loaded and the test kept failing with the *pre-fix* message.
- **Checks:**
  - Deploy should report the deployed DLL's **hash/mtime and whether it changed**:
    `Core: DLL unchanged (no source delta)` vs `Core: DLL updated (mtime <old>→<new>, hash <a>→<b>)`.
  - Deploy/launch should classify each active mod's `Mods/<Mod>` as **symlink (repo = live)** vs **real copy (can go stale)**, and **warn when a real copy's DLL is older than the repo build** of that mod:
    `WARN Mods/TestRunner is a real copy; its DLL (2026-08-10) is older than the repo build (2026-08-12) — the game is running a stale binary. Redeploy or restore the symlink.`
  - This is the single "harness lies" root: a fix that built fine but isn't what runs.

### G7 — `read_rimworld_log` should map known crash signatures to a diagnosis
- **Symptom:** the classifier reported the raw errors; the agent interpreted `BaseMentalState`/`BaseStoryteller` "could not find parent" + `ColoredText.ResetStaticData` NRE as a Core code regression.
- **Check:** maintain a signature table. This exact trio → `"DIAGNOSIS: base game likely inactive — check ludeon.rimworld is in the modlist."` A known-signature hint turns a multi-hour hunt into one line.
- Seed the table with: base-game-absent (above); `TypeLoadException: Could not resolve type … in assembly RimSynapse<X>` → `"stale cross-mod reference — a mod that references <X>'s types is built against an older <X>; rebuild/redeploy the referencing mod."`

### G8 — `validate_mod_defs` should soften cross-mod "unresolved" as non-error
- **Symptom:** flagged Core types (`RimSynapse.*`) referenced by a companion as "unresolved" because it doesn't load Core's assembly. Correctly discounted here, but a naive agent could chase it.
- **Check:** when an unresolved `Class=` type's namespace matches a declared mod dependency, label it `resolved-via-dependency (not loaded here)` rather than `unresolved`.

---

## B. Agent-definition rules

### R1 — Baseline before "regression"
Before diagnosing any "X is broken," run the **documented known-good modlist once** to
establish a green baseline. A single green 152-case run first would have proven the
"Core-only crash" was configuration, not code — instead of bisecting a phantom.

### R2 — Read environment/tool memory at the START of harness trouble, not the end
Environment-tagged memories (here: the base-game-omission trap and the stale-deploy
trap) were written down and consulted only after the fact. When a harness run misbehaves,
the first action is to load the tool/environment notes, not to start bisecting.

### R3 — A run is only valid when the summary is present
Never treat `build.ok:true` as evidence tests ran. Proof of a run =
`sawSummary:true` and `passed + failed == announced`. `activeMods` without
`rimsynapse.testrunner` (or with only 6 official mods) means nothing ran.

### R4 — Always lead `activeMods` with the official block
Every `configure_active_mods` call lists `ludeon.rimworld` + the five
`ludeon.rimworld.<dlc>` ids explicitly. A resolved list that starts
`["brrainz.harmony","rimsynapse.core"...]` (no base game) is a guaranteed crash.

### R5 — Verify deployed binaries by mtime/hash, never ASCII grep
`grep -a` on a .NET DLL for a fix-string is a **false negative** — .NET strings are
UTF-16 (`t\0y\0p\0e\0s\0`), so ASCII search never matches. To confirm a fix deployed,
compare `Mods/<Mod>/Assemblies/*.dll` mtime/hash to the repo build.

### R6 — Kill stray processes between runs when anything looks off
A crashed/hung run leaves `RimWorldWin64.exe` (+ `UnityCrashHandler64.exe`) alive,
holding `Player.log` and competing with the next launch. `taskkill /F` both before
retrying; verify with `tasklist`.

---

## Known-good test modlist (20 mods, base game first)

```
ludeon.rimworld
ludeon.rimworld.royalty
ludeon.rimworld.ideology
ludeon.rimworld.biotech
ludeon.rimworld.anomaly
ludeon.rimworld.odyssey
brrainz.harmony
rimsynapse.core
nozome.mapmodeframework
rimsynapse.regionsandterritories
rimsynapse.livingworld
rimsynapse.psychology
rimsynapse.conversations
rimsynapse.worldnews
rimsynapse.factions
rimsynapse.auraalgorithm
rimsynapse.nvidiatool
rimsynapse.llmtrainer
rimsynapse.testrunner
archdukejim.rimagentic
```

A green run of this list is **152 cases, 0 blocking** as of 2026-08-12.
