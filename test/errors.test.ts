import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanMethod, diff, parseFailure, summarizeFailure } from '../src/errorFormat';
import { buildTree, buildTreeNodeFilter, filterArgs, treeNodeSegments } from '../src/model';
import { inspectProject } from '../src/projects';
import { parseTrx } from '../src/trxParser';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');

test('TRX TUnit (MTP) : classe et méthode via TrxFullyQualifiedTypeName / TestMethodIdentifier', () => {
  const r = parseTrx(fixture('tunit-mtp.trx'), 'Shop.Tests.csproj');
  assert.equal(r.length, 3);
  const [proj] = buildTree(['Shop.Tests.csproj'], r, { failedOnly: false });
  const cls = proj.children[0];
  assert.equal(cls.label, 'CartTests');
  assert.deepEqual(cls.children.map(c => c.label), ['Discount', 'Total_IsComputed']);
  assert.deepEqual(cls.children[0].children.map(c => c.label), ['(0.5)', '(1.5)']);
});

test('Message TUnit : expectation, constat, expression et valeurs', () => {
  const p = parseFailure('Expected to be 80\nbut found 100\n\nat Assert.That(total).IsEqualTo(80)');
  assert.equal(p.assertions.length, 1);
  const a = p.assertions[0];
  assert.deepEqual([a.expected, a.found, a.expression], ['80', '100', 'Assert.That(total).IsEqualTo(80)']);
  assert.equal(summarizeFailure('Expected to be 80\nbut found 100\n\nat Assert.That(total).IsEqualTo(80)'), 'expected 80 · got 100');
});

test('Message TUnit : écart de membre', () => {
  const r = parseTrx(fixture('tunit-mtp.trx'), 'x').find(x => x.displayName === 'Discount(1.5)')!;
  const a = parseFailure(r.message).assertions[0];
  assert.deepEqual([a.member, a.expected, a.found], ['FirstName', '"Victoria"', '"ictoria"']);
});

test('Message TUnit : Assert.Multiple (plusieurs blocs) + CRLF', () => {
  const msg = 'Expected to be 1\r\nbut found 2\r\n\r\nat Assert.That(a).IsEqualTo(1)\r\n\r\nExpected to contain "x"\r\nbut it was not found\r\n\r\nat Assert.That(list).Contains("x")';
  const p = parseFailure(msg);
  assert.equal(p.assertions.length, 2);
  assert.equal(p.assertions[1].expression, 'Assert.That(list).Contains("x")');
  assert.equal(p.assertions[1].expected, undefined, 'pas de valeurs extraites hors IsEqualTo');
});

test('Exceptions internes (format FlattenedException TUnit)', () => {
  const p = parseFailure('Échec du service\n ---> System.InvalidOperationException: Connexion refusée\n ---> System.Net.Sockets.SocketException: 10061',
    '   at Svc.Call() in /src/Svc.cs:line 10\n--- Inner exception stack trace (System.InvalidOperationException) ---\n   at Db.Open() in /src/Db.cs:line 3');
  assert.equal(p.main, 'Échec du service');
  assert.deepEqual(p.inner.map(i => i.type), ['System.InvalidOperationException', 'System.Net.Sockets.SocketException']);
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[1].title, 'System.InvalidOperationException');
});

test('Stack : machine à états async et lambdas nettoyées, "End of stack trace" ignoré', () => {
  const r = parseTrx(fixture('tunit-mtp.trx'), 'x')[0];
  const frames = parseFailure(r.message, r.stackTrace).sections[0].frames;
  assert.equal(frames.length, 3, 'doublon async fusionné');
  assert.equal(frames[1].method, 'CartTests.Total_IsComputed()');
  assert.equal(frames[1].file, 'C:\\src\\Shop.Tests\\CartTests.cs');
  assert.equal(cleanMethod('Ns.C.<Run>b__0_1(Int32 x)'), 'Ns.C.Run (lambda)');
});

