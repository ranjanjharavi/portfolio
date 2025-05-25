import { escapeText, noteExcerpt, renderMarkdown, renderNoteMarkdown } from "./markdown.js";

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="../shared/icons.svg#${name}" /></svg>`;
}

export function noteLabel(count) {
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

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

/* Render Left Rail Document Item */
export function createDocumentRow(doc, { active, hasDraft, matchCount }) {
  const row = document.createElement("li");
  row.className = "doc-row";
  const newest = doc.notes.reduce(
    (latest, note) => (!latest || note.createdAt > latest.createdAt ? note : latest),
    null,
  );

  const draftBadge = hasDraft ? "Draft • " : "";
  const snippet = newest
    ? `<span class="doc-row-snippet">${escapeText(noteExcerpt(newest))}</span>`
    : `<span class="doc-row-snippet">No notes yet</span>`;

  const updatedDate = shortDateFormat.format(new Date(doc.updatedAt));
  const pinHtml = doc.pinned ? `<span class="pin-badge">${icon("pin")}Pinned</span>` : `<span>${updatedDate}</span>`;

  const matchVerb = matchCount === 1 ? "match" : "matches";
  const matchBadge = matchCount > 0 ? `<span class="match-badge">${matchCount} ${matchVerb}</span>` : "";

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
export function renderStage(stageEl, doc, draft) {
  const createdFormatted = shortDateFormat.format(new Date(doc.createdAt));

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
              aria-controls="write-panel"
          >Write</button>
          <button
              id="preview-tab"
              type="button"
              role="tab"
              data-editor-mode="preview"
              aria-controls="preview-panel"
          >Preview</button>
          </div>
          <span class="editor-kind ${draft.editingId ? "is-editing" : ""}">
          ${draft.editingId ? "Editing note" : "New entry"} / Markdown
          </span>
      </div>

      <div id="write-panel" role="tabpanel" aria-labelledby="write-tab">
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
          <span class="stream-count"></span>
      </h3>
      </div>

      <ol class="note-history" aria-label="Note history, newest first"></ol>
      <div class="empty-notes" hidden></div>
  </div>
  `;

  stageEl.querySelector("#note-body").value = draft.body;
  showEditorMode(stageEl, draft);

  const notes = [...doc.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  stageEl.querySelector(".note-history").replaceChildren(...notes.map((note) => createNoteCard(note, draft.editingId)));
}

export function showEditorMode(stageEl, { mode, body }) {
  const preview = stageEl.querySelector("#preview-panel");
  const showPreview = mode === "preview";
  stageEl.querySelector("#write-panel").hidden = showPreview;
  preview.hidden = !showPreview;
  for (const tab of stageEl.querySelectorAll("[data-editor-mode]")) {
    const active = tab.dataset.editorMode === mode;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  if (showPreview) renderMarkdown(preview, body);
}

function createNoteCard(note, editingId) {
  const item = document.createElement("li");
  item.className = "note-entry";
  item.dataset.noteId = note.id;
  const isEditingThis = editingId === note.id;
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
  renderNoteMarkdown(item.querySelector(".markdown"), note);
  return item;
}

export function filterTimeline(stageEl, visibleIds, searching) {
  const cards = stageEl.querySelector(".note-history").children;
  const count = visibleIds?.size ?? cards.length;
  for (const card of cards) {
    const hidden = Boolean(visibleIds && !visibleIds.has(card.dataset.noteId));
    if (card.hidden !== hidden) card.hidden = hidden;
  }
  stageEl.querySelector(".stream-count").textContent = count === cards.length ? count : `${count} of ${cards.length}`;
  const empty = stageEl.querySelector(".empty-notes");
  empty.hidden = count > 0;
  if (empty.hidden) return;
  empty.innerHTML = searching
    ? `<p>No matching notes in this document.</p><span>Clear the search bar to see all entries.</span>`
    : `<p>This document has no notes yet.</p><span>Write a Markdown note above and press Add note (or Ctrl/⌘ + Enter).</span>`;
}
