# Upstream fork governance

`human_in_loop_code` is the product-code fork of `baochunli/pi-collaborating-agents`. The audited upstream baseline is commit `acd50d0ec091deb03bb90b57b694131cff0c297d`, whose package version is `0.4.6`. The commit, not a release tag, is the authority.

## What stays upstream-compatible

Preserve the upstream collaboration plane unless a reviewed divergence is necessary:

- `/agents` overlay;
- Agents / Feed / File reservations / Chat views;
- direct, broadcast, and urgent messages;
- single and parallel subagents;
- TOML subagent types;
- run/session registry and session tail;
- `process` and `cmux-pane` launch behavior;
- packaging as a Pi package under MIT License.

## Product additions on top of the fork

Harness product work may add Controller, Context Router, Agent Registry, workstream continuity, verification, review gates, checkpoint support, and research-project adapters. These must be added through clear packages, adapters, commands, or extensions where possible, rather than rewriting the upstream collaboration core.

P00 deferrals remain in force:

- Herdr backend is deferred and must not be claimed as verified.
- Heavy Docker/VM sandbox validation is deferred and must not be claimed as verified.
- First-class `resume-session` is deferred to P04; completed run records alone are not proof of reusable session continuity.

## Sync policy

- Keep `origin` as the writable FreeGrid fork.
- Keep `upstream` as the read-only upstream source: `https://github.com/baochunli/pi-collaborating-agents.git`.
- Use dedicated `upstream-sync/<date>` branches for upstream sync.
- Do not mix upstream sync and local features in the same PR.
- Run upstream compatibility tests before and after sync.
- Keep MIT LICENSE and copyright notices.

## Divergence policy

Prefer adding new modules over editing upstream core. If upstream core must change, the commit and PR must explain:

- why adapter/new-module extension was insufficient;
- which upstream behaviors are affected;
- what tests protect compatibility;
- whether the change can be proposed upstream or later removed.

Use commit trailer:

```text
Upstream-Divergence: <reason-or-none>
```

## Validation entry points

Use:

```bash
make doctor
make verify-upstream-compat
```

`verify-upstream-compat` should cover upstream tests and `npm pack --dry-run`. Peer dependencies may need to be installed or provided by the Pi runtime; failures must distinguish missing environment dependencies from source regressions.
