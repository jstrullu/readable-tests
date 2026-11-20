import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TestResult } from './model';
import { TestProject } from './projects';
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

const ENV = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1' };

export class DotnetTestRunner {
  private readonly procs = new Set<ChildProcess>();
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
  }

  /** À appeler quand un .csproj / .props change : chemins de sortie potentiellement différents. */
  invalidateRunCommands(): void { this.runCommands.clear(); }

  private exec(cmd: string, args: string[], cwd: string, opts: { quiet?: boolean; env?: Record<string, string>; capture?: boolean } = {}): Promise<{ code: number | null; stdout: string }> {
    if (!opts.quiet) { this.log.appendLine(`\n▶ ${cmd} ${args.map(quoteForLog).join(' ')}`); }
    return new Promise(resolve => {
      let stdout = '';
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...ENV, ...opts.env },
        shell: false,
        detached: process.platform !== 'win32', // groupe de processus pour pouvoir tout arrêter
      });
      this.procs.add(child);
      child.stdout.on('data', d => { const s = d.toString(); if (opts.capture) { stdout += s; } if (!opts.quiet) { this.log.append(s); } });
      child.stderr.on('data', d => { if (!opts.quiet) { this.log.append(d.toString()); } });
      child.on('error', err => { this.log.appendLine(t('Error: {0}', err.message)); this.procs.delete(child); resolve({ code: null, stdout }); });
      child.on('close', code => { this.procs.delete(child); resolve({ code, stdout }); });
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
    if (!props.RunCommand) { throw new Error(t('Empty RunCommand for {0}: multi-targeted project? Set csTestViewer.targetFramework.', path.basename(project.path))); }

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
      return { ok: false, error: t('Test binary not found ({0}). Build first or set csTestViewer.build to "auto".', cmd.targetPath) };
    }
    const dir = this.newResultsDir(project);
    const args = [...cmd.args, '--results-directory', dir, '--report-trx', '--report-trx-filename', 'results.trx',
      '--no-progress', '--no-ansi', ...filterArgs, ...extraArgs];
    const res = await this.exec(cmd.command, args, cmd.cwd, { env: cmd.env });
    return this.collect(project, dir, res.code, true);
  }

  /** VSTest : `dotnet test --no-build` (le build a été fait en amont). */
  async runVstest(project: TestProject, o: { dotnetPath: string; configuration: string; framework?: string; filterArgs: string[]; extraArgs: string[] }): Promise<ProjectRunStatus> {
    const dir = this.newResultsDir(project);
    const args = ['test', project.path, '--no-build', '--nologo', '-c', o.configuration, ...(o.framework ? ['-f', o.framework] : []),
      '--logger', 'trx', '--results-directory', dir, ...o.filterArgs, ...o.extraArgs];
    const res = await this.exec(o.dotnetPath, args, path.dirname(project.path));
    return this.collect(project, dir, res.code, false);
  }

  private newResultsDir(project: TestProject): string {
    const dir = path.join(this.resultsRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${path.basename(project.path, path.extname(project.path))}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private collect(project: TestProject, dir: string, exitCode: number | null, mtp: boolean): ProjectRunStatus {
    try {
      if (this.cancelled) { return { ok: false, error: t('Run cancelled.') }; }
      if (exitCode === null) { return { ok: false, error: t('Cannot start the test process.') }; }
      const trxFiles = findTrx(dir);
      if (trxFiles.length === 0) {
        if (mtp && mtpExit(exitCode)) { return { ok: false, error: `${mtpExit(exitCode)} (code ${exitCode})` }; }
        return { ok: false, error: t('No results produced (code {0}): see the output.', exitCode) };
      }
      const results: TestResult[] = [];
      for (const f of trxFiles) { results.push(...parseTrx(fs.readFileSync(f, 'utf8'), project.path)); }
      let warning: string | undefined;
      if (mtp && exitCode === 8) { warning = t('No test matches the filter.'); }
      else if (mtp && mtpExit(exitCode)) { warning = `${mtpExit(exitCode)} ${t('Partial results.')}`; }
      return { ok: true, results, warning };
    } catch (e) {
      return { ok: false, error: t('Cannot read results: {0}', (e as Error).message) };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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

function quoteForLog(a: string): string {
  return /[\s|;"*()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}
