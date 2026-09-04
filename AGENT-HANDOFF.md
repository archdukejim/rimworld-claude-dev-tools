# AGENT-HANDOFF — `agent/85a44357`

## What this branch fixes

**Every sharp-backed workshop-image tool was dead** (`render_workshop_infographic`, `compose_workshop_page`,
`make_workshop_image`, `list_workshop_images`, `merge_workshop_tiles`, `render_workshop_preview`,
`capture_workshop_image`) with `ERR_DLOPEN_FAILED: The specified procedure could not be found` on
`@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node`.

**Root cause — not an ABI mismatch.** `@xenova/transformers` declares `sharp@^0.32`, the server uses `^0.35`,
so npm nested a second sharp (0.32.6) under `node_modules/@xenova/transformers/node_modules/`. Both copies ship
a DLL named `libvips-42.dll`; Windows binds a DLL name once per process. Any corpus/embedding tool loads
transformers (and its old sharp) first, after which the 0.35 binary binds against the old libvips and every
sharp tool fails for the life of that server process. `native.ts` caches the failure, so it looked permanent.

- **CHANGED `server/package.json`** — `overrides: { "@xenova/transformers": { "sharp": "$sharp" } }` (one
  top-level sharp; every sharp API transformers calls exists in 0.35) + `test:sharp` script.
- **CHANGED `server/package-lock.json`** — nested `sharp`/`node-addon-api` entries removed; top-level sharp
  0.35.3 → 0.35.4 (side effect of `npm dedupe`). `npm install` / `npm dedupe` would NOT evict the locked
  nested copy on their own — the lock entries had to be deleted by hand.
- **NEW `server/test/sharp-dedupe.test.js`** — loads transformers first, then sharp; asserts a deduped tree.
- **CHANGED `CLAUDE.md`** — gotcha under "Conventions & gotchas".

## Verify (done this session)
- `cd server && npm run test:sharp` → 6/6 ok.
- Fresh `node build/index.js --sse`: `search_harmony` (loads transformers) then `list_workshop_images` in the
  same process → real 85-image listing.
- `build/embeddings.embed()` still returns a 384-dim vector; `npm ci --dry-run` clean; `npm ls --all` clean.
- The live session's MCP `list_workshop_images` returns the listing.

## Rollout note
`node_modules` in the main checkout (`C:\github\rimworld-claude-dev-tools\server`) is already reinstalled with
the deduped tree; its `package.json`/`package-lock.json` working copies carry the same change uncommitted until
this PR merges into `development`. MCP server processes started before the fix that already cached the sharp
failure need a restart.
