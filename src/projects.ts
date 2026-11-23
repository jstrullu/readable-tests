import * as fs from 'fs';
import * as path from 'path';

/** `xunit3` : ligne de commande native de xUnit v3 (binaire lancé directement, sans MTP). */
export type Runner = 'vstest' | 'mtp' | 'xunit3' | 'vitest' | 'jest' | 'angular';
export type Framework = 'tunit' | 'xunit3' | 'xunit' | 'nunit' | 'mstest' | 'vitest' | 'jest' | 'unknown';

export interface TestProject {
  /** Identifiant unique : chemin du .csproj, du package.json, ou "angular.json#projet" */
  path: string;
  runner: Runner;
  framework: Framework;
  targetFrameworks: string[];
  /** JS : répertoire de travail (racine du package / workspace Angular) */
  root?: string;
  /** Nom affiché (sinon déduit du chemin) */
  label?: string;
  /** Angular : nom du projet dans angular.json et sa racine relative */
  angularProject?: string;
  angularRoot?: string;
  /** JS : runner introuvable dans les node_modules (npm install non fait) */
  notInstalled?: boolean;
}

export function isNodeRunner(r: Runner): boolean { return r === 'vitest' || r === 'jest' || r === 'angular'; }

const TEST_MARKERS = /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|"(xunit|xunit\.v3|NUnit|MSTest|MSTest\.Sdk|TUnit)[".]|Sdk="MSTest\.Sdk|Include="TUnit/i;

/** Contenu du .csproj + des Directory.Build.props parents (TUnit y est souvent référencé). */
function effectiveContent(csproj: string): string {
  let content = fs.readFileSync(csproj, 'utf8');
  let dir = path.dirname(csproj);
  for (let i = 0; i < 10; i++) {
    for (const f of ['Directory.Build.props', 'Directory.Packages.props']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) {
        try { content += '\n' + fs.readFileSync(p, 'utf8'); } catch { /* ignore */ }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  // Directory.Packages.props (gestion centralisée) liste les versions de TOUS les paquets du dépôt :
  // un <PackageVersion Include="TUnit"> ne veut pas dire que ce projet référence TUnit.
  return content.replace(/<PackageVersion\b[^>]*?(?:\/>|>[\s\S]*?<\/PackageVersion>)/gi, '');
}

export function detectFramework(content: string): Framework {
  if (/Include="TUnit(\.Engine)?"/i.test(content)) { return 'tunit'; }
  if (/Include="xunit\.v3/i.test(content)) { return 'xunit3'; }
  if (/Include="xunit"|Include="xunit\.core"/i.test(content)) { return 'xunit'; }
  if (/Include="NUnit"/i.test(content)) { return 'nunit'; }
  if (/Include="MSTest|Sdk="MSTest\.Sdk/i.test(content)) { return 'mstest'; }
  return 'unknown';
}

export function detectRunner(content: string, framework: Framework): Runner {
  if (framework === 'tunit') { return 'mtp'; }
  // xUnit v3 : le binaire n'expose la ligne de commande MTP qu'avec UseMicrosoftTestingPlatformRunner=true.
  // Sinon c'est la ligne de commande native (-class, -method, -result-trx), quel que soit le mode de dotnet test.
  if (framework === 'xunit3') { return /<UseMicrosoftTestingPlatformRunner>\s*true/i.test(content) ? 'mtp' : 'xunit3'; }
  if (/<(UseMicrosoftTestingPlatformRunner|EnableMSTestRunner|EnableNUnitRunner|TestingPlatformDotnetTestSupport)>\s*true/i.test(content)) { return 'mtp'; }
  return 'vstest';
}

export function inspectProject(csproj: string, override: 'auto' | Runner = 'auto'): TestProject | undefined {
  let content: string;
  try { content = effectiveContent(csproj); } catch { return undefined; }
  const own = fs.readFileSync(csproj, 'utf8');
  if (!TEST_MARKERS.test(content) || /<IsTestProject>\s*false/i.test(own)) { return undefined; }
  // Le Directory.Build.props peut référencer TUnit pour tout le dépôt : on ne garde que les projets
  // qui se déclarent test ou référencent eux-mêmes un framework.
  if (!TEST_MARKERS.test(own) && !/<IsTestProject>\s*true/i.test(content)) { return undefined; }

  // Le framework référencé par le projet lui-même prime sur celui hérité des fichiers parents.
  const ownFramework = detectFramework(own);
  const framework = ownFramework !== 'unknown' ? ownFramework : detectFramework(content);
  const runner = override === 'auto' ? detectRunner(content, framework) : override;
  const tfms = /<TargetFrameworks?>\s*([^<]+)</i.exec(own)?.[1].split(';').map(s => s.trim()).filter(Boolean) ?? [];
  return { path: csproj, runner, framework, targetFrameworks: tfms };
}
