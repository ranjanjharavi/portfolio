import { StorageClosedError } from "../folio/idb.js";
import { escapeText, toggleTask } from "./markdown.js";
import { loadStore } from "./store.js";
import { createDocumentRow, filterTimeline, noteLabel, renderStage, showEditorMode } from "./view.js";

const state = {
  selectedId: null,
  query: "",
  sort: "updated",
};

// Drafts are in memory only and are discarded on reload.
const drafts = new Map();
const savingDocuments = new Set();
const searchText = new WeakMap();
let searchTimer;
let pendingAction;

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const docListEl = ui["doc-list"];
const stageEl = ui["doc-stage"];
const confirmDialog = ui["confirm-dialog"];
const renameDialog = ui["rename-dialog"];

const store = await loadStore({
  onUnavailable(error) {
    ui["db-status-text"].textContent = "Memory Fallback";
    announce(`Local storage is unavailable. Changes will only last until you close this page. ${error.message}`);
  },
  onClose(error) {
    ui["db-status-text"].textContent = "Reload to reconnect";
    announce(error.message);
  },
});
state.selectedId = sortedDocuments()[0]?.id ?? null;

function announce(message) {
  ui["status"].textContent = message;
}

function failureMessage(error, fallback) {
  return error instanceof StorageClosedError ? error.message : fallback;
}

function selectedDocument() {
  return store.getDocument(state.selectedId) || null;
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

/* Global Search & Sorting */
function sortedDocuments() {
  return [...store.documents].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
      return a.pinned ? -1 : 1;
    }
    if (state.sort === "title") return a.title.localeCompare(b.title);
    if (state.sort === "created") return b.createdAt.localeCompare(a.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function titleMatches(doc, query) {
  return doc.title.toLocaleLowerCase().includes(query);
}

function noteMatches(note, query) {
  if (!searchText.has(note)) searchText.set(note, note.body.toLocaleLowerCase());
  return searchText.get(note).includes(query);
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
  submitBtn.disabled = saving || !draft.body.trim() || (Boolean(draft.editingId) && !hasChanges(doc));
  discardBtn.disabled = !draft.body && !draft.editingId;

  const unsavedLabel = hasChanges(doc) ? " • Unsaved draft · " : " · ";
  const draftCount = draft.body ? `${draft.body.length} chars${unsavedLabel}` : "";

  metaEl.textContent = saving ? "Saving note…" : draftCount;
}

function renderDocumentList() {
  const { documents } = store;
  const totalNotes = documents.reduce((acc, d) => acc + d.notes.length, 0);
  ui["doc-total"].textContent = `${documents.length} docs · ${totalNotes} notes`;

  const query = state.query.trim().toLocaleLowerCase();
  const rows = [];
  for (const doc of sortedDocuments()) {
    const matchCount = query ? doc.notes.filter((note) => noteMatches(note, query)).length : 0;
    if (query && !matchCount && !titleMatches(doc, query)) continue;
    rows.push(createDocumentRow(doc, { active: doc.id === state.selectedId, hasDraft: hasChanges(doc), matchCount }));
  }
  docListEl.replaceChildren(...rows);
  if (!rows.length) {
    docListEl.innerHTML = `<li class="no-matches">No documents match "${escapeText(state.query)}".</li>`;
  }
}

function updateTimeline(doc = selectedDocument()) {
  if (!doc) return;
  const query = state.query.trim().toLocaleLowerCase();
  const matchingIds = query
    ? new Set(doc.notes.filter((note) => noteMatches(note, query)).map((note) => note.id))
    : null;
  // A title-only match shows the document's entire timeline.
  const visibleIds = matchingIds?.size === 0 && titleMatches(doc, query) ? null : matchingIds;
  filterTimeline(stageEl, visibleIds, Boolean(query));
}

function render() {
  renderDocumentList();
  const activeDoc = selectedDocument();
  if (!activeDoc) {
    stageEl.innerHTML = `<div class="no-matches">Select or create a document on the left to start jotting notes.</div>`;
    return;
  }

  renderStage(stageEl, activeDoc, draftFor(activeDoc));
  updateTimeline(activeDoc);
  updateEditorControls();
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
  ui["confirm-title"].textContent = title;
  ui["confirm-copy"].textContent = copy;
  ui["confirm-accept"].textContent = acceptLabel;
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
    code: isMultilineCode ? ["```\n", "\n```", "code block"] : ["`", "`", "code"],
    link: ["[", "](https://example.com)", "link text"],
    list: ["- ", "", "list item"],
    checklist: ["- [ ] ", "", "task item"],
    quote: ["> ", "", "quote"],
  };

  const [prefix, suffix, placeholder] = formats[name];
  const needsNewline = ["list", "checklist", "quote"].includes(name) && start > 0 && textarea.value[start - 1] !== "\n";
  const linePrefix = needsNewline ? "\n" : "";

  const replacement = linePrefix + prefix + (selection || placeholder) + suffix;
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
ui["new-doc-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = ui["new-doc-title"];
  const title = input.value.trim();
  if (!title) return;

  try {
    const doc = await store.createDocument(title);
    state.selectedId = doc.id;
  } catch (error) {
    announce(failureMessage(error, "Could not create the document. Try again."));
    return;
  }
  if (input.value.trim() === title) input.value = "";
  render();
  focusEditor();
  announce(`Created document "${title}".`);
});

// Submit Note (Add or Update)
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
    await store.saveNote(doc.id, note, editing);

    // Keep typing during a save attached to the same note for the next save.
    if (drafts.get(doc.id) === draft) {
      if (draft.body === body) drafts.delete(doc.id);
      else draft.editingId = note.id;
    }

    if (state.selectedId === doc.id) {
      const textarea = stageEl.querySelector("#note-body");
      const selection =
        document.activeElement === textarea
          ? [textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection]
          : null;
      const restoreFocus = selection || event.target.contains(document.activeElement);
      render();
      if (state.selectedId === doc.id && restoreFocus) {
        focusEditor();
        if (selection && drafts.get(doc.id) === draft) {
          stageEl.querySelector("#note-body")?.setSelectionRange(...selection);
        }
      }
    } else {
      renderDocumentList();
    }
    const actionVerb = editing ? "updated" : "added";
    announce(
      store.memoryOnly
        ? "Note saved in memory only. It will be lost when this page is closed."
        : `Note ${actionVerb} in IndexedDB.`,
    );
  } catch (error) {
    announce(failureMessage(error, "Could not save note. Your draft is still in the editor. Try saving again."));
  } finally {
    savingDocuments.delete(doc.id);
    updateEditorControls();
  }
});

