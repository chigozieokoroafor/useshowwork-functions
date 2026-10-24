import "./build-bullmq-worker.mjs";
import { mkdir, writeFile } from "node:fs/promises";

// Maintain backward compatibility for dist-ai-worker/run.cjs
await mkdir("dist-ai-worker", { recursive: true });
await writeFile(
  "dist-ai-worker/run.cjs",
  '"use strict";\n// Merged AI Worker runner delegating to unified worker runner\nrequire("../dist-worker-native/run-bullmq.cjs");\n'
);
console.log("AI_WORKER_BUILD_OK: Unified with BullMQ runner");
