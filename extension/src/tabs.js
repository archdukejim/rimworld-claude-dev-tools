/*
 * Tab + tab-group hygiene, exposed over the loopback bridge as `tabsInventory` / `tabsTidy`.
 * ----------------------------------------------------------------------------------------
 * Tab groups are not a DevTools concept — chrome.tabGroups is an extension-only API — so the MCP
 * server's chrome_tabs / chrome_tidy tools route here through the background service worker.
 *
 * Why this is allowed to be aggressive: the RimAgentic launcher runs Chrome on its OWN profile
 * (%LOCALAPPDATA%\RimAgentic\chrome-profile), so every tab in this window belongs to automation, not
 * to the user's real browsing. Groups here go stale precisely because nothing ever cleaned them up.
 *
 * Guard rails that still apply, because "aggressive" must not mean "destroys work in progress":
 *   - pinned tabs are never closed,
 *   - the active tab in each window is never closed,
 *   - anything matching the caller's `keep` substrings is never closed,
 *   - at least one tab always survives (closing the last one takes the window with it).
 */

const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];

/** Stable colour per group name, so a given site keeps its colour across tidies. */
function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/** The group name a tab belongs in — the registrable-ish site name, not the full host. */
function groupNameFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "chrome:" || u.protocol === "chrome-extension:") return "chrome";
    const host = u.hostname.replace(/^www\./, "");
    const parts = host.split(".");
    // steamcommunity.com -> steamcommunity ; i.imgur.com -> imgur ; api.github.com -> github
    return (parts.length >= 2 ? parts[parts.length - 2] : host) || "other";
  } catch {
    return "other";
  }
}

/** Compare URLs ignoring the fragment, so #anchor variants count as duplicates. */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url || "";
  }
}

const GROUP_NONE = chrome.tabGroups ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;

async function readGroups() {
  if (!chrome.tabGroups) return [];
  try {
    return await chrome.tabGroups.query({});
  } catch {
    return [];
  }
}

/** Full picture of the window: groups, their members, ungrouped tabs, and duplicate URLs. */
async function tabsInventory() {
  const tabs = await chrome.tabs.query({});
  const groups = await readGroups();
  const now = Date.now();

  const byGroup = new Map();
  for (const g of groups) byGroup.set(g.id, { id: g.id, title: g.title || "", color: g.color, collapsed: !!g.collapsed, tabs: [] });

  const ungrouped = [];
  const seen = new Map();
  const duplicates = [];

  for (const t of tabs) {
    const row = {
      id: t.id,
      title: t.title || "",
      url: t.url || "",
      active: !!t.active,
      pinned: !!t.pinned,
      windowId: t.windowId,
      idleMinutes: t.lastAccessed ? Math.round((now - t.lastAccessed) / 60000) : null
    };
    const key = normalizeUrl(row.url);
    if (seen.has(key)) duplicates.push({ url: key, ids: [seen.get(key), row.id] });
    else seen.set(key, row.id);

    if (t.groupId !== undefined && t.groupId !== GROUP_NONE && byGroup.has(t.groupId)) byGroup.get(t.groupId).tabs.push(row);
    else ungrouped.push(row);
  }

  const groupList = [...byGroup.values()];
  return {
    tabCount: tabs.length,
    groups: groupList,
    ungrouped,
    duplicates,
    emptyGroups: groupList.filter(g => g.tabs.length === 0).map(g => ({ id: g.id, title: g.title })),
    singletonGroups: groupList.filter(g => g.tabs.length === 1).map(g => ({ id: g.id, title: g.title }))
  };
}

/**
 * Close duplicates + idle tabs, dissolve singleton/empty groups, re-group the survivors by site, and
 * collapse everything except the active group. Returns the plan it carried out (or would have, with
 * dryRun).
 */
