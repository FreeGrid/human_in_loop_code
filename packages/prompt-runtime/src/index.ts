export const packageName = "@human-in-loop-harness/prompt-runtime";

export type PromptRuntimeBoundary = {
  readonly rolePromptRegistry: "deferred-until-p03";
  readonly promptComposer: "deferred-until-p04";
  readonly promptEnvelopeHashLedger: "deferred-until-p04";
  readonly promptBypassFixtures: "deferred-until-p04";
};

export const promptRuntimeBoundary: PromptRuntimeBoundary = {
  rolePromptRegistry: "deferred-until-p03",
  promptComposer: "deferred-until-p04",
  promptEnvelopeHashLedger: "deferred-until-p04",
  promptBypassFixtures: "deferred-until-p04",
};
