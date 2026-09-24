import { describe, expect, it } from 'vitest';

import type { AuditRecord } from '../src/audit/audit-log.js';
import { WorkspaceError } from '../src/errors/errors.js';
import { runTool } from '../src/tools/run-tool.js';

function setup(timeoutMs = 1000) {
  const records: AuditRecord[] = [];
  const options = { tool: 'read_file', path: 'src/a.ts', requestId: 7, timeoutMs, audit: (record: AuditRecord) => records.push(record) };
  return { records, options };
}

describe('runTool', () => {
  it('returns structured content and audits success with byte counts', async () => {
    const { records, options } = setup();
    const result = await runTool(options, async () => ({ result: { content: 'secret body' }, bytesRead: 11 }));

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ content: 'secret body' }) }],
      structuredContent: { content: 'secret body' },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ request_id: '7', tool: 'read_file', path: 'src/a.ts', ok: true, bytes_read: 11 });
    expect(typeof records[0]?.timestamp).toBe('string');
    expect(typeof records[0]?.duration_ms).toBe('number');
    expect(JSON.stringify(records)).not.toContain('secret body');
  });

  it('maps WorkspaceError to an isError result with its code', async () => {
    const { records, options } = setup();
    const result = await runTool(options, async () => {
      throw new WorkspaceError('REVISION_CONFLICT', 'src/a.ts changed since it was read');
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      error: { code: 'REVISION_CONFLICT', message: 'src/a.ts changed since it was read' },
    });
    expect(records[0]).toMatchObject({ ok: false, error_code: 'REVISION_CONFLICT' });
  });

  it('hides unexpected error details behind INTERNAL_ERROR', async () => {
    const { records, options } = setup();
    const result = await runTool(options, async () => {
      throw Object.assign(new Error("EIO: i/o error, open '/srv/private/file'"), { code: 'EIO' });
    });

    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBe(true);
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain('/srv/private');
    expect(records[0]).toMatchObject({ ok: false, error_code: 'INTERNAL_ERROR', error_detail: 'EIO' });
    expect(JSON.stringify(records)).not.toContain('/srv/private');
  });

  it('times out slow operations', async () => {
    const { records, options } = setup(20);
    const result = await runTool(options, () => new Promise<never>(() => undefined));

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe('TIMEOUT');
    expect(records[0]).toMatchObject({ ok: false, error_code: 'TIMEOUT' });
  });

  it('aborts the operation signal when it times out', async () => {
    const { options } = setup(20);
    let signal: AbortSignal | undefined;
    await runTool(options, (received) => {
      signal = received;
      return new Promise<never>(() => undefined);
    });
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the TIMEOUT result when the operation rejects after the abort', async () => {
    const { records, options } = setup(20);
    let late: Promise<unknown> | undefined;
    const result = await runTool(options, (signal) => {
      const operation = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new WorkspaceError('REVISION_CONFLICT', 'late failure')));
      });
      late = operation.catch(() => undefined);
      return operation;
    });
    await late;

    expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe('TIMEOUT');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: false, error_code: 'TIMEOUT' });
  });
});
