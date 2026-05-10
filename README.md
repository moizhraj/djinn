# Djinn

Djinn is a VS Code extension for capturing todos in your repo and syncing them to
Azure DevOps, GitHub, or GitLab. It provides AI-assisted effort estimation, sync,
and metrics tracking, and can delegate work to Claude Code or GitHub Copilot.

## Features

- Capture and manage repo todos in a dedicated Djinn activity-bar view
- Sync todos with Azure DevOps work items, GitHub Issues, or GitLab Issues
  (or run fully local with no provider)
- Delegate todos to a Claude Code (local CLI) or GitHub Copilot Chat agent,
  or open the synced issue to hand off to provider-side tooling (e.g. ADO
  Copilot, the GitHub Copilot coding agent)
- Track progress and effort metrics in a built-in dashboard
- Configure default agents, models, and provider integration settings

## Getting Started

1. Install the extension and open a workspace folder.
2. Open the Djinn activity view from the VS Code sidebar.
3. Add todos, sync them to your selected provider, and run agents on items.
4. Open the metrics dashboard with `Djinn: Open Metrics Dashboard`.
5. Configure settings under `djinn.*` if you want a different default agent or model.

## Extension details

- Name: `Djinn`
- Publisher: `moizmh`
- Providers: Azure DevOps, GitHub, GitLab, Local (no remote sync)
- AI agents: Claude Code (local CLI), GitHub Copilot Chat, Open Issue (handoff to provider tooling)

## Development

```bash
npm install
npm run compile
npm run package
```
