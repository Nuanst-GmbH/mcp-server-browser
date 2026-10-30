# Publishing to the VS Code Marketplace

GitHub owner and Marketplace publisher are `Nuanst-GmbH`.
`repository`, `homepage`, `bugs` (the bug-report form), and `qna` (`SUPPORT.md`) point at `https://github.com/Nuanst-GmbH/mcp-server-browser`.

Publishing runs from `.github/workflows/publish.yml` when a GitHub Release is published. The tag is `v` plus `package.json` `version`. The workflow uses `npx @vscode/vsce publish --oidc`. No PAT is stored in the repo.

Trusted Publishing policy on publisher `Nuanst-GmbH`:

- Policy name: `Release workflow`
- Repository owner: `Nuanst-GmbH`
- Repository: `mcp-server-browser`
- Workflow: `publish.yml`
- Environment: empty

## Checklist

- [ ] `publisher` is `Nuanst-GmbH`
- [ ] `repository` is the public GitHub URL
- [ ] `version` bumped and `CHANGELOG.md` updated
- [ ] GitHub Release tag is `v` plus that version
- [ ] `LICENSE`, `README.md`, `CHANGELOG.md`, `SUPPORT.md`, `PRIVACY.md`, and `icon.png` (128×128 PNG) present
- [ ] README privacy section matches `PRIVACY.md` and the Report Issue code
- [ ] `npx vsce ls` shows `dist/extension.js`, not `src/`, `test/`, or `node_modules/`
- [ ] `npm test` is green
