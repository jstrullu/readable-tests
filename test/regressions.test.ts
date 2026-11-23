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
