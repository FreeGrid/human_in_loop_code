# 旧 DocSync 的事实与候选层（进阶技术参考）

新项目默认阅读 [中文交付检查指南](delivery.md)。本页保留旧阶段生命周期的英文接口参考，描述 baseline、区域身份和候选义务，不代表当前轻量助手已经实现强制门禁。旧决策、欠账处置与受限 Maintainer 仍是未完成能力；不能把候选 ready 当作正式接受。区域标记只在明确选用它的校验层必需，普通全文档目标无需标记。

## Legacy API reference

For ordinary V3/Codex work, see [lightweight delivery checks](delivery.md).
That optional read-only helper uses explicit PR/commit ranges and related local
selection without this legacy phase baseline or completion gate. The legacy
decision/debt policy and restricted Maintainer described below remain separate
unfinished work; the lightweight helper does not claim to implement them.

A task summary can miss a file, and a commit is not the beginning of a new phase.
DocSync therefore compares the **original phase content** with the final worktree.
Existing dirty/untracked files that did not change are not claimed as new work;
restoring previously dirty content, staging, committing, deleting and renaming all
retain the original comparison point. Clean tracked content reuses Git blob IDs.

Dependency knowledge then makes those changes actionable: a source can affect a
whole document or an explicitly marked region. Uncovered or ambiguously classified
code remains a question, not an exemption. A separate README narrative candidate
asks whether the explanation of value, capability relationships and entrypoints
needs updating; a touched README does not answer that question by itself.

**This is the facts/candidate layer, not the completion gate.** Candidates have
`resolution: pending`. The decision/debt policy and restricted Maintainer writer
are not implemented here. The default phase extension uses a real Git baseline,
but DocSync **on still blocks finalize without a gate**, including when this API
returns no candidates. Human off skips that gate, not baseline or Task verification.

## Configure the two roots

The target is an explicit Git worktree root. The governance root contains the Plan
and `.harness/docsync.yml`; it may be the same directory or a separate repository.
All source and document paths in YAML are relative to the **target**, not governance.
No particular private control repository is a runtime dependency.

Commit the following kind of dependency knowledge in the governance repository:

```yaml
version: 1
concepts:
  public_api:
    sources: ["src/api/**"]
    docs: ["docs/api.md", { path: "README.md", section_id: "api" }]
hard_rules:
  - id: cli_contract
    sources: ["src/cli/**"]
    docs: ["docs/cli.md"]
    user_visible: true
readme: README.md
classification:
  code: ["src/**", "package.json"]
  tests: ["tests/**"]
  docs: ["docs/**", "README.md"]
```

`concepts` and `hard_rules` are required (empty mappings/lists are allowed).
Each declared concept/rule needs non-empty `sources` and `docs`; a hard rule
cannot hide an obligation in an empty target list. Rule IDs must be unique.
`user_visible` defaults false, `readme` defaults `README.md`, and classification
lists default empty. No classification match or conflicting classes means
**unknown impact**, not "test-only". Supply disjoint classifications where possible.

A hard rule keeps the matched document obligation hard. A user-visible rule also
proposes narrative work; README is not automatically hard merely because a different
document is hard. An explicitly targeted README hard rule retains that obligation.
This layer never changes the YAML associations automatically.

Patterns support literal paths, segment-local `*`/`?`, and a whole-segment `**`
matching zero or more segments. They are case-sensitive, include dotfiles and do
not execute regular expressions. Negation, braces, character classes and extglob
are unsupported. Document paths are literal targets, not glob expansion requests.
Absolute/parent-traversing paths, Git-internal paths, unsupported path characters
and symlink ancestors/targets are rejected, including for not-yet-existing files.

The parser is an explicit pinned `yaml` runtime dependency. Checkout installs use
`npm ci` with the committed `.npmrc` (`legacy-peer-deps=true`), matching the
runtime-only lock. Pi supplies the existing host peers; this profile deliberately
does not install or upgrade a second Pi host. Copy the `.npmrc` with the manifests
when reproducing the checkout install, or explicitly use `--legacy-peer-deps`.
A standalone embedder must supply and verify its own compatible host peers.

The policy limit is
256 KiB UTF-8, container depth 16 and 1,024 source/classification matching entries.
Duplicate/unknown fields, custom tags, anchors/aliases, merge keys, multiple YAML
documents and unsupported versions fail validation. Missing/invalid policy is a
versioned policy error: it does **not by itself** prevent capturing a trustworthy
Git baseline or accepting Human off. Actual IO, path safety and baseline-integrity
errors still block. Oversized or otherwise unreadable inputs are not ignored.

## Explicit regions

A section target needs both exact markers:

```markdown
<!-- docsync:section:api:start -->
Explain this capability in the surrounding document's narrative.
<!-- docsync:section:api:end -->
```

