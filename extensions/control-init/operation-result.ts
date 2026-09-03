import type { DoctorReport, OperationResult, OperationSummary, RepositoryStatus, ValidationIssue } from "./types.js";

function value(value: string | null | boolean): string {
  if (value === null) return "unknown";
  return String(value);
}

function renderRepository(repository: RepositoryStatus): string {
  return [
    `- ${repository.id} (${repository.kind}): ${repository.configuredPath}`,
    `  resolved=${repository.absolutePath}`,
    `exists=${repository.exists}`,
    `git=${repository.gitRoot ?? "none"}`,
    `branch=${repository.branch ?? "none"}`,
    `dirty=${value(repository.dirty)}`,
    `remote=${repository.gitRemote ?? "none"}`,
    `remote-match=${value(repository.remoteMatches)}`,
  ].join(" | ");
}

export function renderSummary(summary: OperationSummary): string {
  const lines: string[] = [];
  if (summary.profile) lines.push(`Template: ${summary.profile}`);
  if (summary.workspaceId) lines.push(`Workspace: ${summary.workspaceId}`);
  if (summary.repositories?.length) {
    lines.push("Repositories:", ...summary.repositories.map(renderRepository));
  }
  if (summary.files?.length) {
    lines.push("Files:", ...summary.files.map((file) => `- ${file.action}: ${file.path}`));
  }
  if (summary.agentsHighlights?.length) {
    lines.push("AGENTS highlights:", ...summary.agentsHighlights.map((item) => `- ${item}`));
  }
  if (summary.changes?.length) lines.push("Changes:", ...summary.changes.map((item) => `- ${item}`));
  if (summary.warnings?.length) lines.push("Warnings:", ...summary.warnings.map((item) => `- ${item}`));
  if (summary.incomplete?.length) lines.push("Incomplete:", ...summary.incomplete.map((item) => `- ${item}`));
  return lines.join("\n");
}

export function renderOperationResult(result: OperationResult): string {
  if (result.status === "applied") return `Status: applied\n${renderSummary(result.summary)}`;
  if (result.status === "needs_input") {
    const questions = result.questions.map((question) => {
      const choices = question.choices?.length ? ` Choices: ${question.choices.join(", ")}.` : "";
      return `- ${question.id}: ${question.prompt}${choices}`;
    });
    return ["Status: needs_input", result.summary ? renderSummary(result.summary) : "", "Questions:", ...questions]
      .filter(Boolean)
      .join("\n");
  }
  const conflicts = result.conflicts.flatMap((conflict) => {
    const lines = [`- ${conflict.code}: ${conflict.message}${conflict.path ? ` (${conflict.path})` : ""}`];
    if (conflict.choices?.length) lines.push(`  Choices: ${conflict.choices.join(", ")}`);
    if (conflict.candidates?.length) {
      lines.push(...conflict.candidates.map((candidate) => `  Candidate: ${candidate.path} (score ${candidate.score.toFixed(3)}, git ${candidate.gitRoot ?? "none"}, remote ${candidate.gitRemote ?? "none"})`));
    }
    return lines;
  });
  return ["Status: conflict", result.summary ? renderSummary(result.summary) : "", "Conflicts:", ...conflicts]
    .filter(Boolean)
    .join("\n");
}

function renderIssue(issue: ValidationIssue): string {
  const location = issue.path ? ` (${issue.path})` : issue.repositoryId ? ` (${issue.repositoryId})` : "";
  return `- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${location}`;
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    `Doctor: ${report.ok ? "ok" : "issues found"}`,
    renderSummary(report.summary),
    report.issues.length ? `Checks:\n${report.issues.map(renderIssue).join("\n")}` : "Checks: all deterministic checks passed",
  ].filter(Boolean).join("\n");
}

export function toolResponse(result: OperationResult | DoctorReport): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const isDoctor = "ok" in result;
  const text = isDoctor ? renderDoctorReport(result) : renderOperationResult(result);
  return { content: [{ type: "text", text }], details: result as unknown as Record<string, unknown> };
}
