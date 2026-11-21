import { t } from './i18n';
import type { TestResult } from './model';
// Mise en forme lisible des échecs. Module pur (aucune dépendance vscode).

export interface AssertionBlock {
  /** Ce qui était attendu, tel qu'écrit par le framework ("to be equal to 80") */
  expectation: string;
  /** Ce qui a été constaté ("found 100") */
  actual: string;
  /** Expression C# de l'assertion (TUnit : "Assert.That(total).IsEqualTo(80)") */
  expression?: string;
  /** Valeurs extraites pour l'affichage attendu / obtenu avec diff */
  expected?: string;
  found?: string;
  /** Membre en écart pour les comparaisons d'objets (TUnit "differs at member X") */
  member?: string;
}

export interface InnerException { type: string; message: string }

export interface Frame {
  raw: string;
  /** Méthode nettoyée : "CartTests.Discount(Decimal rate)" */
  method: string;
  /** Méthode complète nettoyée (namespace inclus) */
  fullMethod: string;
  file?: string;
  line?: number;
}

export interface StackSection { title?: string; frames: Frame[]; /** Cause JavaScript (Error.cause) plutôt qu'exception interne .NET */ cause?: boolean }

export interface ParsedFailure {
  /** Première ligne significative, pour les résumés */
  headline: string;
  /** Message principal sans les exceptions internes */
  main: string;
  assertions: AssertionBlock[];
  inner: InnerException[];
  sections: StackSection[];
}

const NL = /\r?\n/;

export function parseFailure(message = '', stack = ''): ParsedFailure {
  const { main, inner } = splitInner(message);
  const assertions = parseAssertions(main);
  return {
    headline: firstLine(main) || inner[0]?.message || '',
    main,
    assertions,
    inner,
    sections: parseStack(stack),
  };
}

/**
 * Échec d'un résultat : erreurs structurées des reporters JS si présentes
 * (attendu/obtenu déjà séparés, causes), sinon analyse du message texte (.NET).
 */
