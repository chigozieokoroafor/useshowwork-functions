import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const nextServerShimPlugin = {
  name: "next-server-shim",
  setup(build) {
    build.onResolve({ filter: /^next\/server$/ }, (args) => ({
      path: args.path,
      namespace: "next-server-shim",
    }));
    build.onLoad({ filter: /.*/, namespace: "next-server-shim" }, () => ({
      contents: "export class NextResponse { static json(data, init) { return { data, status: init?.status || 200 }; } } export class NextRequest {} export function after(fn) { if (typeof fn === 'function') fn(); }",
      loader: "js",
    }));
  },
};

const esmBanner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirnameFunc } from 'node:path';",
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __dirnameFunc(__filename);",
].join("\n");

await mkdir("dist-worker-native", { recursive: true });

// 1. Build unified ESM .mjs bundle (primary all-in-one worker runner)
await build({
  entryPoints: ["workers/bullmq/run.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: esmBanner },
  packages: "external",
  outfile: "dist-worker-native/run-workers.mjs",
  plugins: [nextServerShimPlugin],
  metafile: true,
  write: true,
  tsconfig: "tsconfig.json",
  logLevel: "info",
});

// 2. Build CJS bundle for backward compatibility with existing Dockerfiles/scripts
await build({
  entryPoints: ["workers/bullmq/run.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  outfile: "dist-worker-native/run-bullmq.cjs",
  plugins: [nextServerShimPlugin],
  metafile: true,
  write: true,
  tsconfig: "tsconfig.json",
  logLevel: "info",
});

console.log("WORKERS_BUILD_OK: Generated dist-worker-native/run-workers.mjs and dist-worker-native/run-bullmq.cjs");
