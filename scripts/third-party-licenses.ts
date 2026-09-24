/**
 * Builds `THIRD_PARTY_LICENSES.txt` for the release bundle (M29, M51).
 *
 * A package counts as bundled when its files appear in esbuild's metafile inputs or in the
 * `sources` of the final source map. The second set matters because esbuild chains upstream
 * source maps: `@modelcontextprotocol/*` dist files already inline `ajv`, `fast-uri`, and others,
 * which are not installed here and never show up as metafile inputs.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DetectedPackage {
  name: string;
  /** From the enclosing pnpm directory (`.pnpm/<name>@<version>[_peers]`), when it names this package. */
  version: string | undefined;
  /** Absolute package root as the path spells it; it exists only for installed packages. */
  root: string;
}

export interface VendoredNotice {
  license: string;
  /** `dist.integrity` of the npm tarball the notice was copied from. */
  integrity: string;
}

/**
 * Packages that are not published and ship only inside another package's dist, keyed to that
 * package. Its license section covers them. `@modelcontextprotocol/core-internal` is a private
 * workspace package of the typescript-sdk monorepo (404 on npm) under the same LICENSE.
 */
export const SHIPPED_INSIDE: Readonly<Record<string, string>> = {
  '@modelcontextprotocol/core-internal': '@modelcontextprotocol/server',
};

const NODE_MODULES = 'node_modules/';

/** The innermost package a bundled file belongs to, or undefined for first-party files. */
export function packageFromSourcePath(absPath: string): DetectedPackage | undefined {
  const normalized = absPath.split(path.sep).join('/');
  const index = normalized.lastIndexOf(NODE_MODULES);
  if (index < 0) return undefined;
  const segments = normalized.slice(index + NODE_MODULES.length).split('/');
  const name = segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  if (!name) return undefined;
  const parent = normalized.slice(0, index).split('/').slice(-3, -1);
  let version: string | undefined;
  if (parent[0] === '.pnpm' && parent[1]) {
    const match = /^(.+?)@([^_]+)/.exec(parent[1]);
    if (match?.[1]?.replace('+', '/') === name) version = match[2];
  }
  return { name, version, root: normalized.slice(0, index + NODE_MODULES.length) + name };
}

/** Distinct packages behind the given absolute file paths, keyed by package root. */
export function detectPackages(absPaths: Iterable<string>): DetectedPackage[] {
  const packages = new Map<string, DetectedPackage>();
  for (const file of absPaths) {
    const pkg = packageFromSourcePath(file);
    if (pkg && !packages.has(pkg.root)) packages.set(pkg.root, pkg);
  }
  return [...packages.values()];
}

interface Section {
  key: string;
  name: string;
  license: string;
  texts: string[];
}

async function installedSection(pkg: DetectedPackage): Promise<Section | undefined> {
  const manifestPath = path.join(pkg.root, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name: string; version: string; license?: string };
  const files = (await readdir(pkg.root)).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file)).sort();
  // Redistributing bundled code requires its notice; refuse to ship without one.
  if (files.length === 0) throw new Error(`${manifest.name}@${manifest.version} has no license file`);
  return {
    key: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    license: manifest.license ?? 'unknown',
    texts: await Promise.all(files.map((file) => readFile(path.join(pkg.root, file), 'utf8'))),
  };
}

async function vendoredSection(
  pkg: DetectedPackage,
  noticesDir: string,
  notices: Record<string, VendoredNotice>,
): Promise<Section | undefined> {
  if (!pkg.version) return undefined;
  const key = `${pkg.name}@${pkg.version}`;
  const notice = notices[key];
  if (!notice) return undefined;
  const text = await readFile(path.join(noticesDir, `${key.replace('/', '+')}.txt`), 'utf8');
  return { key, name: pkg.name, license: notice.license, texts: [text] };
}

/**
 * License text for every detected package: from the installed package directory, or from the
 * notices vendored under `noticesDir` for packages that only exist pre-bundled inside another
 * package. Throws when a package has neither.
 */
export async function thirdPartyLicenses(packages: DetectedPackage[], noticesDir: string): Promise<string> {
  const notices = JSON.parse(await readFile(path.join(noticesDir, 'manifest.json'), 'utf8')) as Record<
    string,
    VendoredNotice
  >;
  const names = new Set(packages.map((pkg) => pkg.name));
  const covers = new Map<string, string[]>();
  const sections = new Map<string, Section>();
  for (const pkg of packages) {
    const host = SHIPPED_INSIDE[pkg.name];
    if (host !== undefined) {
      if (!names.has(host)) throw new Error(`${pkg.name} is bundled without ${host}, whose license covers it`);
      covers.set(host, [...(covers.get(host) ?? []), pkg.name]);
      continue;
    }
    const section = (await installedSection(pkg)) ?? (await vendoredSection(pkg, noticesDir, notices));
    if (!section) {
      throw new Error(
        `${pkg.name}@${pkg.version ?? 'unknown'} is bundled but has no license text; ` +
          'vendor it under scripts/third-party-notices/ (M51)',
      );
    }
    sections.set(section.key, section);
  }
  return [...sections.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((section) => {
      const covered = (covers.get(section.name) ?? []).sort();
      const note = covered.length > 0 ? `\nAlso covers ${covered.join(', ')}, shipped inside its dist.\n` : '';
      return `${section.key} (${section.license})\n${note}\n${section.texts.map((text) => text.trim()).join('\n\n')}\n`;
    })
    .join(`\n${'-'.repeat(72)}\n\n`);
}
