import { build } from 'esbuild';
import ts from 'typescript';
import { readFile, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const approvedSources = new Set(['workers/publishing/main.ts','workers/publishing/status.ts','workers/publishing/composition.ts','lib/publishing/deploymentReadiness.ts','lib/complimentaryAccess.ts','lib/contentWorkspaceEntitlements.ts','lib/publishing/state.ts','lib/publishing/eligibilityPolicy.ts','lib/publishing/canonicalWorkerStore.ts','lib/publishing/ownership.ts','lib/publishing/externalAuthorization.ts','lib/tiktokSettings.ts','lib/publishing/providerJournal.ts','lib/publishing/capabilityProviders.ts','lib/publishing/canonicalWorker.ts','lib/calendarTeamPolicy.ts','lib/tiktokConsent.ts','lib/publishing/intentActions.ts','lib/publishing/canonicalContract.ts','lib/publishing/canonicalStore.ts','lib/publishing/validationAdapters.ts']);
const approvedBuiltins=new Set(['node:crypto','node:perf_hooks']);

// Stage 1 deliberately approves no runtime packages, including native packages.
// packages:external below prevents native bundling when future composition is
// separately approved. Externalization must never bypass this resolve guard.
export function isolationPlugin(root) {
  return {
    name: 'showwork-worker-isolation',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if(approvedBuiltins.has(args.path))return {path:args.path,external:true};
        let target;
        if (args.kind === 'entry-point') target = path.resolve(root, args.path);
        else if (args.path.startsWith('@/')) target = path.resolve(root, args.path.slice(2));
        else if (args.path.startsWith('.')) target = path.resolve(args.resolveDir, args.path);
        else throw new Error('WORKER_GRAPH_DENIED: runtime packages, builtins and absolute imports are not approved');
        if (!path.extname(target)) target += '.ts';
        const actual = await realpath(target);
        const relative = path.relative(root, actual).split(path.sep).join('/');
        if (!approvedSources.has(relative)) throw new Error('WORKER_GRAPH_DENIED: source is outside the Stage 1 allowlist');
        return { path: actual };
      });
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        const contents = await readFile(args.path, 'utf8');
        const source = ts.createSourceFile(args.path, contents, ts.ScriptTarget.Latest, true);
        function inspect(node) {
          // Dynamic resolution cannot be proved by the bundler graph. Fail closed.
          if (ts.isCallExpression(node) && (
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ts.isIdentifier(node.expression) && ['require', 'eval', 'Function'].includes(node.expression.text)
          ) || ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
            throw new Error('WORKER_GRAPH_DENIED: dynamic loading/evaluation is not approved');
          }
          ts.forEachChild(node, inspect);
        }
        inspect(source);
        return { contents, loader: 'ts' };
      });
    },
  };
}

export async function buildWorker(root = repository) {
  root = await realpath(root);
  const output = path.join(root, 'dist-worker');
  // A rejected rebuild must not leave a previously valid artifact runnable.
  await rm(output, { recursive: true, force: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['workers/publishing/main.ts'],
    outfile: 'dist-worker/main.cjs',
    tsconfig: path.join(root, 'tsconfig.worker.json'),
    bundle: true,
    platform: 'node', target: 'node22', format: 'cjs',
    packages: 'external',
    write: false, metafile: true, sourcemap: false,
    logLevel: 'silent',
    plugins: [isolationPlugin(root)],
  });
  if (result.warnings.length || Object.values(result.metafile.outputs).some(value => value.imports.some(i=>!approvedBuiltins.has(i.path)))) {
    throw new Error('WORKER_GRAPH_DENIED: unresolved imports or build warnings');
  }
  await mkdir(output, { recursive: true });
  for (const file of result.outputFiles) await writeFile(file.path, file.contents);
  await writeFile(path.join(output, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildWorker();
    console.log('WORKER_BUILD_OK: Stage 1 preparation artifact only');
  } catch (error) {
    // Avoid echoing source snippets or values in bundler diagnostics.
    const denied = error.message?.includes('WORKER_GRAPH_DENIED');
    console.error(denied
      ? 'WORKER_GRAPH_DENIED: unapproved dependency or dynamic loading; build rejected'
      : 'WORKER_BUILD_FAILED: compilation or filesystem failure; do not use an earlier artifact');
    process.exitCode = 1;
  }
}
