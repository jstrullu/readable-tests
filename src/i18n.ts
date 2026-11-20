// Localisation. Les modules purs (testables sans VS Code) appellent t() ;
// à l'activation, l'extension branche vscode.l10n.t qui applique le bundle de la langue de VS Code.
// Les messages source sont en anglais ; traductions dans l10n/bundle.l10n.<lang>.json.

type Translator = (message: string, args: (string | number)[]) => string;

export function format(message: string, args: (string | number)[]): string {
  return message.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
}

let translator: Translator = format;

export function setTranslator(fn: Translator): void { translator = fn; }

/** Message localisé. Les paramètres s'écrivent {0}, {1}… */
export function t(message: string, ...args: (string | number)[]): string {
  return translator(message, args);
}
