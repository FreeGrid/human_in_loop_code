import { resolve } from "node:path";
import type { DeliveryImpact, DeliveryImpactInput } from "./delivery-impact.ts";

export type DeliveryInspector = (input: DeliveryImpactInput) => Promise<DeliveryImpact>;
export function renderDeliveryCheck(report: DeliveryImpact): string {
  return [
    "文档交付检查：以下是定位线索，不是同步通过或验证凭据。",
    `范围：${report.scope.changes.length} 个变化路径；上下文：当前工作树 ${report.contextHead.slice(0, 12)}`,
    ...report.candidates.map(c => `- 文档 ${c.path}：${c.reasons.join("；")}`),
    ...report.references.map(r => `- 引用 ${r.path}:${r.line} [${r.term}] ${r.snippet}`),
    ...report.unresolved.map(q => `- 待查：${q}`),
    "按需读取相关 diff 和上述位置，更新过时说明；空候选或文档已修改都不证明语义正确。结果不写入 Plan。",
  ].join("\n");
}

/** Optional session-local reminders, never authority, acceptance or a persistent task ledger. */
export class DeliveryChecks {
  private watches = new Map<string, DeliveryImpactInput>();
  constructor(private inspect: DeliveryInspector = async input => (await import("./delivery-impact.ts")).inspectDocumentationImpact(input)) {}
  clear() { this.watches.clear(); }
  async check(input: DeliveryImpactInput): Promise<string> { return renderDeliveryCheck(await this.inspect(structuredClone(input))); }
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
