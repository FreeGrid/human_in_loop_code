### Delegation backend: Herdr

- Use Herdr for all subagent orchestration in this repository, regardless of
  whether the controller or child runs Pi, Codex, Claude or another host. Do not
  mix in the hosts' native subagent orchestration tools.
- When Herdr operations are needed, read and follow the installed `herdr` skill
  for prerequisites, commands and lifecycle handling. If the skill is unavailable,
  report the missing prerequisite instead of guessing commands or switching backends.
- The shared delegation, continuity and independent-review rules above still
  apply. Include this backend choice and the relevant control rules in child task
  packets so children use the same mechanism.
