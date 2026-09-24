import type { CallToolResult } from '@modelcontextprotocol/server';

import type { AuditRecord, AuditSink } from '../audit/audit-log.js';
import type { Config, WorkspaceMode } from '../config/config.js';
import { WorkspaceError } from '../errors/errors.js';
import type { PathGuard } from '../filesystem/path-guard.js';

export interface RunToolOptions {
  tool: string;
  /**
   * The raw `workspace` argument. Handlers see it as `unknown` because the schema field
   * exists only in multi mode; the SDK has validated it by then. Recorded when a string.
   */
  workspace?: unknown;
  path?: string;
  /** Recorded as `dry_run: true` when set (M49). */
  dryRun?: boolean;
  requestId: string | number;
  timeoutMs: number;
  audit: AuditSink;
}

export interface ToolOutcome<T> {
  result: T;
  bytesRead?: number;
  bytesWritten?: number;
}

/**
 * Runs one tool call with a timeout, turns failures into `isError` results the
 * agent can act on, and writes exactly one audit record.
 */
export async function runTool<T extends Record<string, unknown>>(
  options: RunToolOptions,
  operation: (signal: AbortSignal) => Promise<ToolOutcome<T>>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const base = {
    event: 'tool_call' as const,
    timestamp: new Date().toISOString(),
    request_id: String(options.requestId),
    tool: options.tool,
    ...(typeof options.workspace === 'string' ? { workspace: options.workspace } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.dryRun ? { dry_run: true as const } : {}),
  };
  const elapsed = () => Math.round(performance.now() - startedAt);

  // Searches stop and writes skip their commit once the signal aborts (M24, M43).
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting: an operation that rejects synchronously on abort must not win the race.
      reject(
        new WorkspaceError(
          'TIMEOUT',
          `${options.tool} did not finish within ${options.timeoutMs} ms; it may still complete, so check the current state before retrying`,
        ),
      );
      // Node.js cannot cancel filesystem calls already in flight.
      controller.abort();
    }, options.timeoutMs);
  });

  try {
    const outcome = await Promise.race([operation(controller.signal), timeout]);
    options.audit({
      ...base,
      ok: true,
      duration_ms: elapsed(),
      ...(outcome.bytesRead !== undefined ? { bytes_read: outcome.bytesRead } : {}),
      ...(outcome.bytesWritten !== undefined ? { bytes_written: outcome.bytesWritten } : {}),
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
    };
  } catch (error) {
    const failure =
      error instanceof WorkspaceError ? error : new WorkspaceError('INTERNAL_ERROR', 'internal server error');
    const record: AuditRecord = { ...base, ok: false, duration_ms: elapsed(), error_code: failure.code };
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!(error instanceof WorkspaceError) && typeof errno === 'string') record.error_detail = errno;
    options.audit(record);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: failure.code, message: failure.message } }) }],
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A configured workspace as tools see it: its guard and access mode, always selected together. */
export interface SelectedWorkspace {
  guard: PathGuard;
  mode: WorkspaceMode;
}

export interface ToolDeps {
  config: Config;
  /** One entry per configured workspace, keyed by name. */
  workspaces: ReadonlyMap<string, SelectedWorkspace>;
  audit: AuditSink;
}

/** The workspace for the `workspace` argument in multi mode, or the only workspace otherwise. */
export function selectWorkspace({ config, workspaces }: ToolDeps, workspace: unknown): SelectedWorkspace {
  const name = config.multi ? workspace : config.workspaces[0]?.name;
  const selected = typeof name === 'string' ? workspaces.get(name) : undefined;
  // Unreachable: the input schema only accepts configured names. Surfaces as INTERNAL_ERROR.
  if (selected === undefined) throw new Error('no guard for the requested workspace');
  return selected;
}

/** The guard of the selected workspace, for tools that never write. */
export function guardFor(deps: ToolDeps, workspace: unknown): PathGuard {
  return selectWorkspace(deps, workspace).guard;
}
