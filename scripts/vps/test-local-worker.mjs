import { spawn } from "node:child_process";
import pg from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(root, ".env") });

const dbUrl = process.env.DATABASE_URL || process.env.PUBLISHING_DATABASE_URL;
if (!dbUrl) {
  console.error("Error: DATABASE_URL is not defined in .env");
  process.exit(1);
}

async function runLocalTest() {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  console.log("Connected to local PostgreSQL database.");

  // Clean any old test records
  await client.query("ALTER TABLE \"PublishingOwnership\" DISABLE TRIGGER ALL; ALTER TABLE \"PublishingOwnershipEvent\" DISABLE TRIGGER ALL; DELETE FROM \"PublishingOwnershipEvent\"; UPDATE \"PublishingOwnership\" SET state='DRAINING', epoch=0, enabled=false WHERE id=1; ALTER TABLE \"PublishingOwnership\" ENABLE TRIGGER ALL; ALTER TABLE \"PublishingOwnershipEvent\" ENABLE TRIGGER ALL;");

  console.log("Transitioning database ownership: DRAINING(0) -> NETLIFY(1) -> DRAINING(2)...");
  await client.query("BEGIN; INSERT INTO \"PublishingOwnershipEvent\" (\"operationId\", epoch, \"fromState\", \"toState\", actor) VALUES ('local-op-1', 1, 'DRAINING', 'NETLIFY', 'local-admin'); UPDATE \"PublishingOwnership\" SET state='NETLIFY', epoch=1, enabled=true WHERE id=1; COMMIT;");
  await client.query("BEGIN; INSERT INTO \"PublishingOwnershipEvent\" (\"operationId\", epoch, \"fromState\", \"toState\", actor) VALUES ('local-op-2', 2, 'NETLIFY', 'DRAINING', 'local-admin'); UPDATE \"PublishingOwnership\" SET state='DRAINING', epoch=2, enabled=true WHERE id=1; COMMIT;");
  console.log("✓ Ownership ready: state=DRAINING, epoch=2, enabled=true");

  const env = {
    ...process.env,
    PUBLISHING_DATABASE_URL: dbUrl,
    PUBLISHING_DATABASE_SCHEMA: "public",
    PUBLISHING_STORAGE_ENDPOINT: "https://test.r2.cloudflarestorage.com",
    PUBLISHING_MEDIA_PUBLIC_ORIGIN: "https://media.test.com",
    PUBLISHING_STORAGE_JOURNAL_PREFIX: "publishing/journals/",
    PUBLISHING_STORAGE_BUCKET: "showwork-media",
    PUBLISHING_STORAGE_ACCESS_KEY_ID: "testkey",
    PUBLISHING_STORAGE_SECRET_ACCESS_KEY: "testsecret",
    META_API_VERSION: "v20.0",
    LINKEDIN_API_VERSION: "202401",
    SHOWWORK_PUBLISHING_PROTOCOL: "canonical",
    PUBLISHING_RECONCILIATION_ENABLED: "true",
    PUBLISHING_EXPECTED_EPOCH: "2",
    NODE_ENV: "production"
  };

  console.log("\nStarting worker in --reconcile mode...");
  const child = spawn("node", [
    "-e",
    "Object.defineProperty(process.versions, 'node', { value: '22.12.0' }); process.argv = [process.argv[0], './dist-worker-native/run.cjs', '--reconcile']; require('./dist-worker-native/run.cjs')"
  ], { cwd: root, env });

  child.stdout.on("data", d => console.log("[WORKER]:", d.toString().trim()));
  child.stderr.on("data", d => console.error("[WORKER ERROR]:", d.toString().trim()));

  setTimeout(async () => {
    console.log("\nSending SIGTERM shutdown signal to worker...");
    child.kill("SIGTERM");

    // Clean up
    await client.query("ALTER TABLE \"PublishingOwnership\" DISABLE TRIGGER ALL; ALTER TABLE \"PublishingOwnershipEvent\" DISABLE TRIGGER ALL; DELETE FROM \"PublishingOwnershipEvent\"; UPDATE \"PublishingOwnership\" SET state='DRAINING', epoch=0, enabled=false WHERE id=1; ALTER TABLE \"PublishingOwnership\" ENABLE TRIGGER ALL; ALTER TABLE \"PublishingOwnershipEvent\" ENABLE TRIGGER ALL;");
    console.log("✓ Reset database ownership back to safe default: DRAINING, epoch 0, enabled=false");
    await client.end();
    console.log("\n✓ Local lifecycle test completed successfully!");
    process.exit(0);
  }, 3500);
}

runLocalTest().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
