### Delegation backend: host-native

- Preserve the current host's native subagent mechanism: Pi uses its
  collaborating-agents tools, Codex uses its own subagent tools, and Claude uses
  its own subagent and task mechanisms. Follow the available tool schemas;
  read the installed `collaborating-agents-system` skill when operating Pi's
  collaboration tools. Pi-specific instructions apply only in Pi.
- Keep each child under the backend that created it for follow-ups and result
  collection. If required tools are unavailable, report the limitation rather
  than guessing tool names or automatically switching to Herdr.
- The shared delegation, continuity and independent-review rules above apply
  to every host, including continued review of fixes by the same independent
  reviewer. Tool availability alone does not authorize work.
