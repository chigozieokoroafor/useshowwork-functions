#!/usr/bin/env node
/**
 * Showwork Unified Worker Runner (.mjs)
 * Executes all background workers: Publishing, Background Crons, Content Gen, and AI Polling.
 *
 * Usage:
 *   node run-workers.mjs [--run | --check | --reconcile]
 */
import "./scripts/vps/run-workers.mjs";
