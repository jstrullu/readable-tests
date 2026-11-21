import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { failureOf, parseStack, summarizeResult } from '../src/errorFormat';
import { convertReport, ReporterOutput } from '../src/jsResults';
import { buildTree, jsFullName } from '../src/model';
import { inspectNodeFolder, resolveBin } from '../src/nodeProjects';
import { jsSelection } from '../src/runner';
import { inTarget } from '../src/store';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'js', n), 'utf8')) as ReporterOutput;
const by = (rs: ReturnType<typeof convertReport>, name: string) => rs.find(r => r.methodName === name)!;

for (const [file, root, label] of [['vitest5.json', '/tmp/js/vitest-app', 'Vitest 5'], ['vitest2.json', '/tmp/js/vitest2-app', 'Vitest 2'], ['jest30.json', '/tmp/js/jest-app', 'Jest 30']] as const) {
  test(`${label} : conversion, regroupement, erreurs structurées`, () => {
    const rs = convertReport(fx(file), 'P', root);
    assert.equal(rs.length, 9, '8 tests + 1 fichier qui ne charge pas');
    const [proj] = buildTree(['P'], rs, { failedOnly: false }, () => 'app');
    assert.deepEqual(proj.children.map(c => `${c.label}|${c.description}`).sort(), [
      'Cart › discounts|src/cart.test.js', 'Cart|src/cart.test.js', 'Customer mapping|src/cart.test.js', 'broken.test.js|src', 'cart.test.js|src']);

    // Nombre : valeurs structurées
    assert.equal(summarizeResult(by(rs, 'computes the total')), 'expected 80 · got 100');
    // Objet : attendu/obtenu multi-lignes + frame utilisateur avec ligne exacte
    const obj = failureOf(by(rs, 'maps the first name'));
    assert.match(obj.assertions[0].expected!, /"firstName": "Victoria"/);
    assert.match(obj.assertions[0].found!, /"firstName": "ictoria"/);
    const frame = obj.sections[0].frames.find(f => f.file?.endsWith('cart.test.js'))!;
    assert.equal(frame.line, 27);
    // Erreur levée avec cause
    const thrown = failureOf(by(rs, 'saves the order'));
    assert.equal(thrown.assertions.length, 0);
    assert.match(thrown.main, /Order could not be saved/);
    assert.deepEqual(thrown.inner.map(i => i.message), ['Connection refused (localhost:5432)']);
    // Fichier en erreur de chargement
    assert.match(by(rs, '(file failed to load)').message!, /does-not-exist/);
    // Sortie console (Vitest uniquement : Jest ne rattache pas les logs aux tests)
    if (label !== 'Jest 30') { assert.equal(by(rs, 'maps the first name').stdout, 'mapping customer 42\n'); }
    // Heures de début → temps écoulé calculable
    assert.ok(rs.filter(r => r.outcome !== 'skipped' && r.methodName !== '(file failed to load)').every(r => typeof r.startMs === 'number'));
  });
}

test('Jest : expression d\'assertion conservée, diff texte de Jest remplacé', () => {
  const a = failureOf(by(convertReport(fx('jest30.json'), 'P', '/tmp/js/jest-app'), 'maps the first name')).assertions[0];
  assert.equal(a.expression, 'expect(received).toEqual(expected) // deep equality');
  assert.equal(a.expectation.includes('- Expected'), false);
});

test('Angular 22 (ng test + Vitest 5) : chemins .spec.ts réels et lignes via source maps', () => {
  const rs = convertReport(fx('angular22.json'), 'NG', '/tmp/js/ng-app');
  assert.equal(rs.length, 5);
  const f = rs.find(r => r.methodName === 'computes the total')!;
  assert.equal(f.file, '/tmp/js/ng-app/src/app/cart.spec.ts');
  assert.equal(failureOf(f).sections[0].frames[0].line, 11);
  assert.equal(summarizeResult(f), 'expected 80 · got 100');
});

test('Stack JS : formats de frames', () => {
  const s = parseStack('AssertionError: boom\n    at Object.toEqual (/a/b.spec.ts:27:67)\n    at /a/c.ts:11:15\n    at file:///C:/w/d.spec.ts:3:1\n    at async Promise.all (index 0)\n    at node:internal/process/task_queues:105:5')[0].frames;
  assert.deepEqual(s.map(f => [f.method, f.file, f.line]), [
    ['Object.toEqual', '/a/b.spec.ts', 27], ['<anonymous>', '/a/c.ts', 11], ['<anonymous>', 'C:/w/d.spec.ts', 3],
    ['async Promise.all (index 0)', undefined, undefined], ['<anonymous>', 'node:internal/process/task_queues', 105]]);
});

