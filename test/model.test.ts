import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { aggregate, buildFilter, buildTree, caseLabel, summarize } from '../src/model';
import { parseStack } from '../src/errorFormat';
import { parseDuration, parseTrx } from '../src/trxParser';
import { ResultStore } from '../src/store';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');
const P = 'C:/src/Shop.Tests/Shop.Tests.csproj';

test('parseDuration', () => {
  assert.equal(parseDuration('00:00:01.5000000'), 1500);
  assert.equal(parseDuration('1.00:00:00'), 86_400_000);
  assert.equal(parseDuration(undefined), 0);
});

test('TRX xUnit : classes, theories, nested, outcomes', () => {
  const r = parseTrx(fixture('xunit.trx'), P);
  assert.equal(r.length, 4);
  const failed = r.find(x => x.outcome === 'failed')!;
  assert.equal(failed.className, 'Shop.Tests.CartTests');
  assert.equal(failed.methodName, 'Discount');
  assert.match(failed.message!, /Values differ/);
  assert.equal(failed.stdout, 'calcul remise 1.5');
  assert.equal(r.find(x => x.methodName === 'Skipped')!.outcome, 'skipped');
  const total = r.reduce((s, x) => s + x.durationMs, 0);
  assert.deepEqual(summarize(r), { passed: 2, failed: 1, skipped: 1, durationMs: total, elapsedMs: total }, 'sans startTime : écoulé = somme');
});

test('TRX MSTest DataRow : InnerResults éclatés, className nettoyé', () => {
  const r = parseTrx(fixture('mstest-datarow.trx'), 'Calc.Tests.csproj');
  assert.equal(r.length, 2);
  assert.ok(r.every(x => x.className === 'Calc.Tests.MathTests' && x.methodName === 'Sum'));
  const f = parseStack(r.find(x => x.outcome === 'failed')!.stackTrace!)[0].frames;
  assert.deepEqual([f[0].file, f[0].line], ['/src/Calc.Tests/MathTests.cs', 17]);
});

test('TRX NUnit : TestCase regroupés sous la méthode', () => {
  const r = parseTrx(fixture('nunit.trx'), 'Calc.Tests.csproj');
  const [proj] = buildTree(['Calc.Tests.csproj'], r, { failedOnly: false });
  const sum = proj.children[0].children.find(n => n.label === 'Sum')!;
  assert.equal(sum.children.length, 2);
  assert.deepEqual(sum.children.map(c => c.label), ['(1,2,3)', '(2.5,2,5)']);
  assert.equal(proj.children[0].label, 'MathTests');
});

test('Arbre : Projet > Classe > Méthode > Cas, agrégation et filtres', () => {
  const r = parseTrx(fixture('xunit.trx'), P);
  const [proj] = buildTree([P, 'Other.Tests.csproj'], r, { failedOnly: false }).filter(n => n.project === P);
  assert.equal(proj.label, 'Shop.Tests');
  assert.equal(proj.outcome, 'failed');
  const cart = proj.children.find(c => c.label === 'CartTests')!;
  assert.equal(cart.description, 'Shop.Tests');
  const discount = cart.children.find(c => c.label === 'Discount')!;
  assert.equal(discount.children.length, 2);
  assert.equal(discount.outcome, 'failed');
  assert.equal(caseLabel(discount.children[0].result!), '(rate: 0.1)');

  const all = buildTree([P, 'Other.Tests.csproj'], r, { failedOnly: false });
  assert.equal(all.length, 2, 'projet sans résultat conservé');
  const onlyFailed = buildTree([P, 'Other.Tests.csproj'], r, { failedOnly: true });
  assert.equal(onlyFailed.length, 1, 'projet vide masqué quand filtré');
  assert.equal(onlyFailed[0].children[0].children[0].children.length, 0, 'un seul cas restant → pas de sous-niveau');
  assert.equal(buildTree([P], r, { failedOnly: false, text: 'add_inc' })[0].children[0].children.length, 1);
});

test('aggregate', () => {
  assert.equal(aggregate(['passed', 'skipped']), 'passed');
  assert.equal(aggregate(['skipped', 'skipped']), 'skipped');
  assert.equal(aggregate(['passed', 'failed', 'running']), 'running');
});

test('Filtre vstest : échappement et couverture NUnit', () => {
  assert.equal(buildFilter({ kind: 'all' }), undefined);
  assert.equal(buildFilter({ kind: 'class', className: 'A.B' }), 'FullyQualifiedName~A.B.');
  assert.equal(
    buildFilter({ kind: 'methods', fqns: ['A.B.M', 'A.B.M'] }),
    'FullyQualifiedName=A.B.M|FullyQualifiedName~A.B.M\\(');
  assert.equal(buildFilter({ kind: 'methods', fqns: ['A.B+C.M'] }), 'FullyQualifiedName=A.B+C.M|FullyQualifiedName~A.B+C.M\\(');
});

test('Store : exécution ciblée, suppression des cas disparus, restauration', () => {
  const initial = parseTrx(fixture('xunit.trx'), P);
  const store = new ResultStore(initial);
  const target = { kind: 'methods' as const, fqns: ['Shop.Tests.CartTests.Discount'] };

  store.markRunning(P, target);
  assert.equal(store.all().filter(r => r.outcome === 'running').length, 2);
  store.restore(P);
  assert.equal(store.all().filter(r => r.outcome === 'running').length, 0);

  store.markRunning(P, target);
  const fixed = initial.filter(r => r.displayName.endsWith('(rate: 0.1)')).map(r => ({ ...r, durationMs: 1 }));
  store.apply(P, target, fixed);
  assert.equal(store.all().length, 3, 'le cas (rate: 1.5) disparu est retiré');
  assert.equal(store.failed().length, 0);

  store.apply(P, { kind: 'all' }, initial.slice(0, 1));
  assert.equal(store.all().length, 1, 'run complet = remplacement du projet');
});
