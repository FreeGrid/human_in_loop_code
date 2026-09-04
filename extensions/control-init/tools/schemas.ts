import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";

const TopologyProfileSchema = StringEnum(["control-code", "control-code-latex", "custom"] as const);
const RepositoryKindSchema = StringEnum(["control", "code", "latex", "custom"] as const);
const VisibilitySchema = StringEnum(["private", "private-now-may-open-source", "public", "unspecified"] as const);
const RelationshipTypeSchema = StringEnum(["manages", "tests", "paper-about", "runtime-depends-on", "custom"] as const);

const LatexRepositorySchema = Type.Object({
  id: Type.String({ description: "Stable short paper/repository identifier" }),
  path: Type.Optional(Type.String({ description: "Explicit LaTeX repository directory" })),
}, { additionalProperties: false });

const CustomRepositorySchema = Type.Object({
  id: Type.String(),
  kind: RepositoryKindSchema,
  path: Type.Optional(Type.String()),
  role: Type.String(),
  visibility: VisibilitySchema,
  owns: Type.Array(Type.String()),
  gitRemote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false });

const RelationshipSchema = Type.Object({
  from: Type.String(),
  to: Type.String(),
  type: RelationshipTypeSchema,
  description: Type.Optional(Type.String()),
}, { additionalProperties: false });

const BootstrapSchema = Type.Object({
  create: Type.Optional(Type.Array(Type.String({ description: "Exact absolute path already approved for creation and local git init" }))),
  initialize: Type.Optional(Type.Array(Type.String({ description: "Exact absolute existing non-Git directory already approved for in-place git init" }))),
}, { additionalProperties: false });

export const ControlInitParameters = Type.Object({
  controlPath: Type.Optional(Type.String({ description: "Explicit control repository directory; use the current directory only when the user said so" })),
  codePath: Type.Optional(Type.String({ description: "Explicit product code repository directory" })),
  latexRepositories: Type.Optional(Type.Array(LatexRepositorySchema)),
  topologyProfile: Type.Optional(TopologyProfileSchema),
  workspaceId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String({ description: "Base workspace name. With no controlPath/codePath, local creation uses <name>_control and <name>_code under Pi's current directory." })),
  userRequirements: Type.Optional(Type.Array(Type.String())),
  focusAreas: Type.Optional(Type.Array(Type.String({ description: "Known AGENTS focus module name; custom topology only" }))),
  customRepositories: Type.Optional(Type.Array(CustomRepositorySchema)),
  customRelationships: Type.Optional(Type.Array(RelationshipSchema)),
  agentsExistingStrategy: Type.Optional(StringEnum(["append-managed-block", "preview-only"] as const)),
  bootstrap: Type.Optional(BootstrapSchema),
}, { additionalProperties: false });

export const ControlUpdateParameters = Type.Object({
  ...ControlInitParameters.properties,
  changeRequest: Type.Optional(Type.String({ description: "The user's original description of the desired change" })),
  acceptManagedBlockDrift: Type.Optional(Type.Boolean({ description: "True only after the user chose to regenerate a manually changed managed block" })),
  acceptRemoteIdentityChanges: Type.Optional(Type.Array(Type.String({ description: "Repository ID whose current remote identity the user explicitly accepted" }))),
}, { additionalProperties: false });

export const ControlLocationParameters = Type.Object({
  controlPath: Type.Optional(Type.String({ description: "Explicit control repository directory; omit it to use the control repository initialized in the current Pi session, falling back to the tool working directory when no session target exists" })),
}, { additionalProperties: false });

export type ControlInitParams = Static<typeof ControlInitParameters>;
export type ControlUpdateParams = Static<typeof ControlUpdateParameters>;
export type ControlLocationParams = Static<typeof ControlLocationParameters>;
