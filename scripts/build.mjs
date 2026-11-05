// Teslaplay build script (esbuild).
//   node scripts/build.mjs           → production build into dist/
//   node scripts/build.mjs --serve   → dev server with live reload on http://localhost:5173
//   node scripts/build.mjs --single  → one self-contained demo HTML file in dist-demo/
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const mode = args.has('--serve') ? 'serve' : args.has('--single') ? 'single' : 'build';

// Tesla's browser is Chromium; older firmware ships older engines, so we down-level syntax.
const target = ['chrome79', 'es2019'];

// Build id: lets a running page notice a newer deploy (GitHub Pages caches index.html ~10 min).
const BUILD = mode === 'build' ? Date.now().toString(36) : 'dev';

const common = {
  bundle: true,
  target,
  logLevel: 'info',
  legalComments: 'none',
  define: { __DEV__: mode === 'serve' ? 'true' : 'false', __BUILD__: JSON.stringify(BUILD) },
};

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const template = () => readFileSync(join(root, 'index.html'), 'utf8');

async function build() {
  const out = join(root, 'dist');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  cpSync(join(root, 'public'), out, { recursive: true });

  const js = await esbuild.build({
    ...common, entryPoints: [join(root, 'src/main.ts')], minify: true, sourcemap: false,
    format: 'iife', write: false, outfile: 'app.js',
  });
  const css = await esbuild.build({
    ...common, entryPoints: [join(root, 'styles/index.css')], minify: true, write: false, outfile: 'app.css',
  });
  const jsText = js.outputFiles[0].text;
  const cssText = css.outputFiles[0].text;
  const jsName = `assets/app.${hash(jsText)}.js`;
  const cssName = `assets/app.${hash(cssText)}.css`;
  writeFileSync(join(out, jsName), jsText);
  writeFileSync(join(out, cssName), cssText);
  writeFileSync(join(out, 'index.html'), template()
    .replace('assets/app.css', cssName)
    .replace('assets/app.js', jsName)
    .replace('src="config.js"', `src="config.js?v=${BUILD}"`)
    .replace('<!-- dev-reload -->', ''));
  writeFileSync(join(out, 'version.json'), JSON.stringify({ build: BUILD }));
  console.log(`\n  dist/ ready  (${(jsText.length / 1024).toFixed(0)} KB js, ${(cssText.length / 1024).toFixed(0)} KB css)\n`);
}

async function single() {
  const out = join(root, 'dist-demo');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const js = await esbuild.build({ ...common, entryPoints: [join(root, 'src/main.ts')], minify: true, format: 'iife', write: false, outfile: 'app.js' });
  const css = await esbuild.build({ ...common, entryPoints: [join(root, 'styles/index.css')], minify: true, write: false, outfile: 'app.css' });
  const backdrop = readFileSync(join(root, 'public/demo/backdrop-dark.jpg')).toString('base64');
  const cfg = `window.TESLAPLAY_CONFIG = { demo: true, demoBackdropUrl: "data:image/jpeg;base64,${backdrop}" };`;
  const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
  const html = template()
    .replace(/<link rel="manifest"[^>]*>\s*/, '')
    .replace(/<link rel="icon"[^>]*>\s*/, '')
    .replace('<script src="config.js"></script>', () => `<script>${cfg}</script>`)
    .replace('<link rel="stylesheet" href="assets/app.css">', () => `<style>${css.outputFiles[0].text}</style>`)
    .replace('<script src="assets/app.js" defer></script>', () => `<script>${safe(js.outputFiles[0].text)}</script>`)
    .replace('<!-- dev-reload -->', '');
  writeFileSync(join(out, 'teslaplay-demo.html'), html);
  console.log('\n  dist-demo/teslaplay-demo.html ready\n');
}

async function serve() {
  const out = join(root, '.dev');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  cpSync(join(root, 'public'), out, { recursive: true });
  writeFileSync(join(out, 'index.html'), template().replace('<!-- dev-reload -->',
    `<script>new EventSource('/esbuild').addEventListener('change', () => location.reload())</script>`));
  const ctx = await esbuild.context({
    ...common, entryPoints: { app: join(root, 'src/main.ts'), 'app-css': join(root, 'styles/index.css') },
    outdir: join(out, 'assets'), sourcemap: true, format: 'iife',
    entryNames: '[name]',
    plugins: [{
      name: 'css-rename', setup(b) {
        b.onEnd(() => {
          const p = join(out, 'assets/app-css.css');
          if (existsSync(p)) cpSync(p, join(out, 'assets/app.css'));
        });
      },
    }],
  });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, port: 5173, host: '0.0.0.0' });
  console.log(`\n  Teslaplay dev server → http://localhost:${port}   (add ?demo=1 to run without an API key)\n`);
}

await ({ build, single, serve })[mode]();
