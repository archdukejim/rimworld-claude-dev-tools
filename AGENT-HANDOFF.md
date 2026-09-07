# AGENT-HANDOFF — `agent/e2a85d71-discussions`

## What this branch adds

**Steam Workshop Discussions as the public backlog + changelog** — a `discussions` tool family
plus the milestone-close-out mode of `swh_post_changelog`, driven by the new USER-LEVEL
**`workshop-backlog`** skill (`~/.claude/skills/workshop-backlog/SKILL.md`, not in this repo).
Conventions + write discipline: **`docs/DISCUSSIONS.md`**. Reference target output:
`regions-and-societies/Core-MMF/About/discussions/*.bbcode`.

Built ON TOP of `agent/4c8ab8ba` (PR #34 — steamCdp/steamLogic/bridge modes), which is merged
into this branch. **Land #34 into development first**, then this PR is a small delta; merging
this one alone also works (it carries #34's commits).

- **`server/src/steamCdp.ts`** — thread-page reading + post editing, selectors captured LIVE
  (2026-09-06, item 3784666060): `readThread` (OP `.forum_op` + `.commentthread_comment`
  replies; author via `a.forum_op_author` / `a.commentthread_author_link` — the avatar link
  comes first in DOM order, never take the first profile anchor; comments carry TWO timestamp
  divs, the first an empty template), `openPostEdit`/`saveOpenEdit` (edit control is
  `a.forum_comment_action.edit_post`; comments PRE-RENDER a hidden empty
  `#comment_edit_text_<gid>` — visibility decides, never existence; the OP form appears
  OUTSIDE `.forum_op` as `#forum_topic_edit_<id>_textarea` + visible `input[name=topic]` +
  "Save Changes" button), `setThreadPinned` (pin AND unpin; `pinThread` kept as wrapper),
  richer thread rows (lastActivity, author), `topicUrl`.
- **NEW `server/src/tools/discussions.ts`** — `swh_list_discussions`, `swh_find_discussion`
  (exact title, the skill's create-vs-edit decision), `swh_get_discussion` (RAW BBCode for own
  posts via the edit form, opened read-only; rendered for others), `swh_create_discussion`
  (refuses duplicate titles), `swh_reply_discussion`, `swh_edit_discussion_post` (mandatory
  re-read, no-op on identical, dry run returns current+proposed; OP edits can retitle),
  `swh_pin_discussion` (idempotent, verified). Every write: dry-run default / confirm:true,
  post-cap refusal, domain warnings, public URL + moderation state after.
- **`server/src/steamLogic.ts`** — `DISCUSSION_POST_CAP` (**provisional 8000** — measure on a
  hidden test item and update; the old pre-rebrand item 3768364266 may serve),
  `checkDiscussionPostCap`, `parseTopicId`, `findThreadByTitle`, `findMilestoneThread`,
  `shippedTitle`.
- **`server/src/tools/workshop.ts`** — `swh_post_changelog` milestone mode (`milestoneName`):
  final reply on the `Next milestone: <version> …` thread, retitle `<version> <name> -
  shipped`, unpin; missing thread errors point at the workshop-backlog skill.
- Wired ×4 in `index.ts`; `manifest.json` +7; CLAUDE.md family list + publish subsection;
  `docs/DISCUSSIONS.md`.
- **Skills (user-level, outside this repo)**: NEW `workshop-backlog`; `ship-it` Step 9b now
  the milestone close-out + calls workshop-backlog; `work-next-milestone` Phase 2.4 + Exit
  call it after grooming.

## Verified this session
- `npm run build` clean; `npm run test:steam` **74/74** (stub grew discussion probes: readThread,
  openEditPost/readEditPost/fillEditPost/afterEditPost, clickUnpin + 26 new checks incl. the
  milestone close-out and the pure logic).
- LIVE, read-only, item 3784666060: `swh_list_discussions` (topicIds, pinned, lastActivity,
  author), `swh_get_discussion` returning byte-accurate RAW BBCode for the OP (4,417 chars) and
  a reply (4,833 chars) — the edit forms opened and never saved. Fixed three anatomy bugs the
  live run exposed (hidden template textarea, OP form location, author/timestamp selectors).

## NOT verified (needs a confirmed live write)
- Confirmed create / reply / edit-save / pin / unpin / retitle against real Steam, and the true
  discussion post cap. All dry-run paths and the stub cover the logic; the save-button and
  new-topic selectors were captured live. First real use = the workshop-backlog skill run
  against 3784666060 (user-confirmed), where the existing hand-posted threads ("Backlog",
  "0.4.0 Milestones") should be EDITED/retitled to the conventions, not duplicated.

## Rollout
Rebuild + restart the running `node server/build/index.js` processes to expose the family.
