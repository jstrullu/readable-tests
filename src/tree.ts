import * as vscode from 'vscode';
import { summarizeFailure } from './errorFormat';
import { buildTree, FilterOptions, formatDuration, Outcome, TestResult, TreeNode } from './model';
import { t } from './i18n';

const ICONS: Record<Outcome, vscode.ThemeIcon> = {
  passed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
  skipped: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconSkipped')),
  notRun: new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('testing.iconUnset')),
  running: new vscode.ThemeIcon('loading~spin'),
};

export class TestTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private roots: TreeNode[] = [];
  private parents = new Map<string, TreeNode>();
  private byId = new Map<string, TreeNode>();

  filter: FilterOptions = { failedOnly: false };
  runningProjects = new Set<string>();

  constructor(private projects: () => string[], private results: () => TestResult[], private projectInfo: (p: string) => string | undefined = () => undefined) {}

  refresh(): void {
    this.roots = buildTree(this.projects(), this.results(), this.filter);
    this.parents.clear();
    this.byId.clear();
    const index = (n: TreeNode, parent?: TreeNode) => {
      this.byId.set(n.id, n);
      if (parent) { this.parents.set(n.id, parent); }
      n.children.forEach(c => index(c, n));
    };
    this.roots.forEach(r => index(r));
    this.emitter.fire(undefined);
  }

  get rootNodes(): TreeNode[] { return this.roots; }

  getChildren(node?: TreeNode): TreeNode[] { return node ? node.children : this.roots; }

  getParent(node: TreeNode): TreeNode | undefined { return this.parents.get(node.id); }

  /** Nœuds feuilles en échec, pour les déplier après une exécution. */
  failedLeaves(): TreeNode[] {
    return [...this.byId.values()].filter(n => n.children.length === 0 && n.outcome === 'failed');
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    const outcome: Outcome = n.kind === 'project' && this.runningProjects.has(n.project) ? 'running' : n.outcome;
    const item = new vscode.TreeItem(n.label, this.collapsible(n));
    item.id = n.id;
    item.iconPath = ICONS[outcome];
    item.contextValue = n.kind;

    const parts: string[] = [];
    if (n.description) { parts.push(n.description); }
    if (n.kind === 'project') { const info = this.projectInfo(n.project); if (info) { parts.push(info); } }
    if (n.result?.outcome === 'failed' && n.result.message) { parts.push(summarizeFailure(n.result.message)); }
    if (n.durationMs > 0 && outcome !== 'running') { parts.push(formatDuration(n.durationMs)); }
    if (n.kind === 'project' && n.children.length === 0 && outcome !== 'running') { parts.push(t('not run')); }
    item.description = parts.join(' · ');

    if (n.result) {
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${escapeMd(n.result.displayName)}**\n\n`);
      md.appendMarkdown(`${label(n.result.outcome)} · ${formatDuration(n.result.durationMs)}`);
      if (n.result.message) { md.appendMarkdown('\n\n---\n'); md.appendCodeblock(truncate(n.result.message, 1500), 'text'); }
      md.appendMarkdown('\n\n_' + t('Select for full details.') + '_');
      item.tooltip = md;
    } else {
      const parallel = n.sumMs > n.durationMs * 1.2;
      item.tooltip = (n.kind === 'project' ? n.project + '\n' : '') + t('Elapsed: {0}', formatDuration(n.durationMs))
        + (parallel ? '\n' + t('Sum of test durations: {0} (parallel execution)', formatDuration(n.sumMs)) : '');
    }
    return item;
  }

  private collapsible(n: TreeNode): vscode.TreeItemCollapsibleState {
    if (n.children.length === 0) { return vscode.TreeItemCollapsibleState.None; }
    if (n.kind === 'project') { return vscode.TreeItemCollapsibleState.Expanded; }
    if (this.filter.failedOnly || this.filter.text) { return vscode.TreeItemCollapsibleState.Expanded; }
    return vscode.TreeItemCollapsibleState.Collapsed;
  }
}

export function label(o: Outcome): string {
  return { passed: t('Passed'), failed: t('Failed'), skipped: t('Skipped'), notRun: t('Not run'), running: t('Running') }[o];
}

function escapeMd(s: string): string { return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&'); }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
