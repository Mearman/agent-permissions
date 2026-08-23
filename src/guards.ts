import {
  PermissionMode,
  type PermissionMode as PermissionModeType,
} from "./schema.ts";
import { agentId, type AgentId } from "./compat/codecs.ts";

/**
 * Narrowing guards shared across the library. Each derives its truth from the schema/enum it
 * protects (the zod enum's own options list), so a new value added to the schema is automatically
 * accepted here without an edit.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentId(value: string): value is AgentId {
  for (const id of agentId.options) {
    if (id === value) return true;
  }
  return false;
}

export function isPermissionMode(value: string): value is PermissionModeType {
  for (const mode of PermissionMode.options) {
    if (mode === value) return true;
  }
  return false;
}
