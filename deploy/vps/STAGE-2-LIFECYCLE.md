# Stage 2: isolated configuration and resource lifecycle

These modules are not imported by the worker executable. The Stage 1 source
allowlist is unchanged. Check mode remains connection-free, and all execution
modes other than `--check` remain blocked with exit 78. A later request to wire
these modules must explicitly approve the source and builtin dependencies.

`config.ts` exports strict JSON/config validation and an explicit credential-file
loader. There is no dotenv or automatic environment loading. A future trusted
caller can pass systemd's CREDENTIALS_DIRECTORY; the filename is always
publishing.json. The directory must be canonical, private and owned by root or
the current user, under trusted ancestors. The loader rejects symlinks,
non-regular/hardlinked files, unsafe ownership/permissions and files over 16 KiB.
It accepts modes 0400/0600. Errors contain fixed codes, no source values/paths.

Only version 1 preparation/synthetic-staging configuration with publishingEnabled
false is accepted. Tick interval: 1000–60000 ms; shutdownTimeoutMs: 100–30000;
databaseBackendLimit: 1–2; heavyTransactionLimit: 1–backend limit; mediaConcurrency:
exactly 1. All keys are mandatory; unknown keys fail. These values do not create
clients or enforce a real pool allocation. Existing deploy/vps/worker.config.json
belongs to the older preparation checker and is deliberately not repurposed.

Credential JSON requires exactly version:1 and databaseUrl. Only PostgreSQL URLs
for localhost/127.0.0.1/::1 with a showwork_test_ database name are accepted; URL
options/fragments and nonlocal destinations are rejected. No connection is made.
The wrapper redacts JSON/inspect output; explicit access returns the synthetic
URL. JS strings cannot be guaranteed erased from memory. This is not yet a
production credential schema or a guarantee that any localhost database is safe.
Tests create only random synthetic credentials in private temporary directories.

`lifecycle.ts` accepts mock/future resources, not client factories. Register each
handle immediately after acquisition and before the next await; partially failed
constructors must clean their own allocations. Startup errors trigger cleanup.
SIGTERM/SIGINT handlers are attached only when explicitly requested, removed on
shutdown, and never call process.exit. Shutdown aborts admission, waits boundedly
for initialization, calls stop hooks, then closes consumers, media and databases.
Within each category, resources close in reverse acquisition order. Duplicate
shutdown calls share one promise. Only fixed event codes reach the observer.

Each wait/hook is individually bounded by cleanupTimeoutMs; this is NOT a global
shutdown deadline. Timeout/failure returns clean:false and cleanup continues.
Timeout does not cancel an arbitrary injected promise. Late-acquired handles are
still disposed. Future real adapters must cooperate with abort and verify child
exit; systemd/global deadlines and durable publication recovery are later stages.
STOPPED means cleanup has been attempted, not proof every timed-out resource has
ceased. An unclean result must never authorize publishing takeover.

Offline checks:

```sh
npm run worker:build
npm run worker:check-built
npm run test:worker-lifecycle
npm run test:worker-build
npm run test:vps-preparation
```

The test loader compiles only the two isolated TS modules in memory. It is not a
runtime composition or an alternative production build. No database, HTTP API,
worker loop, media subprocess or actual process signal is used; signal delivery
uses an injected EventEmitter. Linux/systemd credential mount behavior remains
unverified until separately authorized synthetic hosting tests.
