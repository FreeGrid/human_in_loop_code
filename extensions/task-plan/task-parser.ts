export interface MarkdownHeading {
  level: number;
  title: string;
  line: number;
  start: number;
  contentStart: number;
}

export interface ParsedTask {
  id: string;
  title: string;
  heading: MarkdownHeading;
  block: string;
  sections: Map<string, { heading: MarkdownHeading; content: string }[]>;
}

function lineRecords(markdown: string): Array<{ text: string; start: number; end: number; line: number }> {
  const records: Array<{ text: string; start: number; end: number; line: number }> = [];
  let start = 0;
  let line = 1;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline + 1;
    const raw = markdown.slice(start, newline === -1 ? markdown.length : newline);
    records.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, start, end, line });
    start = end;
    line += 1;
  }
  if (markdown.length === 0) return [];
  return records;
}

export function scanHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const record of lineRecords(markdown)) {
    const fenceMatch = record.text.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const sequence = fenceMatch[1] ?? "";
      const marker = sequence[0] as "`" | "~";
      if (!fence) fence = { marker, length: sequence.length };
      else if (fence.marker === marker && sequence.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const match = record.text.match(/^(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (!match) continue;
    const hashes = match[1] ?? "";
    const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (!title) continue;
    headings.push({
      level: hashes.length,
      title,
      line: record.line,
      start: record.start,
      contentStart: record.end,
    });
  }
  return headings;
}

export function sectionContent(markdown: string, heading: MarkdownHeading, headings = scanHeadings(markdown)): string {
  const next = headings.find((candidate) => candidate.start > heading.start && candidate.level <= heading.level);
  return markdown.slice(heading.contentStart, next?.start ?? markdown.length).trim();
}

export function stripFencedCode(markdown: string): string {
  const output: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const record of lineRecords(markdown)) {
    const fenceMatch = record.text.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const sequence = fenceMatch[1] ?? "";
      const marker = sequence[0] as "`" | "~";
      if (!fence) fence = { marker, length: sequence.length };
      else if (fence.marker === marker && sequence.length >= fence.length) fence = null;
      output.push("");
      continue;
    }
    output.push(fence ? "" : record.text);
  }
  return output.join("\n");
}

export function parseTasks(markdown: string): ParsedTask[] {
  const headings = scanHeadings(markdown);
  const taskHeadings = headings.filter((heading) => heading.level === 2 && /^T\d{3}\s+[—-]\s+\S/.test(heading.title));

  return taskHeadings.map((heading) => {
    const match = heading.title.match(/^(T\d{3})\s+[—-]\s+(.+)$/);
    if (!match) throw new Error(`Invalid task heading on line ${heading.line}`);
    const next = headings.find((candidate) => candidate.start > heading.start && candidate.level <= 2);
    const blockEnd = next?.start ?? markdown.length;
    const block = markdown.slice(heading.contentStart, blockEnd);
    const blockHeadings = scanHeadings(block);
    const sections = new Map<string, { heading: MarkdownHeading; content: string }[]>();

    for (const section of blockHeadings.filter((candidate) => candidate.level === 3)) {
      const entries = sections.get(section.title) ?? [];
      entries.push({ heading: section, content: sectionContent(block, section, blockHeadings) });
      sections.set(section.title, entries);
    }

    return {
      id: match[1] ?? "",
      title: (match[2] ?? "").trim(),
      heading,
      block,
      sections,
    };
  });
}

export function parseDependencies(content: string): { dependencies: string[]; valid: boolean } {
  const normalized = content.trim();
  if (normalized === "None.") return { dependencies: [], valid: true };
  if (!normalized) return { dependencies: [], valid: false };

  const dependencies: string[] = [];
  for (const line of normalized.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(T\d{3})\s*$/);
    if (!match) return { dependencies: [], valid: false };
    dependencies.push(match[1] ?? "");
  }
  return { dependencies, valid: dependencies.length > 0 };
}
