// Imported as the first line of a test file: ESM evaluates static imports in
// source order, so this module runs before config/index.js, settingsManager,
// and proxyManager are constructed — the singletons that read a runtime JSON
// path at construction time. Without it, the data/ default would point those
// constructions at the deployed files under data/, reading (and with the
// create-on-missing loaders, writing) operational data from a test run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MASTER_KEY ??= "test-only-master-key";

const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nore-isolated-config-"));
process.env.MODELS_PATH = path.join(scratchDirectory, "models.json");
process.env.ENDPOINTS_PATH = path.join(scratchDirectory, "endpoints.json");
process.env.SETTINGS_PATH = path.join(scratchDirectory, "settings.json");
process.env.PROXIES_PATH = path.join(scratchDirectory, "proxies.json");

export { scratchDirectory };
