# Studio plan

## Status and ownership

Codex owns extraction and validation. Portable editor, home form and server are implemented in this repository.

## Work and acceptance

- [x] Extract article editor; replace personal identifiers.
- [x] Implement home settings form and validated API.
- [x] Align save/publish labels with all saved content publication.
- [x] Verify original content preservation, unsafe paths/origins, Git scope and publish retry.
- [x] Browser check save, reload, preview and home customization.

Next: owner review and optional public release. Risk: visual HTML editing is browser dependent; source mode remains available. Publication requires the owner's configured origin and Git identity. 2026-09-11 verification: 14 Node tests pass. Browser fixture confirmed home save/reload, new article save in HTML mode, visual-mode editing, index refresh and shared branding. Git tests use local bare remotes; public GitHub push is untested in this project.
