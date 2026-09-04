## Human-in-the-Loop workspace

This control workspace is `{{WORKSPACE_NAME}}` (`{{WORKSPACE_ID}}`). `CONTROL_INDEX.json` is the machine-readable authority for repository identities, paths, ownership and relationships. This managed block is the durable operating contract; do not rely on session memory to recover it.

### Repository bindings

{{REPOSITORY_TABLE}}

### Relationships

{{RELATIONSHIP_LIST}}

Treat paths as bindings, not permission to scan elsewhere. The product runtime must never read this control repository or depend on its private plans, fixtures, tests, evidence or release records.

### User-specific requirements

{{USER_REQUIREMENTS}}
