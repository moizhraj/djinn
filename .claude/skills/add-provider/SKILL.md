---
name: add-provider
description: Scaffold a new issue-tracker provider (e.g., Jira, Bitbucket) under src/providers/, wiring it into the provider registry and config types so it reaches parity with the existing ADO/GitHub/GitLab providers.
disable-model-invocation: true
---

# add-provider

Add a new sync provider that matches the existing ADO/GitHub/GitLab shape.

## Inputs
- Provider name (kebab-case id and display name).
- Auth model (PAT, OAuth, basic).
- SDK to use (or "raw fetch").

## Steps

1. Read `src/providers/` to discover the provider interface in use. Treat the existing files as the contract — do not invent new methods.
2. Create `src/providers/<name>Provider.ts` implementing every method on that interface. Stub any method you cannot implement and mark it with a single-line `// TODO(<name>):` comment.
3. Register the provider:
   - Add discriminant to `src/types.ts` provider union.
   - Wire into the provider factory / registry (search for where existing providers are constructed).
   - Add config schema to `src/config/workspaceConfig.ts` and migration handling in `src/config/migration.ts` if needed.
   - Add a secrets entry pattern in `src/config/secrets.ts` (do NOT hardcode tokens).
4. Update `package.json` `contributes.configuration` if the provider needs new user-visible settings.
5. Run `npm run compile` and fix type errors.
6. Report what's stubbed so the user knows what still needs implementing.

## Guardrails
- Never edit `src/config/secrets.ts` to add real credentials — only the schema/key.
- Do not alter the provider interface; if it's insufficient, surface the gap and ask before changing it (parity with other providers matters).
