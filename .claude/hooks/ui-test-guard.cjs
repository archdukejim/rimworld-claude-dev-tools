#!/usr/bin/env node
/**
 * PostToolUse guard: when an Edit/Write/MultiEdit touches a UI-bearing RimWorld file, inject a
 * hard requirement to run the ui-test protocol (positive + negative cases). Deterministic, harness-
 * driven enforcement of docs/UI-TESTING.md — the model sees this every time it edits in-game UI.
 *
 * Reads the hook JSON on stdin, emits PostToolUse additionalContext on a match, else stays silent.
 * Fail-open: any parse/logic error exits 0 with no output (never blocks editing).
 */
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw || "{}");
    const ti = input.tool_input || {};
    const filePath = String(ti.file_path || ti.path || "").replace(/\\/g, "/");
    if (!filePath) return done();

    // Collect the text that was written (Write) or added (Edit/MultiEdit).
    let content = "";
    if (typeof ti.content === "string") content += ti.content + "\n";
    if (typeof ti.new_string === "string") content += ti.new_string + "\n";
    if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e && typeof e.new_string === "string") content += e.new_string + "\n";

    const isCs = /\.cs$/i.test(filePath);
    const isXml = /\.xml$/i.test(filePath);
    // Only game-side / mod files, not the MCP server or docs.
    const inMod = /game-mod\//i.test(filePath) || /\/Defs\//i.test(filePath) || /\/Patches\//i.test(filePath);
    if (!inMod || (!isCs && !isXml)) return done();

    // UI surfaces. C#: gizmos, windows/dialogs, float menus, inspect tabs, colonist bar, play settings.
    const csUi = /GetGizmos|Command_|\bGizmo\b|GizmoOnGUI|\bWindow\b|Dialog_|FloatMenu|ToggleableIcon|DoPlaySettings|InspectTab|\bITab_|ColonistBar|MainTabWindow/;
    // Def XML: inspector tabs, gizmo-bearing comps, ui icons.
    const xmlUi = /<inspectorTabs>|<tabs>|CompProperties_[A-Za-z]*(Gizmo|Toggle|Facility|Power|Refuel)|<uiIcon|<gizmo|Gizmo>/i;

    // Also fire on UI-named source files even if this particular chunk lacks a keyword — a UI file
    // is a UI file. Errs toward reminding (hard enforcement) over silently missing.
    const base = filePath.split("/").pop() || "";
    const fileNameUi = /(Gizmo|Window|Dialog|FloatMenu|ColonistBar|PlaySettings|Overlay|InspectTab|MainTab|Menu)/i.test(base);

    let matchedBy;
    if (isCs) matchedBy = content.match(csUi) || (fileNameUi ? [base] : []);
    else matchedBy = content.match(xmlUi) || [];
    if (!matchedBy.length) return done();

    const context =
      `⚠️ UI CHANGE DETECTED in ${filePath} (matched: "${matchedBy[0]}").\n` +
      `Per docs/UI-TESTING.md this change is NOT done until it passes the ui-test protocol:\n` +
      `• For EACH changed UI element, run >=1 POSITIVE and >=1 NEGATIVE test case, headlessly.\n` +
      `• Assert via the tools (get_gizmos / activate_gizmo / read_float_menu / get_open_windows / ` +
      `get_colonist_bar / get_play_settings / sample_environment); screenshot with capture_* and ` +
      `confirm read_rimworld_log is clean.\n` +
      `• Invoke the \`ui-test\` skill. A missing negative case = not done. If the game can't launch, ` +
      `mark BLOCKED — needs game and report the change as unverified.\n` +
      `• Store each PASSING positive case's screenshot for Steam via showcase_add (caption + mod), so ` +
      `positive evidence accrues for description uploads.`;

    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
  } catch {
    /* fail-open */
  }
  done();
});

function done() { process.exit(0); }
