import { resolve } from "node:path";
import type { DeliveryImpact, DeliveryImpactInput } from "./delivery-impact.ts";

export type DeliveryInspector = (input: DeliveryImpactInput) => Promise<DeliveryImpact>;
export function renderDeliveryCheck(report: DeliveryImpact, repeated = false): string {
  const output = [
    "文档交付检查：以下是定位线索，不是同步通过或验证凭据。",
    ...(repeated ? ["已读取的检查输入未变：复用定位线索，省略重复引用片段；待查问题不会自动关闭。"] : []),
    `范围：${report.scope.changes.length} 个变化路径；上下文：当前工作树 ${report.contextHead.slice(0, 12)}`,
    ...report.scope.ranges.map((r, i) => `- 范围 ${i + 1}${r.label ? ` (${r.label})` : ""}：${r.comparisonBase.slice(0, 12)}..${r.head.slice(0, 12)} [${r.mode}]`),
    ...(report.scope.localPaths.length ? [`- 相关本地路径：${report.scope.localPaths.join(", ")}`] : []),
    ...report.candidates.map(c => `- 文档 ${c.path}：${c.reasons.join("；")}`),
    ...(repeated ? [] : report.references.map(r => `- 引用 ${r.path}:${r.line} [${r.term}] ${r.snippet}`)),
    ...report.unresolved.map(q => `- 待查：${q}`),
    "按需读取相关 diff 和上述位置，更新过时说明；空候选或文档已修改都不证明语义正确。结果不写入 Plan。",
  ].join("\n");
  return output.length <= 24000 ? output : output.slice(0, 23500) + "\n输出预算已用尽：部分定位信息未展示，缩小范围继续检查；这不是文档同步通过。";
}

/** Optional session-local reminders, never authority, acceptance or a persistent task ledger. */
export class DeliveryChecks {
  private watches = new Map<string, DeliveryImpactInput>();
  private versions = new Map<string, string>();
  private generation = 0;
  constructor(private inspect: DeliveryInspector = async input => (await import("./delivery-impact.ts")).inspectDocumentationImpact(input)) {}
  clear() { this.generation++; this.watches.clear(); this.versions.clear(); }
  async check(input: DeliveryImpactInput): Promise<string> {
    input = structuredClone(input);
    const generation = this.generation, key = JSON.stringify(input);
    // Reinspect content and discovery domains even on a cache hit: this saves
    // model context, not filesystem correctness checks or unresolved obligations.
    const report = await this.inspect(input);
    if (generation !== this.generation) throw new Error("Documentation session changed during inspection");
    const limited = report.unresolved.some(q => /limit|not searched|omitted/i.test(q));
    const repeated = !limited && this.versions.get(key) === report.version;
    this.versions.delete(key);
    if (!limited) this.versions.set(key, report.version);
    while (this.versions.size > 16) this.versions.delete(this.versions.keys().next().value!);
    return renderDeliveryCheck(report, repeated);
  }
  watch(planPath: string, taskId: string, input: DeliveryImpactInput) {
    if (!/^T\d{3,}$/.test(taskId)) throw new Error("Invalid task ID");
    const key = this.key(planPath, taskId);
    if (!this.watches.has(key) && this.watches.size >= 8) throw new Error("At most eight task watches per session");
    this.watches.set(key, structuredClone(input));
  }
  unwatch(planPath: string, taskId: string) { this.watches.delete(this.key(planPath, taskId)); }
  async beforeCompletion(planPath: string, taskId: string): Promise<string> {
    const input = this.watches.get(this.key(planPath, taskId));
    if (!input) return "";
    try { return await this.check(input); }
    catch (error) { return `文档检查未完成：${error instanceof Error ? error.message : String(error)}。普通工作可继续；本次勾选不代表文档已同步。修正范围后重新检查。`; }
  }
  private key(path: string, task: string) { return JSON.stringify([resolve(path), task]); }
}
