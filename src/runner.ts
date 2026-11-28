import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TestResult } from './model';
import { TestProject } from './projects';
import { convertReport, ReporterOutput } from './jsResults';
import { globToRegExpSource, majorVersion, resolveBin } from './nodeProjects';
import { RunTarget } from './model';
import { parseTrx } from './trxParser';
import { t } from './i18n';

export interface Log {
  append(text: string): void;
  appendLine(text: string): void;
}

export type ProjectRunStatus =
  | { ok: true; results: TestResult[]; warning?: string }
  | { ok: false; error: string };

export interface RunCommand { command: string; args: string[]; cwd: string; targetPath: string; env: Record<string, string> }

/** Codes de sortie Microsoft.Testing.Platform → message utile. */
function mtpExit(code: number): string | undefined {
  switch (code) {
    case 3: return t('Run aborted.');
    case 5: return t('Command line option rejected. If it is --report-trx: add the Microsoft.Testing.Extensions.TrxReport package (included in the TUnit meta-package, not in TUnit.Engine alone).');
    case 6: return t('The test process exited unexpectedly (crash).');
    case 7: return t('Minimum expected test count not reached (--minimum-expected-tests).');
    case 9: return t('The test process was stopped (session timeout?).');
    case 10: return t('The test process crashed during cleanup.');
    default: return undefined;
  }
}

/** Codes de sortie de la ligne de commande native xUnit v3 (1 = tests en échec : normal). */
function xunitExit(code: number): string | undefined {
  switch (code) {
    case 3: return t('Command line option rejected by the xUnit runner: see the output.');
    case 4: return t('The xUnit runner failed: see the output.');
    default: return undefined;
  }
}

/** Délai max entre 'exit' et 'close' (sortie gardée ouverte par un petit-enfant). */
const EXIT_DRAIN_MS = 2000;
/** Délai max après une annulation avant de considérer les processus comme terminés. */
const CANCEL_GRACE_MS = 1500;

const ENV = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1' };

export class TestRunner {
  private readonly procs = new Set<ChildProcess>();
  /** Fin forcée des exec() en cours : l'annulation ne dépend pas de la fermeture effective des processus. */
  private readonly pending = new Set<() => void>();
  private cancelled = false;
  private readonly runCommands = new Map<string, RunCommand>();

  constructor(private readonly log: Log, private readonly resultsRoot: string) {}

  get isRunning(): boolean { return this.procs.size > 0; }
  resetCancel(): void { this.cancelled = false; }
  get wasCancelled(): boolean { return this.cancelled; }

