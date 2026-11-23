import { XMLParser } from 'fast-xml-parser';
import { Outcome, TestResult } from './model';
import { t } from './i18n';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: name => name === 'UnitTestResult' || name === 'UnitTest',
  // Un TRX est un fichier local produit par le test runner, sans entités personnalisées :
  // les limites anti « bombe d'entités » (1000 expansions par défaut en 4.x) cassent les vrais TRX,
  // qui contiennent des milliers de &lt; &gt; &quot; (messages, sorties console, stack traces).
  processEntities: {
    enabled: true,
    maxTotalExpansions: Number.MAX_SAFE_INTEGER,
    maxExpandedLength: Number.MAX_SAFE_INTEGER,
  },
});

/** "00:00:01.2345678" ou "1.02:03:04.5" → millisecondes */
export function parseDuration(d: string | undefined): number {
  if (!d) { return 0; }
  const m = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d.trim());
  if (!m) { return 0; }
  const [, days, h, min, s] = m;
  return (((Number(days ?? 0) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

export function parseTime(t: string | undefined): number | undefined {
  if (!t) { return undefined; }
  const v = Date.parse(t);
  return Number.isNaN(v) ? undefined : v;
}

export function mapOutcome(o: string | undefined): Outcome {
  switch ((o ?? '').toLowerCase()) {
    case 'passed':
    case 'passedbutrunaborted':
    case 'completed':
      return 'passed';
    case 'failed':
    case 'error':
    case 'timeout':
    case 'aborted':
      return 'failed';
    default:
      return 'skipped'; // NotExecuted, Inconclusive, NotRunnable, Pending, Warning...
  }
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) { return undefined; }
  if (typeof v === 'string') { return v.trim() || undefined; }
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return text((v as Record<string, unknown>)['#text']);
  }
  return String(v).trim() || undefined;
}

interface Definition { className: string; methodName: string }

/** Parse le contenu d'un fichier .trx. `project` = chemin du .csproj qui l'a produit. */
export function parseTrx(xml: string, project: string): TestResult[] {
  const doc = parser.parse(xml);
  const run = doc?.TestRun;
  if (!run) { throw new Error(t('Invalid TRX file: <TestRun> element not found.')); }

  const defs = new Map<string, Definition>();
  for (const ut of run.TestDefinitions?.UnitTest ?? []) {
    const tm = ut.TestMethod ?? {};
    // Anciennes versions MSTest : "Ns.Class, Assembly, Version=..." → on garde "Ns.Class"
    let className = String(tm['@_className'] ?? '').split(',')[0].trim();
    // NUnit : le nom peut contenir les arguments du TestCase → "Sum(1,2,3)" ; on regroupe sur "Sum".
    let methodName = String(tm['@_name'] ?? ut['@_name'] ?? '').split('(')[0].trim();
    if (!className || className.includes('(')) {
      ({ className, methodName } = fallbackDefinition(String(ut['@_name'] ?? '')));
    }
    defs.set(ut['@_id'], { className, methodName });
  }

  const results: TestResult[] = [];
  const visit = (r: any, parentDef?: Definition) => {
    const def = defs.get(r['@_testId']) ?? parentDef ?? fallbackDefinition(String(r['@_testName'] ?? ''));
    const inner = r.InnerResults?.UnitTestResult;
    if (Array.isArray(inner) && inner.length > 0) {
      // MSTest DataRow : le parent n'est qu'un conteneur, on expose chaque ligne.
      for (const i of inner) { visit(i, def); }
      return;
    }
    const out = r.Output ?? {};
    results.push({
      project,
      className: def.className,
      methodName: def.methodName,
      displayName: String(r['@_testName'] ?? def.methodName),
      outcome: mapOutcome(r['@_outcome']),
      durationMs: parseDuration(r['@_duration']),
      startMs: parseTime(r['@_startTime']),
      message: text(out.ErrorInfo?.Message),
      stackTrace: text(out.ErrorInfo?.StackTrace),
      stdout: text(out.StdOut),
    });
  };

  for (const r of run.Results?.UnitTestResult ?? []) { visit(r); }
  return results;
}

/** Si la définition est absente : "Ns.Class.Method(args)" → { Ns.Class, Method } */
function fallbackDefinition(testName: string): Definition {
  const base = testName.split('(')[0];
  const i = base.lastIndexOf('.');
  return i < 0 ? { className: t('(unknown)'), methodName: base } : { className: base.substring(0, i), methodName: base.substring(i + 1) };
}
