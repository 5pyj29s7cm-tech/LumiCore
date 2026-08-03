import fs from 'node:fs';
import path from 'node:path';

const assetsDirectory = path.resolve('dist', 'desktop', 'assets');
const cssFiles = fs.existsSync(assetsDirectory)
  ? fs.readdirSync(assetsDirectory)
    .filter(name => /^desktop-.*\.css$/i.test(name))
    .map(name => path.join(assetsDirectory, name))
  : [];

if (cssFiles.length !== 1) {
  throw new Error(`Expected one compiled desktop CSS asset, found ${cssFiles.length} under ${assetsDirectory}`);
}

const css = fs.readFileSync(cssFiles[0], 'utf8');
const compactDockMatch = css.match(/\[data-compact-layout=true\]\s+\.lumi-dock\{([^}]*)\}/);
if (!compactDockMatch) throw new Error('Compiled compact Dock rule is missing');

const compactDock = compactDockMatch[1];
if (!compactDock.includes('justify-content:safe center')) {
  throw new Error(`Compiled compact Dock lost safe overflow centering: ${compactDock}`);
}
for (const forbidden of ['translate:', 'transform:', 'left:', 'right:']) {
  if (compactDock.includes(forbidden)) {
    throw new Error(`Compiled compact Dock must not override ${forbidden.slice(0, -1)}: ${compactDock}`);
  }
}

for (const requiredPattern of [
  /\.left-2\{left:/,
  /\.right-2\{right:/,
  /grid-template-columns:260px minmax\(0,1fr\) 280px/,
  /grid-template-rows:minmax\(360px,calc\(100dvh - 110px\)\) auto/,
]) {
  if (!requiredPattern.test(css)) throw new Error(`Compiled compact layout is missing ${requiredPattern}`);
}

for (const forbiddenPattern of [
  /min-height:calc\(200vh - 116px\)/,
  /margin-top:calc\(100vh - 250px\)/,
]) {
  if (forbiddenPattern.test(css)) throw new Error(`Compiled compact layout retained ${forbiddenPattern}`);
}

console.log(`[compact-layout] verified production CSS: ${path.relative(process.cwd(), cssFiles[0])}`);
