import { lstat, mkdir, rename, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArtifact, updateArtifactStatus } from "./frontmatter.js";
import {
  assertPathWithin,
  atomicWriteText,
  createWorkId,
  getPlanningPaths,
  isNotFound,
  readTextInside,
  type PlanningPaths,
} from "./paths.js";
import type { ActiveWork, ArtifactStatus, PlanningStage, ValidationIssue } from "./types.js";

export type DetectedStage = PlanningStage | "preparing-plan" | "preparing-tasks" | "completed" | "invalid";

export interface ArtifactSnapshot {
  path: string;
  exists: boolean;
  status?: ArtifactStatus;
  content?: string;
  error?: string;
}

export interface WorkInspection {
  stage: DetectedStage;
  spec: ArtifactSnapshot;
  plan: ArtifactSnapshot;
  tasks: ArtifactSnapshot;
  issues: ValidationIssue[];
}

type SpecFactory = (work: ActiveWork) => string;

export class WorkspaceService {
  readonly paths: PlanningPaths;

  constructor(readonly cwd: string) {
    this.paths = getPlanningPaths(cwd);
  }

  private workFromId(id: string, directory = join(this.paths.activeRoot, id)): ActiveWork {
    return {
      id,
      directory,
      specPath: join(directory, "spec.md"),
      planPath: join(directory, "plan.md"),
      tasksPath: join(directory, "tasks.md"),
    };
  }

