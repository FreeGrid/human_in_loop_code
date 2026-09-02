# Repository layout

`human_in_loop_code` is the Harness implementation repository. It starts from the audited `baochunli/pi-collaborating-agents` fork and keeps the upstream collaboration plane intact while adding Harness-specific apps and packages beside it.

## Boundaries

- Keep upstream paths stable:
  - `extensions/collaborating-agents/`
  - `skills/collaborating-agents-system/`
  - `examples/subagents/`
- Add Harness code in new paths instead of piling product features into the upstream extension.
- Do not move large upstream files during P01-T002; preserve package behavior and future upstream-sync readability.
- Keep the published upstream package `files` allowlist narrow so `npm pack --dry-run` does not include control repo files, artifacts, or local temporary data.

## Top-level directories

| Path | Role |
|---|---|
| `extensions/collaborating-agents/` | Upstream-derived Pi collaboration extension: `/agents`, messaging, reservations, subagent spawning, session/run inspection. |
| `extensions/research-harness/` | Future Harness Pi extension for `/research`, Attention, Workstreams, and Controller integration. Created in P01-T008. |
| `skills/collaborating-agents-system/` | Upstream operating guide for collaborating agents. |
| `examples/subagents/` | Upstream subagent type examples. |
| `apps/researchctl/` | Future CLI entrypoint. |
| `apps/researchd/` | Future daemon entrypoint. |
| `packages/config/` | Future product/workspace configuration loader. |
| `packages/controller-core/` | Future minimal Controller core. |
| `packages/controller-client/` | Future shared client/protocol package for CLI and Pi extension. |
| `packages/schemas/` | Shared schemas and typed contracts. |
| `packages/doctor/` | Future environment/repository doctor checks. |
| `packages/release-manifest/` | Future dual-repo release manifest preparation logic. |
| `templates/` | Workspace templates for Harness product and research three-repo profiles. |
| `tests/` | Harness-level integration/e2e test fixtures beyond upstream tests. |
| `scripts/` | Repository maintenance and automation scripts. |

## Workspace convention

The root `package.json` declares Bun/npm workspaces for:

```json
[
  "apps/*",
  "packages/*",
  "extensions/*"
]
```

New internal packages use the private package prefix `@human-in-loop-harness/*` and expose TypeScript source through `exports`. P01-T002 only creates package boundaries and placeholder exports so later tasks can add real behavior without changing the layout.

## Import convention

- Harness apps should depend on shared behavior from `packages/*`.
- Pi UI should call shared Controller client interfaces rather than parse CLI log text.
- Upstream collaboration code should not import Harness Controller packages unless a later task explicitly defines a compatibility bridge.
