import fs from "node:fs";
import path from "node:path";

const DEFAULT_BACKUP_COUNT = 5;

function rotateBackups(filePath: string, count: number): void {
  if (!fs.existsSync(filePath) || count < 1) return;
  for (let index = count; index >= 2; index -= 1) {
    const previous = `${filePath}.bak.${index - 1}`;
    if (fs.existsSync(previous)) fs.copyFileSync(previous, `${filePath}.bak.${index}`);
  }
  fs.copyFileSync(filePath, `${filePath}.bak.1`);
}

export function writeFileAtomic(
  filePath: string,
  content: string,
  options: { backups?: number } = {},
): void {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const temporaryPath = path.join(directory, `.${basename}.${process.pid}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  rotateBackups(filePath, options.backups ?? DEFAULT_BACKUP_COUNT);

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "w", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

/**
 * Creates the file with `initial` when it does not exist yet, so runtime JSON
 * configuration self-materializes at startup: a deployment that mounts an
 * empty data/ directory comes up with working defaults instead of warnings.
 * Never overwrites. Returns true when the file was created.
 */
export function ensureJsonAtomic(filePath: string, initial: unknown): boolean {
  if (fs.existsSync(filePath)) return false;
  writeJsonAtomic(filePath, initial);
  return true;
}
