// Module --filter de Jest : retire les fichiers de test exclus par readableTests.js.exclude.
// S'ajoute aux exclusions du projet (testPathIgnorePatterns n'est pas remplacé).
const path = require('path');
const patterns = JSON.parse(process.env.READABLE_TESTS_EXCLUDE || '[]').map(s => new RegExp(s));
// Jest ≤ 29 attend [{ test: chemin }], Jest ≥ 30 une liste de chemins.
const legacy = Number(process.env.READABLE_TESTS_JEST_MAJOR || 30) < 30;

module.exports = async testPaths => {
  const kept = testPaths.filter(p => {
    const rel = path.relative(process.cwd(), p).split(path.sep).join('/');
    return !patterns.some(r => r.test(rel));
  });
  return { filtered: legacy ? kept.map(test => ({ test })) : kept };
};
