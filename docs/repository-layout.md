# Repository layout

`human_in_loop_code` is the installable research-product repository. It starts from the audited `baochunli/pi-collaborating-agents` fork and keeps the upstream collaboration plane intact while adding Pi-first research capabilities beside it. `human_in_loop_control` remains the separate development authority for build orchestration, candidate acceptance, upstream sync, and HCP.

## Boundaries

- Keep upstream paths stable:
  - `extensions/collaborating-agents/`
  - `skills/collaborating-agents-system/`
  - `examples/subagents/`
- Add Harness code in new paths instead of piling product features into the upstream extension.
- Do not move large upstream files during P01-T002; preserve package behavior and future upstream-sync readability.
- Keep the published package `files` allowlist narrow so `npm pack --dry-run` does not include control repo files, HCP state, artifacts, or local temporary data.
- The product must not resolve/read `human_in_loop_control`, accept a `control` repo role, aggregate the Harness dual repos, or create/finalize HCP.
- Existing CLI/daemon, dual-repo doctor/release, and Harness-workspace template scaffolds stay dormant until the P09 value Gate; do not extend, wire, publish, or delete them earlier.

## Top-level directories

| Path | Role |
|---|---|
| `extensions/collaborating-agents/` | Upstream-derived Pi collaboration extension: `/agents`, messaging, reservations, subagent spawning, session/run inspection. |
| `extensions/research-harness/` | Pi-first research product entry for `/research`, Attention, Workstreams, and research Controller integration. Introduced in P01-T007. |
| `skills/collaborating-agents-system/` | Upstream operating guide for collaborating agents. |
| `examples/subagents/` | Upstream subagent type examples. |
| `apps/researchctl/` | Dormant scaffold; conditional thin research-runtime adapter only after P09 approval. |
| `apps/researchd/` | Dormant scaffold; conditional research-runtime daemon only after separate P09 approval. |
| `packages/config/` | Research-product and three-repo configuration; CLI-oriented wiring remains dormant until P09. |
| `packages/controller-core/` | Research task/gate/evidence core, called in-process by Pi. |
| `packages/controller-client/` | Typed facade/client contract; Pi is the early consumer, optional adapters may reuse it after P09. |
| `packages/prompt-runtime/` | Versioned Role Prompt Registry, deterministic Prompt Composer, Prompt Envelope/hash ledger, and prompt-bypass behavior fixtures. Prompts guide roles; TypeScript policies enforce permissions and acceptance. |
| `packages/schemas/` | Shared Task, Capsule, Evidence, Review, and RCP contracts. |
| `packages/doctor/` | Dormant dual-repo scaffold; product health checks must be research-runtime-only. |
| `packages/release-manifest/` | Dormant dual-repo scaffold; HCP generation belongs to control. |
| `templates/` | Active research-three-repo templates; Harness-product template scaffold remains dormant. |
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

- Active research-product surfaces should depend on shared behavior from `packages/*`.
- Pi UI should call the in-process typed facade rather than parse CLI log text; CLI is not an early reference architecture.
- Pi product actions submit typed requests to Controller policy; only the Prompt Runtime may assemble Role Prompt + Task Packet + admitted Context + Runtime Envelope + Output Contract for `pi-process`. Do not expose raw spawn as a product bypass.
- Upstream collaboration code should not import Harness Controller packages unless a later task explicitly defines a compatibility bridge.
