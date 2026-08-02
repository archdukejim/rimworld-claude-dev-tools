# `window.SWH` API reference

All methods are **async** (return Promises) and resolve to plain,
JSON-serialisable objects, so they survive the browser-tool boundary.

Every method takes a single options object. Most accept a workshop **`fileId`**
and resolve everything else (owner SteamID64, app ID, title) automatically. You
can override `ownerSteamId` / `appId` if you already have them (skips a lookup).

Requirements:

- The active tab must be on `https://steamcommunity.com/*` (any page).
- Edit/delete actions require you to be logged in as the item **owner**.

---

## Context

### `SWH.getContext()`
Metadata for the workshop item on the **current tab**, or `null` if the tab
isn't a `filedetails` page.

```js
{ fileId, appId, ownerSteamId, title, creatorUrl }
```

### `SWH.resolveMeta({ fileId, ownerSteamId?, appId?, force? })`
Resolve (and cache) metadata for any `fileId` without needing to be on its page.
Returns the same shape as `getContext()`. Pass `force: true` to bypass the cache.

---

## Authentication

The extension **never logs in** — it uses whatever Steam session already exists
in the browser. Two ways to check whether you're authenticated:

### `SWH.getAuth()`  (page context)
Reads Steam's own `g_steamID` global on the current tab.

```js
{ loggedIn: true, steamId: "76561197972336293", accountId: "12070565", accountName: "archdukejim" }
```
`loggedIn` is `false` and `steamId` is `null` when logged out. Note the
`sessionid` cookie exists even when logged out, so it is **not** an auth signal.

Write actions (`postComment`, `deleteComment`, `updateItem`,
`updateDescription`, `updateTitle`) call this first and throw
`Not logged in to Steam…` if you're not authenticated.

### Browser-wide tracking (background)
The service worker watches the httpOnly `steamLoginSecure` cookie via
`chrome.cookies.onChanged`, so it knows your login state **even with no workshop
page open** and updates the instant you log in or out:

- Toolbar **badge**: green ● = logged in, red = logged out.
- `chrome.storage.local.swhAuth` → `{ loggedIn, steamId, checkedAt }`.
- From the popup or a future MCP host: send `{ type: "SWH_AUTH" }` to the
  background worker → `{ ok, result: { loggedIn, steamId } }`.

---

## Comments

### `SWH.listComments({ fileId, ownerSteamId?, start?, count? })`
- `start` default `0`, `count` default `100`.

```js
{
  fileId: "3775176411",
  total: 4,
  start: 0,
  count: 100,
  comments: [
    { id: "582804312418214006", author: "archdukejim", authorId: "12070565",
      authorUrl: "https://steamcommunity.com/id/archdukejim",
      timestamp: 1785594444, text: "Alright I released version 1.0…" }
  ]
}
```

`id` is the `gidcomment` used by `deleteComment`. `timestamp` is Unix seconds.

### `SWH.postComment({ fileId, text, ownerSteamId? })`
Posts a comment (BBCode allowed). Returns:

```js
{ ok: true, newCommentId: "5828…", total: 5 }
```

### `SWH.deleteComment({ fileId, commentId, ownerSteamId? })`
Deletes a comment by its `gidcomment` (`id` from `listComments`). You must own
the comment **or** the item. Returns `{ ok: true, total: <remaining> }`.

---

## Comment notifications

Aggregates comment activity across **all** your workshop items from Steam's
Comment Notifications feed. That feed lists *which* items have new comments but
not the text, so `reviewNotifications` enriches each with its latest comments.

### `SWH.getNotifications()`
Raw list — fast, no comment text.

```js
{ count: 6, notifications: [
  { fileId: "3775176411", title: "Room Auto Light", description: "Your RimWorld Workshop Item",
    newPosts: null, dateText: "10 hours ago", isOwnItem: true }
] }
```

### `SWH.reviewNotifications({ ownItemsOnly?, perItem? })`
The "review my recent notifications" digest. `ownItemsOnly` defaults `true`
(your items only); `perItem` defaults `5`.

```js
{
  itemCount: 4,
  items: [
    { fileId: "3760830041", title: "RimSynapse - Psychology", dateText: "Jul 26 @ 11:10pm",
      newPosts: null, url: "https://steamcommunity.com/sharedfiles/filedetails/?id=3760830041",
      latestComments: [ { id, author: "Bradybeast13", authorId, timestamp, text } ] }
  ],
  skipped: [ { title: "This item was moved or deleted.", dateText, note } ]
}
```

Rows Steam can't resolve to an item (moved/deleted) are returned under `skipped`
rather than dropped silently.

---

## Title & description

These clone the item's real edit form (the `ItemEditText` form at
`/sharedfiles/itemedittext/?id=<fileId>`) and re-POST it. **Owner login
required** — Steam only serves the edit page to the owner (otherwise you get a
clear "Edit form not found" error).

### `SWH.getItem({ fileId, appId? })`
Reads the current editable fields.

```js
{ fileId, appId, title, description, visibility, fields: { /* full form */ } }
```

### `SWH.updateDescription({ fileId, description, appId? })`
Sets the description (plain text or Steam BBCode). Returns:

```js
{ ok: true, fileId, item: { …re-read… }, verified: true }
```
`verified` is `true` when the re-read description matches what you sent.

### `SWH.updateTitle({ fileId, title, appId? })`
Sets the title. Same return shape as `updateDescription` (with `verified`).

### `SWH.updateItem({ fileId, fields, appId? })`
Low-level: override arbitrary edit-form fields (e.g.
`{ title, description, visibility }`) in one POST. Returns `{ ok, fileId, item }`.

---

## Introspection

### `SWH.version`  →  `"0.1.0"`
### `SWH.methods()`  →  array of callable method names.

---

## Errors

Methods **throw** (reject) on failure with a descriptive message, e.g.:

- `No Steam session found…` — not logged in / no `sessionid`.
- `Could not resolve owner for item <id>` — bad `fileId`, or a private item.
- `Edit form not found. Are you logged in as the item owner?` — edit attempted
  without owner rights.

When driven through the extension bridge (popup / MCP host), errors come back as
`{ ok: false, error: "<message>" }` instead of throwing.

## BBCode note

Steam descriptions and comments use **BBCode**, not Markdown or HTML:
`[b]bold[/b]`, `[i]`, `[url=…]…[/url]`, `[list][*]item[/list]`, `[h1]`, `[code]`,
`[img]…[/img]`. `updateDescription` passes your string through verbatim.
