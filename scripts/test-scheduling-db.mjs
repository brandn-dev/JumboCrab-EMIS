import "dotenv/config";
import { spawnSync } from "node:child_process";
import { lstat, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const requestedTests = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (requestedTests.length === 0) {
  throw new Error("Pass one or more explicit scheduling DB test files.");
}

const appDatabaseUrl = process.env.DATABASE_URL?.trim();
const testDatabaseUrl = process.env.DATABASE_URL_TEST?.trim();
const allowCurrentDatabase = process.env.ALLOW_CURRENT_DATABASE_TESTS === "true";
const selectedDatabaseUrl = testDatabaseUrl || (allowCurrentDatabase ? appDatabaseUrl : null);
if (!selectedDatabaseUrl) {
  throw new Error("Set DATABASE_URL_TEST, or explicitly opt in to DATABASE_URL with ALLOW_CURRENT_DATABASE_TESTS=true.");
}
if (appDatabaseUrl && selectedDatabaseUrl === appDatabaseUrl && !allowCurrentDatabase) {
  throw new Error("Current DATABASE_URL requires ALLOW_CURRENT_DATABASE_TESTS=true.");
}

process.env.DATABASE_URL = selectedDatabaseUrl;
process.env.DATABASE_URL_TEST = selectedDatabaseUrl;

const requiredTables = new Set(["Employee", "Shift", "WeeklySchedule", "EmployeeShiftOverride", "LeaveRequest"]);
if (requestedTests.some((file) => file.includes("phase1"))) {
  for (const table of ["AiScheduleDraft", "AiScheduleDraftAssignment", "AiActionAudit"]) requiredTables.add(table);
}
if (requestedTests.some((file) => file.includes("phase3"))) {
  for (const table of ["AiConversation", "AiMessage"]) requiredTables.add(table);
}
if (requestedTests.some((file) => file.includes("phase4"))) {
  for (const table of ["AiScheduleDraft", "AiScheduleDraftAssignment", "AiActionAudit", "ScheduleCoverageRule", "SchedulePublicationOutbox"]) requiredTables.add(table);
}

const client = new Client({ connectionString: selectedDatabaseUrl });
await client.connect();
try {
  const result = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])",
    [Array.from(requiredTables)],
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  const missing = Array.from(requiredTables).filter((table) => !present.has(table));
  if (missing.length) {
    throw new Error(`Selected database is missing required scheduling tables: ${missing.join(", ")}. No migrations were run.`);
  }
} finally {
  await client.end();
}

const serverOnlyPackage = path.resolve("node_modules/server-only");
const nextServerOnly = path.resolve("node_modules/next/dist/compiled/server-only");
let createdServerOnlyLink = false;
try {
  await lstat(serverOnlyPackage);
} catch {
  await symlink(nextServerOnly, serverOnlyPackage, "dir");
  createdServerOnlyLink = true;
}

try {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import=tsx", "--test", ...requestedTests],
    { stdio: "inherit", env: process.env },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  if (createdServerOnlyLink) await rm(serverOnlyPackage, { force: true, recursive: true });
}