export function failureOf(r: Pick<TestResult, 'message' | 'stackTrace' | 'failures'>): ParsedFailure {
  if (!r.failures?.length) { return parseFailure(r.message, r.stackTrace); }
  const assertions: AssertionBlock[] = [];
  const mains: string[] = [];
  const inner: InnerException[] = [];
  const sections: StackSection[] = [];
  r.failures.forEach((f, i) => {
    const msg = f.message.replace(/^(?:Error|AssertionError|JestAssertionError): /, '').trim();
    const first = firstLine(msg);
    if (f.expected !== undefined && f.actual !== undefined) {
      // Jest : 1re ligne = "expect(received).toEqual(expected) // …" ; le diff texte qui suit est remplacé par le nôtre.
      const isExpr = /^expect\(/.test(first);
      assertions.push({ expectation: first, actual: '', expression: isExpr ? first : undefined, expected: f.expected, found: f.actual });
    } else {
      const parsed = parseAssertions(msg);
      if (parsed.length) { assertions.push(...parsed); } else { mains.push((f.name && f.name !== 'Error' && f.name !== 'AssertionError' ? `${f.name}: ` : '') + msg); }
    }
    for (let c = f.cause; c; c = c.cause) {
      inner.push({ type: c.name ?? 'Error', message: c.message });
      if (c.stack) { sections.push(...parseStack(c.stack).map(s => ({ ...s, title: s.title ?? c!.name ?? 'Error', cause: true }))); }
    }
    if (i === 0 && f.stack) { sections.unshift(...parseStack(f.stack)); }
  });
  const main = mains.join('\n\n');
  return { headline: firstLine(main) || assertions[0]?.expectation || inner[0]?.message || '', main, assertions, inner, sections };
}

/** Résumé sur une ligne d'un résultat (structuré ou texte). */
export function summarizeResult(r: Pick<TestResult, 'message' | 'stackTrace' | 'failures'>): string {
  if (!r.failures?.length) { return summarizeFailure(r.message); }
  return summarizeParsed(failureOf(r));
}

/** Résumé sur une ligne : "Attendu 80 · obtenu 100" ou première ligne du message. */
export function summarizeFailure(message?: string): string {
  if (!message) { return ''; }
  return summarizeParsed(parseFailure(message));
}

function summarizeParsed(p: ParsedFailure): string {
  const a = p.assertions[0];
  if (a?.expected !== undefined && a.found !== undefined) {
    const s = t('expected {0} · got {1}', oneLine(a.expected), oneLine(a.found));
    return a.member ? `${a.member}: ${s}` : s;
  }
  if (a) { return oneLine(`Expected ${a.expectation} but ${a.actual}`); }
  return oneLine(p.headline);
}

// ---------- Exceptions internes ----------

/** TUnit / .NET : " ---> System.InvalidOperationException: msg" */
function splitInner(message: string): { main: string; inner: InnerException[] } {
  const lines = message.split(NL);
  const mainLines: string[] = [];
  const inner: InnerException[] = [];
  for (const l of lines) {
    const m = /^\s*--->\s*([\w.`+<>,\[\]]+?)\s*:\s?(.*)$/.exec(l);
    if (m) { inner.push({ type: m[1], message: m[2] }); continue; }
    if (inner.length) { inner[inner.length - 1].message += '\n' + l; } else { mainLines.push(l); }
  }
  inner.forEach(i => { i.message = i.message.trim(); });
  return { main: mainLines.join('\n').trim(), inner };
}

// ---------- Assertions ----------

export function parseAssertions(main: string): AssertionBlock[] {
  return parseTUnit(main) ?? parseClassic(main) ?? [];
}

/**
 * Gabarit TUnit (TUnit.Assertions/Core/Assertion.cs) :
 *   Expected {expectation}
 *   but {result}
 *
 *   at {expression}
 * Assert.Multiple concatène plusieurs blocs séparés par une ligne vide.
 */
function parseTUnit(main: string): AssertionBlock[] | undefined {
  const text = main.replace(/\r\n/g, '\n');
  const blocks: AssertionBlock[] = [];
  const re = /(?:^|\n)Expected ([\s\S]*?)\nbut ([\s\S]*?)(?:\n[ \t]*\nat ([^\n]+))?(?=\n[ \t]*\nExpected |\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const block: AssertionBlock = { expectation: m[1].trim(), actual: m[2].trim(), expression: m[3]?.trim() };
    const exp = /^to (?:be equal to|be equivalent to|equal|be) ([\s\S]+)$/.exec(block.expectation);
    const member = /differs at member ([^:\s]+): expected ([\s\S]+?) but found ([\s\S]+)$/.exec(block.actual);
    const found = /^found ([\s\S]+)$/.exec(block.actual);
    if (member) {
      block.member = member[1]; block.expected = member[2].trim(); block.found = member[3].trim();
    } else if (exp && found) {
      block.expected = exp[1].trim(); block.found = found[1].trim();
    }
    blocks.push(block);
  }
  return blocks.length ? blocks : undefined;
}

/** xUnit, NUnit, MSTest, FluentAssertions-like. */
function parseClassic(main: string): AssertionBlock[] | undefined {
  const text = main.replace(/\r\n/g, '\n');
  const headline = firstLine(text);

  // xUnit : "Expected: X" / "Actual:   Y", lignes de marqueurs ↓ ↑ ignorées
  let m = /^\s*Expected:[ \t]*([\s\S]*?)\n\s*Actual:[ \t]*([\s\S]*)$/m.exec(text);
  if (m && !/^\s*Expected:/.test(headline)) {
    return [{ expectation: headline, actual: '', expected: stripMarkers(m[1]), found: stripMarkers(m[2]) }];
  }
  // Jest (sans valeurs structurées) : "Expected: X" / "Received: Y"
  m = /^\s*Expected[^:\n]*:[ \t]*([\s\S]*?)\n\s*Received[^:\n]*:[ \t]*([\s\S]*?)(?:\n\s*\n|$)/m.exec(text);
  if (m) { return [{ expectation: headline, actual: '', expected: stripMarkers(m[1]), found: stripMarkers(m[2]) }]; }
  // NUnit : "Expected: X" / "But was:  Y"
  m = /Expected:[ \t]*([\s\S]*?)\n\s*But was:[ \t]*([\s\S]*?)(?:\n\s*\n|$)/i.exec(text);
  if (m) { return [{ expectation: headline, actual: '', expected: stripMarkers(m[1]), found: stripMarkers(m[2]) }]; }
  // MSTest : "Expected:<X>. Actual:<Y>."
  m = /Expected:<([\s\S]*?)>\.?\s*Actual:<([\s\S]*?)>/.exec(text);
  if (m) { return [{ expectation: headline, actual: '', expected: m[1], found: m[2] }]; }
  // Fluent : "Expected x to be 5, but found 4."
  m = /^Expected (.+?) to be ([\s\S]+?), but found ([\s\S]+?)\.?$/.exec(text);
  if (m) { return [{ expectation: `${m[1]} to be ${m[2]}`, actual: `found ${m[3]}`, expected: m[2], found: m[3] }]; }
  return undefined;
}

function stripMarkers(s: string): string {
  return s.split('\n').filter(l => !/^\s*[↓↑]/.test(l)).join('\n').trim();
}

// ---------- Stack trace ----------

const FRAME = /^\s*(?:at|à|en|bei|в)\s+(.+?)(?:\s+(?:in|dans|en|in der Datei|в)\s+(.+?):(?:line|ligne|línea|Zeile|строка)\s+(\d+))?\s*$/;
/** JavaScript : "at fn (fichier:ligne:col)" ou "at fichier:ligne:col" (chemins absolus, file://, node:). */
const JS_FRAME = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\((.+?):(\d+):\d+\)|(?:async\s+)?((?:file:\/\/|\/|[A-Za-z]:[\\/]|node:)[^()]*?):(\d+):\d+)\s*$/;

function jsPath(p: string): string {
  if (!p.startsWith('file://')) { return p; }
  const decoded = decodeURIComponent(p.replace(/^file:\/\//, ''));
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.substring(1) : decoded; // file:///C:/x → C:/x
}

export function parseStack(stack: string): StackSection[] {
  const sections: StackSection[] = [{ frames: [] }];
  for (const l of stack.split(NL)) {
    if (!l.trim()) { continue; }
    const inner = /^\s*--- Inner exception stack trace \((.+)\) ---\s*$/.exec(l);
    if (inner) { sections.push({ title: inner[1], frames: [] }); continue; }
    if (/^\s*---.*---\s*$/.test(l)) { continue; } // "End of stack trace from previous location", etc.
    const js = JS_FRAME.exec(l);
    if (js) {
      const file = jsPath(js[2] ?? js[4]);
      const fullMethod = (js[1] ?? '<anonymous>').replace(/^Object\.<anonymous>$/, '<anonymous>');
      sections[sections.length - 1].frames.push({ raw: l.trim(), fullMethod, method: shortMethod(fullMethod), file, line: parseInt(js[3] ?? js[5], 10) });
      continue;
    }
    const m = FRAME.exec(l);
    if (!m) {
      // Lignes de message avant la première frame (stacks JS) : ignorées.
      if (sections[sections.length - 1].frames.length > 0) { sections[sections.length - 1].frames.push({ raw: l.trim(), method: l.trim(), fullMethod: l.trim() }); }
      continue;
    }
    const fullMethod = cleanMethod(m[1]);
    const frames = sections[sections.length - 1].frames;
    const prev = frames[frames.length - 1];
    // Méthode async : la frame "réelle" et sa machine à états pointent sur la même ligne.
    if (prev && prev.fullMethod === fullMethod && prev.file === m[2] && String(prev.line) === m[3]) { continue; }
    frames.push({
      raw: l.trim(),
      fullMethod,
      method: shortMethod(fullMethod),
      file: m[2],
      line: m[3] ? parseInt(m[3], 10) : undefined,
    });
  }
  return sections.filter(s => s.frames.length > 0);
}

/** Retire le bruit des machines à états async et des lambdas. */
export function cleanMethod(m: string): string {
  return m
    .replace(/\.<([^>]+)>d__\d+\.MoveNext\(\)/, '.$1()')
    .replace(/\.<([^>]+)>b__[\w]+(\(.*\))?$/, '.$1 (lambda)')
    .replace(/\+<>c(__DisplayClass[\w]+)?/, '')
    .replace(/`\d+/g, '');
}

/** "Shop.Tests.CartTests.Discount(Decimal rate)" → "CartTests.Discount(Decimal rate)" */
export function shortMethod(full: string): string {
  const paren = full.indexOf('(');
  const name = paren >= 0 ? full.substring(0, paren) : full;
  const args = paren >= 0 ? full.substring(paren) : '';
  const parts = name.split('.');
  return parts.slice(-2).join('.') + args;
}

// ---------- Diff ----------

export interface Segment { text: string; changed: boolean }

/**
 * Diff attendu/obtenu.
 * - une ligne : préfixe et suffixe communs, le milieu est marqué (lisible, sans bruit) ;
 * - plusieurs lignes : diff ligne à ligne (LCS), lignes différentes marquées.
 */
export function diff(expected: string, found: string): { expected: Segment[]; found: Segment[] } {
  if (!expected.includes('\n') && !found.includes('\n')) {
    // Valeurs courtes non textuelles (nombres, booléens, enums) : on marque la valeur entière,
    // un diff partiel "8"/"10" pour 80 vs 100 brouille plus qu'il n'aide.
    const textual = (v: string) => /["'\s]/.test(v) || v.length > 16;
    if (!textual(expected) && !textual(found)) {
      return { expected: [{ text: expected, changed: true }], found: [{ text: found, changed: true }] };
    }
    let p = 0;
    while (p < expected.length && p < found.length && expected[p] === found[p]) { p++; }
    let s = 0;
    while (s < expected.length - p && s < found.length - p && expected[expected.length - 1 - s] === found[found.length - 1 - s]) { s++; }
    const seg = (v: string): Segment[] => [
      { text: v.substring(0, p), changed: false },
      { text: v.substring(p, v.length - s), changed: true },
      { text: v.substring(v.length - s), changed: false },
    ].filter((x, i) => x.text.length > 0 || i === 1); // segment vide conservé = marqueur d'absence
    return { expected: seg(expected), found: seg(found) };
  }
  const a = expected.split('\n');
  const b = found.split('\n');
  if (a.length * b.length > 250_000) {
    return { expected: [{ text: expected, changed: true }], found: [{ text: found, changed: true }] };
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const keepA = new Set<number>(), keepB = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keepA.add(i++); keepB.add(j++); } else if (lcs[i + 1][j] >= lcs[i][j + 1]) { i++; } else { j++; }
  }
  const lines = (v: string[], keep: Set<number>): Segment[] =>
    v.map((t, i) => ({ text: t + (i < v.length - 1 ? '\n' : ''), changed: !keep.has(i) }));
  return { expected: lines(a, keepA), found: lines(b, keepB) };
}

function firstLine(s: string): string {
  return (s.split(NL).find(l => l.trim().length > 0) ?? '').trim();
}

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}
