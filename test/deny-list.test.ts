import { describe, expect, it } from 'vitest';

import { createDenyMatcher, DEFAULT_DENY_PATTERNS, isDenied } from '../src/policy/deny-list.js';

describe('isDenied', () => {
  it.each([
    '.env',
    'apps/api/.env',
    '.ENV',
    '.env.local',
    '.Env.Production',
    'certs/server.pem',
    'a/b/tls.KEY',
    '.ssh',
    '.ssh/id_ed25519',
    'home/user/.ssh/config',
    '.aws/credentials',
    '.gnupg/pubring.kbx',
    '.npmrc',
    'packages/web/.npmrc',
    '.netrc',
    'credentials.json',
    'config/secrets.yaml',
    'Secrets',
    '.git',
    '.git/config',
    'vendor/lib/.git/hooks/pre-commit',
  ])('denies %j', (relativePath) => {
    expect(isDenied(relativePath)).toBe(true);
  });

  it.each([
    '.',
    'README.md',
    'src/env.ts',
    'environment.md',
    '.envrc',
    'keys/readme.md',
    'keyboard.pem.md',
    '.gitignore',
    '.github/workflows/ci.yml',
    'docs/my-secrets-notes.md',
    'src/credential.ts',
  ])('allows %j', (relativePath) => {
    expect(isDenied(relativePath)).toBe(false);
  });
});

describe('createDenyMatcher', () => {
  const matches = createDenyMatcher([...DEFAULT_DENY_PATTERNS, '*.sqlite', 'private']);

  it.each(['db/app.sqlite', 'db/APP.SQLITE', 'private', 'docs/private/notes.md', '.env'])('denies %j', (relativePath) => {
    expect(matches(relativePath)).toBe(true);
  });

  it.each(['db/app.sqlite-journal.md', 'privateer.md', 'README.md'])('allows %j', (relativePath) => {
    expect(matches(relativePath)).toBe(false);
  });
});
