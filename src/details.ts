import * as vscode from 'vscode';
import { AssertionBlock, diff, Frame, parseFailure, Segment, summarizeFailure } from './errorFormat';
import { formatDuration, summarize, TestResult } from './model';
import { label } from './tree';
import { t } from './i18n';

type Msg =
  | { type: 'open'; file: string; line?: number }
  | { type: 'goto' | 'rerun' | 'copy'; key: string };

export interface DetailsHost {
  open(file: string, line?: number): void;
  goTo(key: string): void;
  rerun(key: string): void;
  copy(key: string): void;
  results(): TestResult[];
  keyOf(r: TestResult): string;
  /** Chemin local si le fichier est dans le workspace (frame "utilisateur") */
  resolve(file: string): string | undefined;
  relative(file: string): string;
  snippet(file: string, line: number): { start: number; lines: string[] } | undefined;
}

/** Panneau "Détails" : échec du test sélectionné, ou synthèse de la dernière exécution. */
export class DetailsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private selectedKey?: string;

  constructor(private readonly host: DetailsHost) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((m: Msg) => {
      if (m.type === 'open') { this.host.open(m.file, m.line); }
      else if (m.type === 'goto') { this.host.goTo(m.key); }
      else if (m.type === 'rerun') { this.host.rerun(m.key); }
      else if (m.type === 'copy') { this.host.copy(m.key); }
    });
    this.render();
  }

  select(result?: TestResult): void {
    this.selectedKey = result ? this.host.keyOf(result) : undefined;
    this.render();
  }

  update(): void { this.render(); }

  private render(): void {
    if (!this.view) { return; }
    const r = this.selectedKey ? this.host.results().find(x => this.host.keyOf(x) === this.selectedKey) : undefined;
    this.view.webview.html = page(r ? this.renderTest(r) : this.renderSummary());
  }

  /** Rendu HTML d'un résultat (exposé pour les tests). */
  renderTest(r: TestResult): string {
    const key = esc(this.host.keyOf(r));
    const head = `
<header class="head ${r.outcome}">
  <div class="row"><span class="chip ${r.outcome}">${label(r.outcome)}</span><span class="dim">${formatDuration(r.durationMs)}</span>
    <span class="spacer"></span>
    <button data-action="goto" data-key="${key}" title="${t('Go to code')}">${t('Code')}</button>
    <button data-action="rerun" data-key="${key}" title="${t('Run this test again')}">${t('Rerun')}</button>
    <button data-action="copy" data-key="${key}" title="${t('Copy name, message and stack trace')}">${t('Copy')}</button>
  </div>
  <div class="name">${esc(r.displayName)}</div>
  <div class="dim small">${esc(r.className)}</div>
</header>`;

    if (r.outcome !== 'failed') {
      return head
        + (r.outcome === 'skipped' && r.message ? section(t('Reason'), `<div>${esc(r.message)}</div>`) : '')
        + this.renderOutput(r, true);
    }

    const p = parseFailure(r.message, r.stackTrace);
    let body = '';

    if (p.assertions.length) {
      body += p.assertions.map((a, i) => renderAssertion(a, p.assertions.length > 1 ? i + 1 : undefined)).join('');
    } else if (p.main) {
      const [first, ...rest] = p.main.split(/\r?\n/);
      body += `<div class="card"><div class="headline">${esc(first)}</div>${rest.join('\n').trim() ? `<pre class="plain">${esc(rest.join('\n').trim())}</pre>` : ''}</div>`;
    }

    if (p.inner.length) {
      body += section(t('Caused by'), p.inner.map(i =>
        `<div class="inner"><span class="type">${esc(shortType(i.type))}</span> ${esc(i.message)}</div>`).join(''));
    }

    // Extrait de code autour de la première frame utilisateur
    const userFrame = p.sections.flatMap(s => s.frames).find(f => f.file && this.host.resolve(f.file));
    if (userFrame?.file && userFrame.line) {
      const local = this.host.resolve(userFrame.file)!;
      const snip = this.host.snippet(local, userFrame.line);
      if (snip) {
        const lines = snip.lines.map((line, i) => {
          const n = snip.start + i;
          return `<div class="ln${n === userFrame.line ? ' hit' : ''}"><span class="no">${n}</span><span class="src">${esc(line) || ' '}</span></div>`;
        }).join('');
        body += section(`<a href="#" data-action="open" data-file="${esc(local)}" data-line="${userFrame.line}">${esc(this.host.relative(local))}:${userFrame.line}</a>`,
          `<div class="code">${lines}</div>`, true);
      }
    }

    if (p.sections.length) {
      body += section(t('Call stack'), p.sections.map(s => this.renderSection(s.title, s.frames)).join(''));
    }

    body += this.renderOutput(r, false);
    body += `<details class="raw"><summary>${t('Raw message')}</summary><pre class="plain">${esc(r.message ?? '')}${r.stackTrace ? '\n\n' + esc(r.stackTrace) : ''}</pre></details>`;
    return head + body;
  }

  private renderSection(title: string | undefined, frames: Frame[]): string {
    const user = frames.filter(f => f.file && this.host.resolve(f.file));
    const other = frames.filter(f => !user.includes(f));
    const row = (f: Frame) => {
      const local = f.file && this.host.resolve(f.file);
      const loc = local
        ? `<a href="#" data-action="open" data-file="${esc(local)}" data-line="${f.line ?? ''}">${esc(baseName(local))}:${f.line ?? ''}</a>`
        : f.file ? `<span class="dim">${esc(baseName(f.file))}:${f.line ?? ''}</span>` : '';
      return `<div class="frame${local ? ' user' : ''}" title="${esc(f.fullMethod)}"><span class="m">${esc(f.method)}</span>${loc}</div>`;
    };
    return `${title ? `<div class="sub-title">${esc(t('Inner exception: {0}', shortType(title)))}</div>` : ''}
${user.map(row).join('')}
${other.length ? `<details><summary class="dim">${t('{0} framework / external frame(s)', other.length)}</summary>${other.map(row).join('')}</details>` : ''}`;
  }

  private renderOutput(r: TestResult, open: boolean): string {
    if (!r.stdout) { return ''; }
    const n = r.stdout.split(/\r?\n/).length;
    return `<details class="out"${open || n <= 8 ? ' open' : ''}><summary>${t('Output')} <span class="dim">(${t('{0} line(s)', n)})</span></summary><pre class="plain">${esc(r.stdout)}</pre></details>`;
  }

  renderSummary(): string {
    const all = this.host.results().filter(r => r.outcome !== 'running');
    if (all.length === 0) {
      return `<p class="dim">${t('No results yet. Run the tests with ▶ in the view toolbar.')}</p>`;
    }
    const s = summarize(all);
    const link = (r: TestResult) => `<a href="#" data-action="goto" data-key="${esc(this.host.keyOf(r))}">${esc(r.className.split('.').pop() + '.' + r.methodName)}</a>`;
    const failed = all.filter(r => r.outcome === 'failed').slice(0, 50);
    const slow = [...all].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    return `
<div class="kpis">
  <div class="kpi passed"><b>${s.passed}</b>${t('passed')}</div>
  <div class="kpi failed"><b>${s.failed}</b>${t('failed')}</div>
  <div class="kpi skipped"><b>${s.skipped}</b>${t('skipped')}</div>
  <div class="kpi" title="${esc(t('Sum of test durations: {0}', formatDuration(s.durationMs)))}"><b>${formatDuration(s.elapsedMs)}</b>${t('elapsed')}</div>
</div>
${failed.length ? section(t('Failures'), failed.map(r => `<div class="fail-item">${link(r)}<div class="dim small">${esc(summarizeFailure(r.message))}</div></div>`).join('')) : ''}
${section(t('Slowest'), slow.map(r => `<div class="frame">${link(r)}<span class="dim">${formatDuration(r.durationMs)}</span></div>`).join(''))}`;
  }
}

