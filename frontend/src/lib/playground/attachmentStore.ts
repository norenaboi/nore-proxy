/**
 * Binary payload store for playground attachments and generated images.
 *
 * Base64 image data is far too large for the localStorage workspace, so the
 * workspace persists only attachment metadata and the bytes live here, keyed by
 * the attachment id. Every operation resolves rather than throwing: without
 * IndexedDB the playground still works for the current session, and an image
 * that cannot be reloaded is reported to the user as needing to be reattached.
 */

const DB_NAME = "nore-proxy-playground-attachments";
const STORE_NAME = "payloads";
const DB_VERSION = 1;

interface PayloadRecord {
  id: string;
  dataUrl: string;
  createdAt: number;
}

let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Attachment storage failed to open"));
    request.onblocked = () => reject(new Error("Attachment storage is blocked"));
  });
  // A failed connection must not be cached, or one transient error would
  // disable storage for the rest of the session.
  connection.catch(() => {
    connection = null;
  });
  return connection;
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Attachment storage failed"));
  });
}

async function transaction(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

/** Returns false when the payload could not be stored, so callers can warn. */
export async function writePayload(id: string, dataUrl: string): Promise<boolean> {
  if (!id || !dataUrl) return false;
  try {
    const store = await transaction("readwrite");
    const record: PayloadRecord = { id, dataUrl, createdAt: Date.now() };
    await settle(store.put(record));
    return true;
  } catch {
    return false;
  }
}

/** Missing ids are simply absent from the result rather than being an error. */
export async function readPayloads(ids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return found;

  try {
    const store = await transaction("readonly");
    const records = await Promise.all(
      wanted.map((id) => settle<PayloadRecord | undefined>(store.get(id)).catch(() => undefined)),
    );
    for (const record of records) {
      if (record?.id && typeof record.dataUrl === "string") found.set(record.id, record.dataUrl);
    }
  } catch {
    // The caller renders metadata-only attachments when nothing is returned.
  }
  return found;
}

/** Drops every stored payload the workspace no longer references. */
export async function collectGarbage(referencedIds: string[]): Promise<void> {
  const referenced = new Set(referencedIds.filter(Boolean));
  try {
    const store = await transaction("readwrite");
    const keys = await settle<IDBValidKey[]>(store.getAllKeys());
    await Promise.all(
      keys
        .filter((key) => typeof key === "string" && !referenced.has(key))
        .map((key) => settle(store.delete(key)).catch(() => undefined)),
    );
  } catch {
    // Leftover payloads are harmless; they are only ever read by id.
  }
}
