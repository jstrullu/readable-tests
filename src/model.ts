import { t } from './i18n';
// Modèle pur (aucune dépendance à vscode) : testable unitairement.

export type Outcome = 'passed' | 'failed' | 'skipped' | 'notRun' | 'running';

export interface TestResult {
  /** Projet (.csproj) d'origine */
  project: string;
  /** Nom complet de la classe : Ns.Sub.Class */
  className: string;
  /** Nom de la méthode : Method */
  methodName: string;
  /** Nom affiché (inclut les paramètres pour Theory / TestCase) */
  displayName: string;
  outcome: Outcome;
  durationMs: number;
  /** Début d'exécution (epoch ms) si fourni par le TRX : permet de calculer le temps réellement écoulé. */
  startMs?: number;
  message?: string;
  stackTrace?: string;
  stdout?: string;
  // ---- Résultats JavaScript (Vitest / Jest / Angular) ----
  /** Fichier de test absolu */
  file?: string;
  /** Chaîne des describe() */
  suite?: string[];
  /** Ligne du test dans le fichier, si connue */
  line?: number;
  /** Libellé et détail du nœud de regroupement (remplacent namespace/classe .NET) */
  groupLabel?: string;
  groupDescription?: string;
  /** Erreurs structurées fournies par le reporter (attendu/obtenu déjà séparés) */
  failures?: StructuredFailure[];
  /** Pseudo-test représentant une erreur de fichier (chargement, erreur non interceptée) */
  fileLevel?: boolean;
}

export interface StructuredFailure {
  name?: string;
  message: string;
  stack?: string;
  expected?: string;
  actual?: string;
  cause?: StructuredFailure;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** Somme des durées individuelles (gonflée par le parallélisme) */
  durationMs: number;
  /** Temps réellement écoulé (union des intervalles d'exécution), sinon la somme */
  elapsedMs: number;
}

export type NodeKind = 'project' | 'class' | 'test' | 'case';

export interface TreeNode {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  project: string;
  className?: string;
  methodName?: string;
  outcome: Outcome;
  /** Temps écoulé : union des intervalles d'exécution des tests du nœud (TUnit parallélise) */
  durationMs: number;
  /** Somme des durées individuelles */
  sumMs: number;
  children: TreeNode[];
  result?: TestResult;
}

/** Clé unique d'un résultat (un cas de Theory = un résultat). */
export function resultKey(r: Pick<TestResult, 'project' | 'displayName' | 'className' | 'methodName'>): string {
  return `${r.project}::${r.className}::${r.methodName}::${r.displayName}`;
}

export function fullyQualifiedName(r: Pick<TestResult, 'className' | 'methodName'>): string {
  return `${r.className}.${r.methodName}`;
}

const ORDER: Record<Outcome, number> = { running: 0, failed: 1, notRun: 2, skipped: 3, passed: 4 };

/** Agrège le statut d'un parent : running > failed > notRun > skipped > passed. */
export function aggregate(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 0) { return 'notRun'; }
  let best: Outcome = 'passed';
  let allSkipped = true;
  for (const o of outcomes) {
    if (o !== 'skipped') { allSkipped = false; }
    if (ORDER[o] < ORDER[best]) { best = o; }
  }
  // Un groupe avec des tests passés et des tests ignorés reste "passé".
  if (best === 'skipped' && !allSkipped) { return 'passed'; }
  return best;
}

export interface FilterOptions {
  failedOnly: boolean;
  text?: string;
}

function matches(r: TestResult, f: FilterOptions): boolean {
  if (f.failedOnly && r.outcome !== 'failed') { return false; }
  if (f.text) {
    const t = f.text.toLowerCase();
    if (!`${r.className}.${r.methodName} ${r.displayName}`.toLowerCase().includes(t)) { return false; }
  }
  return true;
}

function splitClass(fqn: string): { ns: string; name: string } {
  // Les classes imbriquées apparaissent avec '+' (Outer+Inner) : on garde tout après le dernier '.'.
  const i = fqn.lastIndexOf('.');
  return i < 0 ? { ns: '', name: fqn } : { ns: fqn.substring(0, i), name: fqn.substring(i + 1) };
}

/**
 * Construit l'arbre Projet > Classe > Test (> Cas si plusieurs cas par méthode).
 * Les projets sans résultats sont conservés pour pouvoir les lancer.
 */
