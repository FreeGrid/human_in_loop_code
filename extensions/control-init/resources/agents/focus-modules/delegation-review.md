### Subagent delegation, continuity and independent review

- Delegate bounded work when specialization, parallelism, context isolation or
  independent review can improve quality or save time. Handle small, local tasks
  directly when coordination would cost more than it helps.
- Give each subagent a clear goal, relevant context, write scope and expected
  result. Delegation stays within the user's authorized task and repository
  boundaries; briefly explain useful divisions of work without a fixed ceremony.
- Run independent tasks in parallel when dependencies are satisfied and write
  scopes do not conflict. Agree on shared interfaces first and serialize
  overlapping changes. Continue useful local work while agents run.
- Continue with a familiar agent for related work while its context and scope
  remain suitable. Clarifications, corrections and follow-ups do not require
  prior task acceptance. Use the backend's actual continuation or recovery
  mechanism rather than pretending a new session is the old one.
- Prefer continuing with the same agent for related work. First address gaps
  or mistakes with additional context or corrective instructions. Start a fresh
  session when the agent repeatedly misses key requirements, persists in an
  incorrect assumption after correction, or the new task no longer fits its
  context. On an actual handoff, provide only what is needed to continue.
- Begin independent review in a fresh session without the implementer's
  transcript. The reviewer must not implement the changes it adjudicates, but
  may continue reviewing fixes to its findings while remaining independent.
- Ask subagents for concise conclusions and necessary evidence, noting file
  changes or unresolved issues when applicable. Ordinary tasks do not require
  separate logs, workstream identifiers or handoff documents.
- The controller integrates results and checks them against the task's
  acceptance criteria. A subagent's success report is not acceptance by itself;
  retain any explicitly assigned Human or independent acceptance authority.
