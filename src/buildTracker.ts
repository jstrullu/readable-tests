import * as fs from 'fs';
import * as path from 'path';
import { t } from './i18n';

const IGNORED = /[\\/](bin|obj|\.git|\.vs|\.vscode|\.idea|node_modules|TestResults|artifacts)([\\/]|$)/i;
const RESTORE_SENSITIVE = /\.(csproj|fsproj|vbproj|props|targets|sln|slnx)$|[\\/](global\.json|nuget\.config|packages\.lock\.json)$/i;

/**
 * Sait si un build est nécessaire : toute modification de fichier source (hors bin/obj…) depuis
 * le dernier build réussi invalide tout. Grossier mais sûr : on ne saute le build que si
 * strictement rien n'a bougé.
 */
export class BuildTracker {
  private built = new Set<string>();
  private restored = false;
  private generation = 0;
  /** Premier fichier modifié depuis le dernier build réussi : explique pourquoi on recompile. */
  private firstChange?: string;
  private changeCount = 0;

  /** Retourne true si le changement touche la structure des projets (restore + caches à invalider). */
  touch(file: string): boolean {
    if (IGNORED.test(file)) { return false; }
    this.generation++;
    this.built.clear();
    if (!this.firstChange) { this.firstChange = file; }
    this.changeCount++;
    if (RESTORE_SENSITIVE.test(file)) { this.restored = false; return true; }
    return false;
  }

  get snapshot(): number { return this.generation; }
  get needsRestore(): boolean { return !this.restored; }
  isBuilt(project: string): boolean { return this.built.has(project); }

  /** "1re exécution de la session" ou "Foo.cs modifié (+3 autres)". */
  buildReason(relative: (f: string) => string = f => f): string {
    if (!this.firstChange) { return t('first run of the session'); }
    const others = this.changeCount - 1;
    return others > 0
      ? t('{0} changed (+{1} more)', relative(this.firstChange), others)
      : t('{0} changed', relative(this.firstChange));
  }

  /** Enregistre un build réussi, sauf si des fichiers ont changé pendant le build. */
  markBuilt(projects: string[], generationAtStart: number, withRestore: boolean): void {
    if (this.generation !== generationAtStart) { return; }
    projects.forEach(p => this.built.add(p));
    if (withRestore) { this.restored = true; }
    this.firstChange = undefined;
    this.changeCount = 0;
  }
}

/** Projets référencés par un .sln ou .slnx (chemins absolus). */
export function solutionProjects(sln: string): string[] {
  const text = fs.readFileSync(sln, 'utf8');
  const dir = path.dirname(sln);
  const rels = sln.toLowerCase().endsWith('.slnx')
    ? [...text.matchAll(/<Project\s+[^>]*Path="([^"]+\.(?:cs|fs|vb)proj)"/gi)].map(m => m[1])
    : [...text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|fs|vb)proj)"/gmi)].map(m => m[1]);
  return rels.map(r => path.resolve(dir, r.replace(/\\/g, path.sep).replace(/\//g, path.sep)));
}

/** Plus petite solution contenant tous les projets demandés. */
export function pickSolution(solutions: string[], projects: string[]): string | undefined {
  const norm = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
  const wanted = projects.map(norm);
  let best: { sln: string; size: number } | undefined;
  for (const sln of solutions) {
    let content: string[];
    try { content = solutionProjects(sln).map(norm); } catch { continue; }
    const set = new Set(content);
    if (wanted.every(w => set.has(w)) && (!best || content.length < best.size)) { best = { sln, size: content.length }; }
  }
  return best?.sln;
}

/** Exécute des tâches avec une concurrence bornée. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { await fn(items[i++]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Configuration + arguments de build ; un "-c X" laissé dans les arguments est repris comme configuration. */
export function buildSettings(cfg: { get<T>(key: string, def?: T): T | undefined }): { configuration: string; buildArgs: string[] } {
  const raw = [...(cfg.get<string[]>('buildArgs', []) ?? []), ...(cfg.get<string[]>('mtp.buildArgs', []) ?? [])];
  let configuration = cfg.get<string>('configuration', 'Debug') || 'Debug';
  const buildArgs: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '-c' || raw[i] === '--configuration') { configuration = raw[++i] ?? configuration; continue; }
    const m = /^(?:-c|--configuration)[:=](.+)$/.exec(raw[i]);
    if (m) { configuration = m[1]; continue; }
    buildArgs.push(raw[i]);
  }
  return { configuration, buildArgs };
}

