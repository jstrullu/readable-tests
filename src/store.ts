import { fullyQualifiedName, resultKey, RunTarget, TestResult } from './model';
import { t } from './i18n';

const MAX_STDOUT = 20_000;

/** État des résultats, indépendant de vscode. */
export class ResultStore {
  private results = new Map<string, TestResult>();
  private previous = new Map<string, TestResult>();

  constructor(initial: TestResult[] = []) {
    for (const r of initial) { this.results.set(resultKey(r), r); }
  }

  all(): TestResult[] { return [...this.results.values()]; }

  failed(): TestResult[] { return this.all().filter(r => r.outcome === 'failed'); }

  forProject(project: string): TestResult[] { return this.all().filter(r => r.project === project); }

  /** Supprime les résultats des projets qui n'existent plus. */
  retainProjects(projects: string[]): void {
    const keep = new Set(projects);
    for (const [k, r] of this.results) { if (!keep.has(r.project)) { this.results.delete(k); } }
  }

  /** Passe en "running" les résultats concernés par la cible. */
  markRunning(project: string, target: RunTarget): void {
    for (const [k, r] of this.results) {
      if (r.project !== project || !inTarget(r, target)) { continue; }
      this.previous.set(k, r);
      this.results.set(k, { ...r, outcome: 'running' });
    }
  }

  /**
   * Intègre les résultats d'une exécution.
   * - cible "all" : remplace tout le projet (les tests supprimés disparaissent) ;
   * - sinon : mise à jour ciblée, les tests ciblés absents du résultat sont retirés (supprimés/renommés).
   */
  apply(project: string, target: RunTarget, fresh: TestResult[]): void {
    if (target.kind === 'all') {
      for (const [k, r] of this.results) { if (r.project === project) { this.results.delete(k); } }
    }
    const seen = new Set<string>();
    for (const r of fresh) {
      const k = resultKey(r);
      seen.add(k);
      this.results.set(k, r.stdout && r.stdout.length > MAX_STDOUT ? { ...r, stdout: r.stdout.slice(0, MAX_STDOUT) + '\n' + t('… (truncated)') } : r);
    }
    for (const [k, r] of this.results) {
      if (r.project === project && r.outcome === 'running' && !seen.has(k)) {
        // Cas d'une Theory dont les données ont changé : l'ancien cas n'existe plus.
        this.results.delete(k);
      }
    }
    this.clearPrevious(project);
  }

  /** Annulation / erreur : on restaure l'état précédent des tests marqués "running". */
  restore(project: string): void {
    for (const [k, r] of this.previous) {
      if (r.project === project) { this.results.set(k, r); }
    }
    this.clearPrevious(project);
  }

  private clearPrevious(project: string): void {
    for (const [k, r] of this.previous) { if (r.project === project) { this.previous.delete(k); } }
  }
}

export function inTarget(r: TestResult, target: RunTarget): boolean {
  switch (target.kind) {
    case 'all': return true;
    case 'class': return r.className === target.className;
    case 'methods': return target.fqns.includes(fullyQualifiedName(r));
  }
}
