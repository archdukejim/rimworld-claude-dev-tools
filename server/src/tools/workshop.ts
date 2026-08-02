import { Bridge } from "../bridge";

/*
 * Steam Workshop tools. Each maps 1:1 to a window.SWH method in the extension
 * (see ../../../src/swh-api.js). The tool handler forwards { method, args }
 * over the loopback bridge; the extension runs it against the logged-in Steam
 * session in the active tab and returns JSON.
 *
 * Convention matches rimsynapse's tool modules: export a `swhTools` array of
 * tool definitions and a `handleSwhTool(name, args, bridge)` dispatcher.
 */

const fileIdProp = {
  fileId: {
    type: "string",
    description: "The Steam Workshop published file ID (the number in the item URL).",
  },
};

export const swhTools = [
  {
    name: "swh_open_item",
    description:
      "Open (or focus and navigate) a browser tab directly on a workshop item and wait until it is ready. Works whether or not you are logged in. Use this to jump to a specific mod, or to bootstrap when no steamcommunity.com tab is open. Returns { ok, tabId, url, context }.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        activate: {
          type: "boolean",
          description: "Bring the tab to the foreground (default true).",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "swh_get_auth",
    description:
      "Report Steam login state as seen by the browser. Returns { loggedIn, steamId, accountName }. The extension never logs in; it reads the existing session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "swh_get_context",
    description:
      "Return metadata about the workshop item currently open in the active browser tab (fileId, appId, ownerSteamId, title), or null if the tab is not a workshop item page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "swh_review_notifications",
    description:
      "Review recent comment notifications across ALL your workshop items in one call. Reads Steam's Comment Notifications feed (items people commented on) and enriches each with its latest comments (author, timestamp, text). This is the 'review my recent notifications' digest.",
    inputSchema: {
      type: "object",
      properties: {
        ownItemsOnly: {
          type: "boolean",
          description: "Only your own items, excluding subscribed discussions (default true).",
        },
        perItem: {
          type: "number",
          description: "How many latest comments to include per item (default 5).",
        },
      },
    },
  },
  {
    name: "swh_get_notifications",
    description:
      "Raw comment-notifications list (which items have new comment activity), without fetching the comment text. Faster than swh_review_notifications; use it for just the summary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "swh_list_comments",
    description:
      "List comments on a workshop item. Returns { total, comments: [{ id, author, authorId, timestamp, text }] }. `id` is the gidcomment used by swh_delete_comment.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        start: { type: "number", description: "Offset of the first comment (default 0)." },
        count: { type: "number", description: "How many comments to fetch (default 100)." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "swh_post_comment",
    description:
      "Post a comment on a workshop item (Steam BBCode allowed). Requires being logged in. Returns { ok, newCommentId, total }.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        text: { type: "string", description: "Comment body (Steam BBCode, not Markdown)." },
      },
      required: ["fileId", "text"],
    },
  },
  {
    name: "swh_delete_comment",
    description:
      "Delete a comment by its gidcomment (the `id` from swh_list_comments). You must own the comment or the item. Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        commentId: { type: "string", description: "The gidcomment id to delete." },
      },
      required: ["fileId", "commentId"],
    },
  },
  {
    name: "swh_get_item",
    description:
      "Read the current editable fields of a workshop item (title, description, visibility). Owner login required. Use before swh_update_description to edit from the current text.",
    inputSchema: {
      type: "object",
      properties: { ...fileIdProp },
      required: ["fileId"],
    },
  },
  {
    name: "swh_update_description",
    description:
      "Replace a workshop item's ENTIRE description with the given Steam BBCode. Owner login required. Read swh_get_item first — this overwrites the whole field. Returns { ok, verified }.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        description: { type: "string", description: "New full description in Steam BBCode." },
      },
      required: ["fileId", "description"],
    },
  },
  {
    name: "swh_update_title",
    description:
      "Update a workshop item's title. Owner login required. Returns { ok, verified }.",
    inputSchema: {
      type: "object",
      properties: {
        ...fileIdProp,
        title: { type: "string", description: "New item title." },
      },
      required: ["fileId", "title"],
    },
  },
];

// Tool name -> window.SWH method.
const METHOD_MAP: Record<string, string> = {
  swh_open_item: "openItem",
  swh_get_auth: "getAuth",
  swh_get_context: "getContext",
  swh_review_notifications: "reviewNotifications",
  swh_get_notifications: "getNotifications",
  swh_list_comments: "listComments",
  swh_post_comment: "postComment",
  swh_delete_comment: "deleteComment",
  swh_get_item: "getItem",
  swh_update_description: "updateDescription",
  swh_update_title: "updateTitle",
};

export async function handleSwhTool(name: string, args: any, bridge: Bridge) {
  const method = METHOD_MAP[name];
  if (!method) throw new Error(`Unknown workshop tool: ${name}`);
  const result = await bridge.call(method, args || {});
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
