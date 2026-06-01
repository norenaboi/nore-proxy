import path from "path";
import Database from "better-sqlite3";
import Config from "../config/index.js";
import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query) =>
new Promise((resolve) => rl.question(query, resolve));

const modelName = await question("Enter model name to delete: ");

rl.close();

if (!modelName) {
  console.error("Model name is required");
  process.exit(1);
}

const dbPath = path.join(Config.LOG_DIR, "logs.db");
const db = new Database(dbPath, { readonly: false });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.prepare("BEGIN TRANSACTION").run();

try {
  const deleteRequests = db.prepare(
    "DELETE FROM request_logs WHERE model = ?"
  );
  const result = deleteRequests.run(modelName);

  db.prepare("COMMIT").run();

  console.log(`Successfully deleted requests for model "${modelName}"`);
  console.log(`Deleted ${result.changes} records`);
} catch (error) {
  db.prepare("ROLLBACK").run();
  console.error("Error deleting model requests:", error.message);
  process.exit(1);
} finally {
  db.close();
}
