// Readable Tests — reporter Jest (Jest 27+).
// Écrit un JSON normalisé dans le fichier désigné par READABLE_TESTS_OUTPUT.
'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');
const { createRequire } = require('module');

const ANSI = /\u001b\[[0-9;]*m/g;
const strip = s => (typeof s === 'string' ? s.replace(ANSI, '') : s);

/** pretty-format du projet (même rendu que les messages Jest), sinon util.inspect. */
function makeFormatter(rootDir) {
  try {
    const req = createRequire(path.join(rootDir || process.cwd(), 'package.json'));
    const pf = req('pretty-format');
    const format = pf.format || pf.default || pf;
    const plugins = pf.plugins ? Object.values(pf.plugins) : [];
    return v => format(v, { plugins, indent: 2, printBasicPrototype: false });
  } catch {
    return v => util.inspect(v, { depth: 8, breakLength: 80 });
  }
}

/** Sépare "message\n    at frame…" en message / stack. */
function splitFailure(text) {
  const lines = strip(text).split(/\r?\n/);
  const i = lines.findIndex(l => /^\s+at\s/.test(l));
  if (i < 0) { return { message: lines.join('\n').trim(), stack: undefined }; }
  return { message: lines.slice(0, i).join('\n').trim(), stack: lines.slice(i).join('\n') };
}

const STATE = { passed: 'passed', failed: 'failed', pending: 'skipped', skipped: 'skipped', todo: 'skipped', disabled: 'skipped', focused: 'passed' };

class ReadableTestsReporter {
  constructor(globalConfig) {
    this.format = makeFormatter(globalConfig && globalConfig.rootDir);
    this.tests = [];
    this.moduleErrors = [];
  }

  onTestResult(_test, result) {
    const file = result.testFilePath;
    if (result.testExecError) {
      const e = result.testExecError;
      this.moduleErrors.push({ file, errors: [{ name: e.name || 'Error', ...splitFailure(e.stack || e.message || String(e)) }] });
    }
    // Jest exécute les tests d'un fichier séquentiellement : heure de début reconstituée.
    let clock = result.perfStats && result.perfStats.start;
    for (const a of result.testResults || []) {
      const errors = (a.failureMessages || []).map((m, i) => {
        const err = splitFailure(m);
        const d = (a.failureDetails || [])[i];
        const mr = d && d.matcherResult;
        if (mr && 'expected' in mr && 'actual' in mr) {
          try { err.expected = this.format(mr.expected); err.actual = this.format(mr.actual); } catch { /* valeurs non sérialisables */ }
        }
        if (d && d.cause) { err.cause = { name: d.cause.name, message: strip(String(d.cause.message ?? d.cause)), stack: strip(d.cause.stack) }; }
        return err;
      });
      const duration = a.duration || 0;
      this.tests.push({
        file,
        suite: a.ancestorTitles || [],
        name: a.title,
        state: STATE[a.status] || 'skipped',
        duration,
        startTime: typeof clock === 'number' ? clock : undefined,
        line: a.location && a.location.line,
        errors,
      });
      if (typeof clock === 'number') { clock += duration; }
    }
  }

  onRunComplete() {
    const out = process.env.READABLE_TESTS_OUTPUT;
    if (!out) { return; }
    fs.writeFileSync(out, JSON.stringify({ runner: 'jest', tests: this.tests, moduleErrors: this.moduleErrors, unhandledErrors: [] }));
  }

  getLastError() { return undefined; }
}

module.exports = ReadableTestsReporter;
