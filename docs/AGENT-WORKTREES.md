# Agent worktree isolation & branching model

This repo is worked on by multiple Claude Code sessions at once — sometimes several forks of the
same conversation. They historically shared **one working directory and one branch**, which caused a
real incident: one session committed another session's uncommitted files and moved shared `HEAD` out
from under it. This document is the fix, and it is enforced by hooks so it can't be forgotten.

## The model in one picture

```
main  ← protected, release-only. PR from development ONLY. No direct writes, ever.
  ▲
  │ (PR)
development  ← integration branch. Protected from DIRECT commits. Branch from it; merge into it via PR.
  ▲
  │ (PR into development)
agent/<session-id>   ← one branch per session, in its own worktree. ALL work happens here.
agent/<other-id>     ← a concurrent/forked session's branch, fully isolated.
```

- **`main`** — protected. Only ever updated by a PR **from `development`**.
- **`development`** — the base everyone branches from and merges back into (via PR). Not committed to directly.
- **`agent/<session-id>`** — your session's private branch, checked out in your session's private worktree.

## How isolation happens (automatic)

Two hooks in `.claude/settings.json` do the work:

1. **`SessionStart` → `.claude/hooks/session-worktree.cjs`**
   On every session start (including every fork — a fork gets a fresh session id), this creates (or
   reuses) a worktree at `../worktrees/<repo>/<session-id>` on branch `agent/<session-id>`, based on
   `development`. It prints the worktree path and the rules into your context. It never blocks startup;
   if it can't create a worktree it warns and tells you to coordinate.
   - Override the worktree root with `CLAUDE_WORKTREE_ROOT`.
   - **Dependencies:** `server/node_modules` is untracked; the hook JUNCTIONS the worktree's
     `server/node_modules` to the main checkout's copy, so a fresh worktree builds immediately.
     Treat it as **read-only from worktrees** — `npm install` / `npm ci` runs ONLY in the main
     checkout's `server/` (the junction target every session shares). If the hook says the main
     checkout has no `node_modules`, install there once, not in the worktree.
   - **Auto-GC:** the hook also spawns `.claude/hooks/gc-worktrees.cjs` (detached, best-effort),
     which removes worktrees that are simultaneously fully merged into `origin/development`,
     clean, and idle for 7+ days — then prunes admin entries and deletes their `agent/*`
     branches (`-d`, so unmerged work always survives). Dry-run it any time:
     `node .claude/hooks/gc-worktrees.cjs --dry-run`.

2. **`PreToolUse(Bash)` → `.claude/hooks/protect-main.cjs`**
   Hard-blocks (exit 2) any `git commit` / `merge` / `rebase` / `push` whose target branch is
   `main`, `master`, or `development`. This is the backstop behind the rule above.

> The SessionStart hook can't change your session's cwd — it only prepares the worktree. **You must
> `cd` into the printed worktree path** (and use absolute paths under it for Edit/Write) to actually
> work in isolation.

## Daily recipes

**Work in your worktree**
```bash
cd ../worktrees/<repo>/<session-id>     # exact path is in your session-start message
# edit / build / commit here, on agent/<session-id>
```

**See what other sessions are doing**
```bash
git worktree list                        # every session's path + branch
git branch --list 'agent/*'              # all agent branches
```

**Absorb a finished subtask from another session (before a full integration)**
```bash
git -C <your-worktree> fetch origin
git -C <your-worktree> merge agent/<other-id>     # or: git cherry-pick <sha>
# read their AGENT-HANDOFF.md first — it says what they changed and any gotchas
```

**Land your work**
```bash
git -C <your-worktree> push -u origin agent/<session-id>
gh pr create --base development --head agent/<session-id>   # PR into development, NEVER main
```

**Promote development → main** (release)
```bash
gh pr create --base main --head development                 # the only way main advances
```

**Clean up finished worktrees**
```bash
git worktree remove ../worktrees/<repo>/<session-id>        # when the branch is merged
git worktree prune                                          # drop stale metadata
```

## Handoffs (`AGENT-HANDOFF.md`)

A session that is finishing, or that expects another agent to pick up its branch, writes an
`AGENT-HANDOFF.md` **on its own branch** — TL;DR of what changed, git state, architecture notes, and
loose ends. Because it lives on the branch, it travels with the work: whoever merges or checks out
`agent/<id>` gets that session's handoff. **Read it before absorbing another branch.** Keep handoffs
branch-local; archive them under `docs/handoffs/` if you want to retain them past a merge.

## Why this is aggressive on purpose

The failure mode (shared checkout, shared `HEAD`, one agent committing another's files) is silent and
destructive. Per-worktree isolation makes it structurally impossible rather than relying on agents to
behave. The cost — a worktree per session (a fresh checkout; objects are shared, so it's mostly disk
for working files) and PR-only promotion — is the intended trade for never losing work to a race again.
