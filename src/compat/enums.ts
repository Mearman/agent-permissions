/**
 * Shared enum schemas — single source of truth.
 *
 * Every agent-specific enum is defined here as a Zod schema.
 * TypeScript types derive via `z.infer`. Alignment with upstream
 * SDKs is verified by compile-time assertions at the bottom of this file.
 *
 * Each export is a PascalCase identifier used as both the runtime schema
 * and the inferred type (TypeScript declaration merging):
 *
 *   import { PermissionBehavior } from "./enums.ts"        // schema
 *   import type { PermissionBehavior } from "./enums.ts"   // type
 */

import * as z from "zod";

import type {
  PermissionMode as ClaudeSdkPermissionMode,
  PermissionBehavior as ClaudeSdkPermissionBehavior,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ApprovalMode as CodexSdkApprovalMode,
  SandboxMode as CodexSdkSandboxMode,
} from "@openai/codex-sdk";

// ---------------------------------------------------------------------------
// Permission behaviour (allow / deny / ask)
// ---------------------------------------------------------------------------

/** Permission tier actions. Shared across Claude Code, OpenCode, and our schema. */
export const PermissionBehavior = z.enum(["allow", "deny", "ask"]);

export type PermissionBehavior = z.infer<typeof PermissionBehavior>;

// ---------------------------------------------------------------------------
// Claude Code — PermissionMode
// ---------------------------------------------------------------------------

/**
 * Claude Code's permission mode values, sourced from
 * `@anthropic-ai/claude-agent-sdk` `PermissionMode` type.
 */
export const ClaudeCodePermissionMode = z.enum([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

export type ClaudeCodePermissionMode = z.infer<typeof ClaudeCodePermissionMode>;

// ---------------------------------------------------------------------------
// Codex — ApprovalMode
// ---------------------------------------------------------------------------

/**
 * Codex's approval policy values, sourced from
 * `@openai/codex-sdk` `ApprovalMode` type.
 */
export const CodexApprovalMode = z.enum([
  "never",
  "on-failure",
  "on-request",
  "untrusted",
]);

export type CodexApprovalMode = z.infer<typeof CodexApprovalMode>;

// ---------------------------------------------------------------------------
// Codex — SandboxMode
// ---------------------------------------------------------------------------

/**
 * Codex's sandbox mode values, sourced from
 * `@openai/codex-sdk` `SandboxMode` type.
 */
export const CodexSandboxMode = z.enum([
  "danger-full-access",
  "read-only",
  "workspace-write",
]);

export type CodexSandboxMode = z.infer<typeof CodexSandboxMode>;

// ---------------------------------------------------------------------------
// Codex — FilesystemAccess
// ---------------------------------------------------------------------------

export const CodexFilesystemAccess = z.enum(["none", "read", "write"]);

export type CodexFilesystemAccess = z.infer<typeof CodexFilesystemAccess>;

// ---------------------------------------------------------------------------
// Codex — DomainAccess (subset of PermissionBehavior)
// ---------------------------------------------------------------------------
// Codex domain rules only use allow/deny, not ask.

export const CodexDomainAccess = z.enum(["allow", "deny"]);

export type CodexDomainAccess = z.infer<typeof CodexDomainAccess>;

// ---------------------------------------------------------------------------
// Compile-time alignment assertions
// ---------------------------------------------------------------------------
// These produce compile errors if our Zod enums diverge from the upstream
// SDK types. They are never referenced at runtime.

type _AssertClaudeModes = [ClaudeCodePermissionMode] extends [
  ClaudeSdkPermissionMode,
]
  ? [ClaudeSdkPermissionMode] extends [ClaudeCodePermissionMode]
    ? true
    : "SDK has modes missing from ClaudeCodePermissionMode"
  : "ClaudeCodePermissionMode has modes missing from SDK";

type _AssertClaudeBehaviors = [PermissionBehavior] extends [
  ClaudeSdkPermissionBehavior,
]
  ? [ClaudeSdkPermissionBehavior] extends [PermissionBehavior]
    ? true
    : "SDK has behaviors missing from PermissionBehavior"
  : "PermissionBehavior has behaviors missing from SDK";

type _AssertCodexApproval = [CodexApprovalMode] extends [CodexSdkApprovalMode]
  ? [CodexSdkApprovalMode] extends [CodexApprovalMode]
    ? true
    : "SDK has approval modes missing from CodexApprovalMode"
  : "CodexApprovalMode has approval modes missing from SDK";

type _AssertCodexSandbox = [CodexSandboxMode] extends [CodexSdkSandboxMode]
  ? [CodexSdkSandboxMode] extends [CodexSandboxMode]
    ? true
    : "SDK has sandbox modes missing from CodexSandboxMode"
  : "CodexSandboxMode has sandbox modes missing from SDK";
