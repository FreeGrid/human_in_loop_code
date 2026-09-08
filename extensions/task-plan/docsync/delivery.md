# Lightweight delivery checks

Ordinary documentation work follows AGENTS.md: update existing explanations as
user-visible behavior stabilizes, and check related changes before delivery.
The optional helper below supplies review context, not semantic certification.
It does not need a Plan, phase baseline, Harness journal or GitHub connection.

## Select related changes

`inspectDeliveryScope` in `delivery-scope.ts` accepts an explicit repository root
and up to eight `{base, head, mode?, label?}` ranges. Resolve PR metadata using
your existing host/GitHub tools and fetch required commits explicitly. Labels
are navigation only; the returned immutable Git OIDs define the comparison.

- `endpoints` compares the specified commits; `merge-base` uses their unique
  common ancestor. Missing or ambiguous bases are errors.
- A stacked PR uses its own parent/base. A combined delivery can include several
  ranges to retain origin labels, plus a net endpoint comparison when evaluating
  final behavior. Overlapping paths are returned once with all range origins.
- Optional `paths` selects exact committed filenames; it is not a glob. Without
  it, include all changed paths in the chosen ranges.
- `localPaths` names only related local files to compare with current HEAD,
  including staged/unstaged, deleted, untracked or explicitly named ignored files.
  Unrelated dirty files are not adopted. Local comparison uses raw bytes and
  executable mode, so normalization-only differences may need Human/model judgment.

The helper returns filenames before requesting detailed context. It reads no
full patches, invokes no repository filter programs and writes no files. It
limits selections to 128 paths each and results to 512 changed paths; narrow an
oversized range rather than treating omitted content as checked. Git queries
and reads retain the existing safety/output bounds. Symlink targets and embedded
alternate Git metadata are not read. Collection detects observed concurrent
changes but is not an OS transaction.