  private async ensureRoots(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true });
    await assertPathWithin(this.paths.root, this.paths.activeRoot);
    await assertPathWithin(this.paths.root, this.paths.completedRoot);
    await mkdir(this.paths.activeRoot, { recursive: true });
    await mkdir(this.paths.completedRoot, { recursive: true });
  }

  async createWork(goal: string, specFactory: SpecFactory, now = new Date()): Promise<ActiveWork> {
    if (!goal.trim()) throw new Error("Cannot create planning work from an empty goal");
    await this.ensureRoots();

    try {
      await lstat(this.paths.currentPointer);
      throw new Error(`Active work already exists: ${this.paths.currentPointer}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const work = this.workFromId(createWorkId(goal, now));
    await assertPathWithin(this.paths.root, work.directory);
    let directoryCreated = false;
    let pointerCreated = false;
    try {
      await mkdir(work.directory);
      directoryCreated = true;
      await atomicWriteText(this.paths.root, work.specPath, specFactory(work), { overwrite: false });
      await atomicWriteText(this.paths.root, this.paths.currentPointer, `${work.id}\n`, { overwrite: false });
      pointerCreated = true;
      return work;
    } catch (error) {
      if (pointerCreated) await unlink(this.paths.currentPointer).catch(() => undefined);
      if (directoryCreated) await rm(work.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async getActiveWork(): Promise<ActiveWork | null> {
    await assertPathWithin(this.paths.root, this.paths.currentPointer);
    let pointer: string;
    try {
      pointer = await readTextInside(this.paths.root, this.paths.currentPointer);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    const id = pointer.trim();
    if (pointer !== id && pointer !== `${id}\n` && pointer !== `${id}\r\n`) {
      throw new Error(`Invalid active work pointer format: ${this.paths.currentPointer}`);
    }
    if (!/^W-\d{8}-\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`Invalid work ID in ${this.paths.currentPointer}: ${id || "<empty>"}`);
    }

    const work = this.workFromId(id);
    await assertPathWithin(this.paths.root, work.directory);
    let stats;
    try {
      stats = await lstat(work.directory);
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`Active work directory does not exist: ${work.directory}`);
      }
      throw error;
    }
    if (!stats.isDirectory()) throw new Error(`Active work path is not a directory: ${work.directory}`);
    return work;
  }

  async readArtifact(path: string): Promise<string> {
    return readTextInside(this.paths.root, path);
  }

  async writeArtifact(path: string, content: string, overwrite = true): Promise<void> {
    await atomicWriteText(this.paths.root, path, content, { overwrite });
  }

  async updateStatus(path: string, status: ArtifactStatus): Promise<void> {
    const current = await this.readArtifact(path);
    await this.writeArtifact(path, updateArtifactStatus(current, status));
  }

  async approveAndCreateNext(currentPath: string, nextPath: string, nextContent: string): Promise<void> {
    await this.writeArtifact(nextPath, nextContent, false);
    try {
      await this.updateStatus(currentPath, "approved");
    } catch (error) {
      await unlink(nextPath).catch(() => undefined);
      throw error;
    }
  }

  async completeWork(work: ActiveWork): Promise<ActiveWork> {
    await this.ensureRoots();
    const destination = join(this.paths.completedRoot, work.id);
    await assertPathWithin(this.paths.root, destination);
    try {
      await lstat(destination);
      throw new Error(`Completed work already exists: ${destination}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const active = await this.getActiveWork();
    if (!active || active.id !== work.id) {
      throw new Error(`Current pointer does not identify ${work.id}: ${this.paths.currentPointer}`);
    }

    await rename(work.directory, destination);
    try {
      await unlink(this.paths.currentPointer);
    } catch (error) {
      try {
        await rename(destination, work.directory);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Failed to clear current pointer and roll back ${work.id}`);
      }
      throw error;
    }
    return this.workFromId(work.id, destination);
  }

  async approveTasksAndComplete(work: ActiveWork): Promise<ActiveWork> {
    const original = await this.readArtifact(work.tasksPath);
    await this.writeArtifact(work.tasksPath, updateArtifactStatus(original, "approved"));
    try {
      return await this.completeWork(work);
    } catch (error) {
      try {
        await this.writeArtifact(work.tasksPath, original);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Failed to complete and roll back ${work.id}`);
      }
      throw error;
    }
  }

  private async snapshot(path: string, expectedStage: PlanningStage, workId: string): Promise<ArtifactSnapshot> {
    let content: string;
    try {
      content = await this.readArtifact(path);
    } catch (error) {
      if (isNotFound(error)) return { path, exists: false };
      return { path, exists: true, error: errorMessage(error) };
    }

    try {
      const parsed = parseArtifact(content);
      if (parsed.metadata.work_id !== workId) {
        return { path, exists: true, content, error: `work_id does not match ${workId}` };
      }
      if (parsed.metadata.stage !== expectedStage) {
        return { path, exists: true, content, error: `stage must be ${expectedStage}` };
      }
      return { path, exists: true, content, status: parsed.metadata.status };
    } catch (error) {
      return { path, exists: true, content, error: errorMessage(error) };
    }
  }

  async inspect(work: ActiveWork): Promise<WorkInspection> {
    const [spec, plan, tasks] = await Promise.all([
      this.snapshot(work.specPath, "spec", work.id),
      this.snapshot(work.planPath, "plan", work.id),
      this.snapshot(work.tasksPath, "tasks", work.id),
    ]);
    const issues: ValidationIssue[] = [];
    for (const artifact of [spec, plan, tasks]) {
      if (artifact.error) {
        issues.push({ severity: "error", code: "artifact_metadata", message: artifact.error, path: artifact.path });
      }
    }
    if (!spec.exists) {
      issues.push({ severity: "error", code: "missing_spec", message: "spec.md is missing", path: spec.path });
    }
    if (plan.exists && spec.status !== "approved") {
      issues.push({ severity: "error", code: "plan_before_spec_approval", message: "plan.md exists before spec approval", path: plan.path });
    }
    if (tasks.exists && (!plan.exists || plan.status !== "approved")) {
      issues.push({ severity: "error", code: "tasks_before_plan_approval", message: "tasks.md exists before plan approval", path: tasks.path });
    }

    let stage: DetectedStage = "invalid";
    if (issues.length === 0) {
      if (spec.status === "draft") stage = "spec";
      else if (spec.status === "approved" && !plan.exists) stage = "preparing-plan";
      else if (plan.status === "draft") stage = "plan";
      else if (plan.status === "approved" && !tasks.exists) stage = "preparing-tasks";
      else if (tasks.status === "draft") stage = "tasks";
      else if (tasks.status === "approved") stage = "completed";
    }
    return { stage, spec, plan, tasks, issues };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function artifactPathForStage(work: ActiveWork, stage: PlanningStage): string {
  if (stage === "spec") return work.specPath;
  if (stage === "plan") return work.planPath;
  return work.tasksPath;
}

export function displayPath(cwd: string, path: string): string {
  const name = basename(cwd);
  const marker = `${name}/`;
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path;
}
