export class StorageClosedError extends Error {
  constructor() {
    super("Local storage changed in another tab. Reload to reconnect.");
    this.name = "StorageClosedError";
  }
}

export function openDatabase(name, version, upgrade, { onClose } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    let blocked = false;

    request.onblocked = () => {
      blocked = true;
      reject(new Error("Close other tabs using this tool and reload to open local storage."));
    };
    request.onupgradeneeded = (event) => {
      // An open request can resume after onblocked even though the caller has given up.
      if (blocked) request.transaction.abort();
      else upgrade(request.result, request.transaction, event);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        onClose?.(new StorageClosedError());
      };
      resolve(db);
    };
  });
}

// A successful request is not necessarily a committed write. Wait for the transaction.
export function transact(db, storeNames, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let request;
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = (event) => reject(tx.error || event.target.error || new Error("Storage transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("Storage transaction was aborted."));
    try {
      request = operation(tx);
    } catch (error) {
      reject(error);
      tx.abort();
    }
  });
}