test('Messages xUnit / NUnit / MSTest', () => {
  const x = parseFailure('Assert.Equal() Failure: Strings differ\n           ↓ (pos 3)\nExpected: "abcdef"\nActual:   "abcxef"\n           ↑ (pos 3)').assertions[0];
  assert.deepEqual([x.expectation, x.expected, x.found], ['Assert.Equal() Failure: Strings differ', '"abcdef"', '"abcxef"']);
  const n = parseFailure('  Expected: 5\n  But was:  4\n').assertions[0];
  assert.deepEqual([n.expected, n.found], ['5', '4']);
  const m = parseFailure('Assert.AreEqual failed. Expected:<5>. Actual:<4>.').assertions[0];
  assert.deepEqual([m.expected, m.found], ['5', '4']);
  assert.equal(parseFailure('Object reference not set to an instance of an object.').assertions.length, 0);
});

test('Diff : une ligne (préfixe/suffixe) et multi-lignes (LCS)', () => {
  const d = diff('"Victoria"', '"ictoria"');
  assert.deepEqual(d.expected.map(s => [s.text, s.changed]), [['"', false], ['V', true], ['ictoria"', false]]);
  assert.deepEqual(d.found.map(s => [s.text, s.changed]), [['"', false], ['', true], ['ictoria"', false]], 'marqueur d\'absence');
  assert.deepEqual(diff('80', '100').expected, [{ text: '80', changed: true }], 'nombre : valeur entière');
  const m = diff('a\nb\nc', 'a\nX\nc');
  assert.deepEqual(m.found.map(s => s.changed), [false, true, false]);
});

test('Filtres TUnit --treenode-filter', () => {
  assert.deepEqual(treeNodeSegments('Shop.Tests.Outer+Inner`1'), { ns: 'Shop.Tests', cls: 'Inner' });
  assert.equal(buildTreeNodeFilter({ kind: 'class', className: 'Shop.Tests.CartTests' }), '/*/Shop.Tests/CartTests/*');
  assert.equal(buildTreeNodeFilter({ kind: 'methods', fqns: ['Shop.Tests.CartTests.Total'] }), '/*/Shop.Tests/CartTests/Total');
  assert.equal(buildTreeNodeFilter({ kind: 'methods', fqns: ['A.C1.M1', 'A.C2.M2', 'A.C2.M1'] }), '/*/A/(C1)|(C2)/(M1)|(M2)');
  assert.equal(buildTreeNodeFilter({ kind: 'class', className: 'GlobalClass' }), '/*/*/GlobalClass/*');
  assert.deepEqual(filterArgs('mtp', 'tunit', { kind: 'all' }), []);
  assert.deepEqual(filterArgs('mtp', 'xunit3', { kind: 'methods', fqns: ['A.B.M'] }), ['--filter-method', 'A.B.M']);
  assert.equal(filterArgs('mtp', 'mstest', { kind: 'class', className: 'A.B' })[0], '--filter');
  assert.deepEqual(filterArgs('xunit3', 'xunit3', { kind: 'class', className: 'A.B' }), ['-class', 'A.B']);
  assert.deepEqual(filterArgs('xunit3', 'xunit3', { kind: 'methods', fqns: ['A.B.M', 'A.B.N', 'A.B.M'] }), ['-method', 'A.B.M', '-method', 'A.B.N']);
});

