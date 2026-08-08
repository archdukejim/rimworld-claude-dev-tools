---
name: ui-test
description: Verify a RimWorld UI change with positive AND negative test cases, headlessly, before calling it done. Trigger whenever a change adds or alters a gizmo, window/dialog/float menu, inspect-pane element, colonist bar, or map-overlay/play-settings toggle — including "test this UI", "verify the gizmo/menu/overlay", or the definition-of-done check for any UI work.
---

# UI change test protocol

Runs the positive/negative UI test protocol for `rimworld-claude-dev-tools`. Every UI
change is verified through the real game with headless assertions + screenshot
evidence before it is "done".

**Authoritative spec — follow it exactly:** `docs/UI-TESTING.md`
(This skill is a stable trigger + summary; the spec is the source of truth.)

## Non-negotiables
- **Both polarities, every element.** For each UI element the change touched, produce
  **≥1 positive and ≥1 negative** case. A missing negative case = **not done**.
- **Assert headlessly, then screenshot.** State assertions come from the tools
  (`get_gizmos` / `read_float_menu` / `get_open_windows` / `get_colonist_bar` /
  `get_play_settings`); screenshots (`capture_*`) are evidence, not the assertion.
- **Log clean.** `read_rimworld_log` must show no new exception/Harmony failure across
  each case (a new element that draws every frame is a common per-frame crash source).
- **Negatives assert absence of effect.** Where a negative path should change nothing,
  re-read the state and confirm it did not change.
- **Don't fake a pass.** If RimWorld can't launch, author the matrix and mark it
  `BLOCKED — needs game`; report the change as *unverified*, never done.

## Flow (see the spec for per-type playbooks)
1. **Detect** the UI surface in the working diff (gizmos / windows / float menus /
   inspect tabs / colonist bar / play-settings). If none, this skill doesn't apply.
2. **Launch** `launch_rimworld { quicktest: true }` (blocks until `mapLive`).
3. **Stage** each precondition with the helpers (`spawn_thing`, `finish_research`,
   `set_roof`, `set_weather`, `set_time`, `build_room`, `select_thing_at`, …).
4. **Run** positive then negative cases per element; collect assertion + screenshot +
   log state for each.
5. **Store positives** — `showcase_add` each passing positive case's screenshot
   (caption + element + mod) so Steam-ready evidence accrues for description uploads.
6. **Gate & report** the matrix: elements × {positive, negative} → PASS/FAIL +
   evidence. Any missing negative, or any FAIL/BLOCKED → not done; fix and re-run.

## Tools (rimworld-claude-dev-tools MCP)
- Readiness/launch: `launch_rimworld`, `get_bridge_status`, `read_rimworld_log`.
- Stage: `spawn_thing`, `destroy_thing_at`, `set_roof`, `set_weather`, `set_time`,
  `finish_research`, `build_room`, `fill_rect`, `move_camera`, `clear_selection`.
- Assert UI state: `get_open_windows`, `open_window`, `read_float_menu`,
  `select_thing_at`, `get_gizmos`, `activate_gizmo`, `get_colonist_bar`,
  `get_play_settings`, `set_play_setting`, `inspect_thing_at`, `sample_environment`.
- Evidence: `capture_game_window`, `capture_gizmo`, `capture_colonist_bar`,
  `capture_play_settings`, `capture_screen` (`focusGame:true`).
- Store positives for Steam: `showcase_add`, `showcase_list`, `showcase_remove`.

## Preconditions
RimWorld installed with the RimAgentic mod active (symlinked from the repo). After any
game-side C# change, rebuild (`dotnet build`) and relaunch so the new DLL loads. If a
just-added capture/UI MCP tool isn't callable, the MCP server predates it — restart it
(kill `node server/build/index.js`; the client respawns it) or start a fresh session.
