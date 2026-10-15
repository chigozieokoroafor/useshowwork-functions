import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const nextServerShimPlugin = {
  name: 'next-server-shim',
  setup(build) {
    build.onResolve({ filter: /^next\/server$/ }, args => ({
      path: args.path,
      namespace: 'next-server-shim',
    }));
    build.onLoad({ filter: /.*/, namespace: 'next-server-shim' }, () => ({
      contents: `
        export class NextResponse {
          static json(data, init) {
            return { data, status: init?.status || 200 };
          }
        }
        export class NextRequest {}
        export function after(fn) { if (typeof fn === 'function') fn(); }
      `,
      loader: 'js',
    }));
  },
};

const result = await build({
  entryPoints: ['workers/bullmq/run.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist-worker-native/run-bullmq.cjs',
  plugins: [nextServerShimPlugin],
  metafile: true,
  write: false,
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
});

await mkdir('dist-worker-native', { recursive: true });
for (const output of result.outputFiles) {
  await writeFile(output.path, output.contents);
}

console.log('BULLMQ_WORKER_BUILD_OK: Generated dist-worker-native/run-bullmq.cjs');
