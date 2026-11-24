// Compiles the worker (and the two other Node entry points a release runs) with esbuild (PKG-2, 11 R3): one ESM
// file each, so a compiled release runs `node dist/worker/index.mjs` and needs neither tsx nor the TypeScript source.
//
//   src/worker/index.ts → dist/worker/index.mjs   the background worker (LaunchAgent com.commandcenter.worker)
//   src/db/migrate.ts   → dist/db/migrate.mjs     `npm run db:migrate` in a release; the installer runs the NEW one
//   src/ops/doctor.ts   → dist/ops/doctor.mjs     `npm run doctor` in a release
//
// Paths: every entry sits two folders below the release root, and code that finds files next to its own source
// (`import.meta.url`: the skills folder, the backup library) gets the URL its source file would have at
// <release>/src/…, so `../../../../skills` and `../../../scripts/ops/lib/backup.mjs` resolve exactly as in a checkout.
// Everything else the app reads at run time is relative to the working directory (the release root).
//
// External (not bundled; shipped whole in the release's node_modules by scripts/release/build.mjs): packages that
// resolve files or workers of their own at run time. The Claude Agent SDK runs the user's own `claude` CLI
// (src/ops/claude-bin.ts), so its 300 MB platform binary package is not shipped.
//
//   node esbuild.worker.mjs [--outdir <dir>]       (scripts/release/build.mjs calls bundleEntries)
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));

export const ENTRIES = [
  { in: 'src/worker/index.ts', out: 'dist/worker/index' },
  { in: 'src/db/migrate.ts', out: 'dist/db/migrate' },
  { in: 'src/ops/doctor.ts', out: 'dist/ops/doctor' },
];

/** Shipped as whole packages (with their dependencies) instead of bundled. */
export const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', 'pino', 'pg-native', 'next', 'react', 'react-dom'];

const BANNER = [
  "import { createRequire as __ccCreateRequire } from 'node:module';",
  "import { fileURLToPath as __ccFileURLToPath } from 'node:url';",
  "import { dirname as __ccDirname } from 'node:path';",
  'const require = __ccCreateRequire(import.meta.url);',
  'const __filename = __ccFileURLToPath(import.meta.url);',
  'const __dirname = __ccDirname(__filename);',
].join('\n');

/** `import.meta.url` in a source file → the URL that file would have inside the release (entries are 2 deep). */
export function sourceUrlPlugin(root = ROOT) {
  return {
    name: 'cc-source-url',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/].*\.(ts|tsx|mts|mjs|js)$/ }, async (args) => {
        const text = await readFile(args.path, 'utf8');
        if (!text.includes('import.meta.url')) return undefined;
        const rel = relative(root, args.path).split('\\').join('/');
        const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') || args.path.endsWith('.mts') ? 'ts' : 'js';
        return { contents: text.replaceAll('import.meta.url', `new URL(${JSON.stringify(`../../${rel}`)}, import.meta.url).href`), loader };
      });
    },
  };
}

/** Bundle the three entries into `outdir` (default: the repo, so dist/…). Returns esbuild's metafile outputs. */
export async function bundleEntries({ root = ROOT, outdir = root, minify = false } = {}) {
  const esbuild = await import('esbuild');
  const r = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ENTRIES.map((e) => ({ in: join(root, e.in), out: e.out })),
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    minify,
    legalComments: 'none',
    alias: { '@': resolve(root, 'src') },
    tsconfig: join(root, 'tsconfig.json'),
    external: EXTERNAL,
    banner: { js: BANNER },
    define: { 'process.env.CC_COMPILED': '"1"' },
    loader: { '.json': 'json', '.md': 'text', '.sql': 'text' },
    plugins: [sourceUrlPlugin(root)],
    metafile: true,
    logLevel: 'warning',
  });
  return Object.entries(r.metafile.outputs).map(([file, o]) => ({ file, bytes: o.bytes }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--outdir');
  const out = await bundleEntries({ outdir: i > 0 ? resolve(process.argv[i + 1]) : ROOT });
  for (const o of out) console.log(`${o.file}  ${(o.bytes / 1024).toFixed(0)} KB`);
}
