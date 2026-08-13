# Harness reliability — false-green defenses & headless testing

The test harness actively guards against its worst failure mode: **reporting success while the game
loaded the wrong thing** — a base-game-less modlist, a stale deployed binary, or a run that silently
"recovered" to safe mode and tested vanilla. This is the durable reference for those guards and for
testing headlessly. The incident write-ups that motivated them (the 2026-08-12 phantom "Core
regression" and the RP2 × R&T recovery cases) live in git history; the knowledge is here and in code.

## Defenses now enforced (and where)

| Guard | What it does | Where |
|---|---|---|
| **Base game mandatory** | `configure_active_mods` injects `ludeon.rimworld` when absent (any DLC implies it), reports the official block, and writes a modlist fingerprint. | `tools/testing.ts` |
| **Modlist drift** | `checkModlistDrift` compares on-disk `ModsConfig.xml` to that fingerprint; launch + test runner warn before launching when RimWorld reset it to safe mode. | `tools/testing.ts`, `tools/rimworldDev.ts` |
| **Deploy / loaded staleness** | Deploy reports whether the deployed assembly hash actually changed; launch warns when a real (non-symlink) deployed copy is older than the repo build. | `tools/rimworldDev.ts` |
| **Crash-signature diagnosis** | `classifyLog` attaches `diagnosis[]` for base-defs-absent and stale cross-mod (`TypeLoadException`) signatures. | `tools/rimworldDev.ts` |
| **Recovery & collapse-to-vanilla** | A run that "recovered" to safe mode, or whose `Initializing new game with mods:` block collapsed to official-only while non-official mods were intended, is a hard FAIL — never a pass. | `tools/rimworldDev.ts` |
| **Empty run** | `run_rimworld_tests` requires `testsSeen > 0`; a green build is not evidence tests ran. | `tools/rimworldDev.ts` |
| **Cross-mod def refs** | `validate_mod_defs` splits refs whose namespace matches a declared dependency into `resolvedViaDependency` instead of `unresolved`. | `tools/defValidate.ts` |

## Reading a run — is it real?

- A run is valid only when a summary was seen (`testsSeen > 0`, `passed + failed == announced`) **and**
  the config did not drift, collapse to vanilla, or recover to safe mode.
- The game's own `Initializing new game with mods:` block is the authoritative loaded modlist — the
  launch first-pass reports it as `Game initialized N mod(s)`. If it collapsed to official-only, the run
  tested nothing you configured.
- If the first-pass reports the rimagentic bridge is **not responding**, `run_debug_action` /
  `execute_game_tool` will time out — a safe-mode recovery disables the bridge mod.

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

A green run of this list is **152 cases, 0 blocking** (baseline as of 2026-08-12). Run it once to
establish a green baseline **before** diagnosing any "X is broken" — configuration failures dwarf code
regressions as the cause of a red run.

## Headless testing guidance

- **Realistic Planets 2 (`koth.RealisticPlanets2`) is unusable under minimal-modlist `-quicktest`.** Its
  Odyssey-era planet-layer work NREs during worldgen, tripping RimWorld's play-data recovery, which
  resets `ModsConfig` to official-only and disables Harmony, the mod under test, and the bridge
  together. Validate RP2-dependent work **interactively** (or with RP2's full expected environment); for
  map-mode-framework compatibility headlessly, prefer the **NozoMe** modlist, which loads and patches
  cleanly.
- **The dev savedatafolder can hit a recurring `ColoredText.ResetStaticData` NRE** on first play-data
  load. The recovery reload does not reliably re-run `[StaticConstructorOnStartup]`, and the bridge
  (which registers from `GameComponentUpdate`) may never come up — so both the bridge path and the
  startup-log path can be unreliable on an affected run. If the bridge times out, check for the recovery
  line before blaming the mod. A curated known-good `Config` baseline avoids the recovery path.
- **After any `-quicktest`, confirm the mod actually loaded** before trusting a "clean" result — check
  the first-pass `Game initialized N mod(s)` line, or `grep <ModTag> Player.log`. A collapsed-to-vanilla
  run reads as clean but tested nothing.

## Agent rules that still matter

- **Verify a deployed fix by DLL mtime/hash, never ASCII grep** — .NET strings are UTF-16, so a `grep -a`
  for a fix-string is a false negative. Compare `Mods/<Mod>/Assemblies/*.dll` to the repo build.
- **Kill stray processes between runs when anything looks off** — a crashed/hung run leaves
  `RimWorldWin64.exe` alive holding `Player.log`; `taskkill /F` before retrying.
