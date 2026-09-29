import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findCredentialPattern } from '../src/policy/content-patterns.js';
import { FAKE_CREDENTIALS, testGitEnv } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('findCredentialPattern', () => {
  it.each(Object.entries(FAKE_CREDENTIALS))('finds %s and returns its pattern id', (id, value) => {
    expect(findCredentialPattern(value)).toBe(id);
    expect(findCredentialPattern(`{\n  "API_KEY": "${value}"\n}\n`)).toBe(id);
    expect(findCredentialPattern(`export KEY=${value}`)).toBe(id);
  });

  it.each([
    ['openai legacy', 'sk-' + 'A1b2C3d4E5f6G7h8I9j0' + 'T3Blbk' + 'FJ' + 'A1b2C3d4E5f6G7h8I9j0', 'openai'],
    ['openai service account', 'sk-' + 'svcacct-' + 'Ab1_-'.repeat(10), 'openai'],
    ['github fine-grained', 'github' + '_pat_' + 'Ab1_'.repeat(21), 'github'],
    ['github app', 'gh' + 's_' + 'A1b2'.repeat(9), 'github'],
    ['slack user', 'xo' + 'xp-' + '1234567890-' + '1234567890-' + '1234567890-' + 'a1b2'.repeat(8), 'slack'],
    ['aws temporary', 'AS' + 'IA' + 'Z7Q2'.repeat(4), 'aws_access_key_id'],
    ['rsa key', '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIEow'.repeat(10), 'private_key'],
    ['pkcs8 key, CRLF', '-----BEGIN ' + 'PRIVATE KEY-----\r\n' + 'MIIEow'.repeat(10), 'private_key'],
    [
      'encrypted PEM with headers',
      '-----BEGIN ' + 'RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00FF\n\n' + 'MIIEow'.repeat(10),
      'private_key',
    ],
  ])('finds the %s form', (_, value, id) => {
    expect(findCredentialPattern(value)).toBe(id);
  });

  // The documented AWS example key id has the real format, so it is blocked like a real one (ADR-010 §3.3).
  it('treats the AWS documentation example as a credential', () => {
    expect(findCredentialPattern('AK' + 'IA' + 'IOSFODNN7EXAMPLE')).toBe('aws_access_key_id');
  });

  it.each([
    ['a bare prefix in prose', 'Anthropic keys start with sk-ant- and GitHub tokens with ghp_.'],
    ['a short placeholder', 'API_KEY=' + 'sk-' + 'ant-xxxxxxxx'],
    ['a tail one character short', 'gh' + 'p_' + 'A1b2'.repeat(9).slice(1)],
    ['a gitlab tail one character short', 'gl' + 'pat-' + 'Ab1-'.repeat(5).slice(1)],
    ['a prefix inside a word', 'x' + 'AK' + 'IA' + 'Z7Q2'.repeat(4)],
    ['an AWS-like run that is too long', 'AK' + 'IA' + 'Z7Q2'.repeat(4) + 'Q'],
    ['the tavily docs placeholder', 'tv' + 'ly-' + 'AbCdEfGh12345678'],
    ['a PEM header in a string literal', "const header = '-----BEGIN " + "PRIVATE KEY-----\\n' + body;"],
    ['a truncated PEM sample', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'],
    ['a public key', '-----BEGIN ' + 'PUBLIC KEY-----\n' + 'MIIBIj'.repeat(10)],
    ['ordinary code', 'const apiKey = process.env.API_KEY;\n'],
  ])('ignores %s', (_, text) => {
    expect(findCredentialPattern(text)).toBeUndefined();
  });

  it('stays linear on adversarial input near the read limit', () => {
    const inputs = [
      ('sk-' + 'ant-' + 'a'.repeat(30) + ' ').repeat(30_000),
      ('-----BEGIN ' + 'PRIVATE KEY-----\n' + 'A'.repeat(30) + '\n').repeat(20_000),
      ('xo' + 'xb-' + '1'.repeat(40)).repeat(25_000),
      'AK' + 'IA'.repeat(500_000),
    ];
    for (const input of inputs) {
      const startedAt = performance.now();
      expect(findCredentialPattern(input)).toBeUndefined();
      expect(performance.now() - startedAt).toBeLessThan(1000);
    }
  });

  // M75: an agent using this repository as its workspace must be able to read every file in it.
  it('finds nothing in the tracked files of this repository', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, env: testGitEnv(), encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) => {
      let text: string;
      try {
        // Like the server: only files that decode as UTF-8 are scanned.
        text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path.join(projectRoot, file)));
      } catch {
        return [];
      }
      const pattern = findCredentialPattern(text);
      return pattern === undefined ? [] : [`${file}: ${pattern}`];
    });
    expect(hits).toEqual([]);
  });
});
