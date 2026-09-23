import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFileAuditSink, type AuditRecord } from '../src/audit/audit-log.js';

function record(requestId: number): AuditRecord {
  return {
    event: 'tool_call',
    timestamp: '2026-09-23T00:00:00.000Z',
    request_id: String(requestId),
    tool: 'read_file',
    path: 'src/index.ts',
    ok: true,
    duration_ms: 1,
  };
}

const lineLength = `${JSON.stringify(record(1))}\n`.length;

describe('createFileAuditSink', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pwmcp-audit-'));
    file = path.join(dir, 'audit.jsonl');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per record, readable only by the owner', async () => {
    const sink = createFileAuditSink(file, 1_000_000);
    sink(record(1));
    sink(record(2));

    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line).request_id)).toEqual(['1', '2']);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rotates to a single .1 backup when the size limit would be exceeded', async () => {
    const sink = createFileAuditSink(file, lineLength * 2);
    for (let id = 1; id <= 5; id++) sink(record(id));

    const ids = async (target: string) =>
      (await readFile(target, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line).request_id);
    expect(await ids(file)).toEqual(['5']);
    expect(await ids(`${file}.1`)).toEqual(['3', '4']);
    await expect(stat(`${file}.2`)).rejects.toThrow();
  });

  it('still writes a record larger than the limit', async () => {
    const sink = createFileAuditSink(file, 10);
    sink(record(1));
    expect(JSON.parse(await readFile(file, 'utf8')).request_id).toBe('1');
  });

  it('falls back to stderr when the file cannot be written', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const sink = createFileAuditSink(path.join(dir, 'missing-dir', 'audit.jsonl'), 1000);
    sink(record(9));

    expect(writes.some((line) => line.includes('"request_id":"9"'))).toBe(true);
  });
});
