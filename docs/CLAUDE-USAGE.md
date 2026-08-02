# Driving Steam Workshop Helper from Claude

This extension is meant to be used like a set of MCP tools, but in Phase 1 it is
driven through the **Claude in Chrome** browser tools — no MCP server required.
`window.SWH` is available on any `steamcommunity.com` tab.

## The loop

1. **Open the item.** Navigate the browser to the workshop page:
   `https://steamcommunity.com/sharedfiles/filedetails/?id=<FILE_ID>`
   (Not strictly required — most methods resolve from `fileId` alone — but it's
   the most reliable context and lets you verify visually.)
2. **Confirm context.** Run `await window.SWH.getContext()` and check
   `ownerSteamId` / `title` are what you expect.
3. **Act.** Call the method you need (see below). Everything is `await`-able and
   returns JSON.
4. **Verify.** For edits, check `verified: true` in the result, or re-read with
   `getItem` / `listComments`.

Run each call as a single expression in the JS tool so its Promise resolves:

```js
await window.SWH.listComments({ fileId: "3775176411" });
```

## Recipes

**Triage comments on a mod**
```js
const { comments } = await window.SWH.listComments({ fileId: "3775176411", count: 50 });
comments.map(c => ({ id: c.id, who: c.author, when: new Date(c.timestamp*1000).toISOString(), text: c.text }));
```

**Reply to a bug report**
```js
await window.SWH.postComment({ fileId: "3775176411", text: "Thanks — fixed in v1.1, please re-download." });
```

**Delete spam** (get the id from `listComments` first)
```js
await window.SWH.deleteComment({ fileId: "3775176411", commentId: "582804312418214006" });
```

**Update a description** (owner login required; Steam BBCode)
```js
await window.SWH.updateDescription({
  fileId: "3775176411",
  description: "[h1]Room Auto Light[/h1]\nAutomatically toggles lights…\n\n[b]v1.1[/b]\n[list][*]Fixed load order[/list]"
});
```

**Read the current description before editing** (recommended)
```js
const item = await window.SWH.getItem({ fileId: "3775176411" });
item.description; // edit this, then send it back via updateDescription
```

## Guardrails for the agent

- **Confirm destructive actions.** `deleteComment`, `updateDescription`, and
  `updateTitle` change live public content and cannot be undone from here. Show
  the user the exact target and payload, and get a clear yes before running them
  — especially in bulk.
- **Read before you overwrite.** `updateDescription` replaces the *entire* body.
  Fetch the current description with `getItem` first and edit from that.
- **Don't guess IDs.** Delete only comments whose `id` came from a fresh
  `listComments` on the same item.
- **Check `verified`.** If an edit returns `verified: false`, the change may not
  have applied (e.g. not logged in as owner) — re-read and report, don't retry
  blindly.
- **BBCode, not Markdown.** Format Steam text with BBCode (`[b]`, `[url]`,
  `[list]`), not `**` or `#`.

## Owner's items (for reference)

| Mod | File ID |
| --- | --- |
| Dynamic Walk Speeds | `3775191933` |
| Performance Custom Maps | `3775179446` |
| Room Auto Light | `3775176411` |
