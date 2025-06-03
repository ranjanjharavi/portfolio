import { openDatabase, transact } from "../folio/idb.js";

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.esm.min.mjs";
const DB_NAME = "folio_mermaid_db";
const DB_VERSION = 2;
const PROFILE_KEY = "folio_mermaid_profile";
const DEFAULT_PROFILE_NAME = "My diagrams";

const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
};

const DIAGRAM_CONFIG_KEYS = {
  classDiagram: "class",
  "flowchart-elk": "flowchart",
  "flowchart-v2": "flowchart",
  railroadAbnf: "railroad",
  railroadEbnf: "railroad",
  stateDiagram: "state",
  xychart: "xyChart",
};

const PREVIEW_ACTIONS = ["download-toggle", "download-svg", "download-png", "open-preview", "fullscreen-preview"];

const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

const diagrams = new Map();
const profiles = new Map();
const dirty = new Set();
let db;
let storageError;
let activeId;
let activeProfileId;
let saveTimer;
let saveQueue = Promise.resolve();
let renderTimer;
let renderVersion = 0;
let renderSequence = 0;
let rendering = false;
let engine;
let enginePromise;
let loadAttempt = 0;
let lastSvg = "";
let pngPending = false;
let lightPreview = true;
let diagramSize;
let zoom = 1;
let fitMode = true;