export function buildTree(projects: string[], results: TestResult[], filter: FilterOptions, labelOf: (project: string) => string = projectName): TreeNode[] {
  const byProject = new Map<string, TestResult[]>();
  for (const p of projects) { byProject.set(p, []); }
  for (const r of results) {
    if (!byProject.has(r.project)) { byProject.set(r.project, []); }
    if (matches(r, filter)) { byProject.get(r.project)!.push(r); }
  }

  const filtering = filter.failedOnly || !!filter.text;
  const roots: TreeNode[] = [];

  for (const [project, list] of [...byProject.entries()].sort((a, b) => labelOf(a[0]).localeCompare(labelOf(b[0])))) {
    if (filtering && list.length === 0) { continue; }

    const classes = new Map<string, Map<string, TestResult[]>>();
    for (const r of list) {
      if (!classes.has(r.className)) { classes.set(r.className, new Map()); }
      const methods = classes.get(r.className)!;
      if (!methods.has(r.methodName)) { methods.set(r.methodName, []); }
      methods.get(r.methodName)!.push(r);
    }

    const classNodes: TreeNode[] = [];
    for (const [className, methods] of [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const testNodes: TreeNode[] = [];
      for (const [methodName, cases] of [...methods.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const base = { project, className, methodName };
        if (cases.length === 1) {
          const r = cases[0];
          testNodes.push({ ...base, id: resultKey(r), kind: 'test', label: methodName, outcome: r.outcome, durationMs: r.durationMs, sumMs: r.durationMs, children: [], result: r });
        } else {
          const caseNodes: TreeNode[] = cases
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map(r => ({ ...base, id: resultKey(r), kind: 'case' as const, label: caseLabel(r), outcome: r.outcome, durationMs: r.durationMs, sumMs: r.durationMs, children: [], result: r }));
          testNodes.push({ ...base, id: `${project}::${className}::${methodName}`, kind: 'test', label: methodName, description: t('{0} cases', cases.length), outcome: aggregate(caseNodes.map(c => c.outcome)), ...timing(cases), children: caseNodes });
        }
      }
      const first = [...methods.values()][0][0];
      const { ns, name } = first.groupLabel !== undefined ? { ns: first.groupDescription ?? '', name: first.groupLabel } : splitClass(className);
      classNodes.push({ id: `${project}::${className}`, kind: 'class', label: name, description: ns, project, className, outcome: aggregate(testNodes.map(t => t.outcome)), ...timing([...methods.values()].flat()), children: testNodes });
    }

    roots.push({ id: project, kind: 'project', label: labelOf(project), project, outcome: aggregate(classNodes.map(c => c.outcome)), ...timing(list), children: classNodes });
  }
  return roots;
}

/** "Ns.Class.Method(a: 1, b: 2)" → "(a: 1, b: 2)" ; sinon nom affiché complet. */
export function caseLabel(r: TestResult): string {
  const i = r.displayName.indexOf('(');
  return i >= 0 ? r.displayName.substring(i) : r.displayName;
}

export function projectName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(cs|fs|vb)proj$/i, '');
}

function timing(results: TestResult[]): { durationMs: number; sumMs: number } {
  const sumMs = results.reduce((s, r) => s + r.durationMs, 0);
  return { durationMs: elapsed(results) ?? sumMs, sumMs };
}

/**
 * Temps écoulé = longueur de l'union des intervalles [début, début + durée].
 * Juste avec des tests parallèles, et avec des résultats issus de plusieurs exécutions
 * (relance partielle) : les trous entre exécutions ne sont pas comptés.
 * undefined si un résultat n'a pas d'heure de début (TRX ancien) → on retombe sur la somme.
 */
export function elapsed(results: TestResult[]): number | undefined {
  if (results.length === 0) { return 0; }
  if (results.some(r => r.startMs === undefined)) { return undefined; }
  const iv = results.map(r => [r.startMs!, r.startMs! + r.durationMs] as const).sort((a, b) => a[0] - b[0]);
  let total = 0, [cs, ce] = iv[0];
  for (const [s, e] of iv.slice(1)) {
    if (s <= ce) { ce = Math.max(ce, e); } else { total += ce - cs; cs = s; ce = e; }
  }
  return total + (ce - cs);
}

export function summarize(results: TestResult[]): RunSummary {
  const s: RunSummary = { passed: 0, failed: 0, skipped: 0, durationMs: 0, elapsedMs: 0 };
  for (const r of results) {
    if (r.outcome === 'passed') { s.passed++; }
    else if (r.outcome === 'failed') { s.failed++; }
    else if (r.outcome === 'skipped') { s.skipped++; }
    s.durationMs += r.durationMs;
  }
  s.elapsedMs = elapsed(results) ?? s.durationMs;
  return s;
}

