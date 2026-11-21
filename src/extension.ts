import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BuildTracker, buildSettings, pickSolution, pool } from './buildTracker';
import { InlineErrors } from './decorations';
import { DetailsView } from './details';
import { filterArgs, formatDuration, fullyQualifiedName, jsFullName, projectName, resultKey, RunTarget, summarize, TestResult, TreeNode } from './model';
import { inspectProject, isNodeRunner, Runner, TestProject } from './projects';
import { TestRunner } from './runner';
import { inspectNodeFolder } from './nodeProjects';
import { clearSourceCache, goToJsTest, goToTest, openLocation, readSnippet, resolveSource } from './source';
import { ResultStore } from './store';
import { TestTreeProvider } from './tree';
import { setTranslator, t } from './i18n';

const STATE_KEY = 'readableTests.results.v1';
/** Au-delà, la ligne de commande devient trop longue (limite Windows ~32k) : on relance le projet entier. */
const MAX_FILTER_LENGTH = 8000;

export function activate(context: vscode.ExtensionContext): void {
  setTranslator((message, args) => vscode.l10n.t(message, ...args));
  const output = vscode.window.createOutputChannel('Readable Tests');
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const runner = new TestRunner(output, `${storage}/runs`);
  const store = new ResultStore(context.workspaceState.get<TestResult[]>(STATE_KEY, []));
  const config = () => vscode.workspace.getConfiguration('readableTests');
  const projects = new Map<string, TestProject>();
  const tracker = new BuildTracker();
  let lastTiming: string | undefined;
  let busy = false;

  const tree = new TestTreeProvider(() => [...projects.keys()], () => store.all(), p => {
    const info = projects.get(p);
    if (!info) { return undefined; }
    if (info.runner === 'angular') { return 'angular · vitest'; }
    if (isNodeRunner(info.runner)) { return info.runner; }
    return `${info.framework === 'unknown' ? '' : info.framework + ' · '}${info.runner}`;
  }, p => projects.get(p)?.label ?? projectName(p));
  const treeView = vscode.window.createTreeView('readableTests.tree', { treeDataProvider: tree, showCollapseAll: true });

  const findResult = (key: string) => store.all().find(r => resultKey(r) === key);
  const details = new DetailsView({
    open: (file, line) => void openLocation(file, line),
    goTo: key => { const r = findResult(key); if (r) { void navigate(r.className, r.methodName, r); } },
    rerun: key => { const r = findResult(key); if (r) { void run([{ project: r.project, target: targetFor(r.project, [r]) }]); } },
    copy: key => {
      const r = findResult(key);
      if (!r) { return; }
      const text = `✖ ${r.className}.${r.methodName} — ${r.displayName}\n\n${r.message ?? ''}${r.stackTrace ? '\n\n' + r.stackTrace : ''}`;
      void vscode.env.clipboard.writeText(text).then(() => vscode.window.setStatusBarMessage(t('Failure copied to clipboard'), 2000));
    },
    results: () => store.all(),
    keyOf: resultKey,
    resolve: resolveSource,
    relative: f => vscode.workspace.asRelativePath(f),
    snippet: (f, l) => readSnippet(f, l),
  });

  const inline = new InlineErrors(() => config().get<boolean>('inlineErrors', true));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'readableTests.tree.focus';

  context.subscriptions.push(output, treeView, status, inline,
    vscode.window.registerWebviewViewProvider('readableTests.details', details, { webviewOptions: { retainContextWhenHidden: true } }));

  // ---------- Rendu ----------

  const render = () => {
    tree.refresh();
    details.update();
    const done = store.all().filter(r => r.outcome !== 'running');
    inline.update(done);
    const s = summarize(done);
    treeView.badge = s.failed > 0 ? { value: s.failed, tooltip: t('{0} failed test(s)', s.failed) } : undefined;
    const f = tree.filter;
    treeView.message = f.text || f.failedOnly
      ? t('Filter: {0}', [f.failedOnly ? t('failures only') : '', f.text ? `"${f.text}"` : ''].filter(Boolean).join(' + '))
      : undefined;
    if (done.length === 0) { status.hide(); return; }
    status.text = `$(beaker) $(pass) ${s.passed}  $(error) ${s.failed}${s.skipped ? `  $(circle-slash) ${s.skipped}` : ''}`;
    status.tooltip = t('Tests — elapsed {0} (sum of tests {1})', formatDuration(s.elapsedMs), formatDuration(s.durationMs))
      + (lastTiming ? '\n' + t('Last run: {0}', lastTiming) : '');
    status.backgroundColor = s.failed > 0 ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    status.show();
  };

  const persist = () => context.workspaceState.update(STATE_KEY, store.all().filter(r => r.outcome !== 'running'));

  // ---------- Découverte des projets ----------

  const discover = async () => {
    const files = await vscode.workspace.findFiles('**/*.csproj', config().get<string>('projectExclude'));
    const override = config().get<'auto' | Runner>('runner', 'auto');
    projects.clear();
    for (const f of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      const p = inspectProject(f.fsPath, override);
      if (p) { projects.set(p.path, p); }
    }
    // JavaScript : Angular CLI (Vitest), Vitest, Jest
    const pkgs = await vscode.workspace.findFiles('**/package.json', config().get<string>('projectExclude'));
    for (const f of pkgs.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      for (const p of inspectNodeFolder(path.dirname(f.fsPath))) { projects.set(p.path, p); }
    }
    store.retainProjects([...projects.keys()]);
    clearSourceCache();
    render();
    void prefetchRunCommands();
  };

  /** Évalue en tâche de fond les commandes de lancement MTP : la 1re exécution n'attend pas MSBuild. */
  const prefetchRunCommands = async () => {
    const cfg = config();
    const { configuration } = buildSettings(cfg);
    const framework = cfg.get<string>('targetFramework') || undefined;
    for (const p of projects.values()) {
      if (p.runner !== 'mtp') { continue; }
      try {
        await runner.resolveRunCommand(p, { dotnetPath: cfg.get<string>('dotnetPath', 'dotnet'), configuration, framework: p.targetFrameworks.length > 1 ? (framework ?? p.targetFrameworks[0]) : undefined });
      } catch { /* sera retenté à l'exécution */ }
    }
  };

  // Tout changement de fichier invalide le build ; un .csproj/.props relance aussi la découverte.
  const onFsChange = (uri: vscode.Uri) => {
    if (tracker.touch(uri.fsPath)) { runner.invalidateRunCommands(); void discover(); }
  };
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(onFsChange);
  watcher.onDidDelete(onFsChange);
  watcher.onDidChange(onFsChange);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('readableTests.runner') || e.affectsConfiguration('readableTests.projectExclude')) { void discover(); }
    if (e.affectsConfiguration('readableTests.configuration') || e.affectsConfiguration('readableTests.buildArgs') || e.affectsConfiguration('readableTests.targetFramework')) { tracker.touch('settings.props'); runner.invalidateRunCommands(); }
    if (e.affectsConfiguration('readableTests.inlineErrors')) { render(); }
  }));

  // ---------- Exécution ----------

  interface Job { project: string; target: RunTarget }

  const run = async (jobs: Job[]) => {
    if (busy) { void vscode.window.showWarningMessage(t('A run is already in progress.')); return; }
    busy = true;
    try { await runJobs(jobs); } finally { busy = false; }
  };

  const runJobs = async (jobs: Job[]) => {
    jobs = jobs.filter(j => projects.has(j.project));
    if (jobs.length === 0) { return; }

    const cfg = config();
    const dotnetPath = cfg.get<string>('dotnetPath', 'dotnet');
    const { configuration, buildArgs } = buildSettings(cfg);
    const framework = cfg.get<string>('targetFramework') || undefined;
    const tfmOf = (p: TestProject) => p.targetFrameworks.length > 1 ? (framework ?? p.targetFrameworks[0]) : undefined;
    const buildMode = cfg.get<'auto' | 'always' | 'never'>('build', 'auto');
    const parallel = cfg.get<boolean>('parallelProjects', true) ? Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2))) : 1;

    runner.resetCancel();
    await vscode.commands.executeCommand('setContext', 'readableTests.running', true);
    output.appendLine(`\n===== ${new Date().toLocaleTimeString()} =====`);
    const t0 = Date.now();
    const timing: string[] = [];

    for (const job of jobs) { store.markRunning(job.project, job.target); tree.runningProjects.add(job.project); }
    render();

    const errors: string[] = [];
    const warnings: string[] = [];
    const fail = (job: Job, msg: string) => {
      store.restore(job.project);
      tree.runningProjects.delete(job.project);
      if (!runner.wasCancelled) { errors.push(`${projectName(job.project)} : ${msg}`); }
    };

    try {
      await vscode.window.withProgress({ location: { viewId: 'readableTests.tree' } }, async () => {
        // 1. Build : une seule invocation MSBuild, et seulement si quelque chose a changé.
        // Les projets JavaScript n'ont pas de build préalable (Vitest/Jest transpilent, ng test compile lui-même).
        const wanted = [...new Set(jobs.map(j => j.project))].filter(p => !isNodeRunner(projects.get(p)!.runner));
        const toBuild = buildMode === 'never' ? [] : buildMode === 'always' ? wanted : wanted.filter(p => !tracker.isBuilt(p));
        if (toBuild.length) {
          const tb = Date.now();
          const gen = tracker.snapshot;
          const restore = tracker.needsRestore;
          const reason = buildMode === 'always' ? 'mode "always"' : tracker.buildReason(f => vscode.workspace.asRelativePath(f));
          let ok = true;
          const failures: string[] = [];
          const sln = toBuild.length > 1 ? pickSolution(await findSolutions(), toBuild) : undefined;
          const targets = sln ? [sln] : toBuild;
          for (const target of targets) {
            const single = projects.get(target);
            const res = await runner.build(target, { dotnetPath, configuration, framework: single ? tfmOf(single) : undefined, restore, extraArgs: buildArgs });
            if (!res.ok) { ok = false; failures.push(...res.errors); }
            if (runner.wasCancelled) { break; }
          }
          timing.push(t('build {0}', formatDuration(Date.now() - tb)) + (sln ? ` (${projectName(sln)})` : '') + (restore ? ' + restore' : '') + ` [${t('reason: {0}', reason)}]`);
          if (!ok) {
            jobs.forEach(j => fail(j, t('build failed')));
            errors.splice(0, errors.length, t('Build failed:') + '\n' + failures.join('\n'));
            return;
          }
          tracker.markBuilt(toBuild, gen, restore);
        } else if (wanted.length) {
          timing.push(t('build skipped (no changes)'));
        }

        // 2. Exécution : binaires lancés directement (MTP), projets en parallèle.
        const tr = Date.now();
        await pool(jobs, parallel, async job => {
          if (runner.wasCancelled) { fail(job, t('cancelled')); return; }
          const project = projects.get(job.project)!;
          let target = job.target;
          let fArgs = filterArgs(project.runner, project.framework, target);
          if (fArgs.join(' ').length > MAX_FILTER_LENGTH || JSON.stringify(target).length > MAX_FILTER_LENGTH) { target = { kind: 'all' }; fArgs = []; }

          let res;
          try {
            res = isNodeRunner(project.runner)
              ? await runner.runNode(project, target, {
                nodePath: cfg.get<string>('nodePath', 'node'),
                reportersDir: context.asAbsolutePath('reporters'),
                extraArgs: cfg.get<string[]>(`${project.runner}.extraArgs`, []),
              })
              : project.runner === 'mtp'
              ? await runner.runMtp(project, await runner.resolveRunCommand(project, { dotnetPath, configuration, framework: tfmOf(project) }), fArgs, cfg.get<string[]>('mtp.extraArgs', []))
              : await runner.runVstest(project, { dotnetPath, configuration, framework: tfmOf(project), filterArgs: fArgs, extraArgs: cfg.get<string[]>('extraArgs', []) });
          } catch (e) {
            fail(job, (e as Error).message);
            render();
            return;
          }
          tree.runningProjects.delete(job.project);
          if (res.ok) {
            store.apply(job.project, target, res.results);
            if (res.warning) { warnings.push(`${projectName(job.project)} : ${res.warning}`); }
          } else {
            fail(job, res.error);
          }
          render();
        });
        timing.push(t('tests {0}', formatDuration(Date.now() - tr)) + (jobs.length > 1 && parallel > 1 ? ' ' + t('({0} in parallel)', Math.min(parallel, jobs.length)) : ''));
      });
    } finally {
      tree.runningProjects.clear();
      await vscode.commands.executeCommand('setContext', 'readableTests.running', false);
      lastTiming = `${timing.join(' · ')} — ${t('total {0}', formatDuration(Date.now() - t0))}`;
      output.appendLine(`\n⏱ ${lastTiming}`);
      void persist();
      render();
    }

    if (warnings.length) { void vscode.window.showWarningMessage(warnings.join('\n')); }
    if (errors.length) {
      const choice = await vscode.window.showErrorMessage(errors.join('\n'), t('Show output'));
      if (choice) { output.show(true); }
    }
    if (cfg.get<boolean>('revealFailures', true) && treeView.visible) {
      for (const leaf of tree.failedLeaves().slice(0, 20)) {
        try { await treeView.reveal(leaf, { expand: true, select: false, focus: false }); } catch { /* nœud filtré */ }
      }
    }
  };
  /** Cible d'exécution d'un ensemble de résultats (JS : fichier + nom complet ; .NET : méthodes). */
  const targetFor = (project: string, results: TestResult[]): RunTarget =>
    isNodeRunner(projects.get(project)?.runner ?? 'vstest')
      ? { kind: 'js', tests: results.filter(r => r.file).map(r => r.fileLevel ? { file: r.file!, fullName: '', path: [] } : { file: r.file!, fullName: jsFullName(r), path: [...(r.suite ?? []), r.methodName] }) }
      : { kind: 'methods', fqns: results.map(fullyQualifiedName) };

  const leaves = (n: TreeNode): TestResult[] => n.result ? [n.result] : n.children.flatMap(leaves);

  const jobsFor = (node: TreeNode): Job[] => {
    if (node.kind !== 'project' && isNodeRunner(projects.get(node.project)?.runner ?? 'vstest')) {
      return [{ project: node.project, target: targetFor(node.project, leaves(node)) }];
    }
    switch (node.kind) {
      case 'project': return [{ project: node.project, target: { kind: 'all' } }];
      case 'class': return [{ project: node.project, target: { kind: 'class', className: node.className! } }];
      default: return [{ project: node.project, target: { kind: 'methods', fqns: [`${node.className}.${node.methodName}`] } }];
    }
  };

  const navigate = async (className: string, methodName?: string, result?: TestResult, group = false) => {
    const ok = result?.file ? await goToJsTest(result, group) : await goToTest(className, methodName, result);
    if (!ok) { void vscode.window.showInformationMessage(t('Source not found for {0}.', className + (methodName ? '.' + methodName : ''))); }
  };

  const setFilter = async (patch: Partial<typeof tree.filter>) => {
    tree.filter = { ...tree.filter, ...patch };
    await vscode.commands.executeCommand('setContext', 'readableTests.failedOnly', tree.filter.failedOnly);
    await vscode.commands.executeCommand('setContext', 'readableTests.hasFilter', !!tree.filter.text);
    render();
  };

  // ---------- Commandes ----------

  const cmd = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('readableTests.runAll', () => run([...projects.keys()].map(p => ({ project: p, target: { kind: 'all' } }))));
  cmd('readableTests.runFailed', () => {
    const byProject = new Map<string, TestResult[]>();
    for (const r of store.failed()) {
      if (!byProject.has(r.project)) { byProject.set(r.project, []); }
      byProject.get(r.project)!.push(r);
    }
    if (byProject.size === 0) { void vscode.window.showInformationMessage(t('No failed tests.')); return; }
    return run([...byProject].map(([project, rs]) => ({ project, target: targetFor(project, rs) })));
  });
  cmd('readableTests.runNode', (node: TreeNode) => run(jobsFor(node)));
  cmd('readableTests.goToSource', (node: TreeNode) => navigate(node.className!, node.methodName, node.result ?? leaves(node)[0], node.kind === 'class'));
  cmd('readableTests.cancel', () => runner.cancel());
  cmd('readableTests.refresh', () => discover());
  cmd('readableTests.showOutput', () => output.show(true));
  cmd('readableTests.showFailedOnly', () => setFilter({ failedOnly: true }));
  cmd('readableTests.showAll', () => setFilter({ failedOnly: false }));
  cmd('readableTests.clearFilter', () => setFilter({ text: undefined }));
  cmd('readableTests.filter', async () => {
    const text = await vscode.window.showInputBox({ prompt: t('Filter tests (class, method, case)'), value: tree.filter.text ?? '' });
    if (text !== undefined) { await setFilter({ text: text.trim() || undefined }); }
  });

  treeView.onDidChangeSelection(e => details.select(e.selection[0]?.result));

  void setFilter({ failedOnly: false });
  void discover();
}

async function findSolutions(): Promise<string[]> {
  return (await vscode.workspace.findFiles('**/*.{sln,slnx}', '**/{bin,obj,node_modules}/**', 50)).map(u => u.fsPath);
}

export function deactivate(): void { /* rien */ }
