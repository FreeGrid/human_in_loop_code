export function workspaceNameError(name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return "Use only letters, numbers, dots, underscores, and hyphens, starting with a letter or number.";
  }
  if (/(?:^|[._-])(control|code)$/i.test(name)) {
    return "Enter the base workspace name without a control or code suffix; the initializer adds both suffixes.";
  }
  return undefined;
}
