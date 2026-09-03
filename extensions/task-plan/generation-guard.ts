import { isAbsolute, resolve } from "node:path";
import { assertPathWithin, canonicalPath } from "./paths.js";
import type { GenerationOperation } from "./types.js";

export interface GenerationGuardState {
  targetPath: string;
  canonicalTargetPath: string;
  operation: GenerationOperation;
}

export interface GuardBlock {
  block: true;
  reason: string;
}

export class GenerationGuard {
  private state: GenerationGuardState | null = null;

  constructor(private readonly planningRoot: string) {}

  get active(): boolean {
    return this.state !== null;
  }

  get current(): Readonly<GenerationGuardState> | null {
    return this.state;
  }

  async activate(targetPath: string, operation: GenerationOperation): Promise<void> {
    if (this.state) throw new Error(`Planning generation guard is already active for ${this.state.targetPath}`);
    const safeTarget = await assertPathWithin(this.planningRoot, targetPath);
    this.state = {
      targetPath: safeTarget,
      canonicalTargetPath: await canonicalPath(safeTarget),
      operation,
    };
  }

  clear(): void {
    this.state = null;
  }

  async check(toolName: string, input: Record<string, unknown>, cwd: string): Promise<GuardBlock | undefined> {
    const state = this.state;
    if (!state) return undefined;
    if (toolName === "bash") return this.blockMessage(state);
    if (toolName !== "write" && toolName !== "edit") return undefined;

    const requested = input.path;
    if (typeof requested !== "string" || requested.trim() === "") {
      return { block: true, reason: `Planning operation is active. ${toolName} requires a valid path. Target: ${state.targetPath}` };
    }

    const requestedPath = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
    try {
      const safeRequested = await assertPathWithin(this.planningRoot, requestedPath);
      if ((await canonicalPath(safeRequested)) === state.canonicalTargetPath) return undefined;
    } catch {
      return this.blockMessage(state);
    }
    return this.blockMessage(state);
  }

  private blockMessage(state: GenerationGuardState): GuardBlock {
    return {
      block: true,
      reason: [
        "Planning operation is active.",
        "Only the current planning artifact may be modified.",
        `Target: ${state.targetPath}`,
      ].join(" "),
    };
  }
}
