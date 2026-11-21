// Readable Tests — reporter Vitest (Vitest 1 à 5, y compris via `ng test`).
// Écrit un JSON normalisé dans le fichier désigné par READABLE_TESTS_OUTPUT.
// API récente (Vitest ≥ 3) : onTestRunEnd(testModules). Ancienne (Vitest ≤ 2) : onFinished(files).
import { writeFileSync } from 'node:fs';

function serializeError(e, depth = 0) {
  if (!e || typeof e !== 'object') { return { message: String(e) }; }
  const out = {
    name: e.name || e.nameStr || undefined,
    message: typeof e.message === 'string' ? e.message : String(e.message ?? ''),
    stack: typeof e.stack === 'string' ? e.stack : undefined,
    expected: typeof e.expected === 'string' ? e.expected : undefined,
    actual: typeof e.actual === 'string' ? e.actual : undefined,
  };
  if (e.cause && depth < 5) { out.cause = serializeError(e.cause, depth + 1); }
  return out;
}

const STATE = { pass: 'passed', passed: 'passed', fail: 'failed', failed: 'failed', skip: 'skipped', skipped: 'skipped', todo: 'skipped', pending: 'skipped' };

export default class ReadableTestsReporter {
  constructor() {
    this.logs = new Map();
    this.written = false;
  }

  onUserConsoleLog(log) {
    if (!log || !log.taskId) { return; }
    const prev = this.logs.get(log.taskId) ?? '';
    this.logs.set(log.taskId, prev + (log.content ?? ''));
  }

  // ----- Vitest ≥ 3 -----
  onTestRunEnd(testModules, unhandledErrors) {
    const tests = [];
    const moduleErrors = [];
    for (const m of testModules ?? []) {
      const file = m.moduleId;
      const errs = typeof m.errors === 'function' ? m.errors() : [];
      if (errs && errs.length) { moduleErrors.push({ file, errors: errs.map(e => serializeError(e)) }); }
      for (const t of m.children.allTests()) {
        const suite = [];
        for (let p = t.parent; p && p.type === 'suite'; p = p.parent) { suite.unshift(p.name); }
        const r = t.result();
        const d = typeof t.diagnostic === 'function' ? t.diagnostic() : undefined;
        tests.push({
          file, suite, name: t.name,
          state: STATE[r?.state] ?? 'skipped',
          duration: d?.duration ?? 0,
          startTime: d?.startTime,
          line: t.location?.line,
          errors: (r?.errors ?? []).map(e => serializeError(e)),
          stdout: this.logs.get(t.id),
        });
      }
    }
    this.write(tests, moduleErrors, unhandledErrors);
  }

  // ----- Vitest ≤ 2 -----
  onFinished(files, errors) {
    if (this.written) { return; }
    const tests = [];
    const moduleErrors = [];
    const walk = (task, file, suite) => {
      for (const c of task.tasks ?? []) {
        if (c.type === 'suite') { walk(c, file, [...suite, c.name]); continue; }
        const st = c.result?.state ?? (c.mode === 'skip' || c.mode === 'todo' ? 'skip' : undefined);
        tests.push({
          file, suite, name: c.name,
          state: STATE[st] ?? 'skipped',
          duration: c.result?.duration ?? 0,
          startTime: c.result?.startTime,
          line: c.location?.line,
          errors: (c.result?.errors ?? []).map(e => serializeError(e)),
          stdout: this.logs.get(c.id),
        });
      }
    };
    for (const f of files ?? []) {
      if (f.result?.errors?.length) { moduleErrors.push({ file: f.filepath, errors: f.result.errors.map(e => serializeError(e)) }); }
      walk(f, f.filepath, []);
    }
    this.write(tests, moduleErrors, errors);
  }

  write(tests, moduleErrors, unhandled) {
    const out = process.env.READABLE_TESTS_OUTPUT;
    if (!out) { return; }
    this.written = true;
    writeFileSync(out, JSON.stringify({
      runner: 'vitest',
      tests,
      moduleErrors,
      unhandledErrors: (unhandled ?? []).map(e => serializeError(e)),
    }));
  }
}
