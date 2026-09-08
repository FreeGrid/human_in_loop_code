# Scoped execution and atomic reports

Task Plan is a Controller component. Starting or binding a phase records its
authorized execution; it does not isolate the already running Pi/Codex host or
schedule an Implementer. A Controller must launch untrusted work through
`configureExecutionSandbox` and `runSandboxedProcess`. Modern automated verification
requires that opaque sandbox on its configured process verification authority.
Model tool arguments cannot create either authority. Legacy V1 retains its prior
adapter contract and is not silently upgraded to this isolation guarantee.

## Filesystem and process boundary

The trusted configuration specifies a canonical target root, exact relative paths
or `directory/**` read/write rules, allowed absolute executables, Git common root,
protected authority paths and narrowly selected runtime library reads. Plan,
operation runtime, registered signing-key paths and every forbidden contract path
must be protected. Git metadata is denied even through worktree common-directory
references. Read and write permissions are distinct. Actual Git changes are checked
against the original capture before verification and finalize, including deletions
and both rename paths. Unchanged preexisting dirty content is part of that capture.
Candidate `files` lists do not authorize changes.

Ignored untracked files inside read/write scopes are currently refused before
initial capture and on every content inspection. Git snapshots cannot represent
their changes, so they cannot serve as verification inputs or outputs. Track the
required file or use a future explicitly inventory-bearing baseline; the service
never silently changes an existing capture. Ignored files outside executable
scopes do not grant the child access.

Node-v1 verification versions combine Git identity with a `scoped-raw-v1` raw-byte
inventory of the read/write scopes. This detects line-ending changes that Git may
normalize away. The original Git baseline and its initial version remain unchanged.
The inventory is sorted and sampled twice, checks file identity around each read,
and refuses aliases, unstable reads, more than 100,000 entries, files over 64 MiB,
or more than 256 MiB total content per sample. Plan, Git metadata and forbidden
paths are excluded because the child cannot read them. Missing exact paths and
directory/file kind changes are represented or rejected explicitly. Existing
receipts using only Git versions require actual verification again.

The current backend requires Darwin's real `sandbox-exec` boundary. Unsupported
hosts fail closed. The child cannot access the network, create child processes,
or execute a replacement outside the allowlist. An allowed in-place replacement
retains the same sandbox. Shell commands that require child processes are refused;
the Controller must invoke separately authorized jobs. Time and output limits kill
the single child. The Controller retains the signing key and receipt issuance.

Filesystem aliases and runtime grants are validated before launch. Writable
runtime trees must remain under trusted Controller ownership for the whole run;
configuration and prelaunch checks cannot prevent a separate unrestricted host
from racing filesystem changes. The kernel boundary protects the launched child,
not other processes running outside it. Provision runtime dependencies narrowly
and keep authority material outside all child-readable trees.

This backend does not provide a full Harness scheduler, a sandbox for the existing
host, or an automatically isolated reviewer service. Those integrations must use
their own trusted launch and identity controls. The Pi write hook is a convenience
guard and is not used as evidence of OS denial.

## Atomic batch and recovery

`plan_report_task_results` requires `expected_document_hash`, `task_id`, a stable
`idempotency_key` and 1–64 reports with distinct work IDs. It validates every item
and the complete candidate before creating a durable intent, then writes all notes
and the batch receipt in one CAS. Invalid items return per-item rejection details
with no partial note installation. Candidate Acceptance booleans remain forbidden.

Successful responses contain an operation ID and stable per-report IDs. Retrying
the identical payload/key returns the original identity without writing again,
provided its notes have not been superseded. Reusing a key with different content
or after reopening is refused. Reopen increments a generation and retains spent
keys. Each phase holds at most 128 batch receipts; reaching that bound requires
explicit archival recovery rather than deleting replay protection.

A failure after candidate installation returns `operation_recovery_required` and
per-item `recovery_required`; it does not claim that notes were absent or accepted.
Inspect and explicitly recover the operation, then retry the original key. Recovery
never reruns verification or captures a new baseline. A losing concurrent CAS does
not install any subset of the batch. See [operation journal](operation-journal.md).

Start/bind derives the session binding from the exact committed phase snapshot.
If an intervening document change prevents that binding, the result reports
`post_start_binding_conflict` with the durable operation identity. Resume the
existing phase; do not recapture its baseline. Session binding is recoverable host
state and is not a second source of execution authority.
