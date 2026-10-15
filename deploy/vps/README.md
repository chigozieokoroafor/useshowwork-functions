# Showwork VPS publishing preparation — NO-GO

Stage 1 standalone build instructions: [STAGE-1-BUILD.md](STAGE-1-BUILD.md).
The new artifact supports an offline check only; no publishing runtime is wired.
Stage 2 isolated configuration/resource modules: [STAGE-2-LIFECYCLE.md](STAGE-2-LIFECYCLE.md).
They remain outside the executable allowlist pending separate integration approval.

This is part of the existing Showwork repository, not a second application. Target: Ubuntu 24.04 at the supplied InterServer address, service user `showwork`, application `/home/showwork/app`. Website/dashboard stay on Netlify. No SSH connection, installation, production credentials, migration, service start, Netlify configuration change or push has occurred.

## What the preparation package does

`npm run worker:check` verifies a fixed, non-secret configuration without importing Prisma, provider SDKs or environment loaders. The executable rejects every start/run mode with exit 78. The service template also requires a separately approved activation file. These are deliberate safety blocks, not a deployable production publisher. `supervisor.cjs` is a tested dependency-injected lifetime adapter: non-overlapping ticks, sanitized errors, restart-safe runtime cleanup. It is not wired to a live store. No mock is substituted for a production provider without explicitly labeling it.

The health command accepts only a fresh synthetic-staging heartbeat, has no network listener/database connection, and fails for absent/stale/future/production data. A future synthetic runner must write the heartbeat atomically; no current process is being reported healthy. The template health timer only records failure locally; it does not provide host-down notification.

## Verified architecture and remaining code work

The reusable candidate is `reliableAdmission` + `reliableStore` + `reliableWorker` + `reliableConsumer` + `platformIntegration` + `portableRuntime`. It includes exact database claims/leases, three heavy transaction slots, account-aware dispatch, committed-proof finalization, TikTok accepted-operation status reconciliation and durable retry/quarantine. The reviewed `coordinatorTransport` uses parameterized SQL and redacts its outer error, but logging its nested cause must be avoided.

Tests demonstrate local behavior, not real VPS or Supabase performance. Main 50/250 attempt-start results were 39–43 / 195–222 seconds under simulated latency; full 250 confirmations took 718–854 seconds. Slow coordination yielded 120.30 seconds for 50 posts, insufficient margin. The forced row-lock timeout test passed. Reboot, real Supabase RTT, media load and ten-minute consumer rotation on this VPS are unverified.

A code search confirms the candidate runtime, legacy recovery bridge and `createPublishingActionBoundary` are not imported by live app/Netlify handlers. The current publish action route still updates legacy post state. Before activation, integrate durable cancellation/rescheduling/retry guards with authenticated routes and test racing edits; wire a real restricted database/provider composition and all lifecycle signals; implement shared cohort ownership checked by both old and new publishers. Merely deploying the service would not complete these requirements. The durable queue schema in `scripts/publishing-reliability/schema.sql` is a staging proposal, not an applied production migration.

Instagram media/container behavior, TikTok consent/media/scopes/token refresh, other platform permissions and shared token-refresh locks remain native implementation responsibilities. TikTok acceptance must remain pending. Unknown external outcomes without proof must not be replayed on restart, rollback or a manual retry checkbox. Reposting confirmed content is a new authorized intent, not reuse of the uncertain job.

## Application/release layout

- `/home/showwork/app`: checkout of this same repository, pinned to an approved sanitized release commit; never pull a moving branch while the worker is running.
- `/etc/showwork/publishing.credentials.json`: root-owned mode 0600, outside Git. Provision only under separate authorization. systemd `LoadCredential` supplies it privately to the service; no secrets in unit files, command arguments or checkout `.env` files.
- `/etc/showwork/publishing.approved`: absent during preparation. It must never be treated as sufficient authorization by itself; the current executable still rejects production.
- `/run/showwork-publishing/`: transient private health/state files.
- `/var/lib/showwork-publishing/tmp/`: bounded temporary media, created by an approved installer; clean completed files and enforce disk limits.
- `journald`: structured IDs, counts, timing, safe error codes; bounded retention. Do not log content, credentials, request headers or raw provider/database errors.

