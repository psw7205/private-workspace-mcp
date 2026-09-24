/**
 * Sensitive names that are never read, written, or listed. Operators can add
 * patterns (WORKSPACE_EXTRA_DENY_PATTERNS) but cannot remove these.
 *
 * Each pattern is a glob (only `*` is special) matched case-insensitively against
 * every segment of a workspace-relative path, so `.ssh` also covers `.ssh/**` and
 * `a/.ssh/config`. This is defense-in-depth, not the security boundary (PRD 9).
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '.ssh',
  '.aws',
  '.gnupg',
  '.npmrc',
  '.netrc',
  'credentials*',
  'secret*',
  // Not in the PRD examples: hooks are executed by the user's next git command,
  // and .git/config can hold credentials. Git access is deferred to a typed tool.
  '.git',
  '.git-credentials',
  // Credential files commonly found outside the directories above.
  'service-account*.json',
  'id_rsa*',
  'id_ed25519*',
  '*.tfstate',
  '*.tfstate.*',
  '.kube',
  'kubeconfig*',
  '.docker',
  '.pypirc',
  '*.p12',
  '*.pfx',
];

export type DenyMatcher = (relativePath: string) => boolean;

/** `relativePath` uses `/` separators; `.` denotes the workspace root. */
export function createDenyMatcher(patterns: readonly string[]): DenyMatcher {
  // `s`: host names can contain line terminators, and `*` must match them too (M64).
  const regexes = patterns.map((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'is'));
  return (relativePath) => relativePath.split('/').some((segment) => regexes.some((regex) => regex.test(segment)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const isDenied: DenyMatcher = createDenyMatcher(DEFAULT_DENY_PATTERNS);
