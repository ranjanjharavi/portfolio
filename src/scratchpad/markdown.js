const MARKDOWN_ALLOW_LIST = {
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
};

export function escapeText(value) {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

const markdown = globalThis.marked;
markdown?.use({ renderer: { html: ({ text }) => escapeText(text) } });

// Notes are replaced, not mutated, on save. Cache per snapshot so old versions
// (and deleted notes) can be collected without explicit invalidation.
const noteCache = new WeakMap();

function cachedNote(note) {
  let entry = noteCache.get(note);
  if (!entry) {
    entry = {};
    noteCache.set(note, entry);
  }
  return entry;
}

function sanitizeMarkdown(body) {
  if (!markdown || !globalThis.DOMPurify) return null;
  const rawHtml = markdown.parse(body, { async: false, gfm: true, breaks: true });
  return globalThis.DOMPurify.sanitize(rawHtml, MARKDOWN_ALLOW_LIST);
}

function taskStates(body) {
  const states = [];
  markdown.walkTokens(markdown.lexer(body, { gfm: true }), (token) => {
    if (token.type === "list_item" && token.task) states.push(token.checked);
  });
  return states;
}

export function toggleTask(body, index, checked) {
  if (!markdown || !Number.isInteger(index) || index < 0) return null;
  const states = taskStates(body);
  if (index >= states.length) return null;
  if (states[index] === checked) return body;

  // Marked does not expose source offsets, and normalizes nested lists and quotes.
  // Use its lexer to locate the task: mark candidates before each midpoint checked
  // and the rest unchecked. Candidates in code, HTML, or prose won't affect the task's state.
  const marker = /(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/g;
  const offsets = [...body.matchAll(marker)].map((match) => match.index + match[0].length - 2);
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    let candidate = 0;
    const probe = body.replace(marker, (match) => `${match.slice(0, -2)}${candidate++ <= mid ? "x" : " "}]`);
    const probeStates = taskStates(probe);
    if (probeStates.length !== states.length) return null;
    if (probeStates[index]) high = mid;
    else low = mid + 1;
  }
  if (low === offsets.length) return null;
  const offset = offsets[low];
  const updated = `${body.slice(0, offset)}${checked ? "x" : " "}${body.slice(offset + 1)}`;
  states[index] = checked;
  const result = taskStates(updated);
  return result.length === states.length && result.every((state, i) => state === states[i]) ? updated : null;
}

function renderHtml(target, body, html) {
  target.classList.toggle("plain-fallback", html === null);
  if (html !== null) {
    target.innerHTML = html;
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
  }
}

export function renderMarkdown(target, body) {
  renderHtml(target, body, sanitizeMarkdown(body));
}

function noteHtml(note, entry) {
  if (!("html" in entry)) entry.html = sanitizeMarkdown(note.body);
  return entry.html;
}

export function renderNoteMarkdown(target, note) {
  renderHtml(target, note.body, noteHtml(note, cachedNote(note)));
}

export function noteExcerpt(note) {
  const entry = cachedNote(note);
  if (!entry.excerpt) {
    const firstLine = note.body.trimStart().split("\n", 1)[0].trim();
    const html = firstLine === note.body ? noteHtml(note, entry) : sanitizeMarkdown(firstLine);
    const preview = document.createElement("div");
    if (html === null) preview.textContent = firstLine;
    else preview.innerHTML = html;
    entry.excerpt = preview.textContent.trim() || "Untitled note";
  }
  return entry.excerpt;
}
