# Control Init

[← Back to the toolkit overview](../../README.md)

The `control-init` extension turns an explicitly named set of repositories into a
durable, auditable workspace. Natural-language requests are the primary entry:
Pi selects a built-in topology and calls a structured tool. The extension asks
only for facts that the template and current context cannot determine.

Examples:

```text
Use this directory as control and ../my-app as code. Initialize the workspace.
Initialize one code/control workspace and add separate paper-a and paper-b LaTeX repositories.
Show the current control workspace status.
The code repository moved to ../my-app-v2; update its binding.
```

## Agent tools and command fallback

| Agent tool | Human command | Behavior |
| --- | --- | --- |
| `control_workspace_init` | `/control:init` | Initialize `CONTROL_INDEX.json`, a managed `AGENTS.md` block, and any explicitly approved local Git repositories. |
| `control_workspace_status` | `/control:status [control-path]` | Read repository bindings, Git state, policies, warnings, and incomplete items. |
| `control_workspace_doctor` | `/control:doctor [control-path]` | Deterministically check schema, canonical paths, Git roots, remote identity, repository boundaries, and managed-block drift. |
| `control_workspace_update` | `/control:update [control-path]` | Preview and apply binding, topology, policy, requirement, or managed-block changes while preserving unaffected state. |

Structured tools never open dialogs. They return one of `applied`,
`needs_input`, or `conflict`; Pi should ask only the returned questions and then
retry. The `init` and `update` tools run sequentially so concurrent tool calls
in one Pi process cannot race one another. Byte-for-byte index and AGENTS
preconditions also reject stale writes from another process.

The slash commands are the Human-UI fallback. For the recommended and LaTeX
profiles, `/control:init` first offers two setup paths:

- **Create from a workspace name** asks for one safe base name and creates
  `<name>_control` plus `<name>_code` as sibling local Git repositories under
  the current directory. It displays the naming rule, both exact paths, and the
  role of each repository before the final preview. Existing names are never
  overwritten; invalid, suffixed, or colliding names are explained and asked
  for again.
- **Use existing repository directories** asks for existing control and code
  paths. Missing, invalid, identical, or nested paths are explained immediately
  and asked for again. Relative paths are resolved from the current directory.

The advanced custom topology retains its explicit JSON editor. Missing paths
introduced by custom or paper-repository input still require exact-path
authorization; any similar-directory choices are listed explicitly.

After interactive initialization succeeds, Pi continues the current history in
a session whose real working directory is the initialized control repository.
This reloads Pi's general file and shell tools, project instructions, system
prompt, and footer against the correct repository instead of merely redirecting
control-init commands. If session persistence is disabled, the wizard cannot
safely replace Pi's working directory and displays an exact `cd ... && pi`
restart command instead.

The extension also keeps the initialized control repository as the active
control-init target for the current extension session. Agent-tool initialization
and follow-up `/control:status`, `/control:doctor`, `/control:update` operations
therefore remain coherent even when an in-turn session switch is unavailable.
An explicit path always takes precedence. In a later Pi session, start Pi inside
the control repository or pass its exact path; when no index exists at the
resolved location, status asks for that path instead of incorrectly asking you
to initialize again.

Before asking about exceptions, the wizard displays the selected profile's
default ownership, privacy, dependency, approval, delivery, and delegation
rules. It then renders the candidate index plus the exact managed AGENTS
content. The final screen provides three explicit actions: apply the shown
initialization, return to modify answers, or cancel without changes. Applying is
bound to that exact preview: if a path, Git remote, index, or AGENTS file changes
after rendering, the operation returns a `preview-stale` conflict and writes
nothing. Invalid custom JSON is returned to the editor with its draft
preserved. Run the command again after a `preview-stale` conflict to review the
refreshed external state.
`/control:update` prints the current state first, retains the user's original
change description, clarifies only the affected category, prints before and
after state, and asks for final confirmation. It offers the same return-to-edit
choice and shows current state again before the revised preview. Cancelling
either command leaves the workspace unchanged. Print/JSON modes without a Human
UI refuse the interactive commands; an RPC host may use them only if it
implements Pi's extension UI request/response protocol.

## Built-in profiles

`control-code` is the recommended default:

- `control` is private by default and owns plans, tests, fixtures, verification
  tools, documents, evidence, implementation records, and release records.
- `code` contains only delivered production source, runtime-required resources,
  package metadata, and user-facing product documentation. It may become public
  and must never depend on control at runtime.

`control-code-latex` inherits that contract and adds one independent private
LaTeX repository per paper. Each paper repository owns only its manuscript,
bibliography, paper figures, submission materials, and directly related writing
records. Multiple papers may refer to the same code repository; code never
depends on a paper repository, and paper repositories do not depend on one
another.

