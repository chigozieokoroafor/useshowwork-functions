# Stage 1: standalone artifact, publishing disabled

This build contains only `workers/publishing/main.ts` and `status.ts`. It does
not compose the reliable runtime, open connections, read configuration/secrets,
or schedule work. Stage 2 and production activation remain unimplemented.
The existing `scripts/vps/worker.cjs` and systemd template are unchanged.

## Local verification

Use Node.js 22 and the repository lockfile:

```sh
npm run worker:build
npm run worker:check-built
npm run test:worker-build
npm run test:vps-preparation
```

`--check` prints fixed preparation status. Any other arguments (including no
arguments) exit 78 without starting a worker. Other Node major versions fail
the built artifact check. The build is a Node 22 CommonJS bundle; aliases are
resolved explicitly. `dist-worker/` is generated and ignored by Git.

## Linux verification, only after separate transfer/install approval

In a disposable Ubuntu 24.04 x64 checkout with Node 22 and no production
environment files, install the pinned lockfile with `npm ci --ignore-scripts`,
then run the four commands above. This needs registry/cache access but no
database or platform credentials. Do not run migrations, the Next build,
`next start`, or a publishing service. Do not copy macOS node_modules to Linux.

Esbuild uses its platform-specific optional binary. Retain optional dependencies;
do not use `--omit=optional`. Installation scripts are deliberately skipped.
The Stage 1 artifact requires neither Prisma generation nor Sharp/media binary
installation. Linux native publisher integration belongs to later stages.

## Isolation policy

The bundler has an exact source-file allowlist. All runtime packages/builtins,
other repository modules, symlink escapes and dynamic import/require/evaluation
calls are rejected. Build warnings or residual external imports also fail.
Errors avoid source snippets. The bundler removes stale output before rebuilding.
The package build first typechecks; a typecheck failure prevents rebuilding, so
never deploy a prior artifact after any failed command.

All packages are configured external rather than bundled; Stage 1 additionally
rejects their imports entirely. A future reviewed graph can allow native modules
such as Prisma and Sharp without embedding native binaries. Do not relax this
policy merely to get a future composition to compile. This is an accidental
dependency guard, not a sandbox against malicious source changes.

The esbuild version is pinned exactly. No timestamp is embedded in the artifact.
Tests compare repeated builds and verify rejected graphs, alias resolution,
disabled execution and secret-free check behavior. This does not prove future
native runtime compatibility or Linux execution until the Linux checks run.
