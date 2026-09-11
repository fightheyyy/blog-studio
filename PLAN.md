# Blog Studio extraction plan

## Current Status

Standalone implementation complete and verified locally. Owner: Codex for extraction and verification; repository owner for public repository/account choices.

## Milestones

- [x] Inspect original static site and local editor; define standalone boundaries.
- [x] Extract theme/editor with generic sample content and license notices.
- [x] Add validated site configuration and homepage editor; synchronize article branding.
- [x] Add static export and GitHub Pages workflow; disclose publication scope.
- [x] Verify configuration, article round trips, HTTP boundaries, export portability, and scoped Git publication.
- [x] Exercise homepage and article editing in browser; inspect desktop and mobile layouts.
- [x] Finish setup/contribution documentation and local Git repository.

## Acceptance Criteria

A fresh checkout runs with Node 22+ and `npm ci && npm run studio`. An owner can customize their homepage, create/edit a post, preview it, and build `dist/` without changing application code. Public files work at a domain root and a repository subpath. Export excludes editor/config/dependencies/private source artifacts. Tests use temporary directories and local bare Git remotes. Original blog worktree remains unchanged.

## Next Steps

Review the runnable local project. If the owner requests public release, create the GitHub repository, enable its template flag and configure Pages; external deployment has not been run.

## Risks / Open Questions

Visual editor uses browser contenteditable/execCommand; advanced HTML remains available in source mode. HTML content is trusted author input, not a multi-user CMS. Private draft workflow and remote hosted editing are out of scope. Public repo name and release remain pending owner decision.

## Verification Log

2026-09-11:
- `npm ci --ignore-scripts`: clean dependency installation succeeded; audit reported no vulnerabilities.
- `npm test`: 14 tests passed, including full saved-site publication through a temporary bare remote preservation of unrelated staged code, and unchanged article files after repeated synchronization.
- `npm run build`: 2 demo articles exported. Output links resolve beneath a repository subpath; editor/config/dependencies/private files excluded; license and font notices included.
- Browser isolated fixture: changed owner to Mira Chen and introduction, saved and reloaded; created a new article in HTML mode, then edited and saved through the visual frame; index updated and branding persisted.
- Responsive browser inspection at 390 × 844: homepage and article document widths stayed inside the viewport. Default desktop home, article and settings screens inspected.
- Source scan found no original article bodies/contact information or machine paths. SHA-256 comparison of the original blog's source files: no changes.
- README preview captured from the standalone homepage. Local main repository prepared; no GitHub repository or live deployment created.

Update this plan when behavior or release status changes.
