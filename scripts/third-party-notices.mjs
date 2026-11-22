// Génère ThirdPartyNotices.txt à partir des dépendances de production réellement installées
// (celles qu'esbuild embarque dans dist/extension.js). Lancé avant chaque empaquetage.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const seen = new Map();

function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) { return dirname(p); }
    if (dirname(dir) === dir) { throw new Error(`Dependency not installed: ${name} (run npm ci)`); }
  }
}

function visit(name, fromDir) {
  const dir = locate(name, fromDir);
  if (seen.has(dir)) { return; }
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  seen.set(dir, meta);
  for (const dep of Object.keys(meta.dependencies ?? {})) { visit(dep, dir); }
}

for (const dep of Object.keys(pkg.dependencies ?? {})) { visit(dep, root); }

const repoUrl = m => (typeof m.repository === 'string' ? m.repository : m.repository?.url ?? m.homepage ?? '')
  .replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
const licenseText = (dir, m) => {
  const f = readdirSync(dir).find(n => /^(licen[cs]e|copying)(\.|$)/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').trim() : `License: ${m.license ?? 'UNKNOWN'} (no license file in the package)`;
};

const entries = [...seen.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
let out = 'This extension bundles the following third-party software.\n';
for (const [dir, m] of entries) {
  out += `\n\n${m.name} ${m.version} — ${m.license ?? 'UNKNOWN'} — ${repoUrl(m)}\n${'-'.repeat(74)}\n${licenseText(dir, m)}\n`;
}
writeFileSync(join(root, 'ThirdPartyNotices.txt'), out);
console.log(`ThirdPartyNotices.txt: ${entries.map(([, m]) => `${m.name}@${m.version}`).join(', ')}`);
