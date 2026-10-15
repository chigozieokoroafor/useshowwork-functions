import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ConfigurationCode = "CONFIG_INVALID" | "CREDENTIALS_MISSING" | "CREDENTIALS_UNSAFE" | "CREDENTIALS_INVALID";
export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationCode) { super(code); this.name = "ConfigurationError"; }
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join();
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}
export type WorkerConfiguration = Readonly<{
  version: 1; mode: "preparation" | "synthetic-staging"; publishingEnabled: false;
  tickIntervalMs: number; shutdownTimeoutMs: number;
  databaseBackendLimit: number; heavyTransactionLimit: number; mediaConcurrency: 1;
}>;
export function validateConfiguration(value: unknown): WorkerConfiguration {
  if (!record(value, ["version", "mode", "publishingEnabled", "tickIntervalMs", "shutdownTimeoutMs", "databaseBackendLimit", "heavyTransactionLimit", "mediaConcurrency"])
    || value.version !== 1 || (value.mode !== "preparation" && value.mode !== "synthetic-staging")
    || value.publishingEnabled !== false || !integer(value.tickIntervalMs, 1000, 60000)
    || !integer(value.shutdownTimeoutMs, 100, 30000) || !integer(value.databaseBackendLimit, 1, 2)
    || !integer(value.heavyTransactionLimit, 1, Number(value.databaseBackendLimit)) || value.mediaConcurrency !== 1) {
    throw new ConfigurationError("CONFIG_INVALID");
  }
  return Object.freeze({ ...value }) as WorkerConfiguration;
}
export function parseConfiguration(text: string): WorkerConfiguration {
  try { return validateConfiguration(JSON.parse(text)); }
  catch { throw new ConfigurationError("CONFIG_INVALID"); }
}

/** Explicit access only. Accidental logging/JSON serialization cannot reveal the URL. */
export class SyntheticCredentials {
  #databaseUrl: string;
  constructor(databaseUrl: string) { this.#databaseUrl = databaseUrl; }
  databaseConnectionString(): string { return this.#databaseUrl; }
  toJSON() { return "[REDACTED]"; }
  [Symbol.for("nodejs.util.inspect.custom")]() { return "SyntheticCredentials [REDACTED]"; }
}
function parseCredentials(text: string): SyntheticCredentials {
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value, ["version", "databaseUrl"]) || value.version !== 1 || typeof value.databaseUrl !== "string") throw Error();
    const url = new URL(value.databaseUrl);
    // Stage 2 cannot authorize a production destination. No connection is made.
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^\/showwork_test_[a-z0-9_]+$/.test(url.pathname)
      || !url.username || !url.password || url.search || url.hash) throw Error();
    return new SyntheticCredentials(value.databaseUrl);
  } catch { throw new ConfigurationError("CREDENTIALS_INVALID"); }
}

/** Future caller may explicitly pass systemd's CREDENTIALS_DIRECTORY.
 * No environment is read on import, and --check never imports this module.
 * Directory must be trusted and not replaceable by an untrusted ancestor owner.
 */
export async function loadSyntheticCredentials(directory: string | undefined): Promise<SyntheticCredentials> {
  if (!directory) throw new ConfigurationError("CREDENTIALS_MISSING");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await realpath(directory) !== directory) throw new ConfigurationError("CREDENTIALS_UNSAFE");
    const uid = process.getuid?.();
    if (uid === undefined) throw new ConfigurationError("CREDENTIALS_UNSAFE");
    const safeOwner = (owner: number) => owner === 0 || owner === uid;
    const parent = await stat(directory);
    if (!parent.isDirectory() || !safeOwner(parent.uid) || (parent.mode & 0o077) !== 0) throw new ConfigurationError("CREDENTIALS_UNSAFE");
    file = await open(path.join(directory, "publishing.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !safeOwner(info.uid) || ![0o400, 0o600].includes(info.mode & 0o7777) || info.size < 1 || info.size > 16384) throw new ConfigurationError("CREDENTIALS_UNSAFE");
    const bytes = Buffer.alloc(16385);
    try {
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, null);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count > 16384) throw new ConfigurationError("CREDENTIALS_UNSAFE");
      return parseCredentials(bytes.subarray(0, count).toString("utf8"));
    } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError((error as NodeJS.ErrnoException)?.code === "ENOENT" ? "CREDENTIALS_MISSING" : "CREDENTIALS_UNSAFE");
  } finally { await file?.close().catch(() => {}); }
}
