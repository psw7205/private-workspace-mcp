import type { CallToolResult } from '@modelcontextprotocol/server';

import type { AuditRecord, AuditSink } from '../audit/audit-log.js';
import type { Config } from '../config/config.js';
import { WorkspaceError } from '../errors/errors.js';
import type { PathGuard } from '../filesystem/path-guard.js';

export interface RunToolOptions {
  tool: string;
  path?: string;
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
    ...(options.path !== undefined ? { path: options.path } : {}),
  };
  const elapsed = () => Math.round(performance.now() - startedAt);

  // Operations that loop (searches) check the signal and stop after a timeout.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Node.js cannot cancel filesystem calls already in flight.
      controller.abort();
      reject(
        new WorkspaceError(
          'TIMEOUT',
          `${options.tool} did not finish within ${options.timeoutMs} ms; it may still complete, so check the current state before retrying`,
        ),
      );
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

export interface ToolDeps {
  config: Config;
  guard: PathGuard;
  audit: AuditSink;
}
