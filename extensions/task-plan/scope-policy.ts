import { lstat, open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalHash, canonicalJson } from "./authority.ts";
import { domainFor, projectTask, validateNodePolicy, type DomainNode } from "./plan-domain.ts";
import { describeExecutionSandbox, type ExecutionSandbox } from "./execution-sandbox.ts";
import { receiptSignerProtectedPaths } from "./evidence.ts";
import { PLAN_RUNTIME_ROOT } from "./operation-journal.ts";
import type { PlanDocument } from "./types.ts";
import type { PhaseContext, BaselineReference, BaselineProvider } from "./phase-contracts.ts";
import type { EvidenceRuntime } from "./receipt-state.ts";
const exec=promisify(execFile);
const fail=(message:string):never=>{throw new Error(message);};
function scope(value:string):{path:string;recursive:boolean} {
  if(typeof value!=="string"||!value||value.length>4096||/[\\\u0000-\u001f]|\p{Surrogate}/u.test(value)||isAbsolute(value))fail("invalid_contract_scope");
  const recursive=value.endsWith("/**"),path=recursive?value.slice(0,-3):value;
  if(!path||path.split("/").some(p=>!p||p==="."||p==="..")||/[?*\[\]{}]/.test(path))fail("invalid_contract_scope");
  return {path,recursive};
}
export function pathMatchesScope(path:string,rule:string):boolean {const s=scope(rule);return path===s.path||(s.recursive&&path.startsWith(s.path+"/"));}
export function nodeExecutionPolicy(document:PlanDocument,nodeId:string):DomainNode {
  const node=domainFor(document).nodes.find(n=>n.id===nodeId)??fail("unknown_contract_node");
  validateNodePolicy(node);
  if(!node.scopes)fail("execution_scopes_required: declare read/write/command boundaries");
  for(const entry of [...node.scopes!.read,...node.scopes!.write,...node.forbidden])scope(entry);
  const task=projectTask(node);
  if(!task||task.acceptance.some(a=>!node.verification?.verification[a.id]))fail("verification_plan_required: every criterion needs a declared method");
  if(Object.values(node.verification!.verification).some(m=>m.command_or_method!=="manual")&&!node.scopes!.commands.length)fail("execution_commands_required");
  if(node.humanGates?.includes("manual_acceptance")&&!Object.values(node.verification?.verification??{}).some(m=>m.command_or_method==="manual"))fail("manual_gate_criterion_required");
  return node;
}
async function canonicalExistingAncestor(path:string):Promise<string> {
  try{return await realpath(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const parent=dirname(path);if(parent===path)throw error;return resolve(await canonicalExistingAncestor(parent),basename(path));}
}
const denyIdentity=(path:string)=>path.normalize("NFC").toLowerCase();
function forbiddenMatch(path:string,rule:string):boolean{return pathMatchesScope(denyIdentity(path),denyIdentity(rule));}
function contains(root:string,path:string):boolean{return path===root||path.startsWith(root+sep);}
/** Git snapshots exclude ignored untracked files. Until an inventory-bearing
 * baseline exists, refuse those files in any executable scope rather than signing
 * evidence whose consumed input/output could change without a content version.
 */
export async function assertGitScopeInventory(document:PlanDocument,nodeId:string,targetRoot:string):Promise<void> {
  const node=nodeExecutionPolicy(document,nodeId);
  const {stdout}=await exec("git",["-C",targetRoot,"ls-files","--others","--ignored","--exclude-standard","-z"],{encoding:"buffer",timeout:30000,maxBuffer:16777216});
  const paths=new TextDecoder("utf-8",{fatal:true}).decode(stdout).split("\0").filter(Boolean);
  for(const path of paths) {
    scope(path);
    if([...node.scopes!.read,...node.scopes!.write].some(rule=>forbiddenMatch(path,rule)))fail(`scope_inventory_unavailable: ignored path ${path}`);
  }
}
/** Processes consume raw bytes, while Git may normalize line endings. Bind their
 * evidence to a bounded raw inventory as well as Git's preserved content identity.
 * Protected paths are not child-readable; excluding Plan projections avoids
 * self-invalidating a receipt when its own machine record is committed.
 */
async function rawScopeDigest(document:PlanDocument,node:DomainNode,targetRoot:string):Promise<string> {
  const entries:unknown[]=[];const seen=new Set<string>();let bytes=0,remaining=100000;
  const plan=relative(targetRoot,document.path);
  async function visit(path:string):Promise<void> {
    if(seen.has(path))return;seen.add(path);
    if(--remaining<0)fail("scope_inventory_budget");
    if(denyIdentity(path).split("/").includes(".git"))return;
    if(denyIdentity(path)===denyIdentity(plan)){if(path!==plan)fail("scope_inventory_protected_alias");return;}
    const forbidden=node.forbidden.find(rule=>forbiddenMatch(path,rule));
    if(forbidden){if(!pathMatchesScope(path,forbidden))fail("scope_inventory_protected_alias");return;}
    const absolute=resolve(targetRoot,path);
    if(await canonicalExistingAncestor(absolute)!==absolute)fail(`scope_inventory_alias: ${path}`);
    let info;try{info=await lstat(absolute,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;entries.push({path,kind:"missing"});return;}
    if(info.isDirectory()) {
      entries.push({path,kind:"directory",mode:Number(info.mode&0o777n)});
      const children=(await readdir(absolute)).sort();for(const name of children)await visit(`${path}/${name}`);
      const after=await lstat(absolute,{bigint:true});
      if(after.dev!==info.dev||after.ino!==info.ino||after.mtimeNs!==info.mtimeNs||after.ctimeNs!==info.ctimeNs)fail("scope_inventory_changed");
      return;
    }
    if(!info.isFile()||info.nlink!==1n)fail(`scope_inventory_alias: ${path}`);
    if(info.size>67108864n)fail("scope_inventory_budget");
    const file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const before=await file.stat({bigint:true});
      if(before.dev!==info.dev||before.ino!==info.ino)fail("scope_inventory_changed");
      const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let fileBytes=0;
      while(true){const read=await file.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;fileBytes+=read.bytesRead;bytes+=read.bytesRead;if(fileBytes>67108864||bytes>268435456)fail("scope_inventory_budget");hash.update(buffer.subarray(0,read.bytesRead));}
      const after=await file.stat({bigint:true}),current=await lstat(absolute,{bigint:true});
      if(after.size!==info.size||BigInt(fileBytes)!==info.size||after.mtimeNs!==info.mtimeNs||after.ctimeNs!==info.ctimeNs||current.dev!==info.dev||current.ino!==info.ino||current.nlink!==1n)fail("scope_inventory_changed");
      entries.push({path,kind:"file",mode:Number(info.mode&0o777n),hash:hash.digest("hex")});
    }finally{await file.close();}
  }
  for(const rule of [...new Set([...node.scopes!.read,...node.scopes!.write])].sort()) {
    const selected=scope(rule);
    try{if((await lstat(resolve(targetRoot,selected.path))).isDirectory()!==selected.recursive)fail("scope_inventory_kind");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    await visit(selected.path);
  }
  return canonicalHash(entries);
}
/** Only the trusted Controller may configure the opaque process boundary. */
export async function assertNodeSandbox(document:PlanDocument,nodeId:string,context:PhaseContext,runtime:EvidenceRuntime,sandbox:ExecutionSandbox):Promise<void> {
  const node=nodeExecutionPolicy(document,nodeId),config=describeExecutionSandbox(sandbox);
  const sorted=(a:readonly string[])=>canonicalJson([...a].sort());
  if(config.target_root!==context.target_root||sorted(config.read_scope)!==sorted(node.scopes!.read)||sorted(config.write_scope)!==sorted(node.scopes!.write))fail("sandbox_contract_scope_mismatch");
  const common=await realpath((await exec("git",["-C",context.target_root,"rev-parse","--path-format=absolute","--git-common-dir"])).stdout.trim());
  if(config.common_git_root!==common)fail("sandbox_git_root_mismatch");
  const required=[await realpath(document.path),PLAN_RUNTIME_ROOT,...receiptSignerProtectedPaths(runtime.signer)];
  for(const path of required)if(!config.protected_roots.some(root=>contains(root,path)))fail("sandbox_authority_protection_required");
  for(const rule of node.forbidden){const p=resolve(context.target_root,scope(rule).path);if(!config.protected_roots.some(root=>contains(root,p)))fail("sandbox_forbidden_scope_unprotected");}
  for(const executable of config.allowed_executables)if(!node.scopes!.commands.includes(executable)&&!node.scopes!.commands.includes(basename(executable)))fail("sandbox_command_scope_mismatch");
}
/** Compare real Git facts to declared writes, including deletions and both sides of renames. */
export async function inspectNodeChanges(document:PlanDocument,nodeId:string,context:PhaseContext,baseline:BaselineReference,provider:BaselineProvider):Promise<string> {
  const node=nodeExecutionPolicy(document,nodeId);
  if(!provider.inspect)fail("capability_unavailable: actual Git scope inspection is required");
  await assertGitScopeInventory(document,nodeId,context.target_root);
  const facts=await provider.inspect!(structuredClone(context),structuredClone(baseline));
  if(canonicalJson(facts.context)!==canonicalJson(context)||canonicalJson(facts.baseline)!==canonicalJson(baseline)||typeof facts.content_version!=="string"||!facts.content_version)fail("scope_facts_binding_mismatch");
  const plan=relative(context.target_root,document.path);
  for(const change of facts.changes) {
    const path=change.path;scope(path);
    if(denyIdentity(path).split("/").includes(".git")||denyIdentity(path)===denyIdentity(plan)||node.forbidden.some(rule=>forbiddenMatch(path,rule))||!node.scopes!.write.some(rule=>pathMatchesScope(path,rule)))fail(`write_scope_violation: ${path}`);
    if(change.before.kind==="symlink"||change.after.kind==="symlink")fail(`write_scope_alias_denied: ${path}`);
    const absolute=resolve(context.target_root,path);
    if(await canonicalExistingAncestor(absolute)!==absolute)fail(`write_scope_alias_denied: ${path}`);
    if(change.after.kind!=="missing") {const info=await lstat(absolute);if(!info.isFile()||info.nlink!==1)fail(`write_scope_alias_denied: ${path}`);}
  }
  const raw=await rawScopeDigest(document,node,context.target_root);
  if(raw!==await rawScopeDigest(document,node,context.target_root))fail("scope_inventory_changed");
  return `scoped-raw-v1:${canonicalHash({git_version:facts.content_version,raw})}`;
}
