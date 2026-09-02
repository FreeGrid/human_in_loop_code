export const extensionName = "research-harness";

export type ResearchHarnessExtensionBoundary = {
  readonly commandNamespace: "/research";
  readonly activeCommands: readonly [];
  readonly piRegistration: "deferred-until-p01-t007";
  readonly controllerFacade: "deferred-until-p01-t008";
};

export const researchHarnessExtensionBoundary: ResearchHarnessExtensionBoundary = {
  commandNamespace: "/research",
  activeCommands: [],
  piRegistration: "deferred-until-p01-t007",
  controllerFacade: "deferred-until-p01-t008",
};
