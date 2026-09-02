# Development commands

This repository exposes deterministic code-local commands for the control workspace to call from `human_in_loop_code` as a subprocess. These commands are development/build interfaces only; they do not start Pi, daemonize, create sockets/PID files, perform global links, or read `human_in_loop_control`.

## Commands

| Command | Purpose | Writes |
|---|---|---|
| `bun run install:frozen` | Install dependencies from `bun.lock` without lockfile mutation. | `node_modules/` and repo-local `.harness-tmp/bun-install-cache/`. |
| `bun run build` | Alias for TypeScript typecheck. | No build output. |
| `bun run typecheck` | Run `tsc -p tsconfig.json --noEmit`. | No build output. |
| `bun run test` | Run repository tests. | Test-owned temporary directories only. |
| `bun run package:dry-run` | Preview npm package contents. | Repo-local `.harness-tmp/npm-cache/`; no publish/tag. |
| `bun run verify:code` | Run build, tests, and package dry-run in sequence. | Same as component commands. |
| `bun run clean` | Remove generated code-local output directories. | Removes only declared relative paths inside this repo. |

## Clean contract

`bun run clean` may remove only these repository-local generated paths:

- `dist/`
- `coverage/`
- `.harness-tmp/` including Bun/npm caches used by development scripts
- `artifacts/tmp/`
- `artifacts/dev-command-results/`

The clean implementation rejects absolute paths and `..` escapes before deleting anything. After removing generated artifact subdirectories, it prunes the top-level `artifacts/` directory only when it is empty. It does not remove source, templates, lockfiles, workspace packages, upstream files, non-empty artifact directories, or files outside the repository.

## Structured result convention

Automation that wraps these commands should record a short JSON result under `artifacts/dev-command-results/` with this shape:

```json
{
  "command": "bun run verify:code",
  "status": "passed",
  "started_at": "2026-09-02T00:00:00.000Z",
  "finished_at": "2026-09-02T00:00:01.000Z",
  "repo": "human_in_loop_code",
  "notes": []
}
```

P01 keeps this as a file/JSON convention for control-owned orchestration; the code product runtime must not create HCP, aggregate the dual repos, or depend on control state.
