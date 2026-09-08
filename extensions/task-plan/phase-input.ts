import { randomUUID } from "node:crypto";
import { captureHumanDecision, type HumanDecision, type HumanDecisionToken } from "./phase-contracts.ts";

/** Deliberately narrow: questions, quotes, suggested actions and "yes, but" are not grants. */
export function explicitPhaseAction(text: string): HumanDecision["action"] | undefined {
  const value = text.trim().replace(/[。！.!]+$/u, "").trim();
  if (/^(?:请\s*)?(?:关闭|停用)\s*DocSync(?:\s*文档检查)?$/iu.test(value) || /^(?:turn\s+)?(?:off\s+docsync|docsync\s+off|disable\s+docsync)$/i.test(value)) return "docsync_off";
  if (/^(?:请\s*)?(?:开启|打开|启用)\s*DocSync(?:\s*文档检查)?$/iu.test(value) || /^(?:turn\s+)?(?:on\s+docsync|docsync\s+on|enable\s+docsync)$/i.test(value)) return "docsync_on";
  if (/^(?:请\s*)?(?:开始执行|继续执行|执行)(?:\s*(?:当前阶段|当前\s*phase|T\d{3}))?$/iu.test(value) || /^(?:execute|resume)(?:\s+(?:the\s+)?(?:current\s+)?phase)?$/i.test(value)) return "execute";
  return undefined;
}

export function decisionFromInput(text: string, source: string): HumanDecisionToken | undefined {
  if (source !== "interactive" && source !== "rpc") return undefined;
  const action = explicitPhaseAction(text);
  return action ? captureHumanDecision({ action, source, text, input_id: randomUUID() }) : undefined;
}

export function phaseSwitchHelp(enabled = true): string {
  return `DocSync: ${enabled ? "on" : "off"}. /docsync off · /docsync on. 自然语言：关闭 DocSync / 开启 DocSync。关闭只跳过文档检查，不跳过 Task 验收，不清除既有债务。`;
}
