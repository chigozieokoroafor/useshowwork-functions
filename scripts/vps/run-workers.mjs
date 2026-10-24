#!/usr/bin/env node
/**
 * Showwork Unified Worker Runner (.mjs)
 * Executes all background workers: Publishing, Background Crons, Content Gen, and AI Polling.
 *
 * Usage:
 *   node scripts/vps/run-workers.mjs [--run | --check | --reconcile]
 */
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(__dirname, "../../dist-worker-native/run-workers.mjs");

if (!existsSync(bundlePath)) {
  console.log("[run-workers.mjs] Bundle not found. Building unified workers bundle first...");
  const { execSync } = await import("node:child_process");
  execSync("node scripts/vps/build-bullmq-worker.mjs", {
    cwd: resolve(__dirname, "../.."),
    stdio: "inherit",
  });
}

// Execute the unified bundle
await import(bundlePath);
