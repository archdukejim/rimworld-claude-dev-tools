# Agent handoff — agent/c2d63b12

**Done (2026-09-05):** removed the two hardcoded-RimSynapse-org breakages hit during
the 2026-08-30 CP (Regions-and-societies) releases.

- `harness/package-release.ps1`: owner/repo slug now derived once per repo from
  `git -C <path> remote get-url origin` (fallback `RimSynapse/<r>`), used for both
  the `releases/latest` lookup and `gh release upload`.
- `server/src/tools/sync.ts` (`sync_repo_wiki`): wiki clone URL now derived from
  the local checkout's origin remote (HTTPS + SSH forms), configured org as fallback.
  Server rebuilt with `npm run build` — compiles clean.

**Landed via:** PR #35 into `development`.
**Follow-up:** RimSynapse/Core#112 tracks other tooling still pointing at the old org.
