import { appendFileSync, constants, renameSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { ErrorCode } from '../errors/errors.js';

/** One record per tool call. Never contains file content or secrets (PRD 12). */
export interface AuditRecord {
  event: 'tool_call';
  timestamp: string;
  request_id: string;
  tool: string;
  /** Workspace name argument; only present in multi mode (ADR-008). */
  workspace?: string;
  /** Path argument as sent by the client. */
  path?: string;
  /** Set on write_file, edit_file, and multi_edit_file previews, which never write (M49, M81). */
  dry_run?: true;
  ok: boolean;
  duration_ms: number;
  bytes_read?: number;
  bytes_written?: number;
  /** Set when a Git tool cut its output at the read limit (ADR-004 §2.8). */
  truncated?: true;
  /** Files search_text skipped for credential content (ADR-010 §3.5); a count, never paths. Set when above 0. */
  content_blocked?: number;
  error_code?: ErrorCode;
  /**
   * Node.js error code (e.g. `EIO`) behind an INTERNAL_ERROR, or a Git tool's `exit:<n>`,
   * `signal:<name>`, or rejected config key (ADR-004 §2.8); never a message.
   */
  error_detail?: string;
}

export type AuditSink = (record: AuditRecord) => void;

/** stdout carries the MCP protocol, so audit records go to stderr as JSON Lines. */
export const stderrAuditSink: AuditSink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

/**
 * Appends JSON Lines to `file`, rotating it to `<file>.1` before it would exceed
 * `maxBytes` (one backup, so disk use stays near 2x the limit). Writes are
 * synchronous to keep records ordered; a failed write falls back to stderr so the
 * record is not lost.
 */
export function createFileAuditSink(file: string, maxBytes: number): AuditSink {
  return (record) => {
    const line = `${JSON.stringify(record)}\n`;
    try {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
      appendFileSync(file, line, { mode: 0o600 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      process.stderr.write(`private-workspace-mcp: audit log write failed (${code})\n`);
      stderrAuditSink(record);
    }
  };
}

/**
 * Fails when the sink above could not write `file`, without creating it. Rotation renames
 * the file and the first write creates it, so the parent directory must always be writable.
 */
export async function assertAuditLogWritable(file: string): Promise<void> {
  const notWritable = (subject: string, error: unknown) =>
    new Error(`${subject} is not writable (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`);
  await access(path.dirname(file), constants.W_OK | constants.X_OK).catch((error: unknown) => {
    throw notWritable('WORKSPACE_AUDIT_LOG parent directory', error);
  });
  await access(file, constants.W_OK).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw notWritable('WORKSPACE_AUDIT_LOG', error);
  });
}

export function createAuditSink(config: { path?: string; maxBytes: number }): AuditSink {
  return config.path === undefined ? stderrAuditSink : createFileAuditSink(config.path, config.maxBytes);
}