// Interactive Markdown Checkboxes inside Saved Notes
stageEl.addEventListener("change", async (event) => {
  const box = event.target.closest('input[type="checkbox"][data-checkbox-index]');
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

  const body = toggleTask(note.body, Number(box.dataset.checkboxIndex), box.checked);
  if (body === null) {
    box.checked = !box.checked;
    announce("Could not locate this checklist item in the note.");
    return;
  }
  savingDocuments.add(doc.id);
  updateEditorControls();
  try {
    await store.saveNote(
      doc.id,
      {
        ...note,
        body,
        updatedAt: new Date().toISOString(),
      },
      true,
    );
    if (state.selectedId === doc.id) render();
    else {
      renderDocumentList();
    }
    announce("Checklist item updated.");
  } catch (error) {
    box.checked = !box.checked;
    announce(failureMessage(error, "Could not save checklist change. Try checking the item again."));
  } finally {
    savingDocuments.delete(doc.id);
    updateEditorControls();
  }
});

// Global Search & Textarea Input
document.addEventListener("input", (event) => {
  if (event.target.id === "global-search") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = event.target.value;
      // Keep the current document open while the user searches the library.
      renderDocumentList();
      updateTimeline();
    }, 120);
  }
  if (event.target.id === "note-body") {
    const draft = draftFor();
    if (draft) {
      draft.body = event.target.value;
      updateEditorControls();
    }
  }
});

// Sort Selector
ui["doc-sort"].addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderDocumentList();
});

// Rename Document Form
ui["rename-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const doc = selectedDocument();
  if (!doc) return;
  const input = ui["rename-input"];
  const newTitle = input.value.trim();
  if (!newTitle) return;

  try {
    await store.renameDocument(doc.id, newTitle);
  } catch (error) {
    const message = failureMessage(error, "Could not rename the document. Try again.");
    ui["rename-error"].textContent = message;
    announce(message);
    return;
  }

  renameDialog.close();
  render();
  announce(`Renamed document to "${newTitle}".`);
});

function selectDocument(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  render();
  document.querySelector(`[data-doc-id="${id}"]`)?.focus({ preventScroll: true });
}