function sourceText(source) {
  const text = source.trim();
  const fenced = text.match(/^(`{3,}|~{3,})mermaid[^\S\n]*\r?\n([\s\S]*?)\r?\n\1$/i);

  return fenced ? fenced[2].trim() : text;
}

function currentDiagram() {
  return diagrams.get(activeId);
}

function byRecent(a, b) {
  return b.updatedAt - a.updatedAt;
}

function profileDiagrams(profileId = activeProfileId) {
  return [...diagrams.values()].filter((diagram) => diagram.profileId === profileId).sort(byRecent);
}

function oldestProfile() {
  return [...profiles.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
}

function createProfileRecord(name) {
  return { id: crypto.randomUUID(), name, createdAt: Date.now() };
}

function storedProfileId() {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function announce(message) {
  ui.status.textContent = message;
}

function previewFeedback(message) {
  ui["preview-feedback"].textContent = message;
  ui["preview-feedback"].hidden = !message;
}

function updatePreviewActions(ready) {
  if (!ready) setDownloadFormatsOpen(false);
  for (const id of PREVIEW_ACTIONS) ui[id].disabled = !ready;
  if (pngPending) ui["download-png"].disabled = true;
  if (ui["fullscreen-dialog"].open) ui["fullscreen-preview"].disabled = false;
}

function setDownloadFormatsOpen(open) {
  ui["download-formats"].hidden = !open;
  ui["download-toggle"].setAttribute("aria-expanded", String(open));
}

function closeDownloadFormats() {
  setDownloadFormatsOpen(false);
  ui["download-toggle"].focus({ preventScroll: true });
}

function prefersDarkDiagram() {
  return document.documentElement.dataset.theme === "dark";
}

function darkTheme(mermaid, source) {
  const type = mermaid.detectType(source);
  const defaults = mermaid.mermaidAPI.defaultConfig;
  const theme = defaults[DIAGRAM_CONFIG_KEYS[type] ?? type]?.theme ?? defaults.theme;
  if (theme === "redux-color") return "redux-dark-color";
  if (theme === "redux") return "redux-dark";
  return "dark";
}

function showStorageError(error) {
  ui["storage-error"].textContent =
    `Changes could not be saved in this browser. Download your source before leaving. ${(storageError ?? error).message || ""}`;
  ui["storage-error"].hidden = false;
}

function updateSaveStatus() {
  const unsaved = dirty.has(activeId);
  ui["save-status"].textContent = storageError
    ? "Reload to reconnect"
    : unsaved
      ? db
        ? "Unsaved changes"
        : "Temporary session"
      : "Saved locally";
  ui["save-status"].dataset.state = unsaved ? "unsaved" : "saved";
}

function saveRecord(record) {
  if (!record || !db || !dirty.has(record.id)) return saveQueue;
  ui["save-status"].textContent = "Saving…";
  // Serialize snapshots so a slower old write cannot overwrite a newer edit.
  saveQueue = saveQueue.then(async () => {
    if (!db) return updateSaveStatus();
    try {
      await transact(db, "diagrams", "readwrite", (tx) => tx.objectStore("diagrams").put(record));
      if (diagrams.get(record.id) === record) dirty.delete(record.id);
      if (!dirty.size && !storageError) ui["storage-error"].hidden = true;
    } catch (error) {
      showStorageError(error);
    }
    updateSaveStatus();
  });
  return saveQueue;
}

function flushSave() {
  clearTimeout(saveTimer);
  return saveRecord(currentDiagram());
}

function updateLibrary() {
  const options = profileDiagrams().map((diagram) => new Option(diagram.title || "Untitled diagram", diagram.id));
  ui["diagram-list"].replaceChildren(...options);
  ui["diagram-list"].value = activeId;
}

function editDiagram() {
  if (storageError) return;
  const record = {
    ...currentDiagram(),
    title: ui["diagram-title"].value,
    source: ui.source.value,
    updatedAt: Date.now(),
  };
  diagrams.set(activeId, record);
  dirty.add(activeId);
  updateLibrary();
  updateSaveStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveRecord(record), 450);
}

function selectDiagram(id) {
  activeId = id;
  fitMode = true;
  const record = currentDiagram();
  ui["diagram-title"].value = record.title;
  ui.source.value = record.source;
  ui["diagram-list"].value = id;
  lastSvg = "";
  diagramSize = null;
  ui["diagram-canvas"].replaceChildren();
  ui["diagram-canvas"].hidden = true;
  ui["preview-empty"].hidden = false;
  ui["syntax-error"].hidden = true;
  setZoomEnabled(false);
  updateSaveStatus();
  updateSourceCount();
  requestRender(0);
}

function createDiagram() {
  flushSave();
  const record = {
    id: crypto.randomUUID(),
    title: "Untitled diagram",
    source: "",
    updatedAt: Date.now(),
    profileId: activeProfileId,
  };
  diagrams.set(record.id, record);
  if (!storageError) dirty.add(record.id);
  selectDiagram(record.id);
  updateLibrary();
  saveRecord(record);
}

function openLatestDiagram() {
  const [latest] = profileDiagrams();
  if (!latest) return createDiagram();
  selectDiagram(latest.id);
  updateLibrary();
}

function updateSourceCount() {
  const source = ui.source.value;
  const lines = source ? source.split("\n").length : 0;
  ui["source-count"].textContent =
    `${lines} ${lines === 1 ? "line" : "lines"} · ${source.length.toLocaleString()} characters`;
}

async function loadMermaid() {
  if (!enginePromise) {
    const url = loadAttempt ? `${MERMAID_URL}?retry=${loadAttempt}` : MERMAID_URL;
    loadAttempt += 1;
    enginePromise = (async () => {
      let timeout;
      try {
        const [module] = await Promise.race([
          Promise.all([import(url), document.fonts?.load('14px "Recursive Variable"').catch(() => [])]),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Mermaid took too long to load.")), 20000);
          }),
        ]);
        engine = module.default;
        engine.initialize(MERMAID_CONFIG);
        ui["dependency-error"].hidden = true;
        return engine;
      } finally {
        clearTimeout(timeout);
      }
    })();
  }
  return enginePromise;
}

function requestRender(delay = 300) {
  renderVersion += 1;
  clearTimeout(renderTimer);
  updatePreviewActions(false);
  previewFeedback("");
  ui["syntax-error"].hidden = true;
  ui["preview-status"].textContent = sourceText(ui.source.value) ? "Updating preview…" : "Waiting for code";
  renderTimer = setTimeout(renderLatest, delay);
}

// One render at a time; discard results if the source or selected diagram changed.
async function renderLatest() {
  if (rendering) return;
  rendering = true;
  ui["preview-viewport"].setAttribute("aria-busy", "true");
  let completedVersion;
  try {
    do {
      const version = renderVersion;
      const source = sourceText(ui.source.value);
      completedVersion = version;
      if (!source) {
        lastSvg = "";
        diagramSize = null;
        ui["diagram-canvas"].replaceChildren();
        ui["diagram-canvas"].hidden = true;
        ui["preview-empty"].hidden = false;
        ui["preview-viewport"].dataset.scheme = prefersDarkDiagram() ? "dark" : "light";
        ui["preview-status"].textContent = "Waiting for code";
        setZoomEnabled(false);
        continue;
      }
      try {
        const mermaid = await loadMermaid();
        if (version !== renderVersion) continue;
        const theme = prefersDarkDiagram() ? darkTheme(mermaid, source) : undefined;
        mermaid.initialize(theme ? { ...MERMAID_CONFIG, theme } : MERMAID_CONFIG);
        const result = await mermaid.render(`folio-diagram-${++renderSequence}`, source, ui["render-sandbox"]);
        if (version !== renderVersion) continue;
        lastSvg = result.svg;
        ui["diagram-canvas"].innerHTML = result.svg;
        const svg = ui["diagram-canvas"].querySelector("svg");
        const box = svg.viewBox.baseVal;
        diagramSize = {
          width: box.width || svg.width.baseVal.value,
          height: box.height || svg.height.baseVal.value,
        };
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", currentDiagram().title || "Mermaid diagram");
        ui["diagram-canvas"].hidden = false;
        ui["preview-empty"].hidden = true;
        ui["syntax-error"].hidden = true;
        const renderedTheme = mermaid.mermaidAPI?.getConfig().theme ?? theme;
        lightPreview = !renderedTheme?.includes("dark");
        ui["preview-viewport"].dataset.scheme = lightPreview ? "light" : "dark";
        updatePreviewActions(true);
        ui["preview-status"].textContent = "Up to date";
        setZoomEnabled(true);
        if (fitMode) fitDiagram();
        else applyZoom();
      } catch (error) {
        if (version !== renderVersion) continue;
        ui["preview-status"].textContent = lastSvg ? "Last valid preview" : "Preview unavailable";
        if (!engine) {
          ui["dependency-error"].hidden = false;
        } else {
          ui["syntax-message"].textContent = String(error.message || error).slice(0, 2000);
          ui["preview-retained"].hidden = !lastSvg;
          ui["syntax-error"].hidden = false;
        }
      } finally {
        ui["render-sandbox"].replaceChildren();
      }
    } while (completedVersion !== renderVersion);
  } finally {
    rendering = false;
    ui["preview-viewport"].setAttribute("aria-busy", "false");
  }
}

function setZoomEnabled(enabled) {
  for (const id of ["zoom-in", "zoom-out", "zoom-fit"]) ui[id].disabled = !enabled;
}

function applyZoom() {
  if (!diagramSize) return;
  const svg = ui["diagram-canvas"].querySelector("svg");
  svg.style.width = `${diagramSize.width * zoom}px`;
  svg.style.height = `${diagramSize.height * zoom}px`;
  ui["zoom-level"].value = `${Math.round(zoom * 100)}%`;
  ui["zoom-out"].disabled = zoom <= 0.1;
  ui["zoom-in"].disabled = zoom >= 4;
}

function fitDiagram() {
  if (!fitMode || !diagramSize) return;
  const viewport = ui["preview-viewport"];
  const style = getComputedStyle(viewport);
  const width = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  zoom = Math.max(0.01, Math.min(1, width / diagramSize.width, height / diagramSize.height));
  applyZoom();
}

function changeZoom(factor) {
  fitMode = false;
  zoom = Math.max(0.1, Math.min(4, zoom * factor));
  applyZoom();
}

function download(blob, extension, diagramTitle = currentDiagram().title) {
  const title =
    (diagramTitle || "diagram")
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .slice(0, 90) || "diagram";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title}.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const message = `Downloaded ${title}.${extension}`;
  if (ui["fullscreen-dialog"].open) previewFeedback(message);
  else announce(message);
}

function diagramImage() {
  const svg = ui["diagram-canvas"].querySelector("svg").cloneNode(true);
  const { width, height } = diagramSize;
  svg.style.removeProperty("width");
  svg.style.removeProperty("height");
  svg.style.removeProperty("max-width");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const markup = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

async function downloadPng() {
  const { width, height } = diagramSize;
  const { title } = currentDiagram();
  const background = lightPreview ? "#fff" : "#181818";
  pngPending = true;
  ui["download-png"].disabled = true;
  previewFeedback("Preparing PNG…");
  try {
    const image = new Image();
    image.src = diagramImage();
    await image.decode();
    // Cap the longest side so large diagrams fit browser canvas limits.
    const scale = Math.min(2, 4096 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG encoding failed.");
    previewFeedback("");
    download(blob, "png", title);
  } catch {
    previewFeedback("Couldn’t export this diagram as PNG. You can still download its SVG.");
  } finally {
    pngPending = false;
    ui["download-png"].disabled = ui["download-svg"].disabled;
  }
}

function openPreview() {
  const link = document.createElement("a");
  const background = lightPreview ? "#fff" : "#181818";
  const image = diagramImage().replaceAll('"', "%22");
  const page = `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
    <title>Diagram preview</title>
    <style>
    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: ${background}; }
      img { display: block; max-width: calc(100% - 32px); max-height: calc(100dvh - 32px); object-fit: contain; }
    </style>
    <img src="${image}" alt="Mermaid diagram"></html>`;
  link.href = URL.createObjectURL(new Blob([page], { type: "text/html" }));
  link.target = "_blank";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  const url = link.href;
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const fullscreenDialog = ui["fullscreen-dialog"];
const fullscreenButton = ui["fullscreen-preview"];
const workspace = ui.workspace;

fullscreenButton.addEventListener("click", () => {
  if (fullscreenDialog.open) {
    fullscreenDialog.close();
    return;
  }
  fullscreenDialog.append(ui["preview-panel"]);
  fullscreenButton.textContent = "Back to editor";
  fullscreenDialog.showModal();
  fullscreenButton.focus();
  fitMode = true;
  fitDiagram();
});
fullscreenDialog.addEventListener("close", () => {
  workspace.append(ui["preview-panel"]);
  fullscreenButton.textContent = "Expand preview";
  fullscreenButton.disabled = ui["download-svg"].disabled;
  fullscreenButton.focus();
  fitMode = true;
  fitDiagram();
});

function bindEditorResize(id, isWidth) {
  const handle = ui[id];
  const min = Number(handle.getAttribute("aria-valuemin"));
  const max = Number(handle.getAttribute("aria-valuemax"));
  const unit = isWidth ? "%" : "px";
  const step = isWidth ? 2 : 20;
  const position = (event) => (isWidth ? event.clientX : event.clientY);
  let drag;

  function currentSize() {
    const size = isWidth ? (ui["editor-panel"].offsetWidth * 100) / workspace.clientWidth : ui.source.offsetHeight;
    return Math.max(min, Math.min(max, Math.round(size)));
  }

  function describeSize(size) {
    handle.setAttribute("aria-valuenow", size);
    handle.setAttribute("aria-valuetext", isWidth ? `${size}%` : `${size} pixels`);
  }

  function resize(size) {
    const value = Math.max(min, Math.min(max, Math.round(size)));
    workspace.style.setProperty(`--${id}`, `${value}${unit}`);
    describeSize(value);
  }

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, start: position(event), size: currentSize() };
    handle.dataset.dragging = "";
  });
  function resizeFromDrag(event) {
    if (drag?.id !== event.pointerId) return;
    const delta = position(event) - drag.start;
    resize(drag.size + (isWidth ? (delta * 100) / workspace.clientWidth : delta));
  }
  handle.addEventListener("pointermove", resizeFromDrag);
  handle.addEventListener("pointerup", resizeFromDrag);
  handle.addEventListener("lostpointercapture", () => {
    drag = null;
    delete handle.dataset.dragging;
  });

  handle.addEventListener("focus", () => describeSize(currentSize()));
  handle.addEventListener("keydown", (event) => {
    const sizes = {
      Home: min,
      End: max,
      [isWidth ? "ArrowLeft" : "ArrowUp"]: currentSize() - step,
      [isWidth ? "ArrowRight" : "ArrowDown"]: currentSize() + step,
    };
    if (!Object.hasOwn(sizes, event.key)) return;
    event.preventDefault();
    resize(sizes[event.key]);
  });
}

bindEditorResize("editor-width", true);
bindEditorResize("editor-height", false);

new MutationObserver(() => requestRender(0)).observe(document.documentElement, {
  attributeFilter: ["data-theme"],
});

ui.source.addEventListener("input", () => {
  editDiagram();
  updateSourceCount();
  requestRender();
});
ui.source.addEventListener("blur", flushSave);
ui["diagram-title"].addEventListener("input", editDiagram);
ui["diagram-title"].addEventListener("blur", flushSave);
ui["diagram-list"].addEventListener("change", () => {
  flushSave();
  selectDiagram(ui["diagram-list"].value);
});
ui["new-diagram"].addEventListener("click", () => {
  createDiagram();
  ui.source.focus();
});
ui["retry-load"].addEventListener("click", () => {
  enginePromise = null;
  ui["dependency-error"].hidden = true;
  requestRender(0);
});
ui["delete-diagram"].addEventListener("click", () => ui["delete-dialog"].showModal());
ui["delete-dialog"].querySelector("form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "delete") return;
  event.preventDefault();
  const id = activeId;
  const buttons = ui["delete-dialog"].querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  clearTimeout(saveTimer);
  await saveQueue;
  try {
    if (storageError) throw storageError;
    if (db) await transact(db, "diagrams", "readwrite", (tx) => tx.objectStore("diagrams").delete(id));
    diagrams.delete(id);
    dirty.delete(id);
    ui["delete-dialog"].close();
    openLatestDiagram();
    announce("Diagram deleted.");
  } catch (error) {
    showStorageError(error);
    ui["delete-dialog"].close();
    announce(storageError?.message ?? "The diagram could not be deleted. Your source is still available.");
  } finally {
    for (const button of buttons) button.disabled = false;
  }
});
ui["zoom-in"].addEventListener("click", () => changeZoom(1.25));
ui["zoom-out"].addEventListener("click", () => changeZoom(0.8));
ui["zoom-fit"].addEventListener("click", () => {
  fitMode = true;
  fitDiagram();
});
new ResizeObserver(fitDiagram).observe(ui["preview-viewport"]);
ui["download-source"].addEventListener("click", () =>
  download(
    new Blob([sourceText(ui.source.value)], {
      type: "text/plain;charset=utf-8",
    }),
    "mmd",
  ),
);
ui["download-toggle"].addEventListener("click", () => {
  setDownloadFormatsOpen(ui["download-formats"].hidden);
  ui["download-toggle"].focus({ preventScroll: true });
});
// A disclosure keeps native Tab navigation among the format buttons.
for (const eventName of ["pointerdown", "focusin"]) {
  document.addEventListener(eventName, (event) => {
    if (!ui["download-formats"].hidden && !ui["download-actions"].contains(event.target)) setDownloadFormatsOpen(false);
  });
}
ui["download-svg"].addEventListener("click", () => {
  closeDownloadFormats();
  download(new Blob([lastSvg], { type: "image/svg+xml;charset=utf-8" }), "svg");
});
ui["download-png"].addEventListener("click", () => {
  closeDownloadFormats();
  downloadPng();
});
ui["open-preview"].addEventListener("click", openPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !ui["download-formats"].hidden) {
    event.preventDefault();
    closeDownloadFormats();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    for (const id of dirty) saveRecord(diagrams.get(id));
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    requestRender(0);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty.size) return;
  event.preventDefault();
  event.returnValue = "";
});

function upgradeDatabase(database, tx, event) {
  if (event.oldVersion < 1) database.createObjectStore("diagrams", { keyPath: "id" });
  if (event.oldVersion < 2) database.createObjectStore("profiles", { keyPath: "id" });
}

async function loadLibrary() {
  let diagramRequest;
  // One read-only transaction gives a consistent snapshot of both stores.
  const profileRecords = await transact(db, ["diagrams", "profiles"], "readonly", (tx) => {
    diagramRequest = tx.objectStore("diagrams").getAll();
    return tx.objectStore("profiles").getAll();
  });
  for (const profile of profileRecords) profiles.set(profile.id, profile);
  for (const record of diagramRequest.result) diagrams.set(record.id, record);
}

// Safe to run on every load: diagrams saved before profiles existed, or whose
// profile is missing, join the oldest profile. Without storage this only fixes memory.
async function migrateLibrary() {
  const addedProfiles = [];
  if (!profiles.size) {
    const profile = createProfileRecord(DEFAULT_PROFILE_NAME);
    profiles.set(profile.id, profile);
    addedProfiles.push(profile);
  }
  const home = oldestProfile();
  const repaired = [];
  for (const record of diagrams.values()) {
    if (profiles.has(record.profileId)) continue;
    const moved = { ...record, profileId: home.id };
    diagrams.set(record.id, moved);
    repaired.push(moved);
  }
  if (!db || (!addedProfiles.length && !repaired.length)) return;
  await transact(db, ["diagrams", "profiles"], "readwrite", (tx) => {
    let request;
    for (const profile of addedProfiles) request = tx.objectStore("profiles").put(profile);
    for (const record of repaired) request = tx.objectStore("diagrams").put(record);
    return request;
  });
}

async function init() {
  try {
    db = await openDatabase(DB_NAME, DB_VERSION, upgradeDatabase, {
      onClose(error) {
        storageError = error;
        db = null;
        clearTimeout(saveTimer);
        ui.source.readOnly = true;
        ui["diagram-title"].readOnly = true;
        ui["new-diagram"].disabled = true;
        ui["delete-diagram"].disabled = true;
        showStorageError(error);
        updateSaveStatus();
      },
    });
    await loadLibrary();
    await migrateLibrary();
  } catch (error) {
    db?.close();
    db = null;
    showStorageError(error);
    await migrateLibrary();
  }
  for (const id of ["source", "diagram-title", "diagram-list", "download-source"]) ui[id].disabled = false;
  for (const id of ["new-diagram", "delete-diagram"]) ui[id].disabled = Boolean(storageError);
  const stored = storedProfileId();
  const [latest] = [...diagrams.values()].sort(byRecent);
  activeProfileId = profiles.has(stored) ? stored : (latest?.profileId ?? oldestProfile().id);
  openLatestDiagram();
}

init();
