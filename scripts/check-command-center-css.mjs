import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cssPath = path.join(root, 'src', 'index.css');
const css = readFileSync(cssPath, 'utf8');
const relevantPrefix = /^\.lumi-(?:2d|command-center|office|private-office|wisp)/;
const counts = new Map();

for (const match of css.matchAll(/(?:^|\})\s*([^@{}][^{}]*)\{/g)) {
  for (const rawSelector of match[1].split(',')) {
    const selector = rawSelector.trim().replace(/\s+/g, ' ');
    if (!relevantPrefix.test(selector)) continue;
    counts.set(selector, (counts.get(selector) || 0) + 1);
  }
}

const duplicateSelectors = [...counts].filter(([, count]) => count > 1);
const duplicateDeclarations = duplicateSelectors.reduce((total, [, count]) => total + count - 1, 0);
const limits = {
  selectors: Number(process.env.LUMI_COMMAND_CENTER_DUPLICATE_SELECTORS || 117),
  declarations: Number(process.env.LUMI_COMMAND_CENTER_DUPLICATE_DECLARATIONS || 183),
};

console.log(
  `[command-center-css] ${duplicateSelectors.length} duplicate selectors, `
  + `${duplicateDeclarations} duplicate declarations `
  + `(limits ${limits.selectors}/${limits.declarations})`,
);

if (duplicateSelectors.length > limits.selectors || duplicateDeclarations > limits.declarations) {
  console.error('[command-center-css] blocked: command-center style overrides grew beyond the audited baseline.');
  console.error(
    duplicateSelectors
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([selector, count]) => `  ${count}x ${selector}`)
      .join('\n'),
  );
  process.exit(1);
}