function renderAssertion(a: AssertionBlock, index?: number): string {
  const expr = a.expression ? `<div class="expr">${index ? `<span class="idx">${index}</span>` : ''}<code>${esc(a.expression)}</code></div>` : '';
  let rows: string;
  if (a.expected !== undefined && a.found !== undefined) {
    const d = diff(a.expected, a.found);
    rows = `${a.member ? `<div class="member">${t('Member')} <code>${esc(a.member)}</code></div>` : ''}
<div class="kv"><span class="k">${t('Expected')}</span><span class="v exp">${segments(d.expected)}</span></div>
<div class="kv"><span class="k">${t('Actual')}</span><span class="v got">${segments(d.found)}</span></div>`;
  } else {
    rows = `<div class="kv"><span class="k">${t('Expected')}</span><span class="v">${esc(a.expectation)}</span></div>
${a.actual ? `<div class="kv"><span class="k">${t('Observed')}</span><span class="v">${esc(a.actual.replace(/^found /, ''))}</span></div>` : ''}`;
  }
  const title = !a.expression && a.expectation && a.expected !== undefined ? `<div class="headline">${esc(a.expectation)}</div>` : '';
  return `<div class="card">${expr}${title}${rows}</div>`;
}

function segments(s: Segment[]): string {
  return s.map(x => !x.changed ? esc(x.text) : x.text ? `<mark>${esc(x.text)}</mark>` : `<mark class="gap" title="${t('missing')}"></mark>`).join('');
}

