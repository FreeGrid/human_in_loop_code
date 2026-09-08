import { adaptV1Domain, parseNativeDomain, projectSections } from "./plan-domain.ts";
import { createHash } from "node:crypto";
import { inspectExecutionNotes } from "./execution-notes.ts";
import { inspectPhaseRecords } from "./phase-record.ts";
import { assertSafeUnicode, decodePlanUtf8, parseFrontmatter, renderFrontmatter, validatePlanMetadata } from "./plan-text.ts";
import { extractAllSections } from "./sections.ts";
import type { PlanDocument } from "./types.ts";

/** Structural validity only. Draft completeness and authority remain transition concerns. */
export function parsePlanCandidate(path: string, text: string): PlanDocument {
  assertSafeUnicode(text);
  if (/\r(?!\n)|[\u2028\u2029]/u.test(text)) throw new Error("invalid_plan_structural_whitespace");
  const bytes = Buffer.from(text, "utf8");
  if (decodePlanUtf8(bytes) !== text) throw new Error("plan_utf8_roundtrip_failed");
  const { metadata, body } = parseFrontmatter(text);
  validatePlanMetadata(metadata);
  renderFrontmatter(metadata); // Prove scalar rendering can be read again without changing values.
  if (metadata.format === "pi-plan/v2") {
    if (/<!--\s*pi-plan:/i.test(text.slice(0, text.length - body.length))) throw new Error("native_frontmatter_reserved_markup");
    const domain = parseNativeDomain(metadata, body);
    return { path, text, document_hash: createHash("sha256").update(bytes).digest("hex"), metadata, body, format: "v2", domain, sections: projectSections(domain) };
  }
  const sections = extractAllSections(text);
  const phases = inspectPhaseRecords(sections.tasks);
  const notes = inspectExecutionNotes(phases.definition);
  if (phases.errors.length || notes.errors.length) throw new Error(`invalid_plan_records: ${[...phases.errors, ...notes.errors].join("; ")}`);
  assertSafeUnicode(phases.records);
  assertSafeUnicode(notes.notes);
  const roundLines = notes.definition.replace(/\r\n/g, "\n").split("\n");
  let roundOwner = "", roundSeen = false, beforeFields = false;
  for (const line of roundLines) {
    if (/^### T\d{3} — .+ \[(?: |x|X)\]$/.test(line)) { roundOwner = line; roundSeen = false; beforeFields = true; }
    else if (/^#{1,4} /.test(line)) beforeFields = false;
    if (line.includes("<!-- pi-plan:round:")) {
      if (!roundOwner || !beforeFields || roundSeen || !/^<!-- pi-plan:round:R\d{3} -->$/.test(line)) throw new Error("invalid_round_marker");
      roundSeen = true;
    }
  }
  const withoutRecords = roundLines.filter(line => !/^<!-- pi-plan:round:R\d{3} -->$/.test(line)).join("\n");
  if (/<!--\s*pi-plan:/i.test(withoutRecords)) throw new Error("invalid_tasks_reserved_markup");
  return { path, text, document_hash: createHash("sha256").update(bytes).digest("hex"), metadata, body, sections, format: "v1", domain: adaptV1Domain(metadata, body, sections) };
}
