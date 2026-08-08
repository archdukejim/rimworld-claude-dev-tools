# UI change testing protocol — positive + negative cases

Authoritative spec for verifying **any RimWorld UI change or enhancement** the agent
makes. It is enforced: a UI change is not "done" until it has passed **both** a
positive and a negative test case per changed element, headlessly, with evidence.
The `ui-test` skill runs this protocol; `CLAUDE.md` makes it mandatory.

Scope — a "UI change" is any change that adds or alters something the player sees or
clicks: a **gizmo** (command button on a thing/pawn), a **window / dialog / float
menu**, an **inspect-pane** element, a **colonist-bar** element, or a **map-overlay /
play-settings toggle**. Def-only changes that surface a new gizmo/comp count too.

Why both polarities — a positive-only test proves the happy path but misses the
failures that actually break mods: an element showing when it shouldn't, an option
that should be disabled being usable, a bad target throwing mid-tick, or a stale
menu. The negative case is where UI bugs live.

---

## The core rule

For **each UI element touched by the change**:

1. **≥1 positive case** — under the correct precondition, the element appears and
   behaves exactly as intended.
2. **≥1 negative case** — under an incorrect or edge precondition, the element is
   correctly **absent / disabled / bounded / side-effect-free**, and never throws.
3. **Evidence for both** — a headless assertion (tool output you check), a
   **screenshot** (`capture_*`), and a **clean log** (`read_rimworld_log` shows no
   new exception across the case).

A change with only a positive case is **not done**.

---

## Positive vs negative — definitions

**Positive** = *right conditions → intended result.* The precondition the feature was
built for holds, and the UI does the thing: the gizmo is present with the right label;
activating it opens the expected menu with the expected options; the toggle flips the
overlay; the window shows the right contents.

**Negative** = *wrong/edge conditions → graceful, correct handling.* Pick at least one
flavor that fits the element:

| Flavor | Question it answers | Example |
|---|---|---|
| **Absence** | Is it hidden when its precondition is unmet? | Gizmo must NOT appear on a thing that lacks the comp / research / faction. |
| **Disabled** | Is it shown-but-disabled with the right reason when it can't be used? | A float-menu option `disabled:true` when the target is invalid. |
| **Boundary / bad input** | Does invalid / empty / extreme input degrade gracefully? | Empty menu, out-of-range cell, missing target → sensible message, no crash. |
| **No side effect** | Does a cancel / read-only / disabled path leave state unchanged? | Opening then dismissing a menu mutates nothing; a disabled action does nothing. |

Every case — positive or negative — also asserts the **log stays clean** (drawing a
new element every frame is a common source of per-frame exceptions).

---

## Element types → headless assertion tools

The tools we drive the game with *are* the assertion API. Pick the row for the element
you changed:

| Element | Discover / read state | Trigger behavior | Verify effect | Screenshot |
|---|---|---|---|---|
| **Gizmo** | `select_thing_at` → `get_gizmos` (present? label? count?) | `activate_gizmo` | `read_float_menu` / `get_open_windows`; then `inspect_thing_at` / `sample_environment` / game-state read | `capture_gizmo` |
| **Window / dialog** | `open_window` (or in-game trigger) → `get_open_windows` (type/rect present?) | — | `get_open_windows` (gone after close?) | `capture_game_window` |
| **Float menu** | `activate_gizmo` / right-click path → `read_float_menu` (options? disabled?) | choose an option (if applicable) | game-state read | `capture_game_window window:"FloatMenu"` |
| **Colonist bar** | `get_colonist_bar` (entries? labels? count?) | — | re-read after a state change | `capture_colonist_bar` |
| **Overlay / play-settings toggle** | `get_play_settings` (present? label? state?) | `set_play_setting` | `get_play_settings` (state changed?) → `sample_environment` / map screenshot for the visual effect | `capture_play_settings` |
| **Any of the above** | `get_bridge_status` (map live first) | — | `read_rimworld_log` clean | `capture_screen focusGame:true` |

Staging helpers to force preconditions: `spawn_thing`, `set_roof`, `set_weather`,
`set_time`, `finish_research`, `build_room`, `fill_rect`, `move_camera`,
`destroy_thing_at`, `clear_selection`.

---

## Test-case shape

Record each case as a row (the `ui-test` skill emits these as a matrix):

```
element     : "Skylight 'Toggle glass' gizmo"
type        : gizmo | window | floatmenu | colonistbar | overlay-toggle
polarity    : positive | negative
precondition: how the world was staged (tools + args)
action      : the tool call(s) that exercise it
assertion   : the exact expected reading (label / count / state / options / effect)
result      : PASS | FAIL  (+ actual reading on FAIL)
evidence    : screenshot path (capture_*)
logClean    : true | false   (read_rimworld_log across the case)
```