Section identity covers only the region between markers, normalizing CRLF to LF;
the whole file retains a separate raw-byte version for freshness. A change outside
the region is not region-update evidence. Missing, duplicate, crossed, nested or
malformed boundaries are errors, never a silent whole-file fallback. Whole-file
identities hash raw bytes and support binary files. Neither identity proves semantic
quality; README narrative disposition and Human acceptance remain later obligations.

## Read-only API and identity binding

Normally `/plan:execute` creates the baseline once. An embedding application can
inspect the **recorded** context/reference rather than capture a replacement:

```ts
import { GitBaselineProvider, collectCandidates } from "./extensions/task-plan/legacy-index.ts";

const facts = await new GitBaselineProvider().inspect(record.context, record.baseline);
const result = await collectCandidates(record.context, record.baseline, currentPhaseNotes);
// result.status: "ready" (facts available) or "blocked" (explicit errors).
// "ready" is NOT a DocSyncGateResult and must never directly complete a phase.
```

`buildCandidates(facts, notes)` is the pure constructor. Returned candidates retain
stable target/kind IDs, separate evidence IDs, trigger reasons, urgency and document
before/after identities. Normal and narrative candidates remain distinct. Multiple
matches merge without lowering hard priority. Uncovered paths retain an association
question; no file, association or debt is written by candidate construction.

Evidence is bound to execution, baseline, content and configuration versions, and
actual bounded notes. Changing change types can produce new narrative obligations
without changing code; the separate notes binding prevents stale candidate reuse
without making every progress report invalidate baseline/Acceptance versions.
Facts are rechecked before returning from `collectCandidates`; a future gate must
recheck again before accepting/writing against them.

## Runtime, recovery and supported profile

Per-execution `baseline.json` lives under the canonical directory returned by
`git rev-parse --git-path docsync`, including linked-worktree Git directories.
A separate Git metadata directory inside the target worktree but outside its
standard `.git` namespace is unsupported, even when ignored by Git. Both per-worktree
and common Git directories are checked before document reads or runtime creation,
so Git internals cannot become document targets or source changes. Ordinary `.git`,
external separate Git directories and linked worktrees remain supported.

It is uncommitted runtime data, not a second Task checklist or a saved full diff.
The execution directory is an exclusive claim; publication is atomic and does not
replace an existing baseline. A partial claim, missing file, corrupt envelope,
foreign reference or moved binding blocks recovery. Preserve the original artifacts;
restore the matching baseline/rules or explicitly resolve the failed execution.
Deleting a claim and recapturing to make prior work disappear is not recovery.

The supported profile covers Git SHA-1/SHA-256 repositories with an existing HEAD,
regular/binary files, executable modes, conservative delete/add renames, and
verified internal LF/CRLF normalization. A symlink can be a Git link-change fact;
it is not followed to read a document. Submodules, unmerged indices, sparse/skip-
worktree/assume-unchanged modes and stat settings that hide changes are rejected.
External filters, encoding transforms and ident expansion are not executed.
External diff, textconv and fsmonitor helpers are disabled/not invoked. Lazy
promisor fetching and all Git transport protocols are disabled for every query;
missing objects fail without running remote/SSH/credential helpers.

Effective Git normalization configuration and attributes are checked, including
external attributes files. Rule drift deliberately blocks rather than interpreting
old evidence under new rules. Restore the original rules; do not reset the baseline.
The implementation requires Git's `GIT_ATTR_SYSTEM`/`GIT_ATTR_GLOBAL` variables and
absolute Git-path support; older unsupported Git fails visibly. Validation targets
Apple Git **2.50.1**, Node **25.9.0**, macOS; other platforms require verification.

Content reads and Git output are bounded at 32 MiB; a baseline envelope is bounded
at 16 MiB, with at most 100,000 exceptions and 2,048 captured document targets.
Metadata/path enumeration is not a promise to avoid Git's own metadata work, but
unrelated clean tracked files are not explicitly re-hashed by the provider. Unknown
new document starts (especially dirty/untracked content or ambiguous checkout
normalization) remain errors instead of invented before-images.

Only the exact Plan uses strict execution-record/checkbox normalization, plus the
valid executing/in-progress and completed-round/awaiting-Human lifecycle pairs.
Other frontmatter, approval hashes and invalid lifecycle pairs remain content. The
current phase's exact untracked, empty, regular mode-0600 finalize sidecar is
recognized as coordination metadata; other lock-looking files, meaningful content
and tracked files are not generally ignored. The Plan has a separate CAS, and its
approved definitions remain protected. Before/after identity and content checks are
cooperative race detection, not an OS sandbox or a multi-file transaction. Keep
non-cooperating editors out of the final publication window.