Select `custom` only when those contracts cannot express the requested
topology. Custom initialization requires an explicit directory, role,
visibility, ownership list, and relationships for every repository. Circular
or protected runtime dependencies and multiple owners for the same artifact
class are rejected deterministically. Custom input may also choose from the
shipped AGENTS focus modules; built-in profiles retain the complete V1 set.

## Authoritative files and safe updates

`CONTROL_INDEX.json` uses schema `human-in-loop/control-index/v1`. It records
stable repository IDs, portable control-relative paths where possible, kinds,
visibility, redacted remote identities, artifact owners, relationships,
policies, and the exact SHA-256 hash of the generated AGENTS block. Unknown
schema versions and fields are not rewritten.

The extension owns only this marker-bounded portion of `AGENTS.md`:

```text
<!-- control-init:managed:start version=1 -->
...
<!-- control-init:managed:end -->
```

Existing bytes outside the markers are preserved. An existing AGENTS file with
no markers requires an explicit append choice. Manual changes inside the block
produce drift; update requires an explicit preserve, regenerate, or hand-merge
decision and never silently repairs it. Moving a repository or changing its
remote is handled through update with an explicit new path or accepted remote
identity. Adding a remote where the recorded identity was empty is also drift,
not an implicit acceptance. A new path is still checked against the previously
recorded remote, and doctor re-renders the canonical managed block to detect an
index edited without its corresponding AGENTS update. Removing a binding never
deletes its directory or Git data.

## Directory and Git safety

Every directory must be explicit. The extension does not scan the home folder
or infer a code/paper directory from its name. A missing path triggers at most
three similar candidates from the specified parent's direct children. A
candidate is never adopted automatically. If none is correct, the exact
canonical path must be approved before directory creation and local `git init`.

An existing non-Git directory can be initialized in place after confirmation;
all existing files remain byte-for-byte unchanged. Preview includes the exact
path and explains that `git init` creates no remote, commit, or push. Symlink
aliases, relative traversal above the workspace parent, duplicate/nested
bindings, invalid Git metadata, and paths that appear or change after preview
are rejected. Status, doctor, and update re-check persisted relative paths
before Git inspection, so an edited path cannot escape the workspace boundary
or cause an outside repository to be inspected. File persistence uses temporary
files, exclusive creation, a cross-process `.control-init.transaction.lock`,
post-write parsing/doctor checks, and cross-file rollback. The lock is removed
on normal success or failure. If the authoritative files were applied and
verified but lock cleanup alone fails, the result remains `applied` and carries
a recovery warning instead of falsely reporting that the write failed. After an
abrupt process termination, confirm that no control-init operation is running
before manually removing a leftover lock and rerunning doctor. Bootstrap rollback
removes only unchanged metadata or repositories created by the current
operation; externally changed content is preserved and reported.

## Generated Agent workflow and Human gates

The generated AGENTS block does not make the extension a task or Git executor.
The four extension operations never create a remote, commit, push, open a PR,
merge, release, or run product work. Instead, the durable rules distinguish two
human decisions:

- Approving a plan accepts only its text and does not start implementation.
- Explicitly assigning a task authorizes the Agent to complete that scoped task,
  verify it, make focused commits on a feature branch, push them, and open a PR
  after validation.

The generated rules treat a plan, plugin, or larger capability as multiple
reviewable delivery slices rather than one oversized PR. Before implementation,
planned tasks are mapped to PR slices with explicit dependencies and scoped
checks. A medium-sized plan normally targets five product PRs within a four-to-
six range; each PR normally carries three to eight focused commits and one
primary review concern. Verification is added incrementally, while the final
slice is reserved for integration, hardening, documentation, and end-to-end
evidence.

The PR is the automation boundary. New remotes, broader scope, destructive
operations, merge, and release still require an explicit human decision.
Multi-repository changes use separate commits and cross-reference the product
and control SHAs plus honest verification results.

## Compatibility and removal

Control-init was verified against
`@mariozechner/pi-coding-agent@0.73.1` on Node.js `>=20.6.0`. Other Pi versions
are unverified. Internal JSON and Markdown templates load relative to the
extension module and are included in the npm package; startup registration does
not read or write the user's workspace.

The extension has no daemon or database. Remove the installed package with the
same source used at installation, for example:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
```

Removing the package does not delete `CONTROL_INDEX.json`, the managed AGENTS
block, or any repository. Remove or revise those durable files manually only
after reviewing the workspace contract they preserve.
