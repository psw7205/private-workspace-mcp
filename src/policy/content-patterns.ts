/**
 * High-confidence credential formats (ADR-010 §3.2). A file whose text contains one is treated
 * like a denied path: read_file and the write tools refuse it and search_text skips it. This is a
 * backstop for secrets in ordinarily named files, not the security boundary.
 *
 * Every pattern is a fixed provider prefix plus a minimum tail, must not follow a letter or digit,
 * and has no nested quantifiers, so a scan is linear in the text. Tail minimums are no longer than
 * the gitleaks rules require (config/gitleaks.toml, commit b58d3f1), so a provider lengthening its
 * keys is still caught; matching stops at the minimum, which is enough to detect a key. Tavily
 * publishes no format, so its minimum is a conservative guess that skips the documented
 * `tvly-` + 16 character placeholder (M71).
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [id: string, source: string]> = [
  // gitleaks: sk-ant-api03-/sk-ant-admin01- + 93 + AA; any 40 cover both without pinning the version.
  ['anthropic', 'sk-ant-[A-Za-z0-9_-]{40}'],
  // gitleaks: project, service account, and admin keys carry 58+ characters before a T3BlbkFJ marker.
  ['openai', 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40}|sk-[A-Za-z0-9]{20}T3BlbkFJ'],
  ['github', 'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}'],
  ['gitlab', 'glpat-[A-Za-z0-9_-]{20}'],
  // Bot, user, and workspace tokens all start with a numeric id after the prefix.
  ['slack', 'xox[abp]-[0-9]+-[A-Za-z0-9-]{18}'],
  // Exactly 20 characters, so a longer uppercase identifier does not match.
  ['aws_access_key_id', '(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])'],
  ['google_api_key', 'AIza[0-9A-Za-z_-]{35}'],
  ['tavily', 'tvly-[A-Za-z0-9_-]{24}'],
  // The header must end its line and be followed by base64 (optionally after the legacy
  // encryption headers), so code that only names the header is not blocked.
  [
    'private_key',
    '-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----\\r?\\n' +
      '(?:Proc-Type:[^\\r\\n]*\\r?\\nDEK-Info:[^\\r\\n]*\\r?\\n\\r?\\n)?[A-Za-z0-9+/=]{40}',
  ],
];

const CREDENTIAL_REGEX = new RegExp(
  CREDENTIAL_PATTERNS.map(([id, source]) => `(?<${id}>(?<![A-Za-z0-9])(?:${source}))`).join('|'),
);

/** Returns the id of the first credential pattern found in `text`, or undefined. Never the value. */
export function findCredentialPattern(text: string): string | undefined {
  const groups = CREDENTIAL_REGEX.exec(text)?.groups;
  if (groups === undefined) return undefined;
  return CREDENTIAL_PATTERNS.find(([id]) => groups[id] !== undefined)?.[0];
}
