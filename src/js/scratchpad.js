function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function noteLabel(count) {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

/* IndexedDB Layer (Local-First Storage) */
const DB_NAME = "folio_scratchpad_db";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("notes")) {
        const notesStore = db.createObjectStore("notes", { keyPath: "id" });
        notesStore.createIndex("by_document", "documentId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Write aborted."));
  });
}

async function dbSaveNote(db, docRecord, noteRecord) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["documents", "notes"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Note save aborted."));
    try {
      tx.objectStore("notes").put(noteRecord);
      tx.objectStore("documents").put(docRecord);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

async function dbDelete(db, storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteDocumentAndNotes(db, documentId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["documents", "notes"], "readwrite");
    tx.objectStore("documents").delete(documentId);
    const notesStore = tx.objectStore("notes");
    const index = notesStore.index("by_document");
    const range = IDBKeyRange.only(documentId);
    const cursorReq = index.openCursor(range);
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* Main Application State & Logic */
document.addEventListener("DOMContentLoaded", async () => {
  let db;
  let documents = []; // Each doc hydrated with .notes = []

  const state = {
    selectedId: null,
    query: "",
    sort: "updated",
  };

  // In-memory uncommitted drafts (discarded on reload per design tree)
  const drafts = new Map();
  const savingDocuments = new Set();
  let pendingAction;

  const docListEl = document.querySelector("#doc-list");
  const stageEl = document.querySelector("#doc-stage");
  const confirmDialog = document.querySelector("#confirm-dialog");
  const renameDialog = document.querySelector("#rename-dialog");

  // Discovery controls become available with their handlers in phase 5.
  document.querySelector("#global-search").disabled = true;
  document.querySelector("#doc-sort").disabled = true;

  const fullDateFormat = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  const shortDateFormat = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  });

  function escapeText(value) {
    const element = document.createElement("span");
    element.textContent = value;
    return element.innerHTML;
  }

  function refreshIcons() {
    globalThis.lucide?.createIcons();
  }

  function announce(message) {
    document.querySelector("#status").textContent = message;
  }

  function selectedDocument() {
    return documents.find((doc) => doc.id === state.selectedId) || null;
  }

  function draftFor(doc = selectedDocument()) {
    if (!doc) return null;
    if (!drafts.has(doc.id)) {
      drafts.set(doc.id, { body: "", editingId: null, mode: "write" });
    }
    return drafts.get(doc.id);
  }

  function hasChanges(doc = selectedDocument()) {
    if (!doc || !drafts.has(doc.id)) return false;
    const draft = drafts.get(doc.id);
    const original = doc.notes.find((n) => n.id === draft.editingId);
    return draft.body !== (original?.body ?? "");
  }

  /* Initialize IndexedDB & First-Run Seed (Option B: Single empty "Quick Scratch") */
  try {
    db = await openDatabase();
    const rawDocs = await dbGetAll(db, "documents");
    const rawNotes = await dbGetAll(db, "notes");

    if (rawDocs.length === 0) {
      const now = new Date().toISOString();
      const starterDoc = {
        id: crypto.randomUUID(),
        title: "Quick Scratch",
        pinned: true,
        createdAt: now,
        updatedAt: now,
      };
      await dbPut(db, "documents", starterDoc);
      documents = [{ ...starterDoc, notes: [] }];
    } else {
      const notesByDoc = new Map();
      for (const note of rawNotes) {
        if (!notesByDoc.has(note.documentId))
          notesByDoc.set(note.documentId, []);
        notesByDoc.get(note.documentId).push(note);
      }
      documents = rawDocs.map((doc) => ({
        ...doc,
        notes: notesByDoc.get(doc.id) || [],
      }));
    }

    state.selectedId = sortedDocuments()[0]?.id ?? null;
  } catch (err) {
    console.error("IndexedDB initialization failed:", err);
    document.querySelector("#db-status-text").textContent = "Memory Fallback";
    announce("IndexedDB unavailable in this context; running in memory mode.");
  }

  /* Markdown Rendering (Marked + DOMPurify with Checkbox support) */
  function renderMarkdown(target, body) {
    if (globalThis.marked && globalThis.DOMPurify) {
      const rawHtml = marked.parse(body, {
        async: false,
        gfm: true,
        breaks: true,
      });
      target.innerHTML = DOMPurify.sanitize(rawHtml, {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "em",
          "a",
          "code",
          "pre",
          "ul",
          "ol",
          "li",
          "blockquote",
          "h1",
          "h2",
          "h3",
          "h4",
          "hr",
          "del",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
          "input",
        ],
        ALLOWED_ATTR: ["href", "title", "type", "checked", "disabled"],
      });
      target.querySelectorAll("a").forEach((link) => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      });
      // Enable interactive task checkboxes inside saved note cards
      target.querySelectorAll('input[type="checkbox"]').forEach((box, idx) => {
        box.removeAttribute("disabled");
        box.dataset.checkboxIndex = String(idx);
      });
    } else {
      target.textContent = body;
      target.classList.add("plain-fallback");
    }
  }

  function noteExcerpt(note) {
    const firstLine =
      note.body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) || "";
    const preview = document.createElement("div");
    renderMarkdown(preview, firstLine);
    return preview.textContent.trim() || "Untitled note";
  }

  /* Global Search & Sorting */
  function sortedDocuments() {
    const q = state.query.trim().toLocaleLowerCase();
    return documents
      .filter((doc) => {
        if (!q) return true;
        const inTitle = doc.title.toLocaleLowerCase().includes(q);
        const inNotes = doc.notes.some((n) =>
          n.body.toLocaleLowerCase().includes(q),
        );
        return inTitle || inNotes;
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        if (state.sort === "title") {
          return a.title.localeCompare(b.title);
        }
        if (state.sort === "created") {
          return b.createdAt.localeCompare(a.createdAt);
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  function filteredNotesFor(doc) {
    const sorted = [...doc.notes].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
    const q = state.query.trim().toLocaleLowerCase();
    if (!q) return sorted;
    // If the document title itself matches, show matching notes first, or all if none specifically match
    const matchingNotes = sorted.filter((n) =>
      n.body.toLocaleLowerCase().includes(q),
    );
    return matchingNotes.length > 0 ? matchingNotes : sorted;
  }

  /* Render Left Rail Document Item */
  function createDocumentRow(doc) {
    const row = document.createElement("li");
    row.className = "doc-row";
    const active = doc.id === state.selectedId;
    const newest = [...doc.notes].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    )[0];

    const draftBadge = hasChanges(doc) ? "Draft • " : "";
    const snippet = newest
      ? `<span class="doc-row-snippet">${escapeText(noteExcerpt(newest))}</span>`
      : `<span class="doc-row-snippet">No notes yet</span>`;

    const updatedDate = shortDateFormat.format(new Date(doc.updatedAt));
    const pinHtml = doc.pinned
      ? `<span class="pin-badge">${icon("pin")}Pinned</span>`
      : `<span>${updatedDate}</span>`;

    const q = state.query.trim().toLocaleLowerCase();
    const matchCount = q
      ? doc.notes.filter((n) => n.body.toLocaleLowerCase().includes(q)).length
      : 0;
    
    const matchVerb = matchCount === 1 ? "match" : "matches";
    const matchBadge = q && matchCount > 0
        ? `<span class="match-badge">${matchCount} ${matchVerb}</span>`
        : "";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "doc-select";
    button.dataset.docId = doc.id;
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `
    <span class="doc-row-meta">
        ${pinHtml}
        ${doc.pinned ? `<span>${updatedDate}</span>` : ""}
    </span>
    <span class="doc-row-title">${escapeText(doc.title)}</span>
    ${snippet}
    <span class="doc-row-footer">
        <span class="note-pill">${icon("notebook-pen")}${draftBadge}${noteLabel(doc.notes.length)}</span>
        ${matchBadge}
    </span>
    `;
    row.append(button);
    return row;
  }

  /* Render Right Stage (Document Header + Markdown Composer + Note Stream) */
  function renderStage(doc) {
    const draft = draftFor(doc);
    const createdFormatted = shortDateFormat.format(new Date(doc.createdAt));
    const visibleNotes = filteredNotesFor(doc);
    const q = state.query.trim();

    stageEl.innerHTML = `
    <div class="stage-inner">
        <header class="doc-header">
        <div class="doc-heading-group">
            <div class="doc-eyebrow">
            <span>Created ${createdFormatted}</span>
            <span>•</span>
            <span>${noteLabel(doc.notes.length)}</span>
            </div>
            <h1 class="doc-title">${escapeText(doc.title)}</h1>
        </div>
        <div class="doc-actions" role="group" aria-label="Document actions">
            <button
            type="button"
            class="icon-button ${doc.pinned ? "is-pinned" : ""}"
            data-action="toggle-pin"
            aria-pressed="${Boolean(doc.pinned)}"
            aria-label="${doc.pinned ? "Unpin document" : "Pin document to top"}"
            data-tooltip="${doc.pinned ? "Unpin document" : "Pin to top"}"
            >${icon("pin")}</button>
            <button
            type="button"
            class="icon-button"
            data-action="rename-doc"
            aria-label="Rename document"
            data-tooltip="Rename document"
            >${icon("pencil")}</button>
            <button
            type="button"
            class="icon-button delete-btn"
            data-action="delete-doc"
            aria-label="Delete document"
            data-tooltip="Delete document"
            >${icon("trash-2")}</button>
        </div>
        </header>

        <form class="note-editor" aria-label="${draft.editingId ? "Edit note" : "Add note"}">
        <div class="editor-top">
            <div class="editor-modes" role="tablist" aria-label="Note editor mode">
            <button
                id="write-tab"
                type="button"
                role="tab"
                data-editor-mode="write"
                aria-selected="${draft.mode === "write"}"
                tabindex="${draft.mode === "write" ? 0 : -1}"
                aria-controls="write-panel"
            >Write</button>
            <button
                id="preview-tab"
                type="button"
                role="tab"
                data-editor-mode="preview"
                aria-selected="${draft.mode === "preview"}"
                tabindex="${draft.mode === "preview" ? 0 : -1}"
                aria-controls="preview-panel"
            >Preview</button>
            </div>
            <span class="editor-kind ${draft.editingId ? "is-editing" : ""}">
            ${draft.editingId ? "Editing note" : "New entry"} / Markdown
            </span>
        </div>

        <div id="write-panel" role="tabpanel" aria-labelledby="write-tab" ${draft.mode === "write" ? "" : "hidden"}>
            <div class="format-tools" role="group" aria-label="Markdown formatting">
            ${[
              ["bold", "Bold", "bold"],
              ["italic", "Italic", "italic"],
              ["code", "Inline or block code", "code"],
              ["link", "Insert link", "link"],
              ["list", "Bullet list", "list"],
              ["checklist", "Task checklist (- [ ])", "check-square"],
              ["quote", "Blockquote", "quote"],
            ]
              .map(
                ([fmt, label, icn]) =>
                  `<button type="button" class="icon-button" data-format="${fmt}" aria-label="${label}" data-tooltip="${label}">${icon(icn)}</button>`,
              )
              .join("")}
            </div>
            <label for="note-body" class="sr-only">Write note in Markdown</label>
            <textarea
            id="note-body"
            placeholder="Jot down a thought, snippet, or checklist in Markdown..."
            rows="4"
            required
            ></textarea>
        </div>

        <div
            id="preview-panel"
            class="editor-preview markdown"
            role="tabpanel"
            aria-labelledby="preview-tab"
            tabindex="0"
            ${draft.mode === "preview" ? "" : "hidden"}
        ></div>

        <div class="editor-footer">
            <div>
            <span class="draft-meta" id="draft-meta"></span>
            <span class="kbd-hint">Ctrl/⌘ + Enter to save</span>
            </div>
            <div class="editor-actions">
            <button
                class="icon-button"
                type="button"
                data-action="discard"
                aria-label="Discard draft"
                data-tooltip="Discard draft"
            >${icon("x")}</button>
            <button class="primary" type="submit">
                ${icon("check")}${draft.editingId ? "Save changes" : "Add note"}
            </button>
            </div>
        </div>
        </form>

        <div class="stream-header">
        <h3>
            Timeline
            <span class="stream-count">${
              q && visibleNotes.length !== doc.notes.length
                ? `${visibleNotes.length} of ${doc.notes.length}`
                : doc.notes.length
            }</span>
        </h3>
        </div>

        <ol class="note-history" aria-label="Note history, newest first"></ol>
    </div>
    `;

    const textarea = stageEl.querySelector("#note-body");
    textarea.value = draft.body;
    renderMarkdown(stageEl.querySelector("#preview-panel"), draft.body);

    const historyList = stageEl.querySelector(".note-history");

    for (const note of visibleNotes) {
      const item = document.createElement("li");
      item.className = "note-entry";
      const isEditingThis = draft.editingId === note.id;
      const formattedTime = fullDateFormat.format(new Date(note.createdAt));

      item.innerHTML = `
        <article class="note-card ${isEditingThis ? "is-being-edited" : ""}" data-note-card="${note.id}" aria-label="Note from ${escapeText(formattedTime)}">
        <header class="entry-header">
            <div>
            <time datetime="${note.createdAt}">${formattedTime}</time>
            ${note.updatedAt ? '<span class="edited-tag">Edited</span>' : ""}
            </div>
            <div class="entry-actions">
            <button
                type="button"
                class="icon-button"
                data-action="copy-note"
                data-note="${note.id}"
                aria-label="Copy raw Markdown"
                data-tooltip="Copy Markdown"
            >${icon("copy")}</button>
            <button
                type="button"
                class="icon-button"
                data-action="edit-note"
                data-note="${note.id}"
                aria-label="Edit note"
                data-tooltip="Edit note"
            >${icon("pencil")}</button>
            <button
                type="button"
                class="icon-button delete-btn"
                data-action="delete-note"
                data-note="${note.id}"
                aria-label="Delete note"
                data-tooltip="Delete note"
            >${icon("trash-2")}</button>
            </div>
        </header>
        <div class="markdown"></div>
        </article>
    `;
      renderMarkdown(item.querySelector(".markdown"), note.body);
      historyList.append(item);
    }

    if (!visibleNotes.length) {
      const empty = document.createElement("div");
      empty.className = "empty-notes";
      empty.innerHTML = q
        ? `<p>No matching notes in this document.</p><span>Clear the search bar to see all entries.</span>`
        : `<p>This document has no notes yet.</p><span>Write a Markdown note above and press Add note (or Ctrl/⌘ + Enter).</span>`;
      historyList.after(empty);
    }

    updateEditorControls();
  }

  function updateEditorControls() {
    const doc = selectedDocument();
    if (!doc) return;
    const draft = draftFor(doc);
    const form = stageEl.querySelector(".note-editor");
    if (!form) return;

    const submitBtn = form.querySelector('[type="submit"]');
    const discardBtn = form.querySelector('[data-action="discard"]');
    const metaEl = form.querySelector("#draft-meta");

    const saving = savingDocuments.has(doc.id);
    form.setAttribute("aria-busy", String(saving));
    submitBtn.disabled =
      saving ||
      !draft.body.trim() ||
      (Boolean(draft.editingId) && !hasChanges(doc));
    discardBtn.disabled = !draft.body && !draft.editingId;

    const unsavedLabel = hasChanges(doc) ? " • Unsaved draft · " : " · ";
    const draftCount = draft.body ? `${draft.body.length} chars${unsavedLabel}` : "";
    
    metaEl.textContent = saving
      ? "Saving note…"
      : draftCount;
    // Enable these controls when their implementation is added.
    stageEl.querySelectorAll('[data-action="toggle-pin"], [data-action="rename-doc"], [data-action="delete-doc"]').forEach((control) => {
      control.disabled = true;
    });
  }

  function renderDocumentList(matches = sortedDocuments()) {
    const totalNotes = documents.reduce((acc, d) => acc + d.notes.length, 0);
    document.querySelector("#doc-total").textContent =
      `${documents.length} docs · ${totalNotes} notes`;

    docListEl.replaceChildren(...matches.map(createDocumentRow));
    if (!matches.length) {
      docListEl.innerHTML = `<li class="no-matches">No documents match "${escapeText(state.query)}".</li>`;
    }
  }

  function render() {
    const matches = sortedDocuments();
    if (!matches.some((d) => d.id === state.selectedId)) {
      state.selectedId = matches[0]?.id ?? null;
    }

    renderDocumentList(matches);
    stageEl.replaceChildren();

    const activeDoc = selectedDocument();
    if (!activeDoc) {
      stageEl.innerHTML = `<div class="no-matches">Select or create a document on the left to start jotting notes.</div>`;
      refreshIcons();
      return;
    }

    renderStage(activeDoc);
    refreshIcons();
  }

  function focusEditor() {
    const textarea = stageEl.querySelector("#note-body");
    textarea?.focus();
    if (textarea) {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }

  function confirmAction(title, copy, acceptLabel, callback) {
    pendingAction = callback;
    document.querySelector("#confirm-title").textContent = title;
    document.querySelector("#confirm-copy").textContent = copy;
    document.querySelector("#confirm-accept").textContent = acceptLabel;
    confirmDialog.showModal();
  }

  function guardUnsavedDraft(callback) {
    if (hasChanges()) {
      confirmAction(
        "Discard unsaved draft?",
        "Your uncommitted Markdown draft in the editor will be lost. Saved notes will stay untouched.",
        "Discard draft",
        callback,
      );
    } else {
      callback();
    }
  }

  /* Selection-aware Markdown Formatting (Expanded with Code & Checklist) */
  function applyFormatting(name) {
    const textarea = stageEl.querySelector("#note-body");
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selection = textarea.value.slice(start, end);

    const isMultilineCode = name === "code" && selection.includes("\n");
    const formats = {
      bold: ["**", "**", "bold text"],
      italic: ["*", "*", "italic text"],
      code: isMultilineCode
        ? ["```\n", "\n```", "code block"]
        : ["`", "`", "code"],
      link: ["[", "](https://example.com)", "link text"],
      list: ["- ", "", "list item"],
      checklist: ["- [ ] ", "", "task item"],
      quote: ["> ", "", "quote"],
    };

    const [prefix, suffix, placeholder] = formats[name];
    const needsNewline =
      ["list", "checklist", "quote"].includes(name) &&
      start > 0 &&
      textarea.value[start - 1] !== "\n";
    const linePrefix = needsNewline ? "\n" : "";

    const replacement =
      linePrefix + prefix + (selection || placeholder) + suffix;
    textarea.setRangeText(replacement, start, end, "end");
    draftFor().body = textarea.value;
    textarea.focus();

    const selStart = start + linePrefix.length + prefix.length;
    const selEnd = selStart + (selection || placeholder).length;
    textarea.setSelectionRange(selStart, selEnd);
    updateEditorControls();
  }

  /* Actions & Event Handlers */

  // Create New Document
  document
    .querySelector("#new-doc-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.querySelector("#new-doc-title");
      const title = input.value.trim();
      if (!title) return;

      guardUnsavedDraft(async () => {
        const now = new Date().toISOString();
        const newDoc = {
          id: crypto.randomUUID(),
          title,
          pinned: false,
          createdAt: now,
          updatedAt: now,
        };
        if (db) await dbPut(db, "documents", newDoc);
        documents.unshift({ ...newDoc, notes: [] });
        state.selectedId = newDoc.id;
        input.value = "";
        render();
        focusEditor();
        announce(`Created document "${title}".`);
      });
    });

  // Submit Note (Add or Update)
  async function persistNote(doc, note) {
    const updatedAt = note.updatedAt || note.createdAt;
    const { notes, ...docRecord } = doc;
    if (db) {
      await dbSaveNote(db, { ...docRecord, updatedAt }, note);
    }

    const index = doc.notes.findIndex((saved) => saved.id === note.id);
    if (index === -1) doc.notes.unshift(note);
    else doc.notes[index] = note;
    doc.updatedAt = updatedAt;
  }

  document.addEventListener("submit", async (event) => {
    if (!event.target.matches(".note-editor")) return;
    event.preventDefault();
    const doc = selectedDocument();
    if (!doc || savingDocuments.has(doc.id)) return;
    const draft = draftFor(doc);
    if (!draft.body.trim()) return;

    const body = draft.body;
    const now = new Date().toISOString();
    const editing = Boolean(draft.editingId);
    const original = doc.notes.find((note) => note.id === draft.editingId);
    if (editing && !original) {
      announce("This note no longer exists. Your draft is still in the editor.");
      return;
    }

    const note = editing
      ? { ...original, body, updatedAt: now }
      : { id: crypto.randomUUID(), documentId: doc.id, body, createdAt: now };

    savingDocuments.add(doc.id);
    updateEditorControls();
    try {
      await persistNote(doc, note);

      // Keep typing during a save attached to the same note for the next save.
      if (drafts.get(doc.id) === draft) {
        if (draft.body === body) drafts.delete(doc.id);
        else draft.editingId = note.id;
      }

      if (state.selectedId === doc.id) {
        const textarea = stageEl.querySelector("#note-body");
        const selection =
          document.activeElement === textarea
            ? [
                textarea.selectionStart,
                textarea.selectionEnd,
                textarea.selectionDirection,
              ]
            : null;
        const restoreFocus =
          selection || event.target.contains(document.activeElement);
        render();
        if (state.selectedId === doc.id && restoreFocus) {
          focusEditor();
          if (selection && drafts.get(doc.id) === draft) {
            stageEl.querySelector("#note-body")?.setSelectionRange(...selection);
          }
        }
      } else {
        renderDocumentList();
        refreshIcons();
      }
      const actionVerb = editing ? "updated" : "added";
      announce(
        db
          ? `Note ${actionVerb} in IndexedDB.`
          : "Note saved in memory only. It will be lost when this page is closed.",
      );
    } catch {
      announce("Could not save note. Your draft is still in the editor. Try saving again.");
    } finally {
      savingDocuments.delete(doc.id);
      updateEditorControls();
    }
  });

  // Interactive Markdown Checkboxes inside Saved Notes
  stageEl.addEventListener("change", async (event) => {
    const box = event.target.closest(
      'input[type="checkbox"][data-checkbox-index]',
    );
    if (!box) return;
    const card = box.closest("[data-note-card]");
    if (!card) return;

    const doc = selectedDocument();
    const note = doc?.notes.find((n) => n.id === card.dataset.noteCard);
    if (!note) return;
    if (savingDocuments.has(doc.id)) {
      box.checked = !box.checked;
      announce("Wait for this document's note to finish saving, then try again.");
      return;
    }

    const targetIdx = Number(box.dataset.checkboxIndex);
    let currentIdx = 0;
    const body = note.body.replace(
      /^(\s*[-*+]\s+\[)([ xX])(\])/gm,
      (full, pre, mark, post) => {
        if (currentIdx++ === targetIdx) {
          return `${pre}${box.checked ? "x" : " "}${post}`;
        }
        return full;
      },
    );
    savingDocuments.add(doc.id);
    updateEditorControls();
    try {
      await persistNote(doc, {
        ...note,
        body,
        updatedAt: new Date().toISOString(),
      });
      if (state.selectedId === doc.id) render();
      else {
        renderDocumentList();
        refreshIcons();
      }
      announce("Checklist item updated.");
    } catch {
      box.checked = !box.checked;
      announce("Could not save checklist change. Try checking the item again.");
    } finally {
      savingDocuments.delete(doc.id);
      updateEditorControls();
    }
  });

  // Global Search & Textarea Input
  document.addEventListener("input", (event) => {
    if (event.target.id === "note-body") {
      const draft = draftFor();
      if (draft) {
        draft.body = event.target.value;
        updateEditorControls();
      }
    }
  });

  function selectDocument(id) {
    if (state.selectedId === id) return;
    guardUnsavedDraft(() => {
      drafts.delete(state.selectedId);
      state.selectedId = id;
      render();
      document
        .querySelector(`[data-doc-id="${id}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  function discardDraft() {
    guardUnsavedDraft(() => {
      drafts.delete(state.selectedId);
      render();
      focusEditor();
      announce("Draft discarded.");
    });
  }

  function editNote(noteId) {
    guardUnsavedDraft(() => {
      const doc = selectedDocument();
      const note = doc?.notes.find((n) => n.id === noteId);
      if (!note) return;
      drafts.set(doc.id, {
        body: note.body,
        editingId: note.id,
        mode: "write",
      });
      render();
      focusEditor();
    });
  }

  function deleteNote(noteId) {
    const doc = selectedDocument();
    if (!doc) return;
    confirmAction(
      "Delete this note?",
      "This removes the entry from the timeline. Other notes in this document remain untouched.",
      "Delete note",
      async () => {
        if (db) await dbDelete(db, "notes", noteId);
        doc.notes = doc.notes.filter((n) => n.id !== noteId);
        if (draftFor(doc)?.editingId === noteId) {
          drafts.delete(doc.id);
        }
        render();
        focusEditor();
        announce("Note deleted from IndexedDB.");
      },
    );
  }

  async function copyNote(noteId) {
    const doc = selectedDocument();
    const note = doc?.notes.find((n) => n.id === noteId);
    if (!note) return;
    try {
      await navigator.clipboard.writeText(note.body);
      announce("Note Markdown copied to clipboard.");
    } catch {
      announce("Could not access clipboard.");
    }
  }

  const actionHandlers = {
    "cancel-rename": () => renameDialog.close(),
    discard: discardDraft,
    "edit-note": (btn) => editNote(btn.dataset.note),
    "delete-note": (btn) => deleteNote(btn.dataset.note),
    "copy-note": (btn) => copyNote(btn.dataset.note),
    "confirm-cancel": () => {
      pendingAction = undefined;
      confirmDialog.close();
    },
    "confirm-accept": () => {
      const cb = pendingAction;
      pendingAction = undefined;
      confirmDialog.close();
      cb?.();
    },
  };

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    if (button.dataset.docId) {
      selectDocument(button.dataset.docId);
      return;
    }
    if (button.dataset.editorMode) {
      const draft = draftFor();
      if (draft) {
        draft.mode = button.dataset.editorMode;
        render();
        stageEl.querySelector(`[data-editor-mode="${draft.mode}"]`)?.focus();
      }
      return;
    }
    if (button.dataset.format) {
      applyFormatting(button.dataset.format);
      return;
    }
    if (
      savingDocuments.has(state.selectedId) &&
      ["toggle-pin", "rename-doc", "delete-doc", "discard", "edit-note", "delete-note"]
        .includes(button.dataset.action)
    ) {
      announce("Wait for this document's note to finish saving, then try again.");
      return;
    }
    actionHandlers[button.dataset.action]?.(button);
  });

  // Keyboard Shortcuts: Escape for dialogs, Cmd/Ctrl+Enter to submit, Arrow keys for Write|Preview tabs
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (confirmDialog.open || renameDialog.open)) {
      event.preventDefault();
      pendingAction = undefined;
      confirmDialog.close();
      renameDialog.close();
      return;
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      event.target.id === "note-body"
    ) {
      event.preventDefault();
      const form = stageEl.querySelector(".note-editor");
      const submitBtn = form?.querySelector('[type="submit"]');
      if (submitBtn && !submitBtn.disabled) {
        form.requestSubmit();
      }
      return;
    }

    const tab = event.target.closest('[role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
      return;
    event.preventDefault();
    const tabs = [
      ...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]'),
    ];
    const current = tabs.indexOf(tab);
    let index =
      (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
      tabs.length;
    if (event.key === "Home") index = 0;
    if (event.key === "End") index = tabs.length - 1;
    tabs[index].click();
  });

  if (!globalThis.marked || !globalThis.DOMPurify || !globalThis.lucide) {
    const warning = document.querySelector("#dependency-status");
    warning.hidden = false;
    warning.textContent =
      "CDN preview libraries could not load (check internet connection). Your notes are still safely editable and stored in IndexedDB using plain-text fallback.";
  }

  render();
  focusEditor();
});
