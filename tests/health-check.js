import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(testsDirectory);
const testFiles = readdirSync(testsDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join("tests", name));

const checks = [
  {
    name: "Server typecheck",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "typecheck:server"],
  },
  {
    name: "Frontend typecheck and production build",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "typecheck:frontend"],
  },
  {
    name: "Unit and contract tests",
    command: process.execPath,
    args: ["--import", "tsx", "--test", ...testFiles],
  },
];

const failures = [];

console.log("Nore Proxy health check\n");
for (const check of checks) {
  console.log(`=== ${check.name} ===`);
  const result = spawnSync(check.command, check.args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    failures.push(`${check.name}: ${result.error.message}`);
  } else if (result.status !== 0) {
    failures.push(`${check.name}: exited with status ${result.status ?? "unknown"}`);
  }
  console.log();
}

if (failures.length > 0) {
  console.error("Health check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Health check passed (${checks.length} categories, ${testFiles.length} test files).`);
}