Use a dedicated read-only GitHub deploy key for this existing repository after history cleanup and explicit access approval. Do not use a personal token embedded in the Git remote. Verify host keys out of band. Review installation scripts; first install with `npm ci --ignore-scripts`, then run only reviewed Prisma generation/build steps with no production environment. Do not run the root `npm run build` or `next start` as the worker entrypoint. No Netlify build/deployment configuration is changed here.

## Supabase connection budget

First determine whether five backends is a publishing allowance or the entire shared application limit. A single pool or loopback PgBouncer must cap the aggregate publishing connections across all consumers/releases; five per Prisma instance is not five globally. Preserve three heavy database operations, leave capacity for coordinator calls, and do not hold a transaction during external IO. Audit transaction-mode compatibility, role limits and all fallback/unbudgeted accesses. Real connection composition remains blocked pending this review.

Runtime role requires selected content/asset/entitlement/connection reads, token refresh writes and queue/post/reporting writes, but no schema DDL, role administration, Supabase service-role key or arbitrary access to billing/customer records. Review PUBLIC/inherited grants, RLS, functions and schemas. Verify TLS and the official CA, hostname, exact allowed database and pool endpoint. Never enable permissive certificate modes. Neither diagnostics nor a future worker should inherit website secrets wholesale.

## Systemd template review

The service runs as `showwork`, restarts on ordinary failures with rate limits, refuses restart on configuration exit 78, and kills the service process group after the shutdown deadline. It uses read-only filesystem protection, private temporary devices, no privileges/capabilities and private state directories. A provisional 2-GB memory limit must be measured against actual server RAM/media load. Node must exist at `/usr/bin/node`; a private nvm path must not be assumed. Network sandboxing/egress and CPU allocation are not proven by these unit settings. Ubuntu `systemd-analyze verify` and real reboot/SIGTERM/SIGKILL behavior must be validated on the VPS after access approval; this macOS workspace cannot validate the Linux unit parser.

## Cutover and rollback

Do not disable existing cron jobs during preparation. Review the exact deployed function inventory later: local source changes do not prove deployed state. For gradual migration, both legacy and candidate paths must consult one account/cohort owner and fence token. Stop old admission for an approved cohort; drain or classify started work; fence delayed old background requests; hand over only verified unsent jobs. Accepted TikTok IDs get status-only recovery. Unknown work stays quarantined. If no proven common fence exists, choose stop-and-drain instead of concurrent ownership.

Rollback stops new sends first, preserves queue/proof/token updates, fences old epochs and reconciles in-flight work. Restore a pinned recovery-compatible release. Do not just reset statuses and restart legacy crons. No drop-table/down migration on rollback. Versioned artifacts and the current queue schema must remain backward compatible; test this with synthetic data before any production approval.

## Exact next VPS step (not executed)

First finish approved local history sanitization and verify both secret scans. Before any GitHub push, separately inspect/approve Netlify branch/preview deployment triggers; branch name or `[skip ci]` alone is not a guarantee against deployment. No merge to `main`.

Then request authorization for **read-only SSH inventory only** as `showwork` at the supplied InterServer address. Verify the SSH host fingerprint through InterServer's console before accepting it. With approval, execute the supplied inventory script over the authenticated SSH session; do not clone the contaminated branch, upload credentials, use sudo to change services or start a worker. Obtain CPU/RAM/disk/architecture, installed runtimes, existing service state and the provider region. No password or private key should be sent in chat.

Subsequent steps require separate approval: configure synthetic VPS testing, provision any restricted credentials, push the sanitized branch, install/enable a service, modify Supabase or change Netlify publishing ownership. No extra paid service is required; existing VPS/Supabase/storage capacity and transfer allowances remain to be verified.
