# Contributing

Use Node 22+. Run `npm ci`, `npm test`, and `npm run build` before submitting a change. For UI work, start `npm run studio` and inspect the homepage, an article and the editor at desktop and mobile widths.

Keep the static output independent of the editor runtime. Preserve authored article HTML when updating metadata; escape configuration text and validate links. Keep Git publication scoped to public content and exercise publish behavior only with temporary local bare repositories in tests.

Do not commit credentials, private drafts, `node_modules/`, `dist/`, or test fixtures. Use examples in documentation instead of personal contact information. Keep font notices with the font.

Root and module `SPEC.md` / `PLAN.md` describe current architecture and work. Update them when a change affects contracts or structure. Describe the user-facing behavior and verification in your pull request.
