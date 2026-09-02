SHELL := /usr/bin/env bash

.PHONY: doctor verify-upstream-compat

doctor:
	@set -euo pipefail; \
	test -f package.json; \
	test -f LICENSE; \
	test -f FORK_BASELINE.toml; \
	test -f UPSTREAM.md; \
	test -d extensions/collaborating-agents; \
	test -d skills/collaborating-agents-system; \
	python3 -c 'import json, pathlib, subprocess, tomllib; root=pathlib.Path("."); pkg=json.load(open(root/"package.json", encoding="utf-8")); baseline=tomllib.load(open(root/"FORK_BASELINE.toml", "rb")); assert pkg["name"] == baseline["package_name"], (pkg["name"], baseline["package_name"]); assert pkg["version"] == baseline["package_version"], (pkg["version"], baseline["package_version"]); assert pkg["license"] == baseline["license"], (pkg["license"], baseline["license"]); base=baseline["baseline_commit"]; subprocess.check_call(["git", "merge-base", "--is-ancestor", base, "HEAD"]); remotes=subprocess.check_output(["git", "remote", "-v"], text=True); assert "origin" in remotes, remotes; assert "upstream" in remotes, remotes; head=subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(); print("doctor ok:", pkg["name"], pkg["version"], "head", head[:12])'

verify-upstream-compat:
	@set -euo pipefail; \
	bun test extensions/collaborating-agents/docs.test.ts; \
	bun test extensions/collaborating-agents/index.test.ts; \
	bun test extensions/collaborating-agents/subagent-spawn.test.ts; \
	bun test extensions/collaborating-agents/session-tail.test.ts; \
	npm_config_cache=.harness-tmp/npm-cache npm pack --dry-run