  cancel(): void {
    this.cancelled = true;
    for (const p of this.procs) {
      if (p.pid === undefined) { continue; }
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
      } else {
        try { process.kill(-p.pid, 'SIGTERM'); } catch { p.kill('SIGTERM'); }
      }
    }
    // Un processus tué peut tarder à « fermer » (taskkill lent, petit-enfant qui garde la sortie
    // ouverte) : on n'attend pas plus de CANCEL_GRACE_MS pour rendre la main. Seuls les exec en cours
    // au moment de l'annulation sont concernés, pas ceux d'une exécution relancée entre-temps.
    const stale = [...this.pending];
    setTimeout(() => stale.forEach(finish => finish()), CANCEL_GRACE_MS);
  }

  /** À appeler quand un .csproj / .props change : chemins de sortie potentiellement différents. */
  invalidateRunCommands(): void { this.runCommands.clear(); }

  private exec(cmd: string, args: string[], cwd: string, opts: { quiet?: boolean; env?: Record<string, string>; capture?: boolean } = {}): Promise<{ code: number | null; stdout: string }> {
    if (!opts.quiet) { this.log.appendLine(`\n▶ ${cmd} ${args.map(quoteForLog).join(' ')}`); }
    return new Promise(resolve => {
      let stdout = '';
      let done = false;
      let drain: NodeJS.Timeout | undefined;
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...ENV, ...opts.env },
        shell: false,
        detached: process.platform !== 'win32', // groupe de processus pour pouvoir tout arrêter
      });
      const finish = (code: number | null) => {
        if (done) { return; }
        done = true;
        clearTimeout(drain);
        this.procs.delete(child);
        this.pending.delete(abort);
        resolve({ code, stdout });
      };
      const abort = () => finish(null);
      this.procs.add(child);
      this.pending.add(abort);
      child.stdout.on('data', d => { const s = d.toString(); if (opts.capture) { stdout += s; } if (!opts.quiet) { this.log.append(s); } });
      child.stderr.on('data', d => { if (!opts.quiet) { this.log.append(d.toString()); } });
      child.on('error', err => { this.log.appendLine(t('Error: {0}', err.message)); finish(null); });
      // 'close' attend la fermeture de stdout/stderr : un processus lancé par le test (serveur, conteneur…)
      // qui hérite de la sortie la garde ouverte indéfiniment. Passé un délai après 'exit', on n'attend plus.
      child.on('exit', code => { drain = setTimeout(() => finish(code), EXIT_DRAIN_MS); });
      child.on('close', code => finish(code));
    });
  }

  /** Un seul `dotnet build` (projet ou solution). */
  async build(target: string, o: { dotnetPath: string; configuration: string; framework?: string; restore: boolean; extraArgs: string[] }): Promise<{ ok: boolean; errors: string[] }> {
    const args = ['build', target, '-nologo', '-v:q', '-clp:NoSummary', '-c', o.configuration,
      ...(o.framework ? ['-f', o.framework] : []), ...(o.restore ? [] : ['--no-restore']), ...o.extraArgs];
    const res = await this.exec(o.dotnetPath, args, path.dirname(target), { capture: true });
    if (res.code === 0) { return { ok: true, errors: [] }; }
    if (res.code === null) { return { ok: false, errors: [t('Cannot start "{0}".', o.dotnetPath)] }; }
    const errors = [...new Set(res.stdout.split(/\r?\n/).filter(l => /:\s*error\s+[A-Z]+\d+/.test(l)).map(l => l.trim().replace(/\s*\[[^\]]+\]$/, '')))];
    return { ok: false, errors: errors.length ? errors.slice(0, 5) : [t('Build failed (code {0}).', res.code)] };
  }

  /**
   * Commande exacte qu'utiliserait `dotnet run` (RunCommand/RunArguments), obtenue une fois par
   * évaluation MSBuild puis mise en cache : les exécutions suivantes lancent directement le binaire.
   */
  async resolveRunCommand(project: TestProject, o: { dotnetPath: string; configuration: string; framework?: string }): Promise<RunCommand> {
    const key = `${project.path}|${o.configuration}|${o.framework ?? ''}`;
    const cached = this.runCommands.get(key);
    if (cached) { return cached; }

    const args = ['msbuild', project.path, '-nologo',
      '-getProperty:RunCommand', '-getProperty:RunArguments', '-getProperty:RunWorkingDirectory', '-getProperty:TargetPath',
      `-p:Configuration=${o.configuration}`, ...(o.framework ? [`-p:TargetFramework=${o.framework}`] : [])];
    const res = await this.exec(o.dotnetPath, args, path.dirname(project.path), { quiet: true, capture: true });
    let props: Record<string, string>;
    try {
      props = JSON.parse(res.stdout.substring(res.stdout.indexOf('{'))).Properties;
    } catch {
      throw new Error(t('MSBuild evaluation failed for {0} (code {1}).', path.basename(project.path), String(res.code)));
    }
    if (!props.RunCommand) { throw new Error(t('Empty RunCommand for {0}: multi-targeted project? Set readableTests.targetFramework.', path.basename(project.path))); }

    const cmd: RunCommand = {
      command: props.RunCommand,
      args: splitArgs(props.RunArguments ?? ''),
      cwd: props.RunWorkingDirectory || path.dirname(props.TargetPath),
      targetPath: props.TargetPath,
      env: readLaunchSettingsEnv(project.path, this.log),
    };
    this.runCommands.set(key, cmd);
    return cmd;
  }

  /** MTP : lancement direct du binaire de test (pas de MSBuild). */
  async runMtp(project: TestProject, cmd: RunCommand, filterArgs: string[], extraArgs: string[]): Promise<ProjectRunStatus> {
    if (!fs.existsSync(cmd.targetPath)) {
      return { ok: false, error: t('Test binary not found ({0}). Build first or set readableTests.build to "auto".', cmd.targetPath) };
    }
    const dir = this.newResultsDir(project);
    const args = [...cmd.args, '--results-directory', dir, '--report-trx', '--report-trx-filename', 'results.trx',
      '--no-progress', '--no-ansi', ...filterArgs, ...extraArgs];
    const res = await this.exec(cmd.command, args, cmd.cwd, { env: cmd.env });
    return this.collect(project, dir, res.code, mtpExit, 8);
  }

  /**
   * xUnit v3 sans MTP : ligne de commande native du binaire. `-result-trx` (3.x+) remplace `-trx`,
   * déprécié puis retiré : on retente avec l'ancien nom si le binaire ne connaît pas le nouveau.
   */
  async runXunit(project: TestProject, cmd: RunCommand, filterArgs: string[], extraArgs: string[]): Promise<ProjectRunStatus> {
    if (!fs.existsSync(cmd.targetPath)) {
      return { ok: false, error: t('Test binary not found ({0}). Build first or set readableTests.build to "auto".', cmd.targetPath) };
    }
    const dir = this.newResultsDir(project);
    const run = (trxSwitch: string) => this.exec(cmd.command,
      [...cmd.args, '-noLogo', '-noColor', trxSwitch, path.join(dir, 'results.trx'), ...filterArgs, ...extraArgs],
      cmd.cwd, { env: cmd.env, capture: true });
    let res = await run('-result-trx');
    if (res.code === 3 && /unknown option: -result-trx/i.test(res.stdout)) { res = await run('-trx'); }
    return this.collect(project, dir, res.code, xunitExit);
  }

  /** VSTest : `dotnet test --no-build` (le build a été fait en amont). */
  async runVstest(project: TestProject, o: { dotnetPath: string; configuration: string; framework?: string; filterArgs: string[]; extraArgs: string[] }): Promise<ProjectRunStatus> {
    const dir = this.newResultsDir(project);
    const args = ['test', project.path, '--no-build', '--nologo', '-c', o.configuration, ...(o.framework ? ['-f', o.framework] : []),
      '--logger', 'trx', '--results-directory', dir, ...o.filterArgs, ...o.extraArgs];
    const res = await this.exec(o.dotnetPath, args, path.dirname(project.path));
    return this.collect(project, dir, res.code);
  }

  /**
   * JavaScript : Vitest, Jest ou `ng test` lancés avec node (binaire local, pas de shell) et le reporter
   * embarqué de l'extension, qui écrit un JSON normalisé dans READABLE_TESTS_OUTPUT.
   */
  /**
   * @param o.exclude globs de fichiers de test à ne jamais lancer (relatifs à la racine du projet),
   *   ajoutés aux exclusions propres au projet
   */
  async runNode(project: TestProject, target: RunTarget, o: { nodePath: string; reportersDir: string; extraArgs: string[]; exclude: string[] }): Promise<ProjectRunStatus> {
    const root = project.root!;
    const dir = this.newResultsDir(project);
    const output = path.join(dir, 'results.json');
    const sel = jsSelection(target, root, project);

    let script: { script: string; version: string } | undefined;
    let args: string[];
    const env: Record<string, string> = { READABLE_TESTS_OUTPUT: output, NO_COLOR: '1', FORCE_COLOR: '0', NG_CLI_ANALYTICS: 'false' };
    if (project.runner === 'jest') {
      script = resolveBin(root, 'jest', 'jest');
      // --filter (module) plutôt que --testPathIgnorePatterns, qui remplacerait celui de la configuration.
      const filter = o.exclude.length ? [`--filter=${path.join(o.reportersDir, 'jest-filter.cjs')}`] : [];
      env.READABLE_TESTS_EXCLUDE = JSON.stringify(o.exclude.map(globToRegExpSource));
      env.READABLE_TESTS_JEST_MAJOR = String(script ? majorVersion(script.version) : 30);
      args = ['--ci', '--testLocationInResults', '--passWithNoTests', '--reporters=default', `--reporters=${path.join(o.reportersDir, 'jest.cjs')}`, ...filter,
        ...(sel.pattern ? ['-t', sel.pattern] : []), ...o.extraArgs, ...(sel.files.length ? ['--runTestsByPath', ...sel.files] : [])];
    } else if (project.runner === 'angular') {
      script = resolveBin(root, '@angular/cli', 'ng');
      // --exclude remplace l'option d'angular.json : on la reprend.
      const exclude = o.exclude.length ? [...new Set([...(project.angularExclude ?? []), ...o.exclude])] : [];
      args = ['test', project.angularProject!, '--no-watch', '--no-progress', '--reporters=default', `--reporters=${path.join(o.reportersDir, 'vitest.mjs')}`,
        ...sel.files.map(f => `--include=${f}`), ...exclude.map(g => `--exclude=${g}`), ...(sel.pattern ? [`--filter=${sel.pattern}`] : []), ...o.extraArgs];
    } else {
      script = resolveBin(root, 'vitest', 'vitest');
      const withLocation = script && majorVersion(script.version) >= 4 ? ['--includeTaskLocation'] : [];
      // --exclude de Vitest s'ajoute aux exclusions de la configuration.
      args = ['run', '--reporter=default', `--reporter=${path.join(o.reportersDir, 'vitest.mjs')}`, '--passWithNoTests', ...withLocation,
        ...o.exclude.map(g => `--exclude=${g}`), ...(sel.pattern ? ['-t', sel.pattern] : []), ...o.extraArgs, ...sel.files];
    }
    if (!script) {
      fs.rmSync(dir, { recursive: true, force: true });
      const pkg = project.runner === 'angular' ? '@angular/cli' : project.runner;
      return { ok: false, error: t('{0} is not installed in {1}: run npm install.', pkg, root) };
    }

    const res = await this.exec(o.nodePath, [script.script, ...args], root, { env });
    try {
      if (this.cancelled) { return { ok: false, error: t('Run cancelled.') }; }
      if (res.code === null) { return { ok: false, error: t('Cannot start "{0}".', o.nodePath) }; }
      if (!fs.existsSync(output)) { return { ok: false, error: t('No results produced (code {0}): see the output.', res.code) }; }
      const report = JSON.parse(fs.readFileSync(output, 'utf8')) as ReporterOutput;
      return { ok: true, results: convertReport(report, project.path, root) };
    } catch (e) {
      return { ok: false, error: t('Cannot read results: {0}', (e as Error).message) };
    } finally {
      // Après annulation, un processus encore en train de mourir peut verrouiller le dossier (Windows).
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* nettoyé au prochain démarrage */ }
    }
  }

  private newResultsDir(project: TestProject): string {
    const dir = path.join(this.resultsRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${path.basename(project.path, path.extname(project.path))}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * @param exitMessage message associé à un code de sortie anormal (MTP, xUnit natif)
   * @param noMatchCode code de sortie « aucun test ne correspond au filtre »
   */
  private collect(project: TestProject, dir: string, exitCode: number | null,
    exitMessage: (code: number) => string | undefined = () => undefined, noMatchCode?: number): ProjectRunStatus {
    try {
      if (this.cancelled) { return { ok: false, error: t('Run cancelled.') }; }
      if (exitCode === null) { return { ok: false, error: t('Cannot start the test process.') }; }
      const trxFiles = findTrx(dir);
      if (trxFiles.length === 0) {
        if (exitMessage(exitCode)) { return { ok: false, error: `${exitMessage(exitCode)} (code ${exitCode})` }; }
        return { ok: false, error: t('No results produced (code {0}): see the output.', exitCode) };
      }
      const results: TestResult[] = [];
      for (const f of trxFiles) { results.push(...parseTrx(fs.readFileSync(f, 'utf8'), project.path)); }
      let warning: string | undefined;
      if (noMatchCode !== undefined && exitCode === noMatchCode) { warning = t('No test matches the filter.'); }
      else if (exitMessage(exitCode)) { warning = `${exitMessage(exitCode)} ${t('Partial results.')}`; }
      return { ok: true, results, warning };
    } catch (e) {
      return { ok: false, error: t('Cannot read results: {0}', (e as Error).message) };
    } finally {
      // Après annulation, un processus encore en train de mourir peut verrouiller le dossier (Windows).
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* nettoyé au prochain démarrage */ }
    }
  }
}

