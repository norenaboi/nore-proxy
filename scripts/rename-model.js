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

const oldModel = await question("Enter old model name: ");
const newModel = await question("Enter new model name: ");

rl.close();

if (!oldModel || !newModel) {
  console.error("Both model names are required");
  process.exit(1);
}

const dbPath = path.join(Config.LOG_DIR, "logs.db");
const db = new Database(dbPath, { readonly: false });
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.prepare("BEGIN TRANSACTION").run();

try {
  const updateData = db.prepare(
    "UPDATE request_logs SET data = json_set(data, '$.model', ?) WHERE model = ?"
  );
  updateData.run(newModel, oldModel);

  const updateModel = db.prepare(
    "UPDATE request_logs SET model = ? WHERE model = ?"
  );
  const result = updateModel.run(newModel, oldModel);

  db.prepare("COMMIT").run();

  console.log(`Successfully renamed model "${oldModel}" to "${newModel}"`);
  console.log(`Updated ${result.changes} records`);
} catch (error) {
  db.prepare("ROLLBACK").run();
  console.error("Error renaming model:", error.message);
  process.exit(1);
} finally {
  db.close();
}