async function tabsTidy(args) {
  const opts = args || {};
  const maxAgeMinutes = Number.isFinite(opts.maxAgeMinutes) ? Number(opts.maxAgeMinutes) : 60;
  const keep = Array.isArray(opts.keep) ? opts.keep.filter(Boolean).map(String) : [];
  const regroup = opts.regroup !== false;
  const collapse = opts.collapse !== false;
  const dryRun = !!opts.dryRun;

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const protectedIds = new Set();
  const protectedReason = {};

  for (const t of tabs) {
    let why = null;
    if (t.pinned) why = "pinned";
    else if (t.active) why = "active";
    else if (keep.some(k => (t.url || "").includes(k))) why = "keep-list";
    if (why) { protectedIds.add(t.id); protectedReason[t.id] = why; }
  }

  const closing = new Map(); // id -> reason

  // 1. Duplicate URLs: keep the most recently accessed, close the rest.
  const byUrl = new Map();
  for (const t of tabs) {
    const key = normalizeUrl(t.url || "");
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(t);
  }
  for (const [url, group] of byUrl) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    for (const t of ordered.slice(1)) {
      if (protectedIds.has(t.id)) continue;
      closing.set(t.id, `duplicate of ${url}`);
    }
  }

  // 2. Idle tabs.
  if (maxAgeMinutes > 0) {
    for (const t of tabs) {
      if (protectedIds.has(t.id) || closing.has(t.id)) continue;
      if (!t.lastAccessed) continue;
      const idle = (now - t.lastAccessed) / 60000;
      if (idle > maxAgeMinutes) closing.set(t.id, `idle ${Math.round(idle)}m > ${maxAgeMinutes}m`);
    }
  }

  // 3. Never take the window down with us.
  const survivors = tabs.filter(t => !closing.has(t.id));
  if (!survivors.length && tabs.length) {
    const newest = tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    closing.delete(newest.id);
    protectedReason[newest.id] = "last surviving tab";
  }

  const plan = {
    closing: [...closing.entries()].map(([id, reason]) => {
      const t = tabs.find(x => x.id === id);
      return { id, reason, url: t ? t.url : null, title: t ? t.title : null };
    }),
    protected: Object.entries(protectedReason).map(([id, reason]) => ({ id: Number(id), reason })),
    groups: []
  };

  // 4. Work out the target grouping for whatever survives.
  const remaining = tabs.filter(t => !closing.has(t.id) && !t.pinned);
  const wanted = new Map(); // name -> tab ids
  for (const t of remaining) {
    const name = groupNameFor(t.url || "");
    if (!wanted.has(name)) wanted.set(name, []);
    wanted.get(name).push(t.id);
  }
  // A group of one is noise — leave those ungrouped.
  for (const [name, ids] of [...wanted.entries()]) if (ids.length < 2) wanted.delete(name);
  plan.groups = [...wanted.entries()].map(([name, ids]) => ({ name, color: colorFor(name), tabs: ids.length }));

  if (dryRun) return { dryRun: true, ...plan, note: "Nothing was changed. Re-run without dryRun to apply." };

  // ---- apply ----
  const closed = [];
  for (const id of closing.keys()) {
    try { await chrome.tabs.remove(id); closed.push(id); } catch { /* already gone */ }
  }

  const groupsApplied = [];
  if (regroup && chrome.tabGroups) {
    const existing = await readGroups();
    for (const [name, ids] of wanted) {
      // Reuse a group that already carries this title so ids/colours stay stable across tidies.
      const match = existing.find(g => (g.title || "") === name);
      try {
        const groupId = await chrome.tabs.group(match ? { tabIds: ids, groupId: match.id } : { tabIds: ids });
        await chrome.tabGroups.update(groupId, { title: name, color: colorFor(name) });
        groupsApplied.push({ name, groupId, tabs: ids.length, reused: !!match });
      } catch (e) {
        groupsApplied.push({ name, error: String((e && e.message) || e) });
      }
    }

    // Dissolve anything left holding a single tab — the classic stale-group residue.
    const after = await readGroups();
    for (const g of after) {
      const members = await chrome.tabs.query({ groupId: g.id });
      if (members.length === 1) {
        try { await chrome.tabs.ungroup(members.map(m => m.id)); groupsApplied.push({ name: g.title || "(untitled)", dissolved: true, reason: "singleton" }); }
        catch { /* raced with a close */ }
      }
    }
  }

  if (collapse && chrome.tabGroups) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeGroup = active && active.groupId !== undefined ? active.groupId : GROUP_NONE;
    for (const g of await readGroups()) {
      try { await chrome.tabGroups.update(g.id, { collapsed: g.id !== activeGroup }); } catch { /* raced */ }
    }
  }

  const final = await tabsInventory();
  return { closed: closed.length, closedDetail: plan.closing, groups: groupsApplied, protected: plan.protected, after: final };
}

self.RIMAGENTIC_TABS = { tabsInventory, tabsTidy, groupNameFor, normalizeUrl, colorFor };