/** Variables d'environnement du premier profil "Project" de launchSettings.json (comme `dotnet run`). */
export function readLaunchSettingsEnv(csproj: string, log?: Log): Record<string, string> {
  const file = path.join(path.dirname(csproj), 'Properties', 'launchSettings.json');
  if (!fs.existsSync(file)) { return {}; }
  try {
    const json = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    const entry = Object.entries<any>(json.profiles ?? {}).find(([, p]) => p?.commandName === 'Project');
    if (!entry) { return {}; }
    const env = Object.fromEntries(Object.entries<any>(entry[1].environmentVariables ?? {}).map(([k, v]) => [k, String(v)]));
    if (Object.keys(env).length) { log?.appendLine(t('launchSettings.json: profile "{0}" ({1})', entry[0], Object.keys(env).join(', '))); }
    return env;
  } catch (e) {
    log?.appendLine(t('launchSettings.json ignored: {0}', (e as Error).message));
    return {};
  }
}

/** Retire les commentaires // et /* *\/ hors chaînes (launchSettings.json les tolère). */
export function stripJsonComments(s: string): string {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { out += c; if (c === '\\') { out += s[++i] ?? ''; } else if (c === '"') { inStr = false; } continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') { i++; } out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { i++; } i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Découpe RunArguments ("exec \"C:\\x y\\a.dll\"") en respectant les guillemets. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '', inQ = false, has = false;
  for (const c of s) {
    if (c === '"') { inQ = !inQ; has = true; continue; }
    if (/\s/.test(c) && !inQ) { if (has || cur) { out.push(cur); } cur = ''; has = false; continue; }
    cur += c;
  }
  if (has || cur) { out.push(cur); }
  return out;
}

function findTrx(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); } else if (e.name.toLowerCase().endsWith('.trx')) { out.push(p); }
    }
  };
  walk(dir);
  return out;
}

