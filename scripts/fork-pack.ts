// Packs built packages as @rangeraidev/betteroffice-<name> tarballs for GitHub Packages.
// Usage: bun scripts/fork-pack.ts <prerelease-suffix> <out-dir> [root...]
// Consumers alias them back: "@betteroffice/docx-react": "npm:@rangeraidev/betteroffice-docx-react@<version>".
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  repository?: unknown;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const SCOPE = '@rangeraidev';
const REGISTRY = 'https://npm.pkg.github.com';
const REPO = 'https://github.com/RangerAIDev/betteroffice';
const DEFAULT_ROOTS = ['docx-react', 'xlsx-react', 'fonts'];

const [suffix, outArg, ...rootArgs] = process.argv.slice(2);
if (!suffix || !/^[0-9A-Za-z.-]+$/.test(suffix) || !outArg) {
  console.error('usage: bun scripts/fork-pack.ts <prerelease-suffix> <out-dir> [root...]');
  process.exit(1);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const roots = (rootArgs.length ? rootArgs : DEFAULT_ROOTS).map((r) =>
  r.startsWith('@betteroffice/') ? r : `@betteroffice/${r}`,
);

const manifests = new Map<string, { dir: string; json: Manifest }>();
for (const dir of readdirSync('packages')) {
  const path = join('packages', dir, 'package.json');
  if (!existsSync(path)) continue;
  const json = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  manifests.set(json.name, { dir: join('packages', dir), json });
}

const selected = new Set<string>();
const visit = (name: string) => {
  if (selected.has(name)) return;
  const entry = manifests.get(name);
  if (!entry) throw new Error(`unknown package ${name}`);
  selected.add(name);
  for (const dep of Object.keys(entry.json.dependencies ?? {})) {
    if (manifests.has(dep)) visit(dep);
  }
};
roots.forEach(visit);

const forkName = (name: string) => `${SCOPE}/betteroffice-${name.slice('@betteroffice/'.length)}`;
const forkVersion = (name: string) => `${manifests.get(name)!.json.version}-${suffix}`;

function rewrite(deps: Record<string, string> | undefined, peer: boolean) {
  if (!deps) return;
  for (const [dep, range] of Object.entries(deps)) {
    if (!manifests.has(dep)) continue;
    if (selected.has(dep) && !peer) {
      deps[dep] = `npm:${forkName(dep)}@${forkVersion(dep)}`;
    } else if (range.startsWith('workspace:')) {
      const rest = range.slice('workspace:'.length);
      const version = manifests.get(dep)!.json.version;
      deps[dep] = rest === '*' || rest === '' ? version : rest === '^' || rest === '~' ? rest + version : rest;
    }
  }
}

const SECRET_FILE = /(^|\/)(\.npmrc|\.env(\..*)?|\.netrc|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx))$/i;
const SECRET_TEXT =
  /(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|_authToken=)/;

function assertNoSecrets(dir: string) {
  const [pack] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' }),
  ) as [{ files: { path: string }[] }];
  for (const { path } of pack.files) {
    if (SECRET_FILE.test(path)) throw new Error(`${dir}: refusing to pack ${path}`);
    const full = join(dir, path);
    if (statSync(full).size > 64 * 1024 * 1024) continue;
    const hit = SECRET_TEXT.exec(readFileSync(full).toString('latin1'));
    if (hit) throw new Error(`${dir}: ${path} contains what looks like a credential (${hit[0].slice(0, 8)}…)`);
  }
}

const packed: { name: string; alias: string; spec: string; tarball: string }[] = [];
for (const name of selected) {
  const { dir } = manifests.get(name)!;
  const original = readFileSync(join(dir, 'package.json'), 'utf8');
  const out: Manifest = JSON.parse(original);
  out.name = forkName(name);
  out.version = forkVersion(name);
  delete out.private;
  delete out.devDependencies;
  out.repository = { type: 'git', url: `git+${REPO}.git`, directory: dir };
  out.publishConfig = { registry: REGISTRY };
  rewrite(out.dependencies, false);
  rewrite(out.optionalDependencies, false);
  rewrite(out.peerDependencies, true);

  writeFileSync(join(dir, 'package.json'), JSON.stringify(out, null, 2) + '\n');
  try {
    assertNoSecrets(dir);
    const [result] = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir], {
        cwd: dir,
        encoding: 'utf8',
      }),
    ) as [{ filename: string }];
    packed.push({ name, alias: out.name, spec: `npm:${out.name}@${out.version}`, tarball: result.filename });
  } finally {
    writeFileSync(join(dir, 'package.json'), original);
  }
}

writeFileSync(join(outDir, 'packages.json'), JSON.stringify(packed, null, 2) + '\n');
for (const p of packed) console.log(`"${p.name}": "${p.spec}"`);
