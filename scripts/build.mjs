// Bundles src/ into dist/relay.mjs. Dependencies stay in node_modules (packages: external).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/relay.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: 'linked',
  logLevel: 'info',
});
