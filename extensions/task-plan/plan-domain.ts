import { createHash } from "node:crypto";
import { assertNoReservedPlanMarkup, assertSafeUnicode, parseFrontmatter, parseStrictJson, renderFrontmatter, validatePlanMetadata } from "./plan-text.ts";
import { extractAllSections, extractNativeSections, replaceSection, type NativeSections } from "./sections.ts";
import { canonicalTaskDefinition, parseTasks, taskField } from "./tasks.ts";
import { inspectPhaseRecords, upsertPhaseRecord } from "./phase-record.ts";
import { inspectExecutionNotes, upsertExecutionNote, type ExecutionNote } from "./execution-notes.ts";
import { parsePlanOutlineEntries } from "./nodes.ts";
import type { PhaseRecord } from "./phase-contracts.ts";
import type { PlanDocument, PlanMetadata, SectionName, TaskBlock } from "./types.ts";

export const NATIVE_FORMAT = "pi-plan/v2";
export interface NodeVerificationPolicy { risk: "low" | "medium" | "high" | "unknown"; verification: Record<string, { command_or_method: string; inputs: string[]; expected: string }> }
export interface NodeScopes { read: string[]; write: string[]; commands: string[] }
export interface NodeReviewPolicy { independent: boolean; required_evidence: string[] }
export const CORE_HUMAN_GATES = ["approve_contract","authorize_execution","finalize"] as const;
export type NodeHumanGate = typeof CORE_HUMAN_GATES[number] | "manual_acceptance";
export interface DomainNode {
  requestedRole?:"implementer"; humanGates?:NodeHumanGate[];
  id: string; title: string; round: number | null; outcome: string;
  outline: Record<string, string>; work: string; acceptance: string; dependsOn: string[];
  verification: NodeVerificationPolicy | null; scopes: NodeScopes | null;
  forbidden: string[]; nonGoals: string[]; reviewPolicy: NodeReviewPolicy | null;
  progress: "outline" | "open" | "completed";
  phase?: PhaseRecord; notes: Record<string, ExecutionNote>;
  /** Exact definition coverage for legacy fields that have no native interpretation. */
  legacyDefinition?: { outline: string; task: string };
}
export interface PlanDomain { originalRequest: string; title: string; whatWhy: string; strategy: string; nodes: DomainNode[]; review: string }
const outlineFields = ["Work Areas", "Ordering", "Exit Condition", "Promotion Condition", "Dependencies on T001", "Candidate Work", "Conditional Direction", "Dependencies / Assumptions", "Replan Triggers"];
const nodeFields = ["Round", "Outcome", ...outlineFields, "Work", "Acceptance", "Verification", "Scopes", "Forbidden", "Non-Goals", "Review Policy", "Requested Role", "Human Gates", "Progress", "Depends On"];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).sort().join() === [...fields].sort().join();
function fail(message: string): never { throw new Error(message); }
function scalarText(value: unknown, max = 65536): value is string { return typeof value === "string" && value.length <= max && !/[\u0000]|\p{Surrogate}/u.test(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 128 && value.every(v => scalarText(v, 8192) && !!v.trim()) && new Set(value).size === value.length; }
function parseJsonField(raw: string): unknown { return raw.trim() ? parseStrictJson(raw.trim()) : null; }
function fields(markdown: string, allowed?: readonly string[], strict = true): Record<string, string> {
  const headings = [...markdown.matchAll(/^#### (.+)$/gm)];
  const result: Record<string, string> = Object.create(null);
  for (const [i, h] of headings.entries()) {
    const name = h[1]!.trim();
    if (strict && (Object.hasOwn(result, name) || allowed && !allowed.includes(name))) fail(`invalid_node_field: ${name}`);
    const value = markdown.slice(h.index! + h[0].length, headings[i + 1]?.index ?? markdown.length).trim();
    if (strict && /^#{1,4} /m.test(value)) fail("unowned_node_heading");
    result[name] = value;
  }
  return result;
}
export function validateNodePolicy(node: DomainNode): void {
  if(node.requestedRole!==undefined && node.requestedRole!=="implementer")fail("unsupported_execution_role");
  if(node.humanGates!==undefined && (!strings(node.humanGates)||node.humanGates.some(g=>![...CORE_HUMAN_GATES,"manual_acceptance"].includes(g))||CORE_HUMAN_GATES.some(g=>!node.humanGates!.includes(g))))fail("required_human_gate_missing");
  const v = node.verification;
  if (v !== null) {
    if (!object(v) || !exact(v, ["risk", "verification"]) || !["low", "medium", "high", "unknown"].includes(v.risk) || !object(v.verification) || Object.keys(v.verification).length > 128) fail("invalid_verification_policy");
    const ids = projectTask(node)?.acceptance.map(a => a.id) ?? [];
    for (const [id, method] of Object.entries(v.verification)) if (!ids.includes(id) || !object(method) || !exact(method, ["command_or_method", "inputs", "expected"]) || !scalarText(method.command_or_method, 8192) || !method.command_or_method.trim() || !scalarText(method.expected, 8192) || !method.expected.trim() || !strings(method.inputs)) fail("invalid_verification_method");
  }
  if (node.scopes !== null && (!object(node.scopes) || !exact(node.scopes, ["read", "write", "commands"]) || !strings(node.scopes.read) || !strings(node.scopes.write) || !strings(node.scopes.commands))) fail("invalid_node_scopes");
  if (!strings(node.forbidden) || !strings(node.nonGoals)) fail("invalid_node_boundaries");
  const review = node.reviewPolicy;
  if (review !== null && (!object(review) || !exact(review, ["independent", "required_evidence"]) || typeof review.independent !== "boolean" || !strings(review.required_evidence))) fail("invalid_node_review_policy");
}
function checklist(raw: string, kind: "work" | "acceptance"): void {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const bullet = kind === "work" ? /^- .+ \[(?: |x|X)\]$/ : /^- \[(?: |x|X)\] .+$/;
    if (!bullet.test(line)) fail(`invalid_native_${kind}_item`);
  }
}
export function validateDomain(domain: PlanDomain): void {
  assertSafeUnicode(domain);
  if (!Array.isArray(domain.nodes) || domain.nodes.length > 256) fail("invalid_domain_nodes");
  for (const key of ["originalRequest", "title", "whatWhy", "strategy", "review"] as const) {
    if (!scalarText(domain[key], 1048576)) fail(`invalid_domain_${key}`);
    assertNoReservedPlanMarkup(domain[key], key);
  }
  if (!domain.title.trim() || /[\r\n]/.test(domain.title)) fail("invalid_plan_title");
  const seen = new Set<string>();
  let previousId="";
  for (const node of domain.nodes) {
    if(node.id<=previousId)fail("invalid_native_node_order");
    previousId=node.id;
    if (!/^T\d{3}$/.test(node.id) || seen.has(node.id)) fail("duplicate_or_invalid_native_node");
    seen.add(node.id);
    if (!node.title.trim() || /[\r\n]/.test(node.title) || /\[(?: |x|X)\]$/.test(node.title)) fail("invalid_native_node_title");
    if (!["outline", "open", "completed"].includes(node.progress) || !(node.round === null || Number.isSafeInteger(node.round) && node.round >= 0)) fail("invalid_native_node_progress");
    if (node.progress !== "outline" && node.round === null) fail("executable_node_round_required");
    if (node.progress === "outline" && (node.phase || Object.keys(node.notes).length)) fail("outline_execution_state_forbidden");
    if (!object(node.outline) || Object.keys(node.outline).some(k => !outlineFields.includes(k))) fail("invalid_native_outline");
    for (const value of [node.title, node.outcome, node.work, node.acceptance, ...Object.values(node.outline)]) { if (!scalarText(value)) fail("invalid_node_text"); assertNoReservedPlanMarkup(value); }
    checklist(node.work, "work"); checklist(node.acceptance, "acceptance");
    if (!strings(node.dependsOn) || node.dependsOn.some(id => !/^T\d{3}$/.test(id) || id === node.id)) fail("invalid_native_dependencies");
    for(const value of [node.verification,node.scopes,node.forbidden,node.nonGoals,node.reviewPolicy]) assertNoReservedPlanMarkup(JSON.stringify(value));
    validateNodePolicy(node);
    const task = projectTask(node);
    if (Object.keys(node.notes).some(id => !task?.workItems.some(w => w.id === id))) fail("unknown_native_execution_note");
    if (node.phase && (node.phase.context.phase_id !== node.id || node.phase.context.round !== node.round)) fail("native_phase_owner_mismatch");
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string): void { if (visiting.has(id)) fail("dependency_cycle"); if (visited.has(id)) return; const node = domain.nodes.find(n => n.id === id) ?? fail("unknown_dependency"); visiting.add(id); node.dependsOn.forEach(visit); visiting.delete(id); visited.add(id); }
  domain.nodes.forEach(n => visit(n.id));
}
function field(name: string, value: string): string { return `#### ${name}\n\n${value.trim()}\n`; }
/** Compatibility projection, never persisted as a second V2 node. */
export function projectTaskDefinition(node: DomainNode): string {
  const policy = [node.verification && field("Verification", JSON.stringify(node.verification)), node.scopes && field("Scopes", JSON.stringify(node.scopes)), node.forbidden.length && field("Forbidden", JSON.stringify(node.forbidden)), node.nonGoals.length && field("Non-Goals", JSON.stringify(node.nonGoals)), node.reviewPolicy && field("Review Policy", JSON.stringify(node.reviewPolicy)), node.requestedRole && field("Requested Role",node.requestedRole), node.humanGates && field("Human Gates",JSON.stringify(node.humanGates))].filter(Boolean);
  let text = [`### ${node.id} — ${node.title} [${node.progress === "completed" ? "x" : " "}]`, `<!-- pi-plan:round:R${String(node.round ?? 0).padStart(3, "0")} -->`, field("Tasks", node.work), field("Acceptance", node.acceptance), ...policy, field("Depends On", node.dependsOn.join(", ") || "None.")].join("\n\n").trimEnd();
  for (const [id, note] of Object.entries(node.notes)) text = upsertExecutionNote(text, id, note);
  if (node.phase) text = upsertPhaseRecord(text, node.id, node.phase);
  return text;
}
export function projectTask(node: DomainNode): TaskBlock | undefined { return node.progress === "outline" ? undefined : parseTasks(projectTaskDefinition(node))[0]; }
export function projectSections(domain: PlanDomain): Record<SectionName, string> {
  const plan = [domain.strategy, ...domain.nodes.map(n => [`### ${n.id} — ${n.title}`, field("Outcome", n.outcome), ...Object.entries(n.outline).map(([k, v]) => field(k, v))].join("\n\n"))].filter(Boolean).join("\n\n");
  return { what_why: domain.whatWhy, plan, tasks: domain.nodes.filter(n => n.progress !== "outline").map(projectTaskDefinition).join("\n\n"), review: domain.review };
}
export function parseNativeNodes(markdown: string): DomainNode[] {
  if (!markdown.trim()) return [];
  const headers = [...markdown.matchAll(/^### (T\d{3}) — (.+)$/gm)];
  if (!headers.length || markdown.slice(0, headers[0]!.index).trim()) fail("unowned_native_node_content");
  return headers.map((h, i) => {
    const raw = markdown.slice(h.index!, headers[i + 1]?.index ?? markdown.length).trim();
    const projected = raw.replace(h[0], `${h[0]} [ ]`).replace(/^#### Work$/gm, "#### Tasks");
    const phases = inspectPhaseRecords(projected), notes = inspectExecutionNotes(phases.definition);
    if (phases.errors.length || notes.errors.length) fail(`invalid_native_records: ${[...phases.errors, ...notes.errors].join("; ")}`);
    const clean = notes.definition.replace(`${h[0]} [ ]`, h[0]).replace(/^#### Tasks$/gm, "#### Work");
    const first = clean.indexOf("\n");
    if (first < 0 || clean.slice(first + 1).split(/^#### /m)[0]!.trim()) fail("unowned_native_node_content");
    if (/<!--\s*pi-plan:/i.test(clean)) fail("invalid_native_reserved_markup");
    const f = fields(clean.slice(first + 1), nodeFields);
    for (const name of ["Round", "Outcome", "Progress", "Depends On"]) if (!Object.hasOwn(f, name)) fail(`missing_native_node_field: ${name}`);
    if (Object.keys(f).at(-1) !== "Depends On") fail("native_dependencies_must_be_last");
    const round = f.Round === "future" ? null : /^R\d{3,}$/.test(f.Round!) ? Number(f.Round!.slice(1)) : fail("invalid_native_round");
    const dependsOn = /^(?:None\.?|\[\])$/.test(f["Depends On"]!) ? [] : f["Depends On"]!.split(/,\s*/);
    return { ...(f["Requested Role"]!==undefined?{requestedRole:f["Requested Role"] as "implementer"}:{}), ...(f["Human Gates"]!==undefined?{humanGates:parseJsonField(f["Human Gates"]!) as NodeHumanGate[]}:{}), id: h[1]!, title: h[2]!, round, outcome: f.Outcome!, outline: Object.fromEntries(outlineFields.filter(k => Object.hasOwn(f, k)).map(k => [k, f[k]!])), work: f.Work ?? "", acceptance: f.Acceptance ?? "", dependsOn, verification: parseJsonField(f.Verification ?? "") as NodeVerificationPolicy | null, scopes: parseJsonField(f.Scopes ?? "") as NodeScopes | null, forbidden: (parseJsonField(f.Forbidden ?? "") ?? []) as string[], nonGoals: (parseJsonField(f["Non-Goals"] ?? "") ?? []) as string[], reviewPolicy: parseJsonField(f["Review Policy"] ?? "") as NodeReviewPolicy | null, progress: f.Progress as DomainNode["progress"], ...(phases.records[h[1]!] ? {phase: phases.records[h[1]!]} : {}), notes: notes.notes };
  });
}
export function renderNativeNode(node: DomainNode): string {
  let work = node.work;
  if (Object.keys(node.notes).length) {
    const projected = projectTaskDefinition({...node, phase: undefined});
    work = taskField(projected, "Tasks").trim();
  }
  const values: Record<string, string> = { Round: node.round === null ? "future" : `R${String(node.round).padStart(3, "0")}`, Outcome: node.outcome, ...node.outline, Work: work, Acceptance: node.acceptance, ...(node.verification ? {Verification: JSON.stringify(node.verification)} : {}), ...(node.scopes ? {Scopes: JSON.stringify(node.scopes)} : {}), ...(node.forbidden.length ? {Forbidden: JSON.stringify(node.forbidden)} : {}), ...(node.nonGoals.length ? {"Non-Goals": JSON.stringify(node.nonGoals)} : {}), ...(node.reviewPolicy ? {"Review Policy": JSON.stringify(node.reviewPolicy)} : {}), ...(node.requestedRole?{"Requested Role":node.requestedRole}:{}), ...(node.humanGates?{"Human Gates":JSON.stringify(node.humanGates)}:{}), Progress: node.progress, "Depends On": node.dependsOn.join(", ") || "None." };
  let text = [`### ${node.id} — ${node.title}`, ...nodeFields.filter(k => Object.hasOwn(values,k)).map(k => field(k,values[k]!))].join("\n\n").trimEnd();
  if (node.phase) {
    const projected = projectTaskDefinition(node);
    const record = projected.match(/^<!-- pi-plan:phase:T\d{3}:start -->\n[^\n]+\n<!-- pi-plan:phase:T\d{3}:end -->$/m)?.[0] ?? fail("invalid_native_phase_record");
    text += `\n${record}`;
  }
  return text;
}
export function parseNativeDomain(metadata: PlanMetadata, body: string): PlanDomain {
  const s = extractNativeSections(body);
  const prefix = s.prefix.replace(/\r\n/g,"\n").trim();
  const match = prefix.match(/^# (P\d{3}) — ([^\n]+)\n+## Original Request(?:\n+([\s\S]*))?$/);
  if (!match || match[1] !== metadata.plan_id) fail("invalid_native_document_envelope");
  const domain = { originalRequest: match[3]?.trim() ?? "", title: match[2]!, whatWhy: s.what_why, strategy: s.strategy, nodes: parseNativeNodes(s.nodes), review: s.review };
  validateDomain(domain);
  for(const id of [metadata.selected_node,metadata.pending_node]) if(id&&!domain.nodes.some(n=>n.id===id)) fail("unknown_selected_native_node");
  if(metadata.node_approvals)for(const id of Object.keys(parseStrictJson(metadata.node_approvals) as Record<string,unknown>))if(!domain.nodes.some(n=>n.id===id))fail("unknown_native_approval_node");
  return domain;
}
export function adaptV1Domain(metadata: PlanMetadata, body: string, sections: Record<SectionName,string>): PlanDomain {
  const outlines = parsePlanOutlineEntries(sections.plan), tasks = parseTasks(sections.tasks);
  const before = outlines.length ? sections.plan.slice(0, sections.plan.indexOf(outlines[0]!.definition)).trim() : sections.plan;
  const ids = [...new Set([...outlines.map(n=>n.id), ...tasks.map(t=>t.id)])];
  const nodes = ids.map(id => {
    const outline = outlines.find(n=>n.id===id), task = tasks.find(n=>n.id===id);
    const f = outline ? fields(outline.definition.slice(outline.definition.indexOf("\n") + 1), undefined, false) : {};
    const base: DomainNode = { id, title: task?.title ?? outline!.title, round: task?.round ?? null, outcome: f.Outcome ?? f["Expected Outcome"] ?? f.Goal ?? "", outline: Object.fromEntries(Object.entries(f).filter(([k])=>!["Outcome","Expected Outcome","Goal"].includes(k))), work: "", acceptance: "", dependsOn: [], verification: null, scopes: null, forbidden: [], nonGoals: [], reviewPolicy: null, progress: task ? task.completed ? "completed" : "open" : "outline", notes: {}, legacyDefinition: {outline:outline?.definition??"",task:task?canonicalTaskDefinition(task.definition):""} };
    return task ? taskDomain(base,task,true) : base;
  });
  const title = body.match(/^# P\d{3} — (.+)$/m)?.[1] ?? metadata.plan_id;
  const originalRequest = body.match(/^## Original Request\s*\n([\s\S]*?)(?=^---$|<!-- pi-plan:)/m)?.[1]?.trim() ?? "";
  return { originalRequest,title,whatWhy:sections.what_why,strategy:before,nodes,review:sections.review };
}
function taskDomain(base: DomainNode, task: TaskBlock, legacy = false): DomainNode {
  const phases = inspectPhaseRecords(task.definition), notes = inspectExecutionNotes(phases.definition);
  if (phases.errors.length || notes.errors.length) fail("invalid_projected_execution_state");
  const raw = (name: string) => taskField(notes.definition,name).trim();
  const policy = (name: string): unknown => { try { return parseJsonField(raw(name)); } catch(error) { if(!legacy)throw error;return raw(name); } };
  return {...base,...(raw("Requested Role")?{requestedRole:raw("Requested Role") as "implementer"}:{}),...(raw("Human Gates")?{humanGates:policy("Human Gates") as NodeHumanGate[]}:{}),title:task.title,round:task.round,progress:task.completed?"completed":"open",work:raw("Tasks"),acceptance:raw("Acceptance"),dependsOn:task.dependsOn,verification:policy("Verification") as NodeVerificationPolicy|null,scopes:policy("Scopes") as NodeScopes|null,forbidden:(policy("Forbidden")??[]) as string[],nonGoals:(policy("Non-Goals")??[]) as string[],reviewPolicy:policy("Review Policy") as NodeReviewPolicy|null,phase:phases.records[task.id],notes:notes.notes};
}
export function domainFor(document: PlanDocument): PlanDomain { return document.domain ?? adaptV1Domain(document.metadata,document.body ?? "",document.sections); }
export function renderNativeDocument(metadata: PlanMetadata, domain: PlanDomain): string {
  validatePlanMetadata(metadata); validateDomain(domain);
  if(domain.nodes.some(node=>node.legacyDefinition!==undefined))fail("native_legacy_projection_forbidden");
  if (metadata.harness !== NATIVE_FORMAT || metadata.format !== NATIVE_FORMAT || metadata.identity_policy !== "node-v1") fail("invalid_native_metadata");
  const sections: Omit<NativeSections,"prefix"> = {what_why:domain.whatWhy,strategy:domain.strategy,nodes:domain.nodes.map(renderNativeNode).join("\n\n"),review:domain.review};
  const text = `${renderFrontmatter(metadata)}\n# ${metadata.plan_id} — ${domain.title}\n\n## Original Request\n\n${domain.originalRequest}\n\n${Object.entries(sections).map(([key,value])=>{const name=key.replace("_","-");return `<!-- pi-plan:${name}:start -->\n\n${value}\n\n<!-- pi-plan:${name}:end -->`;}).join("\n\n")}\n`;
  parseNativeDomain(metadata,parseFrontmatter(text).body);
  return text;
}
export function serializePlanDocument(document: PlanDocument, nextDomain = domainFor(document), metadata = document.metadata): string {
  if (document.format === "v2" || metadata.format === NATIVE_FORMAT) return renderNativeDocument(metadata,nextDomain);
  if (JSON.stringify(domainFor(document)) !== JSON.stringify(nextDomain)) fail("v1_domain_rewrite_requires_logical_sections");
  if (JSON.stringify(metadata) === JSON.stringify(document.metadata)) return document.text;
  const {body}=parseFrontmatter(document.text); return renderFrontmatter(metadata)+body;
}
/** Internal execution projection edits; native definition UI must use editNativeNode. */
export function replaceLogicalSection(document: PlanDocument, section: SectionName, content: string): string {
  if (document.format !== "v2" && document.metadata.format !== NATIVE_FORMAT) return replaceSection(document.text,section,content);
  const next = structuredClone(domainFor(document));
  if (section === "what_why") next.whatWhy=content;
  else if (section === "review") next.review=content;
  else if (section === "plan") {
    if (/^### T\d{3} — /m.test(content)) fail("native_node_edit_required");
    next.strategy=content;
  } else {
    const tasks=parseTasks(content), executable=next.nodes.filter(n=>n.progress!=="outline");
    if (tasks.length !== executable.length || new Set(tasks.map(t=>t.id)).size!==tasks.length || tasks.some(t=>!executable.some(n=>n.id===t.id))) fail("native_projection_node_mismatch");
    for(const task of tasks){const index=next.nodes.findIndex(n=>n.id===task.id); next.nodes[index]=taskDomain(next.nodes[index]!,task);}
    const normalize=(text:string)=>text.replace(/\r\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    if(normalize(projectSections(next).tasks)!==normalize(content))fail("unmapped_native_execution_projection");
  }
  return renderNativeDocument(document.metadata,next);
}
export function editNativeNode(document: PlanDocument, id: string, candidate: string): string {
  if (document.format !== "v2") fail("native_node_edit_requires_v2");
  const nodes=parseNativeNodes(candidate);
  if(nodes.length!==1||nodes[0]!.id!==id) fail("native_node_candidate_identity_mismatch");
  const next=structuredClone(domainFor(document)), before=next.nodes.find(n=>n.id===id), after=nodes[0]!;
  if (before?.progress === "completed" || before?.phase?.finalized) fail("finalized_node_requires_explicit_reopen");
  if (after.phase || Object.keys(after.notes).length || after.progress==="completed" || /\[x\]/i.test(after.work+after.acceptance)) fail("reserved_execution_state_changed");
  if(before && (before.phase||Object.keys(before.notes).length)) {after.phase=before.phase;after.notes=before.notes;after.progress=before.progress;}
  const at=next.nodes.findIndex(n=>n.id===id); if(at<0)next.nodes.push(after);else next.nodes[at]=after;
  return renderNativeDocument(document.metadata,next);
}
export function createNativeSkeletonText(metadata: PlanMetadata, goal: string, title: string): string {
  return renderNativeDocument({...metadata,harness:NATIVE_FORMAT,format:NATIVE_FORMAT,identity_policy:"node-v1"},{originalRequest:goal,title,whatWhy:"Pending.",strategy:"Pending approval of What / Why.",nodes:[],review:"Not run."});
}
export function sourceHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
