import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseTrx } from '../src/trxParser';
import { nodeRunnerBin } from '../src/nodeProjects';

test('TRX volumineux : des milliers d\'entités XML ne bloquent pas l\'analyse (0.4.0 : "Entity expansion limit exceeded")', () => {
  const res: string[] = [], defs: string[] = [];
  for (let i = 0; i < 400; i++) {
    const failed = i % 3 === 0;
    const out = failed
      ? `<Output><StdOut>${i === 0 ? 'log &lt;line&gt; &amp; &quot;x&quot;\n'.repeat(12000) : 'ok'}</StdOut><ErrorInfo><Message>Expected &lt;List&lt;int&gt;&gt; to be &quot;a&quot; &amp; b</Message><StackTrace>   at Ns.C.&lt;M${i}&gt;d__3.MoveNext() in /src/C.cs:line ${i}</StackTrace></ErrorInfo></Output>`
      : '';
    res.push(`<UnitTestResult testId="t${i}" testName="M${i}(&quot;x&quot;)" duration="00:00:00.001" outcome="${failed ? 'Failed' : 'Passed'}">${out}</UnitTestResult>`);
    defs.push(`<UnitTest id="t${i}" name="M${i}"><TestMethod className="Ns.C" name="M${i}" /></UnitTest>`);
  }
  const xml = `<?xml version="1.0" encoding="utf-8"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>${res.join('')}</Results><TestDefinitions>${defs.join('')}</TestDefinitions></TestRun>`;
  assert.ok((xml.match(/&[a-z]+;/g) ?? []).length > 50_000);
  const start = Date.now();
  const r = parseTrx(xml, 'P');
  assert.ok(Date.now() - start < 5000, 'analyse en moins de 5 s');
  assert.equal(r.length, 400);
  const first = r.find(x => x.methodName === 'M0')!;
  assert.equal(first.displayName, 'M0("x")');
  assert.equal(first.message, 'Expected <List<int>> to be "a" & b');
  assert.match(first.stackTrace!, /Ns\.C\.<M0>d__3\.MoveNext\(\)/);
  assert.ok(first.stdout!.startsWith('log <line> & "x"') && first.stdout!.length > 200_000);
});

test('Projet JS sans dépendances installées : détecté comme tel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ni-'));
  const p = { path: path.join(root, 'package.json'), runner: 'jest' as const, framework: 'jest' as const, targetFrameworks: [], root };
  assert.equal(nodeRunnerBin(p), undefined);
  fs.mkdirSync(path.join(root, 'node_modules', 'jest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'jest', 'package.json'), JSON.stringify({ version: '30.0.0', bin: { jest: './bin/jest.js' } }));
  assert.equal(nodeRunnerBin(p)?.version, '30.0.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('xUnit v3 natif : -result-trx, repli sur -trx pour les anciennes versions, filtres -method', async () => {
  const { TestRunner } = await import('../src/runner');
  const fixture = path.resolve(__dirname, '../../test/fixtures/xunit3/fake-xunit.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xv3-'));
  const argsFile = path.join(tmp, 'args.json');
  const log = { append: () => {}, appendLine: () => {} };
  for (const [mode, sw] of [['new', '-result-trx'], ['old', '-trx']]) {
    const runner = new TestRunner(log as never, tmp);
    const cmd = { command: process.execPath, args: [fixture], cwd: tmp, targetPath: fixture,
      env: { FAKE_XUNIT_MODE: mode, FAKE_XUNIT_ARGS: argsFile } };
    const res = await runner.runXunit({ path: path.join(tmp, 'X.Tests.csproj'), runner: 'xunit3', framework: 'xunit3', targetFrameworks: [] },
      cmd, ['-method', 'Demo.Calc.Ko'], []);
    if (!res.ok) { assert.fail(`${mode}: ${res.error}`); }
    assert.equal(res.results[0].outcome, 'failed');
    assert.equal(res.results[0].className, 'Demo.Calc');
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    assert.ok(args.includes(sw), `${mode} utilise ${sw}`);
    assert.deepEqual(args.slice(-2), ['-method', 'Demo.Calc.Ko']);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Exécution : un petit-enfant qui garde la sortie ouverte ne bloque pas la fin du processus', async () => {
  const { TestRunner } = await import('../src/runner');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-'));
  const script = path.join(tmp, 'app.js');
  // Le « test » lance un serveur détaché qui hérite de stdout puis se termine (cas Testcontainers, host web…).
  fs.writeFileSync(script, `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir() }); require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'pid'))}, String(c.pid)); c.unref();`);
  const runner = new TestRunner({ append: () => {}, appendLine: () => {} } as never, tmp);
  const t0 = Date.now();
  const res = await runner.runMtp({ path: path.join(tmp, 'X.csproj'), runner: 'mtp', framework: 'tunit', targetFrameworks: [] },
    { command: process.execPath, args: [script], cwd: os.tmpdir(), targetPath: script, env: {} }, [], []);
  assert.ok(Date.now() - t0 < 6000, `rendu en ${Date.now() - t0} ms`);
  assert.equal(res.ok, false);
  try { process.kill(Number(fs.readFileSync(path.join(tmp, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* déjà mort */ }
  removeLater(tmp);
});

test('Annulation : la main est rendue même si le processus ne se ferme pas', async () => {
  const { TestRunner } = await import('../src/runner');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
  const script = path.join(tmp, 'app.js');
  // Processus qui ignore SIGTERM : simule un taskkill lent ou un processus récalcitrant.
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'pid'))}, String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => {}, 20000);`);
  const runner = new TestRunner({ append: () => {}, appendLine: () => {} } as never, tmp);
  const t0 = Date.now();
  const pending = runner.runMtp({ path: path.join(tmp, 'X.csproj'), runner: 'mtp', framework: 'tunit', targetFrameworks: [] },
    { command: process.execPath, args: [script], cwd: os.tmpdir(), targetPath: script, env: {} }, [], []);
  setTimeout(() => runner.cancel(), 300);
  const res = await pending;
  assert.ok(Date.now() - t0 < 5000, `rendu en ${Date.now() - t0} ms`);
  assert.equal(res.ok, false);
  if (!res.ok) { assert.match(res.error, /cancel/i); }
  // Nettoyage : le processus récalcitrant est tué pour de bon.
  try { process.kill(Number(fs.readFileSync(path.join(tmp, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* déjà mort */ }
  removeLater(tmp);
});

/** Sous Windows, un processus tué libère ses fichiers de façon asynchrone : nettoyage sans faire échouer le test. */
function removeLater(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* dossier temporaire */ }
}
