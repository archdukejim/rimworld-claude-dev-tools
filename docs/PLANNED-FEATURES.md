# Planned Features

A human-readable roadmap for `rimworld-claude-dev-tools`. The **GitHub issue
tracker is the live source of truth**; this file is a snapshot overview. Newest
first.

---

## Steam Workshop

### 1. Window navigation + screenshot → JPEG for description embedding
[#1](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/1) · `enhancement` · proposed

Drive RimWorld's UI to a named window/menu via a **lookup table**, capture a
screenshot, inspect it, and **save it as a JPEG** for upload to the Steam
Workshop. Purpose: **beat the ~8,000-character description cap** by embedding
"pages" of content as images — packing far more into an item description.
Builds on `pcControl`/`pc`, `rimworldDev`, `gameIpc`, and `sharp`.

### 2. Steam Workshop image scaling + embedding polish
[#2](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/2) · `enhancement` · proposed (depends on #1)

Fine-tune photo scaling and how generated images embed in a Workshop description
so they render cleanly (right dimensions, crisp, well-placed).

---

## Harness / testing

### 3. Async job broker: parallel dev + serial execution
[#3](https://github.com/archdukejim/rimworld-claude-dev-tools/issues/3) · `enhancement` · proposed

Turn the RimWorld test harness into an **async job broker**: submit returns
`pending` + a `job_id` immediately (parallel authoring), while game runs execute
**serially** on one worker (can't run two RimWorld instances on one box). Two
lanes — a **parallel build pool** (worktree-isolated) and a **serial game-run
lane** with **per-job pinned config** (own mod list + savedatafolder + rotated
log, verified at launch). Structural fix for the shared-mutable-global bugs
RimSynapse/Repo-MCP#18 and #19. Watch the local LLM (LM Studio @ 192.168.4.106)
as a third shared resource.

---

## In progress / fixes (not yet a tracked issue)

### Bridge isolation — per-profile "connect to MCP bridge" toggle
Surfaced during the scheduled-triage test: the dedicated headless Chrome and a
normal Chrome both run the extension and poll the same loopback bridge port
(8766), so the wrong instance can grab a command. Plan: a per-profile toggle
(reusing `swhBridgeEnabled`) — **off** in the normal Chrome, **on** in the
dedicated profile — so exactly one extension serves the bridge. Alternative: a
dedicated bridge port for the scheduled flow.