test('Sélection JS : fichiers relatifs, motif échappé ancré en fin, cible et store', () => {
  const rs = convertReport(fx('vitest5.json'), 'P', '/tmp/js/vitest-app');
  const picked = [by(rs, 'rate 0.1 gives 90'), by(rs, 'computes the total')];
  const target = { kind: 'js' as const, tests: picked.map(r => ({ file: r.file!, fullName: jsFullName(r), path: [...r.suite!, r.methodName] })) };
  const sel = jsSelection(target, '/tmp/js/vitest-app', { runner: 'vitest' });
  assert.deepEqual(sel, { files: ['src/cart.test.js'], pattern: '(?:Cart(?: > | )discounts(?: > | )rate 0\\.1 gives 90|Cart(?: > | )computes the total)$' });
  // Les deux formats de nom complet (Vitest 5 / Angular : " > ", Vitest 2 / Jest : espace) sont acceptés
  const re = new RegExp(sel.pattern!);
  assert.ok(re.test('Cart > discounts > rate 0.1 gives 90') && re.test('Cart discounts rate 0.1 gives 90') && re.test(' Cart computes the total'));
  assert.equal(re.test('Cart keeps passing tests green'), false);
  // Fichier entier (erreur de chargement) : pas de filtre de nom
  assert.deepEqual(jsSelection({ kind: 'js', tests: [{ file: '/tmp/js/vitest-app/src/broken.test.js', fullName: '', path: [] }] }, '/tmp/js/vitest-app', { runner: 'vitest' }), { files: ['src/broken.test.js'] });
  assert.deepEqual(jsSelection(target, '/tmp/js/vitest-app', { runner: 'angular', angularRoot: 'src' }).files, ['cart.test.js']);
  assert.equal(rs.filter(r => inTarget(r, target)).length, 2);
});

test('Découverte : Angular unit-test, Karma ignoré, Vitest, Jest, monorepo et binaire remonté', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-js-'));
  const w = (rel: string, c: unknown) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof c === 'string' ? c : JSON.stringify(c)); };
  w('ng/package.json', { name: 'ng', scripts: { test: 'ng test' }, devDependencies: { vitest: '5', '@angular/build': '22' } });
  w('ng/angular.json', { projects: { app: { root: '', architect: { test: { builder: '@angular/build:unit-test' } } }, lib: { root: 'projects/lib', architect: { test: { builder: '@angular/build:karma' } } } } });
  w('vi/package.json', { name: 'vi', devDependencies: { vitest: '5' } }); w('vi/vitest.config.ts', 'export default {}');
  w('je/package.json', { name: 'je', devDependencies: { jest: '30' }, jest: { testEnvironment: 'node' } });
  w('none/package.json', { name: 'none', devDependencies: { vitest: '5' } });
  w('node_modules/jest/package.json', { version: '30.5.2', bin: { jest: './bin/jest.js' } });

  const ng = inspectNodeFolder(path.join(root, 'ng'));
  assert.deepEqual(ng.map(p => [p.runner, p.label, p.angularProject]), [['angular', 'app', 'app']], 'Karma ignoré, pas de doublon Vitest');
  assert.deepEqual(inspectNodeFolder(path.join(root, 'vi')).map(p => p.runner), ['vitest']);
  assert.deepEqual(inspectNodeFolder(path.join(root, 'je')).map(p => p.runner), ['jest']);
  assert.deepEqual(inspectNodeFolder(path.join(root, 'none')), [], 'vitest sans config ni script : pas un projet de test');
  assert.deepEqual(resolveBin(path.join(root, 'je'), 'jest', 'jest'), { script: path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'), version: '30.5.2' });
  fs.rmSync(root, { recursive: true, force: true });
});

import { ResultStore } from '../src/store';

test('Store : exécution JS filtrée sans écraser les tests non sélectionnés', () => {
  const full = convertReport(fx('vitest5.json'), 'P', '/tmp/js/vitest-app');
  const store = new ResultStore(full);
  const one = by(full, 'computes the total');
  const target = { kind: 'js' as const, tests: [{ file: one.file!, fullName: jsFullName(one), path: [...one.suite!, one.methodName] }] };
  store.markRunning('P', target);
  assert.equal(store.all().filter(r => r.outcome === 'running').length, 1);
  // Vitest renvoie tout le fichier : le test ciblé + les autres en "skipped"
  const fresh = full.filter(r => r.file === one.file).map(r => r === one ? { ...r, outcome: 'passed' as const } : { ...r, outcome: 'skipped' as const });
  store.apply('P', target, fresh);
  const after = new Map(store.all().map(r => [r.methodName, r.outcome]));
  assert.equal(after.get('computes the total'), 'passed');
  assert.equal(after.get('maps the first name'), 'failed', 'non sélectionné : inchangé');
  assert.equal(after.get('(file failed to load)'), 'failed', 'autre fichier : inchangé');
});
