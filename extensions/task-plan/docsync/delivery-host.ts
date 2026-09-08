import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { DeliveryChecks } from "./delivery-session.ts";

const strings = (maxItems: number) => Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems });
const watch = Type.Object({ plan_path: Type.String(), task_id: Type.String({ pattern: "^T[0-9]{3,}$" }) }, { additionalProperties: false });
export function registerDeliveryChecks(pi: ExtensionAPI): DeliveryChecks {
  const checks = new DeliveryChecks();
  const response = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: { advisory: true }, ...(isError ? { isError } : {}) });
  pi.registerTool({ name: "docsync_check", label: "检查相关文档影响", description: "Optional read-only delivery check. Supply actual PR base/head or explicit commit ranges, related localPaths, small mappings and literal names/domains to locate dependencies. Inspect relevant snippets with ordinary tools next. No full diff, semantic certification or Plan writes. Optional watch binds this scope to one Plan task's status-tool completion reminder; use only when the user selects this helper. Missing Git data requires explicit retrieval by existing host tools, never automatic fetch.",
    parameters: Type.Object({ root: Type.String(), ranges: Type.Array(Type.Object({ base: Type.String(), head: Type.String(), mode: Type.Optional(Type.Union([Type.Literal("endpoints"), Type.Literal("merge-base")])), label: Type.Optional(Type.String()) }, { additionalProperties: false }), { maxItems: 8 }), paths: Type.Optional(strings(128)), localPaths: Type.Optional(strings(128)), mappings: Type.Optional(Type.Array(Type.Object({ sources: strings(64), docs: strings(64) }, { additionalProperties: false }), { maxItems: 64 })), terms: Type.Optional(strings(16)), codePaths: Type.Optional(strings(64)), docPaths: Type.Optional(strings(64)), governanceRoot: Type.Optional(Type.String()), watch: Type.Optional(watch) }, { additionalProperties: false }), executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      try {
        const { watch: binding, ...request } = params;
        const input = { ...request, root: resolve(ctx.cwd, request.root), ...(request.governanceRoot === undefined ? {} : { governanceRoot: resolve(ctx.cwd, request.governanceRoot) }) };
        const planPath = binding ? await realpath(resolve(ctx.cwd, binding.plan_path)) : undefined;
        const result = await checks.check(input);
        signal?.throwIfAborted();
        if (binding) checks.watch(planPath!, binding.task_id, input);
        return response(result + (binding ? `\n已启用 ${binding.task_id} 的会话内交付提醒；不改变完成权限。` : ""));
      } catch (error) { return response(`文档检查失败：${error instanceof Error ? error.message : String(error)}。普通 Plan 编辑仍可使用。`, true); }
    } });
  pi.registerTool({ name: "docsync_unwatch", label: "关闭文档交付提醒", description: "Remove an optional session-local task reminder when the user chooses ordinary editing. Does not change Plan or claim documents are synchronized.", parameters: watch, executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const path = resolve(ctx.cwd, params.plan_path);
      checks.unwatch(await realpath(path).catch(() => path), params.task_id);
      return response("已关闭该任务的文档交付提醒；不改变 Plan 或文档完成判断。");
    } });
  return checks;
}