async function togglePin() {
  const doc = selectedDocument();
  if (!doc) return;
  try {
    await store.togglePin(doc.id);
  } catch (error) {
    announce(failureMessage(error, "Could not update the document pin. Try again."));
    return;
  }
  render();
  stageEl.querySelector('[data-action="toggle-pin"]')?.focus();
  announce(doc.pinned ? `"${doc.title}" pinned to top.` : `"${doc.title}" unpinned.`);
}

function openRenameDialog() {
  const doc = selectedDocument();
  if (!doc) return;
  const input = ui["rename-input"];
  input.value = doc.title;
  ui["rename-error"].textContent = "";
  renameDialog.showModal();
  input.focus();
  input.select();
}

function deleteDocument() {
  const doc = selectedDocument();
  if (!doc) return;
  confirmAction(
    "Delete document?",
    `This permanently deletes "${doc.title}" and its ${noteLabel(doc.notes.length)} from IndexedDB.`,
    "Delete document",
    async () => {
      let seedFailed;
      try {
        ({ seedFailed } = await store.deleteDocument(doc.id));
      } catch (error) {
        announce(failureMessage(error, "Could not delete the document. It is still in your library."));
        return;
      }
      drafts.delete(doc.id);
      const message = `Deleted "${doc.title}".`;
      state.selectedId = sortedDocuments()[0]?.id ?? null;
      render();
      announce(seedFailed ? `${message} Could not save Quick Scratch. It is available in memory for now.` : message);
    },
  );
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
      try {
        await store.deleteNote(doc.id, noteId);
      } catch (error) {
        announce(failureMessage(error, "Could not delete the note. Try again."));
        return;
      }
      if (draftFor(doc)?.editingId === noteId) {
        drafts.delete(doc.id);
      }
      render();
      focusEditor();
      announce(store.memoryOnly ? "Note deleted." : "Note deleted from IndexedDB.");
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
  "toggle-pin": togglePin,
  "rename-doc": openRenameDialog,
  "delete-doc": deleteDocument,
  "cancel-rename": () => renameDialog.close(),
  discard: discardDraft,
  "edit-note": (btn) => editNote(btn.dataset.note),
  "delete-note": (btn) => deleteNote(btn.dataset.note),
  "copy-note": (btn) => copyNote(btn.dataset.note),
  "confirm-cancel": () => confirmDialog.close(),
  "confirm-accept": async () => {
    const cb = pendingAction;
    pendingAction = undefined;
    confirmDialog.close();
    try {
      await cb?.();
    } catch (error) {
      announce(failureMessage(error, "Could not complete the action. Try again."));
    }
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
      showEditorMode(stageEl, draft);
      button.focus();
    }
    return;
  }
  if (button.dataset.format) {
    applyFormatting(button.dataset.format);
    return;
  }
  if (
    savingDocuments.has(state.selectedId) &&
    ["toggle-pin", "rename-doc", "delete-doc", "discard", "edit-note", "delete-note"].includes(button.dataset.action)
  ) {
    announce("Wait for this document's note to finish saving, then try again.");
    return;
  }
  actionHandlers[button.dataset.action]?.(button);
});

confirmDialog.addEventListener("close", () => {
  // `close` fires asynchronously; the callback may already have reopened the dialog with a new action.
  if (!confirmDialog.open) pendingAction = undefined;
});

window.addEventListener("beforeunload", (event) => {
  const unsavedDraft = store.documents.some((doc) => hasChanges(doc));
  const unsavedNotes = store.memoryOnly && store.documents.some((doc) => doc.notes.length);
  if (!unsavedDraft && !unsavedNotes && !savingDocuments.size) return;
  event.preventDefault();
  event.returnValue = "";
});

// Keyboard shortcuts for saving and navigating editor tabs.
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.id === "note-body") {
    event.preventDefault();
    const form = stageEl.querySelector(".note-editor");
    const submitBtn = form?.querySelector('[type="submit"]');
    if (submitBtn && !submitBtn.disabled) {
      form.requestSubmit();
    }
    return;
  }

  const tab = event.target.closest('[role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(tab);
  let index = (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  if (event.key === "Home") index = 0;
  if (event.key === "End") index = tabs.length - 1;
  tabs[index].click();
});

if (!globalThis.marked || !globalThis.DOMPurify) {
  const warning = ui["dependency-status"];
  warning.hidden = false;
  warning.textContent =
    "CDN preview libraries could not load (check internet connection). Your notes are still safely editable and stored in IndexedDB using plain-text fallback.";
}

render();
focusEditor();
