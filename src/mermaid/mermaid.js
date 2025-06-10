import { openDatabase, transact } from "../folio/idb.js";

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.esm.min.mjs";
const DB_NAME = "folio_mermaid_db";
const DB_VERSION = 2;
const PROFILE_KEY = "folio_mermaid_profile";
const DEFAULT_PROFILE_NAME = "My diagrams";
const PROFILE_NAME_MAX = 40;
const SVG_NS = "http://www.w3.org/2000/svg";

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
// Actions that write to storage. Switching profiles still works in memory without storage.
const WRITE_ACTIONS = ["new-diagram", "delete-diagram", "new-profile", "manage-profiles", "move-diagram"];

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
const disclosures = [];

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

function createDiagramRecord(profileId) {
  return { id: crypto.randomUUID(), title: "Untitled diagram", source: "", updatedAt: Date.now(), profileId };
}

function sortedProfiles() {
  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function countLabel(count) {
  return `${count} ${count === 1 ? "diagram" : "diagrams"}`;
}

function profileInitial(name) {
  return [...name.trim()][0]?.toLocaleUpperCase() ?? "?";
}

function profileNameError(name, exceptId) {
  if (!name) return "Enter a name for the profile.";
  if (name.length > PROFILE_NAME_MAX) return `Use ${PROFILE_NAME_MAX} characters or fewer.`;
  const key = name.toLocaleLowerCase();
  const taken = [...profiles.values()].some(
    (profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === key,
  );
  return taken ? `There is already a profile named “${name}”.` : "";
}

function storedProfileId() {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function rememberProfile(id) {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // Without localStorage the app falls back to the most recently edited diagram's profile.
  }
}

function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  const use = document.createElementNS(SVG_NS, "use");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `../shared/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function profileAvatar(name) {
  const avatar = document.createElement("span");
  avatar.className = "profile-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = profileInitial(name);
  return avatar;
}

function diagramCounts() {
  const counts = new Map();
  for (const diagram of diagrams.values()) counts.set(diagram.profileId, (counts.get(diagram.profileId) ?? 0) + 1);
  return counts;
}

// Profile names are user input, so options are built with DOM APIs and textContent.
function profileOption(profile, count) {
  const button = document.createElement("button");
  const text = document.createElement("span");
  const name = document.createElement("strong");
  const hint = document.createElement("span");
  button.type = "button";
  button.className = "profile-option";
  button.dataset.profileId = profile.id;
  text.className = "option-text";
  name.textContent = profile.name;
  name.title = profile.name;
  hint.className = "option-hint";
  hint.textContent = countLabel(count);
  text.append(name, hint);
  button.append(profileAvatar(profile.name), text);
  return button;
}

function renderProfiles() {
  const active = profiles.get(activeProfileId);
  ui["profile-current"].textContent = active.name;
  ui["profile-current"].title = active.name;
  ui["profile-avatar"].textContent = profileInitial(active.name);
  const counts = diagramCounts();
  const sorted = sortedProfiles();
  const options = sorted.map((profile) => {
    const button = profileOption(profile, counts.get(profile.id) ?? 0);
    button.setAttribute("aria-pressed", String(profile.id === activeProfileId));
    button.append(icon("check", "icon option-check"));
    return button;
  });
  ui["profile-options"].replaceChildren(...options);
  const targets = sorted.filter((profile) => profile.id !== activeProfileId);
  ui["move-options"].replaceChildren(...targets.map((profile) => profileOption(profile, counts.get(profile.id) ?? 0)));
  // People who never create a second profile never see the Move button.
  ui["move-actions"].hidden = !targets.length;
  if (!targets.length) moveMenu.close();
}

function announce(message) {
  ui.status.textContent = message;
}

function previewFeedback(message) {
  ui["preview-feedback"].textContent = message;
  ui["preview-feedback"].hidden = !message;
}

function updatePreviewActions(ready) {
  if (!ready) downloadMenu.close();
  for (const id of PREVIEW_ACTIONS) ui[id].disabled = !ready;
  if (pngPending) ui["download-png"].disabled = true;
  if (ui["fullscreen-dialog"].open) ui["fullscreen-preview"].disabled = false;
}

// Menus are disclosures (a button plus a panel), not ARIA menus, so native Tab
// navigation keeps working among the buttons in each panel.
function createDisclosure({ container, toggle, panel }) {
  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  }
  const disclosure = {
    container,
    isOpen: () => !panel.hidden,
    open: () => setOpen(true),
    close({ focus = false } = {}) {
      setOpen(false);
      if (focus) toggle.focus({ preventScroll: true });
    },
  };
  toggle.addEventListener("click", () => {
    setOpen(panel.hidden);
    toggle.focus({ preventScroll: true });
  });
  disclosures.push(disclosure);
  return disclosure;
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
  const record = createDiagramRecord(activeProfileId);
  diagrams.set(record.id, record);
  if (!storageError) dirty.add(record.id);
  selectDiagram(record.id);
  updateLibrary();
  renderProfiles();
  saveRecord(record);
}

function openLatestDiagram() {
  const [latest] = profileDiagrams();
  if (!latest) return createDiagram();
  selectDiagram(latest.id);
  updateLibrary();
  renderProfiles();
}

function mostRecentProfileId() {
  const [latest] = [...diagrams.values()].sort(byRecent);
  return latest?.profileId ?? oldestProfile().id;
}

function saveProfile(profile) {
  if (!db) return saveQueue;
  saveQueue = saveQueue.then(async () => {
    if (!db) return;
    try {
      await transact(db, "profiles", "readwrite", (tx) => tx.objectStore("profiles").put(profile));
    } catch (error) {
      showStorageError(error);
    }
  });
  return saveQueue;
}

function renameProfile(id, name) {
  const profile = { ...profiles.get(id), name };
  profiles.set(id, profile);
  renderProfiles();
  saveProfile(profile);
  announce(`Renamed profile to ${name}.`);
}

function moveDiagram(targetId) {
  clearTimeout(saveTimer);
  // Moving is not editing, so updatedAt stays as it was.
  const record = { ...currentDiagram(), profileId: targetId };
  diagrams.set(record.id, record);
  if (!storageError) dirty.add(record.id);
  saveRecord(record);
  openLatestDiagram();
  announce(`Moved “${record.title || "Untitled diagram"}” to ${profiles.get(targetId).name}.`);
}

function switchProfile(id) {
  flushSave();
  activeProfileId = id;
  rememberProfile(id);
  openLatestDiagram();
  announce(`Switched to ${profiles.get(id).name}.`);
}

async function createProfile(name) {
  if (storageError) throw storageError;
  await flushSave();
  const profile = createProfileRecord(name);
  const diagram = createDiagramRecord(profile.id);
  if (db) {
    // Chained on the save queue so it cannot race a pending diagram save.
    const write = saveQueue.then(() =>
      transact(db, ["profiles", "diagrams"], "readwrite", (tx) => {
        tx.objectStore("profiles").put(profile);
        return tx.objectStore("diagrams").put(diagram);
      }),
    );
    saveQueue = write.catch(() => {});
    await write;
  } else if (!storageError) {
    dirty.add(diagram.id);
  }
  profiles.set(profile.id, profile);
  diagrams.set(diagram.id, diagram);
  switchProfile(profile.id);
  announce(`Created ${name}.`);
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
const downloadMenu = createDisclosure({
  container: ui["download-actions"],
  toggle: ui["download-toggle"],
  panel: ui["download-formats"],
});
const profileMenu = createDisclosure({
  container: ui["profile-actions"],
  toggle: ui["profile-toggle"],
  panel: ui["profile-panel"],
});
const moveMenu = createDisclosure({
  container: ui["move-actions"],
  toggle: ui["move-diagram"],
  panel: ui["move-panel"],
});
ui["move-options"].addEventListener("click", (event) => {
  const option = event.target.closest("[data-profile-id]");
  if (!option) return;
  moveMenu.close({ focus: true });
  moveDiagram(option.dataset.profileId);
});
ui["profile-options"].addEventListener("click", (event) => {
  const option = event.target.closest("[data-profile-id]");
  if (!option) return;
  profileMenu.close({ focus: true });
  if (option.dataset.profileId !== activeProfileId) switchProfile(option.dataset.profileId);
});

const profileDialog = ui["profile-dialog"];
const profileForm = profileDialog.querySelector("form");
let profileCreated = false;

function setNameError(input, error, message) {
  error.textContent = message;
  error.hidden = !message;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

ui["new-profile"].addEventListener("click", () => {
  profileMenu.close();
  profileCreated = false;
  ui["profile-name"].value = "";
  setNameError(ui["profile-name"], ui["profile-name-error"], "");
  profileDialog.showModal();
});
ui["profile-name"].addEventListener("input", () => setNameError(ui["profile-name"], ui["profile-name-error"], ""));
ui["cancel-profile"].addEventListener("click", () => profileDialog.close());
profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = ui["profile-name"].value.trim();
  const message = profileNameError(name);
  if (message) {
    setNameError(ui["profile-name"], ui["profile-name-error"], message);
    ui["profile-name"].focus();
    return;
  }
  const buttons = profileForm.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  try {
    await createProfile(name);
    profileCreated = true;
    profileDialog.close();
  } catch (error) {
    showStorageError(error);
    setNameError(ui["profile-name"], ui["profile-name-error"], "The profile could not be saved in this browser.");
  } finally {
    for (const button of buttons) button.disabled = false;
  }
});
profileDialog.addEventListener("close", () => {
  if (profileCreated) ui.source.focus();
  else ui["profile-toggle"].focus();
});

const manageDialog = ui["manage-dialog"];
const deleteProfileDialog = ui["delete-profile-dialog"];
let pendingDeleteId;
let deleteReturnFocus;

function renderManageList() {
  const counts = diagramCounts();
  const rows = sortedProfiles().map((profile) => {
    const row = document.createElement("li");
    const input = document.createElement("input");
    const count = document.createElement("span");
    const remove = document.createElement("button");
    row.className = "manage-row";
    input.type = "text";
    input.maxLength = PROFILE_NAME_MAX;
    input.value = profile.name;
    input.dataset.profileId = profile.id;
    input.setAttribute("aria-label", `Name of profile ${profile.name}`);
    count.className = "manage-count";
    count.textContent = countLabel(counts.get(profile.id) ?? 0);
    remove.type = "button";
    remove.className = "icon-button danger";
    remove.dataset.deleteProfile = profile.id;
    remove.setAttribute("aria-label", `Delete profile ${profile.name}`);
    remove.title = profiles.size > 1 ? "Delete profile" : "The last profile can’t be deleted";
    remove.disabled = profiles.size === 1 || Boolean(storageError);
    remove.append(icon("trash-2"));
    row.append(profileAvatar(profile.name), input, count, remove);
    return row;
  });
  ui["manage-list"].replaceChildren(...rows);
}

function setManageError(input, message) {
  for (const field of ui["manage-list"].querySelectorAll("input")) {
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-describedby");
  }
  ui["manage-error"].textContent = message;
  ui["manage-error"].hidden = !message;
  if (!message || !input) return;
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", "manage-error");
}

// Enter keeps an invalid name for correcting; leaving the field puts the saved name back.
function commitRename(input, { revert }) {
  const profile = profiles.get(input.dataset.profileId);
  if (!profile) return;
  const name = input.value.trim();
  if (storageError && name !== profile.name) {
    input.value = profile.name;
    return setManageError(null, storageError.message);
  }
  if (name === profile.name) {
    input.value = name;
    setManageError(null, "");
    return;
  }
  const message = profileNameError(name, profile.id);
  if (message) {
    if (!revert) return setManageError(input, message);
    input.value = profile.name;
    return setManageError(null, `${message} The name was not changed.`);
  }
  setManageError(null, "");
  input.value = name;
  input.setAttribute("aria-label", `Name of profile ${name}`);
  input.previousElementSibling.textContent = profileInitial(name);
  input.parentElement.querySelector("[data-delete-profile]").setAttribute("aria-label", `Delete profile ${name}`);
  renameProfile(profile.id, name);
}

ui["manage-profiles"].addEventListener("click", () => {
  profileMenu.close();
  renderManageList();
  setManageError(null, "");
  manageDialog.showModal();
});
ui["manage-list"].addEventListener("change", (event) => {
  if (event.target.matches("input")) commitRename(event.target, { revert: true });
});
ui["manage-list"].addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || !event.target.matches("input")) return;
  // Without this, Enter submits the dialog form and closes Manage profiles.
  event.preventDefault();
  commitRename(event.target, { revert: false });
});
ui["manage-list"].addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-profile]");
  if (!button) return;
  const profile = profiles.get(button.dataset.deleteProfile);
  const doomed = profileDiagrams(profile.id);
  const count = countLabel(doomed.length);
  pendingDeleteId = profile.id;
  deleteReturnFocus = button;
  ui["delete-profile-heading"].textContent = `Delete “${profile.name}”?`;
  ui["delete-profile-copy"].textContent =
    `This deletes the profile and its ${count} from this browser. Download any you want to keep first.`;
  ui["delete-profile-list"].replaceChildren(
    ...doomed.map((diagram) => {
      const item = document.createElement("li");
      item.textContent = diagram.title || "Untitled diagram";
      return item;
    }),
  );
  ui["delete-profile-list"].scrollTop = 0;
  ui["confirm-delete-profile"].textContent = `Delete profile and ${count}`;
  deleteProfileDialog.showModal();
});
manageDialog.addEventListener("close", () => ui["profile-toggle"].focus());
deleteProfileDialog.addEventListener("close", () => {
  pendingDeleteId = null;
  if (deleteReturnFocus?.isConnected) deleteReturnFocus.focus();
  else ui["manage-done"].focus();
});
deleteProfileDialog.querySelector("form").addEventListener("submit", async (event) => {
  if (event.submitter?.value !== "delete") return;
  event.preventDefault();
  const id = pendingDeleteId;
  const { name } = profiles.get(id);
  const doomed = profileDiagrams(id).map((diagram) => diagram.id);
  const buttons = deleteProfileDialog.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  await flushSave();
  try {
    if (storageError) throw storageError;
    if (profiles.size === 1) throw new Error("The last profile can’t be deleted.");
    if (db) {
      await transact(db, ["profiles", "diagrams"], "readwrite", (tx) => {
        const store = tx.objectStore("diagrams");
        for (const diagramId of doomed) store.delete(diagramId);
        return tx.objectStore("profiles").delete(id);
      });
    }
    for (const diagramId of doomed) {
      diagrams.delete(diagramId);
      dirty.delete(diagramId);
    }
    profiles.delete(id);
    deleteProfileDialog.close();
    if (id === activeProfileId) switchProfile(mostRecentProfileId());
    else renderProfiles();
    renderManageList();
    announce(`Deleted “${name}” and ${countLabel(doomed.length)}.`);
  } catch (error) {
    showStorageError(error);
    deleteProfileDialog.close();
    announce(storageError?.message ?? `“${name}” could not be deleted. Its diagrams are still available.`);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
});
for (const eventName of ["pointerdown", "focusin"]) {
  document.addEventListener(eventName, (event) => {
    for (const disclosure of disclosures) {
      if (disclosure.isOpen() && !disclosure.container.contains(event.target)) disclosure.close();
    }
  });
}
ui["download-svg"].addEventListener("click", () => {
  downloadMenu.close({ focus: true });
  download(new Blob([lastSvg], { type: "image/svg+xml;charset=utf-8" }), "svg");
});
ui["download-png"].addEventListener("click", () => {
  downloadMenu.close({ focus: true });
  downloadPng();
});
ui["open-preview"].addEventListener("click", openPreview);
document.addEventListener("keydown", (event) => {
  const openDisclosure = disclosures.find((disclosure) => disclosure.isOpen());
  if (event.key === "Escape" && openDisclosure) {
    event.preventDefault();
    openDisclosure.close({ focus: true });
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
        for (const id of WRITE_ACTIONS) ui[id].disabled = true;
        moveMenu.close();
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
  for (const id of ["source", "diagram-title", "diagram-list", "profile-toggle", "download-source"]) {
    ui[id].disabled = false;
  }
  for (const id of WRITE_ACTIONS) ui[id].disabled = Boolean(storageError);
  const stored = storedProfileId();
  activeProfileId = profiles.has(stored) ? stored : mostRecentProfileId();
  openLatestDiagram();
}

init();
