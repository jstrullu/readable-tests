import * as vscode from 'vscode';
import { summarizeResult } from './errorFormat';
import { TestResult } from './model';
import { firstUserFrame } from './source';
import { t } from './i18n';

/** Affiche le résumé de l'échec en fin de ligne de l'assertion, dans l'éditeur. */
export class InlineErrors implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('testing.message.error.lineBackground'),
    overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  /** fichier (minuscule sous Windows) → échecs */
  private byFile = new Map<string, { line: number; result: TestResult }[]>();
  private readonly subs: vscode.Disposable[];

  constructor(private enabled: () => boolean) {
    this.subs = [vscode.window.onDidChangeVisibleTextEditors(() => this.apply())];
  }

  update(results: TestResult[]): void {
    this.byFile.clear();
    if (this.enabled()) {
      for (const r of results) {
        if (r.outcome !== 'failed') { continue; }
        const f = firstUserFrame(r);
        if (!f?.line) { continue; }
        const k = norm(f.local);
        if (!this.byFile.has(k)) { this.byFile.set(k, []); }
        this.byFile.get(k)!.push({ line: f.line, result: r });
      }
    }
    this.apply();
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const items = this.byFile.get(norm(editor.document.uri.fsPath)) ?? [];
      // Plusieurs cas (Theory) sur la même ligne : un seul décor, compteur dans le texte.
      const byLine = new Map<number, TestResult[]>();
      for (const i of items) {
        if (i.line > editor.document.lineCount) { continue; }
        if (!byLine.has(i.line)) { byLine.set(i.line, []); }
        byLine.get(i.line)!.push(i.result);
      }
      const decos: vscode.DecorationOptions[] = [...byLine].map(([line, rs]) => {
        const text = summarizeResult(rs[0]) || t('test failed');
        const hover = new vscode.MarkdownString();
        for (const r of rs.slice(0, 5)) {
          hover.appendMarkdown(`**✖ ${r.displayName}**\n`);
          hover.appendCodeblock(r.message ?? '', 'text');
        }
        if (rs.length > 5) { hover.appendMarkdown(t('… and {0} more', rs.length - 5)); }
        return {
          range: new vscode.Range(line - 1, 0, line - 1, 0),
          hoverMessage: hover,
          renderOptions: {
            after: {
              contentText: `  ✖ ${rs.length > 1 ? t('({0} cases)', rs.length) + ' ' : ''}${text}`,
              color: new vscode.ThemeColor('testing.message.error.decorationForeground'),
              fontStyle: 'italic',
            },
          },
        };
      });
      editor.setDecorations(this.type, decos);
    }
  }

  dispose(): void { this.type.dispose(); this.subs.forEach(s => s.dispose()); }
}

function norm(p: string): string { return process.platform === 'win32' ? p.toLowerCase() : p; }
