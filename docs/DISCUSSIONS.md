# Steam Workshop Discussions tools

The Discussions tab of each Workshop item replaces BOTH the GitHub backlog and the changelog
for players. The `discussions` tool family (`server/src/tools/discussions.ts`) gives agents
list/read/create/reply/edit/pin on a workshop item's Discussions tab; the user-level
**`workshop-backlog`** skill (`~/.claude/skills/workshop-backlog/`) drives them to keep two
pinned threads per mod current. `swh_post_changelog` (workshop.ts) closes a milestone thread
out at ship time.

## Route

DevTools-only (`steamCdp.ts`): the RimAgentic Chrome (`launch_chrome`, port 9222) holds the
Steam owner session, and the tools drive Steam's own page JS (`Forum_CreateTopic`, the
comment-thread widget) over `Runtime.evaluate`. The extension bridge never implemented
discussions, and driving the real page JS beats reverse-engineering the forum AJAX endpoints —
this mirrors how `swh_post_changelog` and the `swh_update_description` fallback already work.
Never hand-roll a CDP script for Steam; extend `steamCdp.ts` (every expression carries a
`swh:<probe>` marker the stub test keys on — `npm run test:steam`).

Page anatomy (list page, thread page, new-topic form, admin pin menu, inline post-edit form)
is documented in the `steamCdp.ts` header. The post-edit selectors (`readThread`,
`openPostEdit`, `saveOpenEdit`) are scan-based and defensive: they look for the edit
affordance/save control by text and onclick rather than a fixed id, and fail with an
instructive note instead of guessing.

## Tools

| Tool | What it does |
| --- | --- |
| `swh_list_discussions { fileId }` | Every thread: topicId, title, url, pinned, replies, lastActivity. |
| `swh_find_discussion { fileId, title }` | Exact-title match (case-insensitive, `PINNED:` stripped; pinned wins) → thread or null. The skill's create-vs-edit decision point. |
| `swh_get_discussion { fileId, topicId }` | OP + every reply. Own posts return **raw BBCode** (read from the inline edit form, opened read-only and never saved); others return rendered text (`bbcodeSource` says which). |
| `swh_create_discussion { fileId, title, body, pin? }` | New thread. Dry-run default; refuses duplicate exact titles. |
| `swh_reply_discussion { fileId, topicId, body }` | Reply. Dry-run default; re-reads the thread first. |
| `swh_edit_discussion_post { fileId, topicId, postId?, body, newTitle? }` | Edit the OP (`postId` omitted) or a reply **in place**. Re-reads the current raw BBCode, no-ops on identical text, dry run returns current + proposed for a diff. OP edits can retitle the thread. |
| `swh_pin_discussion { fileId, topicId, pinned }` | Pin/unpin from the owner admin menu, idempotent, verified against the listing. |
| `swh_post_changelog { …, milestoneName }` | Milestone mode: posts the changelog block as the final reply on the `Next milestone: <version> …` thread, retitles it `<version> <name> - shipped`, unpins it. Without `milestoneName`: the running `Changelog` thread (find-or-create + pin). |

## Write discipline (every write tool)

- **Dry-run by default** — the exact title/body that would be posted comes back; only
  `confirm:true` posts. `dryRun:false` alone is refused (not consent).
- **Re-read before write** — edits fetch the live raw BBCode first and return it beside the
  proposed body; an identical body is a no-op, never a blind save.
- **Post cap** — bodies over `DISCUSSION_POST_CAP` (steamLogic.ts; **provisional 8,000** —
  matches the description cap and the hand-trimmed 7,988-byte backlog draft, but not yet
  measured; measure once by growing a post on a hidden test item until Steam refuses, then
  update the constant and this line) are refused before anything touches Steam.
- **Link domains** — anything outside steamcommunity/steampowered/github/imgur/ko-fi/discord.gg
  warns (Steam's content scan hides items over unfamiliar domains).
- **Moderation state after writes** — Steam re-scans an item when its content changes; every
  confirmed write re-reads the public page and reports
  `visible | awaiting_analysis | removed | hidden | incompatible`.
- Every write returns the **public URL** of what it touched.

## Thread conventions (the workshop-backlog contract)

Two pinned threads per mod, kept current by the `workshop-backlog` skill (reference drafts:
`Core-MMF/About/discussions/*.bbcode` in the R&S repo — match their structure and voice):

1. **`Backlog - everything planned for <Mod>`** (pinned, edited in place, never re-created):
   intro + current Workshop version → **Scope** (stable between refreshes) → **Shipped** (one
   line per version, from the wiki Changelog — never invented) → one `[h2]` per open milestone
   (Next / Later / Then) with issues grouped under `[b]theme[/b]` headings, every title
   rewritten into one plain-language player sentence, `#<n>` kept as a `[url]` to GitHub →
   **Unscheduled** → **Companion mods** → wiki + Discord links. If the OP would exceed the post
   cap: OP keeps intro + scope + shipped + a milestone index; each milestone's list moves to
   its own reply, edited in place on later refreshes.
2. **`Next milestone: <version> <name>`** (pinned while active): status line → **Why this
   milestone** → **Goals** (bold outcome statements citing issues) → **What stays out** (pulled
   from the backlog thread's Scope so they never drift) → **Progress** (`<open> open, <closed>
   landed`). Landed items get a short reply; at ship time `swh_post_changelog` (milestone mode)
   posts the changelog as the final reply, retitles to `<version> <name> - shipped`, unpins.

BBCode rules for both: `[h1] [h2] [b] [list][*] [url=]` only, no `[img]`, well-known domains
only, plain hyphens, no em dashes, no emoji. Everything public is confirm-gated: show the full
dry-run body and the diff against the live thread, get the user's yes, then `confirm:true`.
Never post from a scheduled or unattended run.