/**
 * Argument cité pour la ligne « ▶ commande » du journal, copiable dans un terminal.
 * Règles de CommandLineToArgvW : les \ ne sont doublés que devant un " (échappé) ou en fin
 * d'argument (devant le " fermant) ; ailleurs, un chemin Windows reste lisible.
 */
export function quoteForLog(a: string): string {
  if (a !== '' && !/[\s|;"'*()&<>^]/.test(a)) { return a; }
  let out = '';
  let slashes = 0;
  for (const c of a) {
    if (c === '\\') { slashes++; continue; }
    if (c === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; }
    else { out += '\\'.repeat(slashes) + c; }
    slashes = 0;
  }
  return `"${out}${'\\'.repeat(slashes * 2)}"`;
}

function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Fichiers et motif de nom pour une cible JS. Le motif est ancré en fin seulement :
 * selon les versions, Vitest préfixe le nom complet (espace, nom de fichier…).
 */
export function jsSelection(target: RunTarget, root: string, project: Pick<TestProject, 'runner' | 'angularRoot'>): { files: string[]; pattern?: string } {
  if (target.kind !== 'js') { return { files: [] }; }
  const base = project.runner === 'angular' ? path.join(root, project.angularRoot ?? '') : root;
  const files = [...new Set(target.tests.map(x => path.relative(base, x.file).split(path.sep).join('/')))];
  // Un fichier entier demandé (erreur de chargement) : pas de filtre de nom.
  if (target.tests.some(x => x.path.length === 0)) { return { files }; }
  // Séparateur du nom complet : " > " (Vitest ≥ 3/4, Angular) ou espace (Vitest ≤ 2, Jest) → on accepte les deux.
  const names = [...new Set(target.tests.map(x => x.path.map(escapeRegex).join('(?: > | )')))];
  return { files, pattern: names.length ? `(?:${names.join('|')})$` : undefined };
}
