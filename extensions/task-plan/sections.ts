import type { SectionName } from "./types.ts";

const MARKER_NAMES: Record<SectionName, string> = {
  what_why: "what-why",
  plan: "plan",
  tasks: "tasks",
  review: "review",
};

export function markersFor(section: SectionName): { start: string; end: string } {
  const name = MARKER_NAMES[section];
  return { start: `<!-- pi-plan:${name}:start -->`, end: `<!-- pi-plan:${name}:end -->` };
}

export function extractSection(text: string, section: SectionName): string {
  const { start, end } = markersFor(section);
  const startMatches = [...text.matchAll(new RegExp(escapeRegExp(start), "g"))];
  const endMatches = [...text.matchAll(new RegExp(escapeRegExp(end), "g"))];
  if (startMatches.length !== 1 || endMatches.length !== 1) {
    throw new Error(`Section ${section} must contain exactly one start and one end marker`);
  }
  const startIndex = startMatches[0]!.index! + start.length;
  const endIndex = endMatches[0]!.index!;
  if (endIndex < startIndex) throw new Error(`Section ${section} end marker appears before start marker`);
  return text.slice(startIndex, endIndex).replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function replaceSection(text: string, section: SectionName, content: string): string {
  const { start, end } = markersFor(section);
  const startMatches = [...text.matchAll(new RegExp(escapeRegExp(start), "g"))];
  const endMatches = [...text.matchAll(new RegExp(escapeRegExp(end), "g"))];
  if (startMatches.length !== 1 || endMatches.length !== 1) {
    throw new Error(`Section ${section} must contain exactly one start and one end marker`);
  }
  const startEnd = startMatches[0]!.index! + start.length;
  const endStart = endMatches[0]!.index!;
  if (endStart < startEnd) throw new Error(`Section ${section} end marker appears before start marker`);
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return `${text.slice(0, startEnd)}\n\n${normalized}\n\n${text.slice(endStart)}`;
}

export function extractAllSections(text: string): Record<SectionName, string> {
  // Every reserved token has one structural owner, even inside frontmatter/code fences.
  const positions: Array<{ section: SectionName; start: number; end: number }> = [];
  let previous = -1;
  const frontmatterEnd = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
  for (const section of Object.keys(MARKER_NAMES) as SectionName[]) {
    const { start, end } = markersFor(section);
    extractSection(text, section);
    const a = text.indexOf(start), b = text.indexOf(end);
    for (const [index, marker] of [[a, start], [b, end]] as const) {
      if (index < frontmatterEnd || index && text[index - 1] !== "\n" || !["", "\n", "\r\n"].includes(text.slice(index + marker.length).match(/^(?:\r?\n|$)/)?.[0] ?? "invalid")) throw new Error("invalid_section_marker_line");
    }
    if (a <= previous) throw new Error("invalid_section_order_or_overlap");
    positions.push({ section, start: a + start.length, end: b }); previous = b + end.length;
  }
  const tasks = positions.find(p => p.section === "tasks")!;
  for (const match of text.matchAll(/<!--\s*pi-plan:/gi)) {
    const index = match.index!;
    const token = text.slice(index).match(/^<!-- pi-plan:(?:(?:what-why|plan|tasks|review):(?:start|end)|round:R\d{3}|(?:phase:T\d{3}|execution:T\d{3}\.W\d{3}):(?:start|end)) -->/)?.[0];
    if (!token) throw new Error("unknown_or_malformed_plan_marker");
    if (/^<!-- pi-plan:(?:phase|execution|round):/.test(token) && !(index >= tasks.start && index < tasks.end)) throw new Error("misplaced_plan_record_marker");
  }
  return {
    what_why: extractSection(text, "what_why"),
    plan: extractSection(text, "plan"),
    tasks: extractSection(text, "tasks"),
    review: extractSection(text, "review"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
