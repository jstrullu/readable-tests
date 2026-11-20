import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { format, setTranslator, t } from '../src/i18n';

const root = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const placeholders = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(',');

/** Messages t('...') du code source (littéraux simples, comme exigé par la convention du projet). */
function sourceMessages(): Set<string> {
  const out = new Set<string>();
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    const src = read(path.join('src', f));
    for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) { out.add(m[1].replace(/\\(.)/g, '$1')); }
    assert.equal(/\bt\(\s*[`"]/.test(src), false, `${f} : t() doit recevoir un littéral entre apostrophes`);
  }
  return out;
}

test('Bundle FR : complet, sans orphelin, paramètres identiques', () => {
  const fr = JSON.parse(read('l10n/bundle.l10n.fr.json')) as Record<string, string>;
  const used = sourceMessages();
  assert.ok(used.size > 50);
  const missing = [...used].filter(m => !(m in fr));
  assert.deepEqual(missing, [], 'traductions manquantes');
  const orphans = Object.keys(fr).filter(k => !used.has(k));
  assert.deepEqual(orphans, [], 'traductions orphelines');
  for (const [en, f] of Object.entries(fr)) {
    assert.equal(placeholders(f), placeholders(en), `paramètres différents : "${en}"`);
    assert.ok(f.trim().length > 0, `traduction vide : "${en}"`);
  }
});

test('Manifeste : toutes les clés %…% traduites en EN et FR', () => {
  const keys = [...read('package.json').matchAll(/"%([^%"]+)%"/g)].map(m => m[1]);
  const en = JSON.parse(read('package.nls.json'));
  const fr = JSON.parse(read('package.nls.fr.json'));
  assert.ok(keys.length > 20);
  assert.deepEqual(keys.filter(k => !(k in en)), [], 'manquantes en EN');
  assert.deepEqual(keys.filter(k => !(k in fr)), [], 'manquantes en FR');
  assert.deepEqual(Object.keys(en).filter(k => !keys.includes(k)), [], 'clés EN inutilisées');
});

test('t() : format par défaut et traducteur branché', () => {
  assert.equal(format('{0} changed (+{1} more)', ['a.cs', 2]), 'a.cs changed (+2 more)');
  const fr = JSON.parse(read('l10n/bundle.l10n.fr.json'));
  setTranslator((m, a) => format(fr[m] ?? m, a));
  assert.equal(t('{0} changed (+{1} more)', 'a.cs', 2), 'a.cs modifié (+2 autre(s))');
  setTranslator(format);
});
