---
name: steam-comment-triage
description: Review recent Steam Workshop comments across all of archdukejim's items — classify each as bug/feature_request/qol (ignore thanks, spam, or undiscernible), dedup against existing GitHub issues, then draft issues + a reply-as-author. Draft-first (nothing public until approved). Trigger on "review the steam comments", "triage the workshop comments", "check my steam comments", or the scheduled triage run.
---

# Steam comment triage

Runs the comment-triage routine for archdukejim's Steam Workshop items using the
`rimworld-claude-dev-tools` MCP. Same workflow whether invoked interactively or by
the scheduled runner.

**Authoritative spec — follow it exactly:**
`C:\github\rimworld-claude-dev-tools\docs\COMMENT-TRIAGE.md`
(This skill is a stable trigger + summary; the spec is the source of truth.)

## Non-negotiables
- **Draft-first.** Do Phases 1–3 only unless the user explicitly approves this run:
  classify → dedup against GitHub issues → write `mcp-config/triage-report.json` →
  **stop**. Create issues / post Steam replies (Phase 4) **only after explicit
  approval** (all, or a named subset).
- **Read your own replies.** Load the full comment thread including archdukejim's
  own replies; skip anything already addressed — matched **by topic, not @mention**.
  Honor `mcp-config/triage-state.json` (handled/seen): never re-file or re-post.
- **Categories:** `bug` / `feature_request` / `qol`. **Ignore** thanks, spam, or
  comments whose intent can't be discerned — no issue, no reply.
- **Replies are posted as the author (archdukejim), first person**, carrying the
  issue link ("logged as #N: {url}"), or referencing the existing issue for a
  duplicate ("already tracked here: {url} (#N)").

## Tools (rimworld-claude-dev-tools MCP)
- Read: `swh_open_item` (ensure a Steam tab exists), `swh_review_notifications`,
  `swh_get_notifications`, `swh_list_comments`, `swh_repo_for_item`, `swh_find_issue`.
- Write (approval-gated only): `swh_create_issue`, `swh_post_comment`.

## Preconditions
Chrome running with the Steam Workshop Helper extension and logged into Steam; the
MCP registered (user scope); a GitHub token (reused from the `gh` keyring). If
Steam isn't logged in, say so and stop — don't guess.

## Reviewing a prior draft
If asked to "review the latest triage report", read
`mcp-config/triage-report.json`, walk the user through the drafted issues/replies,
and on approval run Phase 4 for the approved items.