test('Détection xUnit v3 : ligne de commande native sauf UseMicrosoftTestingPlatformRunner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-'));
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); return path.join(root, rel); };
  const native = write('a/A.Tests.csproj', '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup></Project>');
  const withSdk = write('b/B.Tests.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit.v3" /><PackageReference Include="xunit.runner.visualstudio" /></ItemGroup></Project>');
  const dotnetTestMtp = write('c/C.Tests.csproj', '<Project><PropertyGroup><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup></Project>');
  write('d/Directory.Build.props', '<Project><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup></Project>');
  const mtp = write('d/D.Tests.csproj', '<Project><ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup></Project>');
  assert.equal(inspectProject(native)!.runner, 'xunit3');
  assert.equal(inspectProject(withSdk)!.runner, 'xunit3');
  assert.equal(inspectProject(dotnetTestMtp)!.runner, 'xunit3', 'TestingPlatformDotnetTestSupport ne change pas la ligne de commande du binaire');
  assert.equal(inspectProject(mtp)!.runner, 'mtp');

  // Gestion centralisée des paquets : TUnit déclaré en version pour d'autres projets du dépôt.
  write('e/Directory.Packages.props', '<Project><ItemGroup><PackageVersion Include="TUnit" Version="1.2.3" /><PackageVersion Include="xunit.v3" Version="3.2.2"></PackageVersion></ItemGroup></Project>');
  write('e/Directory.Build.props', '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup></Project>');
  const cpm = inspectProject(write('e/src/E.Tests/E.Tests.csproj', '<Project><ItemGroup><PackageReference Include="xunit.v3" /></ItemGroup></Project>'))!;
  assert.deepEqual([cpm.framework, cpm.runner], ['xunit3', 'xunit3'], 'PackageVersion TUnit ignoré');
  assert.equal(inspectProject(write('e/src/Lib/Lib.csproj', '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup></Project>')), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Détection projets : TUnit direct, TUnit via Directory.Build.props, xUnit VSTest, projet non-test', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-'));
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); return path.join(root, rel); };
  const tunit = write('a/A.Tests.csproj', '<Project><PropertyGroup><TargetFrameworks>net9.0;net8.0</TargetFrameworks></PropertyGroup><ItemGroup><PackageReference Include="TUnit" Version="1.78.0" /></ItemGroup></Project>');
  const xunit = write('b/B.Tests.csproj', '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="xunit" /></ItemGroup></Project>');
  write('c/Directory.Build.props', '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><PackageReference Include="TUnit" /></ItemGroup></Project>');
  const viaProps = write('c/C.Tests.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
  const lib = write('d/Lib.csproj', '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup></Project>');

  const t = inspectProject(tunit)!;
  assert.deepEqual([t.framework, t.runner, t.targetFrameworks], ['tunit', 'mtp', ['net9.0', 'net8.0']]);
  assert.deepEqual([inspectProject(xunit)!.framework, inspectProject(xunit)!.runner], ['xunit', 'vstest']);
  assert.equal(inspectProject(viaProps)!.framework, 'tunit');
  assert.equal(inspectProject(lib), undefined);
  assert.equal(inspectProject(xunit, 'mtp')!.runner, 'mtp', 'forçage par paramètre');
  fs.rmSync(root, { recursive: true, force: true });
});

import { BuildTracker, buildSettings, pickSolution, pool, solutionProjects } from '../src/buildTracker';
import { readLaunchSettingsEnv, splitArgs, stripJsonComments } from '../src/runner';

test('BuildTracker : build sauté si rien n\'a changé, invalidé sinon, course pendant le build', () => {
  const t = new BuildTracker();
  assert.equal(t.needsRestore, true);
  let g = t.snapshot;
  t.markBuilt(['A'], g, true);
  assert.deepEqual([t.isBuilt('A'), t.needsRestore], [true, false]);
  assert.equal(t.touch('/ws/A/bin/Debug/x.dll'), false);
  assert.equal(t.isBuilt('A'), true, 'bin/obj ignorés');
  t.touch('/ws/A/Foo.cs');
  assert.deepEqual([t.isBuilt('A'), t.needsRestore], [false, false], '.cs : build mais pas restore');
  assert.equal(t.touch('/ws/A/A.csproj'), true);
  assert.equal(t.needsRestore, true);
  g = t.snapshot; t.touch('/ws/A/Bar.cs'); t.markBuilt(['A'], g, true);
  assert.equal(t.isBuilt('A'), false, 'fichier modifié pendant le build → pas marqué');
});

