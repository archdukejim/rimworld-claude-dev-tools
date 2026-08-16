---
name: cut-release
description: Cut a complete release of one of archdukejim's RimWorld mods end-to-end — bump version + changelog in all three places, run the gates, merge dev→main, tag + GitHub release, deploy, and update the LIVE Steam Workshop description. Trigger on "cut a release", "cut it", "I'm ready to release", "release <mod> <version>", "ship <version>", "do the release", "push the release".
---

# Cut a release

Runs the full release of one mod from a clean `development` branch to a published
Workshop update. **When the user says "cut it," every phase below runs — do not stop
after the merge.** The release is "done" only when the tag, the GitHub release, the
deploy, AND the live Steam description are all updated. The two things that historically
slip are the **git tag/GitHub release** and the **live Steam description** — treat them
as first-class, not afterthoughts.

## Non-negotiables
- **Finish the whole sequence.** Merging dev→main is the middle, not the end. Tag +
  GitHub release + deploy + live Steam description all follow, in one go.
- **Version lives in THREE places — update all, then prove it.** (1) `About/About.xml`
  `<modVersion>`, (2) the `Version:` line + a new changelog block inside About.xml's
  `<description>`, (3) `About/steam_description.txt`'s version line + changelog block.
  Run `harness/verify-metadata.ps1` and require it to pass before merging — that is the
  gate that catches a forgotten changelog.
- **`main` is protected → merge via PR.** Trial-merge `origin/development` into
  `origin/main` on a throwaway branch FIRST; assert no conflicts and that the merged tree
  equals `development` (no stale content resurrected). Only then create/merge the PR.
- **The live Steam description is a public change** → show the final BBCode and confirm
  before `swh_update_description`. Separately, **the mod FILES upload via RimWorld's
  in-game "Update on Steam Workshop" button** — there is no headless path; say so plainly
  and never claim you uploaded the files.
- **Two-edition mods (standard + RP2):** release only the edition asked for. Keep the
  other edition's `About` in sync (committed) but do not publish it unless told.

## Workflow

**Phase 0 — Scope.** Confirm: which mod, the exact version string (e.g. `0.8.0`), and
which edition(s). Confirm the fileId for the Steam step (`About/PublishedFileId.txt`).

**Phase 1 — Version + changelog (do this FIRST, before any merge).** Bump `<modVersion>`;
update the `Version:` line and add a new dated changelog block in About.xml `<description>`;
mirror the version line + changelog into `steam_description.txt` (BBCode). Base the
changelog on the real `main..development` commit set — do not invent or advertise cut
features. Run `./harness/verify-metadata.ps1 -Root "<mod>"` → must report OK (all three
versions agree and the changelog names the new version). Commit to `development` and push.

**Phase 2 — Gates.** `dotnet build -c Release` clean; `validate_mod_defs`; save-compat
sanity (diff `Scribe_`/`ExposeData` `main..development` — renamed/retyped existing keys
are red flags; additive keys + sentinel migrations are fine). Check the CI `release-gates`
run; if a gate is red, diagnose it — only proceed past a knowingly-non-blocking one.

**Phase 3 — Merge dev→main.** `git fetch origin`. Trial-merge on a temp branch off
`origin/main`; assert `git merge` is clean and `git diff origin/development` (merged tree)
is empty; abort the trial. Create or refresh the `development`→`main` PR (fix a stale
title/body). Merge it (`gh pr merge --merge`). Verify `origin/main` now contains
`development` and shows the new `modVersion`.

**Phase 4 — Tag + GitHub release.** Annotated tag `vX.Y.Z` on the merge commit; push it.
`gh release create vX.Y.Z --target main` with the changelog as notes.

**Phase 5 — Deploy.** `deploy_rimworld_mods { mods:["<mod>"] }` so the Mods folder carries
the new `About` + built DLL (the repo edits do NOT reach the deployed folder on their own).
Verify the deployed `About/About.xml` `<modVersion>` matches.

**Phase 6 — Live Steam description.** `swh_get_auth` (needs Chrome + Steam Workshop Helper
logged into Steam). `swh_get_item { fileId }` to see the current live body. Build the new
body from `steam_description.txt` (already BBCode). Show the user the change; on approval
`swh_update_description { fileId, description }`; verify with `swh_get_item`. Then remind
the user to click **Update on Steam Workshop** in RimWorld's mod list to push the 0.8.0
FILES (headless upload is not available).

## Tools
- Local/git: `dotnet build`, `git`, `gh` (pr/tag/release), `deploy_rimworld_mods`,
  `validate_mod_defs`, `harness/verify-metadata.ps1`.
- Steam (approval-gated, via Steam Workshop Helper + Chrome): `swh_get_auth`,
  `swh_get_item`, `swh_update_description`.

## Preconditions
Run from a session where the `rimworld-claude-dev-tools` MCP is registered. Phase 6 needs
Chrome with the Steam Workshop Helper extension, logged into Steam. If a precondition is
missing, say so and stop at that phase — the earlier phases (through the GitHub release +
deploy) still stand as a complete code/GitHub release even if the Steam step waits.

## Where releases live
Skill + MCP are in the **dev-tools repo**; each mod is its **own content repo**. Run this
pointed at the target mod's folder; all commits/tags/PRs land in that mod's repo, never in
dev-tools.
