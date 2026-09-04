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
