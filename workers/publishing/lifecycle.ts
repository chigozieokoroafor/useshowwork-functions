export type ResourceKind = "database" | "media" | "consumer";
export type OwnedResource = { stop?: () => void | Promise<void>; close: () => void | Promise<void> };
export type LifecycleEvent = "STARTED" | "START_FAILED" | "STOP_FAILED" | "CLOSE_FAILED" | "CLEANUP_TIMEOUT" | "STOPPED";
type Signals = {
  on(name: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  removeListener(name: "SIGTERM" | "SIGINT", listener: () => void): unknown;
};

/** No clients, child processes, listeners or timers are created on import. */
export function createResourceLifecycle(options: { cleanupTimeoutMs: number; emit?: (event: LifecycleEvent) => void }) {
  if (!Number.isInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1 || options.cleanupTimeoutMs > 30000) throw Error("LIFECYCLE_CONFIGURATION_INVALID");
  const abort = new AbortController();
  const resources: { kind: ResourceKind; resource: OwnedResource }[] = [];
  let started = false, stopping = false, failed = false, cleanupStarted = false;
  let startup: Promise<void> | undefined, shutdown: Promise<Readonly<{ clean: boolean }>> | undefined;
  let detach: (() => void) | undefined;
  const emit = (event: LifecycleEvent) => { try { options.emit?.(event); } catch { /* Observers cannot break cleanup. */ } };
  const scope = {
    signal: abort.signal,
    own(kind: ResourceKind, resource: OwnedResource) {
      // Register each handle immediately, before another await. Constructors
      // failing before registration must clean their own partial acquisition.
      if (!["database", "media", "consumer"].includes(kind) || !resource || typeof resource.close !== "function" || resources.some(entry => entry.resource === resource)) throw Error("RESOURCE_OWNERSHIP_INVALID");
      resources.push({ kind, resource });
      if (cleanupStarted) {
        // An initializer ignored abort and settled after the bounded wait.
        // Report unclean shutdown, but still dispose of the late handle.
        failed = true;
        void (async () => {
          if (resource.stop) await bounded(() => resource.stop!(), "STOP_FAILED");
          await bounded(() => resource.close(), "CLOSE_FAILED");
        })();
        throw Error("RESOURCE_START_STOPPED");
      }
      return resource;
    },
  };
  async function bounded(operation: () => void | Promise<void>, error: LifecycleEvent) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("CLEANUP_TIMEOUT")), options.cleanupTimeoutMs); }),
      ]);
    } catch (cause) {
      failed = true;
      emit(cause instanceof Error && cause.message === "CLEANUP_TIMEOUT" ? "CLEANUP_TIMEOUT" : error);
    } finally { clearTimeout(timer); }
  }
  function stop(): Promise<Readonly<{ clean: boolean }>> {
    stopping = true; abort.abort();
    if (!shutdown) {
      // Let acquisition finish registering any handle obtained during abort.
      shutdown = (async () => {
        if (startup) await bounded(() => startup!, "START_FAILED");
        cleanupStarted = true;
        detach?.();
        const rank = { consumer: 0, media: 1, database: 2 };
        const ordered = [...resources].reverse().sort((a, b) => rank[a.kind] - rank[b.kind]);
        for (const { resource } of ordered) if (resource.stop) await bounded(() => resource.stop!(), "STOP_FAILED");
        for (const { resource } of ordered) await bounded(() => resource.close(), "CLOSE_FAILED");
        emit("STOPPED");
        return Object.freeze({ clean: !failed });
      })();
    }
    return shutdown;
  }
  async function start(initialize: (context: typeof scope) => Promise<void>) {
    if (started || stopping) throw Error("LIFECYCLE_START_BLOCKED");
    started = true;
    startup = Promise.resolve().then(() => initialize(scope));
    try { await startup; if (!stopping) emit("STARTED"); }
    catch { failed = true; emit("START_FAILED"); await stop(); throw Error("RESOURCE_START_FAILED"); }
  }
  function attachSignals(source: Signals) {
    if (detach || stopping) throw Error("SIGNAL_BINDING_BLOCKED");
    const handler = () => { void stop(); };
    source.on("SIGTERM", handler); source.on("SIGINT", handler);
    detach = () => { source.removeListener("SIGTERM", handler); source.removeListener("SIGINT", handler); };
    return detach;
  }
  return { start, stop, attachSignals, signal: abort.signal };
}
