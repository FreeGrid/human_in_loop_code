import { isAbsolute } from "node:path";
import { canonicalHash, canonicalJson } from "./authority.ts";
import { currentReadableTask, renderReadablePlan, type ReadablePlan } from "./v3-format.ts";

/** This policy is configured by the trusted host. It is never a model tool argument. */
export interface ReadableRequirementSource { kind: "brief" | "task" | "subtask"; index: number | null; quote: string }
export interface ReadableCriterion {
  id: string;
  source: ReadableRequirementSource;
  command_or_method: string;
  inputs: string[];
}
export interface ReadableExecutionPolicy {
  policy_id: string;
  criteria: ReadableCriterion[];
  read_scope: string[];
  write_scope: string[];
  forbidden_scope: string[];
  allowed_executables: string[];
  dependencies: string[];
}
export interface ReadableContract {
  version: 1;
  plan_id: string;
  node_id: string;
  definition: { brief: string; task: string; subtasks: string[] };
  definition_hash: string;
  policy: ReadableExecutionPolicy;
  contract_hash: string;
}
export function v3Fail(reason: string): never { throw new Error(`optional_governed:${reason}`); }
export function exactV3(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  canonicalJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) v3Fail("invalid_fields");
}
export function textV3(value: unknown, max = 65536): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\0|\p{Surrogate}/u.test(value)) v3Fail("invalid_string");
}
export function hashV3(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) v3Fail("invalid_hash"); }
export function stringsV3(value: unknown, max = 256): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max) v3Fail("invalid_array");
  canonicalJson(value); value.forEach(item => textV3(item));
  if (new Set(value).size !== value.length) v3Fail("duplicate_entry");
}
export function parseV3Scope(value: string): { path: string; recursive: boolean } {
  textV3(value, 4096);
  const recursive = value.endsWith("/**"), path = recursive ? value.slice(0, -3) : value;
  if (!path || isAbsolute(path) || /[\\\u0000-\u001f?*\[\]{}]/u.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) v3Fail("invalid_scope");
  return { path, recursive };
}
export function v3PathMatches(path: string, rule: string): boolean { const scope = parseV3Scope(rule); return path === scope.path || scope.recursive && path.startsWith(scope.path + "/"); }
function validatePolicy(value: unknown): asserts value is ReadableExecutionPolicy {
  exactV3(value, ["policy_id", "criteria", "read_scope", "write_scope", "forbidden_scope", "allowed_executables", "dependencies"]);
  textV3(value.policy_id, 256);
  stringsV3(value.read_scope); stringsV3(value.write_scope); stringsV3(value.forbidden_scope); stringsV3(value.allowed_executables); stringsV3(value.dependencies);
  for (const rule of [...value.read_scope, ...value.write_scope, ...value.forbidden_scope]) parseV3Scope(rule);
  if (!value.allowed_executables.length || value.allowed_executables.some(path => !isAbsolute(path))) v3Fail("absolute_executable_required");
  if (value.dependencies.some(id => !/^T\d{3,}$/.test(id))) v3Fail("invalid_dependency");
  if (!Array.isArray(value.criteria) || !value.criteria.length || value.criteria.length > 256) v3Fail("criteria_required");
  const ids = new Set<string>();
  for (const criterion of value.criteria) {
    exactV3(criterion, ["id", "source", "command_or_method", "inputs"]);
    textV3(criterion.id, 256); textV3(criterion.command_or_method); stringsV3(criterion.inputs);
    if (ids.has(criterion.id)) v3Fail("duplicate_criterion"); ids.add(criterion.id);
    for (const input of criterion.inputs) { parseV3Scope(input); if (![...value.read_scope, ...value.write_scope].some(rule => v3PathMatches(input, rule))) v3Fail("input_out_of_scope"); }
    exactV3(criterion.source, ["kind", "index", "quote"]); textV3(criterion.source.quote);
    if (!["brief", "task", "subtask"].includes(String(criterion.source.kind))) v3Fail("invalid_requirement_source");
    if (criterion.source.kind === "subtask" ? !Number.isSafeInteger(criterion.source.index) || Number(criterion.source.index) < 0 : criterion.source.index !== null) v3Fail("invalid_requirement_index");
  }
}
function validateTrace(contract: ReadableContract): void {
  // Coverage is structural, not a claim that substring matching proves semantic completeness.
  // The trusted policy must attach an actual verification method to every current subtask.
  for (const [index] of contract.definition.subtasks.entries()) if (!contract.policy.criteria.some(criterion => criterion.source.kind === "subtask" && criterion.source.index === index)) v3Fail("subtask_verification_coverage_required");
  for (const criterion of contract.policy.criteria) {
    const source = criterion.source;
    const text = source.kind === "brief" ? contract.definition.brief : source.kind === "task" ? contract.definition.task : contract.definition.subtasks[source.index!];
    // Exact quotations make every criterion visibly attributable to the user-owned definition.
    if (!text || !text.includes(source.quote) || source.kind === "subtask" && text !== source.quote) v3Fail("criterion_not_traceable");
  }
}
export function assertReadableContract(value: unknown): asserts value is ReadableContract {
  exactV3(value, ["version", "plan_id", "node_id", "definition", "definition_hash", "policy", "contract_hash"]);
  if (value.version !== 1 || typeof value.plan_id !== "string" || !/^P\d{3,}$/.test(value.plan_id) || typeof value.node_id !== "string" || !/^T\d{3,}$/.test(value.node_id)) v3Fail("invalid_contract_identity");
  exactV3(value.definition, ["brief", "task", "subtasks"]); textV3(value.definition.brief); textV3(value.definition.task);
  if (!Array.isArray(value.definition.subtasks) || value.definition.subtasks.length > 256) v3Fail("invalid_subtasks"); value.definition.subtasks.forEach(item => textV3(item));
  validatePolicy(value.policy); hashV3(value.definition_hash); hashV3(value.contract_hash);
  if (value.policy.dependencies.includes(value.node_id)) v3Fail("self_dependency");
  if (canonicalHash(value.definition) !== value.definition_hash) v3Fail("definition_hash_mismatch");
  const { contract_hash, ...body } = value; if (canonicalHash(body) !== contract_hash) v3Fail("contract_hash_mismatch");
  validateTrace(value as unknown as ReadableContract);
}
export function prepareReadableContract(plan: ReadablePlan, policy: ReadableExecutionPolicy): ReadableContract {
  renderReadablePlan(plan); validatePolicy(policy);
  const task = currentReadableTask(plan) ?? v3Fail("no_current_task");
  const earlier = plan.tasks.slice(0, plan.tasks.indexOf(task));
  if (policy.dependencies.some(id => !earlier.some(prior => prior.id === id && prior.completed))) v3Fail("dependency_not_prior_completed_task");
  const definition = { brief: plan.brief, task: task.text, subtasks: task.subtasks.map(subtask => subtask.text) };
  const body = { version: 1 as const, plan_id: plan.plan_id, node_id: task.id, definition, definition_hash: canonicalHash(definition), policy: structuredClone(policy) };
  const result = { ...body, contract_hash: canonicalHash(body) }; assertReadableContract(result); return result;
}
/** Checkboxes are display state; child text and order remain part of the definition. */
export function readableContractMatches(plan: ReadablePlan, contract: ReadableContract): boolean {
  assertReadableContract(contract);
  const task = plan.tasks.find(task => task.id === contract.node_id);
  return plan.plan_id === contract.plan_id && plan.brief === contract.definition.brief && task?.text === contract.definition.task &&
    canonicalJson(task.subtasks.map(subtask => subtask.text)) === canonicalJson(contract.definition.subtasks);
}
