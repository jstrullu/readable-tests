import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Frame, parseStack } from './errorFormat';
import { TestResult } from './model';

const cache = new Map<string, string | undefined>();

/**
 * Chemin local d'un fichier cité dans une stack trace, ou undefined s'il n'est pas dans le workspace.
 * Gère les builds déterministes (<Deterministic>/ContinuousIntegrationBuild) où les chemins sont "/_/src/...".
 */
export function resolveSource(file: string): string | undefined {
  if (cache.has(file)) { return cache.get(file); }
  let resolved: string | undefined;
  const inWs = (p: string) => !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p)) && fs.existsSync(p);
  if (inWs(file)) {
    resolved = file;
  } else if (/^[\\/]_\d*[\\/]/.test(file)) {
    const rel = file.replace(/^[\\/]_\d*[\\/]/, '');
    resolved = (vscode.workspace.workspaceFolders ?? []).map(f => path.join(f.uri.fsPath, rel)).find(p => fs.existsSync(p));
  }
  cache.set(file, resolved);
  return resolved;
}

export function clearSourceCache(): void { cache.clear(); }

/** Première frame du code utilisateur (fichier présent dans le workspace). */
export function firstUserFrame(result: TestResult): (Frame & { local: string }) | undefined {
  if (!result.stackTrace) { return undefined; }
  for (const section of parseStack(result.stackTrace)) {
    for (const f of section.frames) {
      const local = f.file ? resolveSource(f.file) : undefined;
      if (local) { return { ...f, local }; }
    }
  }
  return undefined;
}

export function readSnippet(file: string, line: number, around = 3): { start: number; lines: string[] } | undefined {
  try {
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const start = Math.max(1, line - around);
    return { start, lines: all.slice(start - 1, Math.min(all.length, line + around)) };
  } catch { return undefined; }
}

export async function openLocation(file: string, line?: number): Promise<void> {
  const local = resolveSource(file) ?? file;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(local));
  const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

/**
 * 1. échec → ligne de l'assertion (première frame utilisateur) ;
 * 2. symboles du serveur de langage C# ;
 * 3. recherche texte dans les .cs.
 */
export async function goToTest(className: string, methodName: string | undefined, result?: TestResult): Promise<boolean> {
  const frame = result && firstUserFrame(result);
  if (frame) { await openLocation(frame.local, frame.line); return true; }

  const shortClass = className.split('.').pop()!.split('+').pop()!.replace(/`\d+$/, '');
  const symbolName = methodName ?? shortClass;

  try {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', symbolName);
    const wanted = methodName ? [vscode.SymbolKind.Method, vscode.SymbolKind.Function] : [vscode.SymbolKind.Class];
    const hit = (symbols ?? []).find(s =>
      s.name.split('(')[0] === symbolName &&
      wanted.includes(s.kind) &&
      (!methodName || (s.containerName ?? '').includes(shortClass)));
    if (hit) {
      await vscode.window.showTextDocument(hit.location.uri, { selection: hit.location.range, preview: true });
      return true;
    }
  } catch { /* pas de fournisseur de symboles */ }

  const pattern = methodName
    ? new RegExp(`\\b${escapeRegex(methodName)}\\s*[(<]`)
    : new RegExp(`\\b(class|record|struct)\\s+${escapeRegex(shortClass)}\\b`);
  const candidates = [
    ...(await vscode.workspace.findFiles(`**/${shortClass}*.cs`, '**/{bin,obj}/**', 50)),
    ...(await vscode.workspace.findFiles('**/*.cs', '**/{bin,obj}/**', 5000)),
  ];
  const visited = new Set<string>();
  for (const uri of candidates) {
    if (visited.has(uri.fsPath)) { continue; }
    visited.add(uri.fsPath);
    const content = fs.readFileSync(uri.fsPath, 'utf8');
    if (methodName && !content.includes(shortClass)) { continue; }
    const idx = content.split(/\r?\n/).findIndex(l => pattern.test(l));
    if (idx >= 0) { await openLocation(uri.fsPath, idx + 1); return true; }
  }
  return false;
}

function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
