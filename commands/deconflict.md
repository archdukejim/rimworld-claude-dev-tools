---
description: Find and resolve mod conflicts in the active (or given) mod set — duplicate packageIds, incompatibilities, and load-order cycles.
argument-hint: "[packageId ...] (optional; defaults to the active ModsConfig list)"
allowed-tools: mcp__rimagentic__detect_mod_conflicts, mcp__rimagentic__resolve_mod_load_order, mcp__rimagentic__get_mod_metadata, mcp__rimagentic__list_installed_mods, mcp__rimagentic__configure_active_mods
---

Deconflict the RimWorld mod set. If the user passed packageIds in `$ARGUMENTS`, analyze
those; otherwise analyze the active `ModsConfig` list.

## 1. Detect
Call `detect_mod_conflicts` (pass `mods` if the user gave any). You get
`{ conflictCount, duplicatePackageIds, incompatiblePairs, cycles }`.

## 2. Explain and resolve each kind

**duplicatePackageIds** — two+ installed folders share a packageId; RimWorld loads the
first (local ▸ Workshop ▸ Data) and silently shadows the rest. For each:
- Name the winning folder and the shadowed one(s).
- If it's a **local dev copy shadowing a Workshop copy of the same mod**, that's usually
  intended (you want your local build) — say so, don't "fix" it.
- If it's an **unrelated mod squatting another's id** (e.g. a Workshop mod claiming a DLC
  packageId), flag it as a real problem and recommend removing/replacing the squatter.

**incompatiblePairs** — both sides declare/are declared incompatible and both are active.
Read each side's `get_mod_metadata`, explain why, and recommend disabling one (or a known
compatibility patch if the user mentions one).

**cycles** — a loadAfter/loadBefore cycle. Inspect the members with `get_mod_metadata`,
identify the contradicting declarations, and propose which edge to ignore (the mods still
load; the order is just arbitrary within the cycle). If the user owns one of the mods,
suggest correcting its About.xml declaration.

## 3. Apply (only what's safe and wanted)
- For load order, `resolve_mod_load_order` gives the correct sequence; apply with
  `configure_active_mods` (the RimAgentic mod is forced last automatically).
- Do NOT delete or disable a mod without the user's go-ahead — recommend, then confirm.

## 4. Report
Summarize: conflicts found, which were benign (dev-vs-Workshop dupes), which need action,
and what you applied vs. what needs the user's decision. If `conflictCount` is 0, say the
set is clean and show the resolved load order.
