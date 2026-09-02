import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const exists = (relativePath: string) => fs.existsSync(path.join(repoRoot, relativePath));

const forbiddenCommandPatterns = [
  /\bnpm\s+link\b/,
  /\bbun\s+link\b/,
  /\bresearchd\b/,
  /\bresearchctl\b/,
  /\bdaemon\b/,
  /\bnohup\b/,
  /\bpi\b/,
  /human_in_loop_control/,
  /HCP/,
];

describe("P01 code development command contract", () => {
  test("exposes deterministic code-local scripts without global links or background services", () => {
    const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

    expect(packageJson.scripts["install:frozen"]).toBe(
      "BUN_INSTALL_CACHE_DIR=.harness-tmp/bun-install-cache bun install --frozen-lockfile",
    );
    expect(packageJson.scripts.build).toBe("bun run typecheck");
    expect(packageJson.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");
    expect(packageJson.scripts.test).toBe("bun test");
    expect(packageJson.scripts["package:dry-run"]).toBe("npm_config_cache=.harness-tmp/npm-cache npm pack --dry-run");
    expect(packageJson.scripts.clean).toBe("bun ./scripts/clean.ts");
    expect(packageJson.scripts["verify:code"]).toBe("bun run build && bun run test && bun run package:dry-run");
    expect(packageJson.scripts["install:frozen"]).toContain(".harness-tmp/bun-install-cache");
    expect(packageJson.scripts["package:dry-run"]).toContain(".harness-tmp/npm-cache");

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      for (const forbidden of forbiddenCommandPatterns) {
        expect(command, `${name} must not contain ${forbidden}`).not.toMatch(forbidden);
      }
      expect(command, `${name} must not background work`).not.toMatch(/(^|[^&])&($|[^&])/);
    }
  });

  test("documents clean rules and structured result convention", () => {
    const docs = read("docs/development-commands.md");
    expect(docs).toContain("bun run install:frozen");
    expect(docs).toContain("bun run verify:code");
    expect(docs).toContain(".harness-tmp/bun-install-cache/");
    expect(docs).toContain(".harness-tmp/npm-cache/");
    expect(docs).toContain("artifacts/dev-command-results/");
    expect(docs).toContain("must not create HCP");
    expect(docs).not.toContain("human_in_loop_control/../");
  });

  test("clean removes only declared repository-local generated paths", () => {
    const tempRoot = path.join(repoRoot, ".harness-tmp", "p01-clean-test");
    const artifactRoot = path.join(repoRoot, "artifacts", "tmp", "p01-clean-test");
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "marker.txt"), "temporary");
    fs.writeFileSync(path.join(artifactRoot, "marker.txt"), "temporary");

    const result = spawnSync("bun", ["run", "clean"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"command": "clean"');
    expect(exists(".harness-tmp/p01-clean-test/marker.txt")).toBe(false);
    expect(exists("artifacts/tmp/p01-clean-test/marker.txt")).toBe(false);
    expect(exists("artifacts")).toBe(false);
    expect(exists("package.json")).toBe(true);
    expect(exists("extensions/collaborating-agents/index.ts")).toBe(true);
    expect(exists("templates/research-three-repo/.gitkeep")).toBe(true);
  });
});