function section(title: string, content: string, rawTitle = false): string {
  return `<section><h3>${rawTitle ? title : esc(title)}</h3>${content}</section>`;
}

function shortType(t: string): string { return t.split('.').pop() ?? t; }
function baseName(p: string): string { return p.split(/[\\/]/).pop() ?? p; }

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function page(body: string, nonce = Math.random().toString(36).slice(2)): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body>${body}
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage(){} };
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  e.preventDefault();
  const d = a.dataset;
  vscode.postMessage({ type: d.action, file: d.file, line: d.line ? Number(d.line) : undefined, key: d.key });
});
</script></body></html>`;
}

const CSS = `
:root { --fail: var(--vscode-testing-iconFailed, #f14c4c); --pass: var(--vscode-testing-iconPassed, #73c991); --skip: var(--vscode-testing-iconSkipped, #848484); }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 6px 10px 16px; line-height: 1.45; }
code, pre, .code, .v, .frame .m { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: var(--vscode-editor-font-size, 12px); }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
.dim { color: var(--vscode-descriptionForeground); }
.small { font-size: 11px; }
h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; }
h3 a { text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 12px; }
.head { border-left: 3px solid var(--skip); padding: 2px 0 2px 10px; }
.head.passed { border-color: var(--pass); } .head.failed { border-color: var(--fail); }
.row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
.chip { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 9px; background: color-mix(in srgb, var(--skip) 20%, transparent); }
.chip.failed { color: var(--fail); background: color-mix(in srgb, var(--fail) 15%, transparent); }
.chip.passed { color: var(--pass); background: color-mix(in srgb, var(--pass) 15%, transparent); }
.name { font-weight: 600; font-size: 13px; margin-top: 4px; word-break: break-word; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 9px; border-radius: 3px; cursor: pointer; font-size: 11px; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.card { margin-top: 12px; padding: 8px 10px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-left: 3px solid var(--fail); }
.expr { margin-bottom: 6px; display: flex; gap: 6px; align-items: baseline; }
.expr code { color: var(--vscode-textPreformat-foreground); word-break: break-word; }
.idx { font-size: 10px; font-weight: 700; color: var(--fail); }
.headline { font-weight: 600; margin-bottom: 4px; word-break: break-word; }
.member { font-size: 11px; margin-bottom: 4px; }
.kv { display: grid; grid-template-columns: 62px 1fr; gap: 8px; padding: 2px 0; }
.k { font-size: 11px; color: var(--vscode-descriptionForeground); padding-top: 1px; }
.v { white-space: pre-wrap; word-break: break-word; }
.v.exp mark { background: color-mix(in srgb, var(--pass) 30%, transparent); color: inherit; border-radius: 2px; }
.v mark.gap { display: inline-block; width: 2px; height: 1.1em; vertical-align: text-bottom; padding: 0; margin: 0 1px; }
.v.exp mark.gap { background: var(--pass); } .v.got mark.gap { background: var(--fail); }
.v.got mark { background: color-mix(in srgb, var(--fail) 35%, transparent); color: inherit; border-radius: 2px; }
.inner { margin: 3px 0; word-break: break-word; }
.type { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 0 5px; border-radius: 3px; background: color-mix(in srgb, var(--fail) 15%, transparent); color: var(--fail); }
.code { border-radius: 4px; overflow-x: auto; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25)); padding: 4px 0; }
.ln { display: flex; white-space: pre; }
.ln .no { width: 38px; text-align: right; padding-right: 10px; color: var(--vscode-editorLineNumber-foreground); flex-shrink: 0; }
.ln.hit { background: color-mix(in srgb, var(--fail) 18%, transparent); }
.ln.hit .no { color: var(--fail); font-weight: 700; }
.frame { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
.frame .m { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.frame.user .m { color: var(--vscode-foreground); }
.frame a, .frame span:last-child { flex-shrink: 0; }
.sub-title { font-size: 11px; margin: 8px 0 2px; color: var(--fail); }
details { margin-top: 4px; }
details summary { cursor: pointer; font-size: 11px; }
details.out, details.raw { margin-top: 14px; }
details.out > summary, details.raw > summary { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
pre.plain { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; padding: 6px 8px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 6px; }
.kpi { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); padding: 6px 8px; border-radius: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.kpi b { display: block; font-size: 17px; color: var(--vscode-foreground); }
.kpi.passed b { color: var(--pass); } .kpi.failed b { color: var(--fail); } .kpi.skipped b { color: var(--skip); }
.fail-item { padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.15)); }
`;