---

## Per-type playbooks

### Gizmos (furniture + pawn command buttons)
- **Positive:** stage the precondition (e.g. `finish_research`, `spawn_thing`,
  `set_roof`), `select_thing_at` the thing, `get_gizmos` → assert the gizmo is present
  with the expected label. If it opens a menu, `activate_gizmo` → `read_float_menu`
  → assert the expected options (labels, none wrongly `disabled`). If it performs an
  action, verify the effect with `inspect_thing_at` / `sample_environment`.
  `capture_gizmo` for evidence.
- **Negative (absence):** select a thing that should NOT have it (missing
  comp/research) → `get_gizmos` → assert it's **absent**.
- **Negative (disabled/boundary):** stage the blocking condition → `activate_gizmo`
  → `read_float_menu` → assert the relevant option is `disabled:true` (right reason),
  or the menu is empty, and no state changed / no exception.

### Windows, dialogs & float menus
- **Positive:** open via the real trigger (`open_window`, or `activate_gizmo`) →
  `get_open_windows` shows the expected type; `read_float_menu` shows the expected
  options. `capture_game_window`.
- **Negative:** trigger under the wrong context → assert the window/menu does **not**
  open (`get_open_windows` unchanged), or opens with the correct empty/disabled state;
  dismiss and assert it's gone and nothing mutated.

### Colonist bar
- **Positive:** `get_colonist_bar` → assert entries match the live colonists
  (count/labels); after a state change (e.g. draft, downed) re-read and assert it
  reflects it. `capture_colonist_bar`.
- **Negative:** with no colonists (or the bar disabled via `set_play_setting`) →
  assert empty / not drawn.

### Map-overlay / play-settings toggles
- **Positive:** `get_play_settings` → assert the toggle is present with a label;
  `set_play_setting {on:true}` → `get_play_settings` → assert `on:true`; then confirm
  the *visual effect* (`sample_environment` for light/roof, or a map `capture_screen`).
  `capture_play_settings`.
- **Negative:** `set_play_setting {on:false}` → assert `on:false` and the effect is
  gone; and a bad label → assert the tool reports "no toggle matching …" (no silent
  success).

---

## Universal assertions (every case)

1. `get_bridge_status` shows `mapLive:true` before asserting (don't race the load).
2. `read_rimworld_log` is clean of **new** exceptions/Harmony failures across the case
   — capture the log state before and after for a changed element that draws.
3. A screenshot exists as evidence (`capture_*`, `focusGame:true` for full frames).
4. Negative cases assert the **absence of a side effect** where relevant (re-read the
   state you'd expect to change and confirm it did **not**).

---

## Definition of done (the gate)

A UI change is done **only** when its **test matrix is complete and green**:

- Every element the change touched has **at least one positive and one negative** row.
- Every row is `PASS` with evidence (screenshot) and `logClean:true`.
- No changed element is missing its negative row. **A missing negative row = not
  done**, even if every positive passes.

If the game can't be launched (no RimWorld available), the matrix is authored but
marked `BLOCKED — needs game`, and the change is explicitly reported as *unverified*
rather than done.

---

## Enforcement logic (how "these things get done for any UI change")

The agent applies this automatically; it is not opt-in:

1. **Detect** — after editing, scan the working diff for UI surfaces:
   - C#: `GetGizmos`, `Command_*`, `Gizmo`, `*Window`, `Dialog_*`, `FloatMenu`,
     `InspectTab*`, `ITab_*`, `DoPlaySettings*`, `ToggleableIcon`, colonist-bar draws.
   - Def XML: new/changed `<comps>` that add gizmos, `<inspectorTabs>`, `<tabs>`,
     research/recipe gating that changes what UI appears.
   If any match, a UI test is **required**.
2. **Enumerate** the affected elements (one matrix row-group each).
3. **Author** positive + negative cases per element from the playbooks above.
4. **Run** them via the tools (launch with `launch_rimworld {quicktest:true}` which
   blocks until `mapLive`), collecting assertions + screenshots + log state.
5. **Gate** — build the matrix; if any element lacks a negative case, or any row is
   FAIL/BLOCKED, the change is **not done**: fix and re-run, or report it unverified.
6. **Report** the matrix (elements × {positive, negative} → PASS/FAIL + evidence) as
   the completion artifact for the UI change.

This protocol composes with the existing gates: a clean `read_rimworld_log` and (for
anything performance-sensitive) the perf baseline in `TESTING-PLAN.md` Phase 6.
