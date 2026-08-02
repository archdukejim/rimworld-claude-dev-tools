# Comment Triage Routine

Reviews recent comments across **all** your Steam Workshop items, classifies the
actionable ones, files/links GitHub issues **without duplicates**, and replies on
Steam as you with the issue link — **draft-first**: nothing public happens until
you approve.

This file *is* the routine. A scheduled run (or you, on demand) follows it
step by step using the `steam-workshop-helper` MCP tools.

---

## Preconditions

The routine acts on your live browser session, so at run time:

1. **Chrome is running** with the Steam Workshop Helper extension (v0.3.0+) loaded.
2. You are **logged into Steam** in that Chrome.
3. The MCP server is reachable (registered in your config; it hosts the loopback bridge).
4. A GitHub token is available for the MCP — from `GITHUB_TOKEN`,
   `github_token.txt`, or automatically from your `gh` CLI login
   (`gh auth token`). Needed only for the issue steps.
5. `mcp-config/repo-map.json` maps each workshop item to its GitHub repo.

If Chrome isn't up / not logged in, the Steam tools return a clear error — stop
and report that rather than guessing.

---

## Classification rubric

Classify each comment into exactly one:

- **bug** — reports something broken: an error, crash, incompatibility, wrong
  behavior, "stopped working after update", red errors, load failure.
- **feature_request** — asks for new functionality that doesn't exist:
  "can you add support for X", "would love an option to …".
- **qol** — a tweak or improvement to *existing* behavior: better defaults,
  a slider range, clearer labels, small usability wins.
- **ignore** — do nothing, no issue, no reply:
  - thanks / praise / "great mod" with no request
  - spam, self-promotion, off-topic
  - **the intent can't be discerned** (too vague to act on)

When in doubt between an actionable category and `ignore`, prefer `ignore`
(filing junk issues and replying to non-requests is worse than missing one).
Distinguishing bug vs qol: if something is *broken*, it's a bug; if it *works
but could be nicer*, it's qol.

Skip comments **you** authored (author is `archdukejim`) — those are your own
replies, not requests.

---

## Idempotency — read your own replies, never re-post (critical)

The mod author (**archdukejim**) replies to users **directly on Steam**. The
routine MUST account for this or it will spam duplicate replies:

- **Read the whole thread, all authors, chronological** — including
  archdukejim's own comments. Do **not** filter them out.
- A user comment that archdukejim has **already replied to / addressed** (fixed,
  shipped, backlogged-with-reasons) is **handled** → skip it. Never classify
  archdukejim's own comments as requests.
