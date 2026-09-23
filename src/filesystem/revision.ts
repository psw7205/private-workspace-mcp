import { createHash } from 'node:crypto';

/** Opaque revision of a file's full byte content, used for optimistic concurrency. */
export function computeRevision(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