test('Solutions .sln / .slnx et choix de la plus petite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-sln-'));
  fs.writeFileSync(path.join(root, 'Big.sln'), 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "src\\A\\A.csproj", "{1}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "src\\B\\B.csproj", "{2}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "C", "src\\C\\C.csproj", "{3}"\nEndProject\n');
  fs.writeFileSync(path.join(root, 'Small.slnx'), '<Solution><Folder Name="/t/"><Project Path="src/A/A.csproj" /><Project Path="src/B/B.csproj" /></Folder></Solution>');
  const A = path.join(root, 'src', 'A', 'A.csproj'), B = path.join(root, 'src', 'B', 'B.csproj'), C = path.join(root, 'src', 'C', 'C.csproj');
  assert.deepEqual(solutionProjects(path.join(root, 'Big.sln')), [A, B, C]);
  assert.equal(pickSolution([path.join(root, 'Big.sln'), path.join(root, 'Small.slnx')], [A, B]), path.join(root, 'Small.slnx'));
  assert.equal(pickSolution([path.join(root, 'Big.sln'), path.join(root, 'Small.slnx')], [A, C]), path.join(root, 'Big.sln'));
  assert.equal(pickSolution([path.join(root, 'Small.slnx')], [C]), undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Arguments : RunArguments, -c dans buildArgs, launchSettings', () => {
  assert.deepEqual(splitArgs('exec "C:\\a b\\t.dll" --x'), ['exec', 'C:\\a b\\t.dll', '--x']);
  assert.deepEqual(splitArgs(''), []);
  const cfg = (o: Record<string, unknown>) => ({ get: <T>(k: string, d?: T) => (k in o ? o[k] : d) as T });
  assert.deepEqual(buildSettings(cfg({ 'mtp.buildArgs': ['-c', 'Release', '-p:X=1'] })), { configuration: 'Release', buildArgs: ['-p:X=1'] });
  assert.deepEqual(buildSettings(cfg({ configuration: 'Debug' })), { configuration: 'Debug', buildArgs: [] });
  assert.equal(JSON.parse(stripJsonComments('{ // c\n "u": "http://x/*y*/", /* z */ "a": [1,], }')).u, 'http://x/*y*/');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctv-ls-'));
  fs.mkdirSync(path.join(root, 'Properties'));
  fs.writeFileSync(path.join(root, 'Properties', 'launchSettings.json'), '{ "profiles": { "IIS": { "commandName": "IISExpress" }, "Tests": { "commandName": "Project", "environmentVariables": { "DB": "test", "N": 3 } } } }');
  assert.deepEqual(readLaunchSettingsEnv(path.join(root, 'X.csproj')), { DB: 'test', N: '3' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('pool : concurrence bornée', async () => {
  let live = 0, max = 0;
  await pool([1, 2, 3, 4, 5], 2, async () => { live++; max = Math.max(max, live); await new Promise(r => setTimeout(r, 10)); live--; });
  assert.equal(max, 2);
});

import { elapsed } from '../src/model';
import { parseTime } from '../src/trxParser';

test('Temps écoulé : tests parallèles, relances partielles, repli sur la somme', () => {
  const t0 = parseTime('2026-11-20T15:00:00.0000000Z')!;
  const mk = (cls: string, m: string, startS: number, durS: number) => ({ project: 'P', className: cls, methodName: m, displayName: m, outcome: 'passed' as const, durationMs: durS * 1000, startMs: t0 + startS * 1000 });
  // 20 tests de 0,9 s lancés quasi simultanément : somme 18 s, écoulé ~1 s
  const par = Array.from({ length: 20 }, (_, i) => mk('A.Import', 'T' + i, i * 0.005, 0.9));
  assert.equal(Math.round(elapsed(par)!), 995);
  const [proj] = buildTree(['P'], par, { failedOnly: false });
  assert.deepEqual([Math.round(proj.durationMs), proj.sumMs], [995, 18000]);
  // relance d'un test 10 min plus tard : le trou n'est pas compté
  assert.equal(elapsed([mk('A', 'x', 0, 1), mk('A', 'y', 600, 2)]), 3000);
  // un résultat sans heure → somme
  assert.equal(elapsed([mk('A', 'x', 0, 1), { ...mk('A', 'y', 0, 2), startMs: undefined }]), undefined);
  assert.equal(parseTime('2026-11-20T16:00:00.1234567+01:00'), t0 + 123);
});

test('BuildTracker : cause du build', () => {
  const t = new BuildTracker();
  assert.equal(t.buildReason(), 'first run of the session');
  t.markBuilt(['A'], t.snapshot, true);
  t.touch('/ws/A/obj/x.cs');
  t.touch('/ws/A/data/test.db'); t.touch('/ws/A/Foo.cs'); t.touch('/ws/A/Bar.cs');
  assert.equal(t.buildReason(f => f.replace('/ws/', '')), 'A/data/test.db changed (+2 more)');
  t.markBuilt(['A'], t.snapshot, false);
  t.touch('/ws/A/Foo.cs');
  assert.equal(t.buildReason(), '/ws/A/Foo.cs changed');
});
