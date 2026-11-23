import * as fs from 'fs';
import * as path from 'path';
import { TestProject } from './projects';
import { stripJsonComments } from './runner';

function readJson(file: string): any {
  try { return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))); } catch { return undefined; }
}

function hasAny(dir: string, names: string[]): boolean {
  return names.some(n => fs.existsSync(path.join(dir, n)));
}

const EXT = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const configFiles = (base: string) => EXT.map(e => `${base}.${e}`);

/**
 * Projets de test JavaScript d'un dossier contenant un package.json :
 * - Angular CLI : chaque projet d'angular.json dont la cible "test" utilise @angular/build:unit-test (Vitest) ;
 * - Vitest : dépendance vitest + config vitest/vite ou script de test "vitest" (hors Angular CLI) ;
 * - Jest : dépendance jest + config jest, clé "jest" du package.json ou script de test "jest".
 */
export function inspectNodeFolder(dir: string): TestProject[] {
  const pkgFile = path.join(dir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) { return []; }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScript: string = pkg.scripts?.test ?? '';
  const out: TestProject[] = [];

  const ng = fs.existsSync(path.join(dir, 'angular.json')) ? readJson(path.join(dir, 'angular.json')) : undefined;
  let angularVitest = false;
  for (const [name, proj] of Object.entries<any>(ng?.projects ?? {})) {
    const test = proj?.architect?.test ?? proj?.targets?.test;
    if (test?.builder !== '@angular/build:unit-test') { continue; }
    if ((test.options?.runner ?? 'vitest') !== 'vitest') { continue; }
    angularVitest = true;
    out.push({
      path: `${path.join(dir, 'angular.json')}#${name}`,
      runner: 'angular', framework: 'vitest', targetFrameworks: [],
      root: dir, label: name, angularProject: name, angularRoot: proj.root ?? '',
      angularExclude: Array.isArray(test.options?.exclude) ? test.options.exclude : [],
    });
  }

  const vitestConfig = hasAny(dir, [...configFiles('vitest.config'), ...configFiles('vitest.workspace'), ...configFiles('vite.config')]);
  if (deps.vitest && !angularVitest && (vitestConfig || /\bvitest\b/.test(testScript))) {
    out.push({ path: pkgFile, runner: 'vitest', framework: 'vitest', targetFrameworks: [], root: dir, label: pkg.name || path.basename(dir) });
  }

  const jestConfig = hasAny(dir, [...configFiles('jest.config'), 'jest.config.json']) || !!pkg.jest;
  if (deps.jest && (jestConfig || /\bjest\b/.test(testScript))) {
    out.push({ path: out.some(p => p.path === pkgFile) ? `${pkgFile}#jest` : pkgFile, runner: 'jest', framework: 'jest', targetFrameworks: [], root: dir, label: pkg.name || path.basename(dir) });
  }
  return out;
}

/** Paquet installé, cherché dans les node_modules en remontant (monorepos avec dépendances remontées). */
export function findPackage(fromDir: string, name: string): { dir: string; json: any } | undefined {
  let dir = fromDir;
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) { return { dir: path.dirname(p), json: readJson(p) }; }
    const parent = path.dirname(dir);
    if (parent === dir) { return undefined; }
    dir = parent;
  }
}

/** Script JS du binaire d'un paquet (lancé avec node : pas de .cmd sous Windows, pas de shell). */
export function resolveBin(fromDir: string, pkgName: string, binName: string): { script: string; version: string } | undefined {
  const pkg = findPackage(fromDir, pkgName);
  if (!pkg?.json) { return undefined; }
  const bin = typeof pkg.json.bin === 'string' ? pkg.json.bin : pkg.json.bin?.[binName];
  if (!bin) { return undefined; }
  return { script: path.join(pkg.dir, bin), version: String(pkg.json.version ?? '0') };
}

export function majorVersion(v: string): number { return parseInt(v.split('.')[0], 10) || 0; }

/** Binaire du runner d'un projet JS (undefined si les dépendances ne sont pas installées). */
export function nodeRunnerBin(p: TestProject): { script: string; version: string } | undefined {
  const root = p.root ?? '';
  if (p.runner === 'angular') { return resolveBin(root, '@angular/cli', 'ng'); }
  if (p.runner === 'jest') { return resolveBin(root, 'jest', 'jest'); }
  if (p.runner === 'vitest') { return resolveBin(root, 'vitest', 'vitest'); }
  return undefined;
}

/**
 * Glob (relatif à la racine du projet) → expression régulière, pour le filtre Jest.
 * `**` traverse les dossiers, `*` et `?` restent dans un segment.
 */
export function globToRegExpSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
    } else if (c === '*') { re += '[^/]*'; }
    else if (c === '?') { re += '[^/]'; }
    else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  }
  return `^${re}$`;
}