- **Author replies often do NOT @mention the user.** Match a reply to a comment
  by **topic and position** (an archdukejim comment on the same subject, usually
  right after the user's), not by name. E.g. a "does it work with Empire
  Refactored?" question is answered by a following archdukejim comment about
  Empire Refactored compat even though it never names the asker.
- Maintain persistent state in `mcp-config/triage-state.json`:
  `{ "handled": { "<commentId>": { "disposition": "...", "issue": "...", "note": "...", "at": "..." } } }`.
  **Skip any comment whose ID is already in `handled`.** Record every comment the
  routine files, replies to, or decides to skip.
- **Before posting any reply**, confirm no equivalent reply already exists in the
  thread (from archdukejim or a prior routine run). If one does, do not post.

This is the guard against the re-posting loop: without it, a run that can't see
its own past replies re-comments every time.

## Workflow (draft-first)

### Phase 1 — gather & classify (read-only)
1. `swh_review_notifications { ownItemsOnly: true, perItem: 15 }`.
2. For each notified item, read the **full comment thread** (`swh_list_comments`)
   including archdukejim's replies, chronological.
3. For every user comment: skip it if its ID is in `triage-state.json.handled`,
   or if archdukejim has already replied to/addressed it. Otherwise apply the
   rubric. Drop `ignore` (and record ignored IDs as handled to keep reports quiet).
4. For each actionable comment, resolve its repo:
   `swh_repo_for_item { fileId }`. If `unmapped`, keep it in the report under
   **"needs repo mapping"** and do not attempt to file it.

### Phase 2 — dedup against existing issues (read-only)
4. For each actionable, mapped comment, build a short **keyword** query from the
   comment's core idea (not the whole comment) and call
   `swh_find_issue { fileId, query, state: "all" }`.
5. Judge the candidates **semantically** — a real match means the same
   underlying bug/request, not just shared words. Consider closed issues too
   (an already-fixed/-declined item is still a match to reference).
   - **Match found** → mark as `duplicate`, capture `{ number, url, state }`.
   - **No match** → mark as `new`, draft an issue (title, body, labels).

### Phase 3 — the review report (NO public actions)
6. Produce a report grouped by item, listing for each actionable comment:
   - category, author, the comment text, and Steam link
   - **duplicate** → the existing issue `#N` + url + the proposed Steam reply
   - **new** → proposed issue `{ repo, title, body, labels }` + the proposed
     Steam reply (with a `#<new>` placeholder until the issue exists)
   - **needs repo mapping** / **ignored (with reason)** as separate sections
7. **Stop here.** Do not call `swh_create_issue` or `swh_post_comment`. Present
   the report and wait for approval.

### Phase 4 — execute (only after explicit approval)
Approval may be "do all", or a subset ("just the bugs", "skip #3").
For each approved item:
- **new** → `swh_create_issue { fileId, title, body, labels }`, take the real
  `#N`/url, then `swh_post_comment { fileId, text: <new-issue reply> }` —
  **unless archdukejim already replied in-thread**, in which case file the issue
  but skip the reply.
- **duplicate** → `swh_post_comment { fileId, text: <duplicate reply> }` only
  (again, skip if already replied).

After each action, **record the comment ID in `triage-state.json.handled`** with
its disposition and issue link, so it is never processed again.

Report back what was created and posted, with links.

---

## Issue drafting

- **Title**: concise, imperative, derived from the comment
  (e.g. "Lights flicker in rooms with two lamps", "Add per-terrain slider for X").
- **Body** (Markdown), include:
  ```
  Reported by **<author>** on the Steam Workshop.

  > <verbatim comment text>

  **Category:** <bug|feature_request|qol>
  **Source:** <steam comment permalink or item link>
  ```
- **Labels**: `bug` → `["bug"]`; `feature_request` → `["enhancement"]`;
  `qol` → `["enhancement"]` (add a `Category: QOL` line in the body — don't rely
  on a `qol` label existing in every repo). Only use labels the repo already has.

---

## Reply templates (posted **as you**, first person)

Keep it short, warm, and in your voice. Adapt per category.

- **New — bug:**
  > Thanks for flagging this — logged as #{n} so I can track the fix: {url}

- **New — feature/qol:**
  > Good idea, appreciate it. Logged as #{n}: {url}

- **Duplicate (open):**
  > This one's already on my radar — tracked here: {url} (#{n}). Updates will land there.

- **Duplicate (closed/fixed):**
  > This should be handled already — see {url} (#{n}). If you're still seeing it, let me know.

Never promise a timeline. Never post a reply for an `ignore` comment.

---

## Output contract (for the scheduled/headless run)

When run unattended, write the Phase-3 report to
`mcp-config/triage-report.json` (overwrite each run) with this shape, so a
later interactive session can pick it up for approval:

```json
{
  "generatedAt": "<ISO8601>",
  "actionable": [
    { "fileId": "...", "item": "...", "repo": "owner/repo", "author": "...",
      "category": "bug|feature_request|qol", "comment": "...", "steamUrl": "...",
      "disposition": "new|duplicate",
      "existingIssue": { "number": 0, "url": "", "state": "" },
      "draftIssue": { "title": "", "body": "", "labels": [] },
      "draftReply": "..." }
  ],
  "needsRepoMapping": [ { "fileId": "...", "item": "..." } ],
  "ignored": [ { "item": "...", "author": "...", "reason": "..." } ]
}
```

The unattended run stops after writing this. Approval + Phase 4 happen
interactively (`"review the latest triage report"`).
