---
name: vsce-package
description: Build, validate, and package this VS Code extension into a versioned VSIX. Verifies tsc compile, package.json contributions, and .vscodeignore before invoking vsce package.
disable-model-invocation: true
---

# vsce-package

Produce a clean VSIX for the Todo Sync extension.

## Steps

1. Run `npm run compile` and fail fast if tsc reports errors.
2. Validate `package.json`:
   - `main` points to a file under `out/` that exists after compile.
   - Every entry in `contributes.commands` is also referenced in `contributes.menus` or registered in `src/extension.ts`.
   - `version` matches the user's intent (ask if unsure; do not auto-bump).
3. Validate `.vscodeignore` excludes `src/`, `tsconfig.json`, `.vscode/`, `node_modules` dev-only deps, and the `.todos/` / `.ado/` runtime dirs.
4. Run `npx vsce package` (or `scripts/build-vsix.ps1` on Windows).
5. Report VSIX path and size. Warn if size > 2 MB.

## Notes
- Do not run `vsce publish` from this skill.
- If `git status` is dirty, warn before packaging.
