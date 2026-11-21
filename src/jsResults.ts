import * as path from 'path';
import { t } from './i18n';
import { Outcome, StructuredFailure, TestResult } from './model';

/** Format écrit par reporters/vitest.mjs et reporters/jest.cjs. */
export interface ReporterError { name?: string; message: string; stack?: string; expected?: string; actual?: string; cause?: ReporterError }
export interface ReporterTest {
  file: string; suite: string[]; name: string;
  state: 'passed' | 'failed' | 'skipped';
  duration: number; startTime?: number; line?: number;
  errors: ReporterError[]; stdout?: string;
}
export interface ReporterOutput {
  runner: string;
  tests: ReporterTest[];
  moduleErrors: { file: string; errors: ReporterError[] }[];
  unhandledErrors: ReporterError[];
}

const OUTCOME: Record<string, Outcome> = { passed: 'passed', failed: 'failed', skipped: 'skipped' };

function toFailure(e: ReporterError, depth = 0): StructuredFailure {
  // Vitest ≤ 2 sérialise expected/actual à "undefined" pour toute erreur, même hors assertion.
  const noValues = e.expected === 'undefined' && e.actual === 'undefined';
  return {
    name: e.name,
    message: e.message ?? '',
    stack: e.stack,
    expected: noValues ? undefined : e.expected,
    actual: noValues ? undefined : e.actual,
    cause: e.cause && depth < 5 ? toFailure(e.cause, depth + 1) : undefined,
  };
}

/** Message principal sans en-tête "Error: " (Jest le préfixe systématiquement). */
function plainMessage(f: StructuredFailure): string {
  return f.message.replace(/^(?:Error|AssertionError|JestAssertionError): /, '');
}

/** Stack sans les lignes de message qui la précèdent (Vitest inclut "AssertionError: …" en tête). */
function framesOnly(stack?: string): string | undefined {
  if (!stack) { return undefined; }
  const lines = stack.split(/\r?\n/);
  const i = lines.findIndex(l => /^\s+at\s/.test(l));
  return i < 0 ? undefined : lines.slice(i).join('\n');
}

function base(project: string, root: string, file: string, suite: string[]) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return {
    project,
    file,
    suite,
    className: `${file}::${suite.join('›')}`,
    groupLabel: suite.length ? suite.join(' › ') : path.basename(file),
    groupDescription: suite.length ? rel : path.dirname(rel) === '.' ? '' : path.dirname(rel),
  };
}

export function convertReport(report: ReporterOutput, project: string, root: string): TestResult[] {
  const out: TestResult[] = [];
  for (const x of report.tests ?? []) {
    const failures = (x.errors ?? []).map(e => toFailure(e));
    out.push({
      ...base(project, root, x.file, x.suite ?? []),
      methodName: x.name,
      displayName: x.name,
      outcome: OUTCOME[x.state] ?? 'skipped',
      durationMs: x.duration ?? 0,
      startMs: typeof x.startTime === 'number' ? x.startTime : undefined,
      line: x.line,
      failures: failures.length ? failures : undefined,
      message: failures.length ? failures.map(plainMessage).join('\n\n') : undefined,
      stackTrace: framesOnly(failures[0]?.stack),
      stdout: x.stdout || undefined,
    });
  }
  // Fichier qui ne charge pas (import manquant, erreur de compilation…) : visible comme un test en échec.
  for (const m of report.moduleErrors ?? []) {
    const failures = m.errors.map(e => toFailure(e));
    out.push({
      ...base(project, root, m.file, []),
      methodName: t('(file failed to load)'),
      displayName: t('(file failed to load)'),
      outcome: 'failed', durationMs: 0, fileLevel: true,
      failures, message: failures.map(plainMessage).join('\n\n'), stackTrace: framesOnly(failures[0]?.stack),
    });
  }
  if (report.unhandledErrors?.length) {
    const failures = report.unhandledErrors.map(e => toFailure(e));
    out.push({
      ...base(project, root, root, []),
      groupLabel: t('Unhandled errors'), groupDescription: '',
      methodName: t('Unhandled errors'), displayName: t('Unhandled errors'),
      outcome: 'failed', durationMs: 0, fileLevel: true,
      failures, message: failures.map(plainMessage).join('\n\n'), stackTrace: framesOnly(failures[0]?.stack),
    });
  }
  return out;
}

export { plainMessage, framesOnly };
