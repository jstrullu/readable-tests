import * as fs from 'fs';
import * as path from 'path';

export type Runner = 'vstest' | 'mtp' | 'vitest' | 'jest' | 'angular';
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
  return content;
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
  if (/<(UseMicrosoftTestingPlatformRunner|EnableMSTestRunner|EnableNUnitRunner|TestingPlatformDotnetTestSupport)>\s*true/i.test(content)) { return 'mtp'; }
  if (framework === 'xunit3' && /<OutputType>\s*Exe/i.test(content) && !/Microsoft\.NET\.Test\.Sdk/i.test(content)) { return 'mtp'; }
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

  const framework = detectFramework(content);
  const runner = override === 'auto' ? detectRunner(content, framework) : override;
  const tfms = /<TargetFrameworks?>\s*([^<]+)</i.exec(own)?.[1].split(';').map(s => s.trim()).filter(Boolean) ?? [];
  return { path: csproj, runner, framework, targetFrameworks: tfms };
}
