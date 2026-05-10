/**
 * Agent Permission Policy — public API.
 *
 * Re-exports the Zod schema and inferred types for consumers who want
 * runtime validation, plus a helper to compile the JSON Schema.
 */

export {
  agentPermissionPolicy,
  permissionTiers,
  permissionMode,
  permissionRule,
  conditionalRule,
  ruleCondition,
  delegation,
  sandboxMode,
  sandbox,
  profiles,
  network,
} from "./schema.ts";

export type {
  AgentPermissionPolicy,
  PermissionTiers,
  ConditionalRule,
  RuleCondition,
  Delegation,
  PermissionMode,
  SandboxMode,
  Sandbox,
  Profiles,
  Network,
} from "./schema.ts";

export {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
  CODECS,
} from "./compat/codecs.ts";

export type { AgentId, Codecs } from "./compat/codecs.ts";

export {
  evaluate,
  type PermissionDecision,
  type PermissionPolicy,
} from "./evaluate.ts";

export { loadPolicy, type PolicyLoadOptions } from "./loader.ts";
