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
} from "./schema.js";

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
} from "./schema.js";

export {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
  CODECS,
} from "./compat/codecs.js";

export type { AgentId, Codecs } from "./compat/codecs.js";
