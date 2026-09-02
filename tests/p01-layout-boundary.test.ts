import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const exists = (relativePath: string) => fs.existsSync(path.join(repoRoot, relativePath));

const activeBoundaries = [
  "extensions/research-harness/package.json",
  "extensions/research-harness/src/index.ts",
  "packages/controller-core/package.json",
  "packages/controller-core/src/index.ts",
  "packages/controller-client/package.json",
  "packages/controller-client/src/index.ts",
  "packages/config/package.json",
  "packages/config/src/index.ts",
  "packages/prompt-runtime/package.json",
  "packages/prompt-runtime/src/index.ts",
  "packages/schemas/package.json",
  "packages/schemas/src/index.ts",
  "templates/research-three-repo/.gitkeep",
];

const frozenScaffolds = [
  "apps/researchctl/package.json",
  "apps/researchd/package.json",
  "packages/doctor/package.json",
  "packages/release-manifest/package.json",
  "templates/harness-product/.gitkeep",
];

const activeSourceGlobs = [
  "extensions/research-harness/src/index.ts",
  "packages/controller-core/src/index.ts",
  "packages/controller-client/src/index.ts",
  "packages/config/src/index.ts",
  "packages/prompt-runtime/src/index.ts",
  "packages/schemas/src/index.ts",
];

describe("P01 active/frozen product layout", () => {
  test("keeps upstream collaboration plane and creates active research product boundaries", () => {
    expect(exists("extensions/collaborating-agents/index.ts")).toBe(true);
    expect(exists("skills/collaborating-agents-system/SKILL.md")).toBe(true);
    expect(exists("examples/subagents/worker.toml")).toBe(true);

    for (const boundary of activeBoundaries) {
      expect(exists(boundary), boundary).toBe(true);
    }
  });

  test("keeps P09-gated CLI, daemon, dual-repo doctor, release and harness-product scaffolds dormant", () => {
    for (const scaffold of frozenScaffolds) {
      expect(exists(scaffold), scaffold).toBe(true);
    }

    for (const source of activeSourceGlobs) {
      const text = read(source);
      expect(text).not.toContain("researchctl");
      expect(text).not.toContain("researchd");
      expect(text).not.toContain("@human-in-loop-harness/doctor");
      expect(text).not.toContain("@human-in-loop-harness/release-manifest");
      expect(text).not.toContain("human_in_loop_control");
    }
  });

  test("publishing allowlist includes active product paths but excludes dormant scaffolds and control/HCP paths", () => {
    const manifest = JSON.parse(read("package.json")) as { files: string[]; pi: { extensions: string[] } };

    expect(manifest.files).toContain("extensions/collaborating-agents/**/*");
    expect(manifest.files).toContain("extensions/research-harness/**/*");
    expect(manifest.files).toContain("packages/controller-core/**/*");
    expect(manifest.files).toContain("packages/prompt-runtime/**/*");
    expect(manifest.files).toContain("templates/research-three-repo/**/*");

    expect(manifest.files.some((entry) => entry.startsWith("apps/"))).toBe(false);
    expect(manifest.files.some((entry) => entry.includes("doctor"))).toBe(false);
    expect(manifest.files.some((entry) => entry.includes("release-manifest"))).toBe(false);
    expect(manifest.files.some((entry) => entry.includes("harness-product"))).toBe(false);
    expect(manifest.files.some((entry) => entry.includes("human_in_loop_control"))).toBe(false);

    expect(manifest.pi.extensions).toEqual(["./extensions/collaborating-agents/index.ts"]);
  });
});
