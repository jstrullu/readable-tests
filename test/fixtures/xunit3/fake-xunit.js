// Simule la ligne de commande native xUnit v3 : MODE=old ne connaît que -trx, MODE=new que -result-trx.
const fs = require('fs');
const args = process.argv.slice(2);
const sw = process.env.FAKE_XUNIT_MODE === 'old' ? '-trx' : '-result-trx';
for (const a of args) {
  if (a.startsWith('-') && !['-noLogo', '-noColor', '-class', '-method', sw].includes(a)) {
    console.log(`error: unknown option: ${a}`); process.exit(3);
  }
}
fs.writeFileSync(process.env.FAKE_XUNIT_ARGS, JSON.stringify(args));
fs.writeFileSync(args[args.indexOf(sw) + 1], fs.readFileSync(__dirname + '/results.trx'));
process.exit(1);
