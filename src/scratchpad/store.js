import { openDatabase, transact } from "../folio/idb.js";

const DB_NAME = "folio_scratchpad_db";
const DB_VERSION = 1;

function upgrade(db) {
  if (!db.objectStoreNames.contains("documents")) {
    db.createObjectStore("documents", { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains("notes")) {
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("by_document", "documentId", { unique: false });
  }
}

function documentRecord(title, pinned) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title, pinned, createdAt: now, updatedAt: now };
}

export async function loadStore({ onClose, onUnavailable } = {}) {
  let db;
  let storageError;
  const documents = [];
  let writes = Promise.resolve();
  const putDocument = (record) =>
    transact(db, "documents", "readwrite", (tx) => tx.objectStore("documents").put(record));

  try {
    db = await openDatabase(DB_NAME, DB_VERSION, upgrade, {
      onClose(error) {
        storageError = error;
        onClose?.(error);
      },
    });
    const [records, notes] = await Promise.all(
      ["documents", "notes"].map((name) => transact(db, name, "readonly", (tx) => tx.objectStore(name).getAll())),
    );
    const notesByDocument = new Map();
    for (const note of notes) {
      if (!notesByDocument.has(note.documentId)) notesByDocument.set(note.documentId, []);
      notesByDocument.get(note.documentId).push(note);
    }
    documents.push(...records.map((record) => ({ ...record, notes: notesByDocument.get(record.id) || [] })));
    // First run seeds one empty, pinned document.
    if (!documents.length) await createDocument("Quick Scratch", true);
  } catch (error) {
    db?.close();
    db = null;
    if (!storageError) onUnavailable?.(error);
    if (!documents.length) documents.push({ ...documentRecord("Quick Scratch", true), notes: [] });
  }

  function getDocument(id) {
    return documents.find((doc) => doc.id === id);
  }

  function requireDocument(id) {
    const doc = getDocument(id);
    if (!doc) throw new Error("This document no longer exists.");
    return doc;
  }

  // Build each snapshot after the previous write commits, so updates cannot overwrite one another.
  function write(operation) {
    const result = writes.then(() => {
      if (storageError) throw storageError;
      return operation();
    });
    writes = result.catch(() => {});
    return result;
  }

  async function createDocument(title, pinned = false) {
    const record = documentRecord(title, pinned);
    if (db) await putDocument(record);
    const doc = { ...record, notes: [] };
    documents.unshift(doc);
    return doc;
  }

  async function saveDocument(doc, patch) {
    const { notes, ...record } = doc;
    if (db) await putDocument({ ...record, ...patch });
    Object.assign(doc, patch);
  }

  return {
    get documents() {
      return documents;
    },
    get persistent() {
      return Boolean(db) && !storageError;
    },
    get memoryOnly() {
      return !db && !storageError;
    },
    getDocument,
    createDocument: (title) => write(() => createDocument(title)),
    renameDocument: (id, title) =>
      write(() => saveDocument(requireDocument(id), { title, updatedAt: new Date().toISOString() })),
    togglePin: (id) =>
      write(async () => {
        const doc = requireDocument(id);
        await saveDocument(doc, { pinned: !doc.pinned });
      }),
    deleteDocument: (id) =>
      write(async () => {
        const doc = requireDocument(id);
        if (db) {
          await transact(db, ["documents", "notes"], "readwrite", (tx) => {
            tx.objectStore("documents").delete(id);
            const request = tx.objectStore("notes").index("by_document").openCursor(IDBKeyRange.only(id));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return;
              try {
                cursor.delete();
                cursor.continue();
              } catch {
                tx.abort();
              }
            };
          });
        }
        documents.splice(documents.indexOf(doc), 1);
        if (!documents.length) {
          try {
            await createDocument("Quick Scratch", true);
          } catch {
            documents.push({ ...documentRecord("Quick Scratch", true), notes: [] });
            return { seedFailed: true };
          }
        }
        return { seedFailed: false };
      }),
    saveNote: (id, note, editing = false) =>
      write(async () => {
        const doc = requireDocument(id);
        const index = doc.notes.findIndex((saved) => saved.id === note.id);
        if (editing && index === -1) throw new Error("This note no longer exists.");
        const updatedAt = note.updatedAt || note.createdAt;
        const { notes, ...record } = doc;
        if (db) {
          await transact(db, ["documents", "notes"], "readwrite", (tx) => {
            tx.objectStore("notes").put(note);
            tx.objectStore("documents").put({ ...record, updatedAt });
          });
        }
        if (index === -1) notes.unshift(note);
        else notes[index] = note;
        doc.updatedAt = updatedAt;
      }),
    deleteNote: (id, noteId) =>
      write(async () => {
        const doc = requireDocument(id);
        if (db) await transact(db, "notes", "readwrite", (tx) => tx.objectStore("notes").delete(noteId));
        doc.notes = doc.notes.filter((note) => note.id !== noteId);
      }),
  };
}