export function formatDuration(ms: number): string {
  if (ms < 1) { return '<1 ms'; }
  if (ms < 1000) { return `${Math.round(ms)} ms`; }
  if (ms < 60_000) { return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`; }
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

// ---------- Filtre vstest ----------

/** Échappe les caractères spéciaux du langage de filtre vstest : \ ( ) & | = ! ~ , */
export function escapeFilterValue(v: string): string {
  return v.replace(/[\\()&|=!~,]/g, c => `\\${c}`);
}

export type RunTarget =
  | { kind: 'all' }
  | { kind: 'class'; className: string }
  | { kind: 'methods'; fqns: string[] }
  /**
   * JavaScript : tests précis. fullName = "describe … test" (identité) ; path = segments pour le motif -t.
   * fullName vide = tout le fichier (erreur de chargement à relancer).
   */
  | { kind: 'js'; tests: { file: string; fullName: string; path: string[] }[] };

/** Nom complet JS tel que filtré par -t / --filter : describe … test, séparés par des espaces. */
export function jsFullName(r: Pick<TestResult, 'suite' | 'methodName'>): string {
  return [...(r.suite ?? []), r.methodName].join(' ');
}

/**
 * Construit l'argument --filter. Retourne undefined pour "tout".
 * Pour une classe on utilise "~" (contains) sur "Ns.Class." afin d'éviter de matcher "Ns.ClassBis".
 */
export function buildFilter(target: RunTarget): string | undefined {
  switch (target.kind) {
    case 'all': case 'js': return undefined;
    case 'class': return `FullyQualifiedName~${escapeFilterValue(target.className + '.')}`;
    case 'methods': {
      // "=" couvre xUnit/MSTest ; "~X(" couvre NUnit dont le FQN des TestCase inclut les arguments.
      const unique = [...new Set(target.fqns)];
      return unique
        .map(f => `FullyQualifiedName=${escapeFilterValue(f)}|FullyQualifiedName~${escapeFilterValue(f + '(')}`)
        .join('|');
    }
  }
}

// ---------- Filtres MTP ----------

/** "Ns.Outer+Inner`1" → { ns: "Ns", cls: "Inner" } (TUnit filtre sur le nom déclaré, sans arguments génériques). */
export function treeNodeSegments(className: string): { ns: string; cls: string } {
  const outer = className.split('+')[0];
  const dot = outer.lastIndexOf('.');
  const ns = dot < 0 ? '' : outer.substring(0, dot);
  const last = className.includes('+') ? className.substring(className.lastIndexOf('+') + 1) : outer.substring(dot + 1);
  return { ns, cls: last.replace(/`\d+$/, '').replace(/<.*>$/, '') };
}

function alt(values: string[]): string {
  const u = [...new Set(values)];
  if (u.length === 0 || u.some(v => v === '')) { return '*'; }
  return u.length === 1 ? u[0] : u.map(v => `(${v})`).join('|');
}

/**
 * Filtre TUnit --treenode-filter : /<Assembly>/<Namespace>/<Classe>/<Test>.
 * Un seul filtre par exécution : pour plusieurs méthodes réparties sur plusieurs classes,
 * on fait le produit cartésien (peut sélectionner quelques tests de plus, jamais de moins).
 */
export function buildTreeNodeFilter(target: RunTarget): string | undefined {
  switch (target.kind) {
    case 'all': case 'js': return undefined;
    case 'class': {
      const { ns, cls } = treeNodeSegments(target.className);
      return `/*/${ns || '*'}/${cls}/*`;
    }
    case 'methods': {
      const parts = target.fqns.map(f => {
        const i = f.lastIndexOf('.');
        return { ...treeNodeSegments(f.substring(0, i)), m: f.substring(i + 1) };
      });
      return `/*/${alt(parts.map(p => p.ns))}/${alt(parts.map(p => p.cls))}/${alt(parts.map(p => p.m))}`;
    }
  }
}

/** Arguments de filtre selon le runner et le framework. */
export function filterArgs(runner: string, framework: string, target: RunTarget): string[] {
  if (target.kind === 'all' || target.kind === 'js') { return []; }
  if (runner === 'mtp' && framework === 'tunit') { return ['--treenode-filter', buildTreeNodeFilter(target)!]; }
  if (runner === 'mtp' && framework === 'xunit3') {
    return target.kind === 'class'
      ? ['--filter-class', target.className]
      : [...new Set(target.fqns)].flatMap(f => ['--filter-method', f]);
  }
  if (runner === 'xunit3') {
    return target.kind === 'class'
      ? ['-class', target.className]
      : [...new Set(target.fqns)].flatMap(f => ['-method', f]);
  }
  return ['--filter', buildFilter(target)!];
}
