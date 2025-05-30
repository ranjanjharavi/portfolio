import {
  clamp,
  easeInOutCubic,
  hasIntersectionObserver,
  isPaused,
  motionAllowed,
  onPauseChange,
  reducedMotion,
} from "../motion.js";

// Project previews: authored illustrations of the real extensions
const hasObservers = hasIntersectionObserver && "ResizeObserver" in window;
const kebab = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

// A run that was stopped (offscreen for good, the pause control, reduced motion)
class Stopped extends Error {}

// macOS cursors, as the kit draws them. Each glyph's hotspot is placed in CSS.
const CURSOR = `<div class="ss-cursor" data-kind="pointer" aria-hidden="true"><div class="ss-cursor__press">
<div class="ss-cursor__glyph" data-glyph="pointer"><svg width="24" height="24" viewBox="0 0 32 32" fill="none"><g transform="translate(10 7)"><path d="m6.148 18.473 1.863-1.003 1.615-.839-2.568-4.816h4.332l-11.379-11.408v16.015l3.316-3.221z" fill="#fff"/><path d="m6.431 17 1.765-.941-2.775-5.202h3.604l-8.025-8.043v11.188l2.53-2.442z" fill="#000"/></g></svg></div>
<div class="ss-cursor__glyph" data-glyph="hand"><svg width="26" height="26" viewBox="0 0 32 32" fill="none"><path d="M10.6 6a1.7 1.7 0 0 1 3.4 0v6.6a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0v.7a1.3 1.3 0 0 1 2.6 0V19c0 3.1-2 5.6-5 5.6h-2.6c-2 0-3.3-.9-4.4-2.4l-3.1-4.1c-.6-.9-.4-2 .5-2.5.8-.4 1.7-.2 2.3.5l1.1 1.4V6Z" fill="#fff" stroke="#000" stroke-width="1.1" stroke-linejoin="round"/><path d="M14 12.6v3.6M16.6 13.3v3M19.2 14v2.6" stroke="#000" stroke-width="1" stroke-linecap="round"/></svg></div>
<div class="ss-cursor__glyph" data-glyph="ibeam"><svg width="10" height="16" viewBox="0 0 10 16" fill="none" overflow="visible"><path d="M3 1H7M3 15H7M5 1V15" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M3 1H7M3 15H7M5 1V15" stroke="#000" stroke-width="1" stroke-linecap="round"/></svg></div>
</div></div>`;

function createStage(root, scene) {
  root.insertAdjacentHTML("beforeend", CURSOR);
  const cursor = root.querySelector(".ss-cursor");
  const state = {};
  const waiters = new Set();
  let time = 0;
  let frame = null;
  let lastFrame = null;
  let active = false;
  let run = 0;
  let moving = false;
  let pos = { x: 0, y: 0 };
  let anchor = null;
  let hovered = null;
  let holdWaiter = null;

  // The stage's own clock: it only advances while the stage is in view.
  function tick(now) {
    frame = null;
    if (!active) {
      lastFrame = null;
      return;
    }
    time += lastFrame === null ? 0 : Math.min(now - lastFrame, 64);
    lastFrame = now;
    waiters.forEach((waiter) => {
      waiter.step?.(clamp((time - waiter.start) / waiter.duration, 0, 1));
      if (time >= waiter.until) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    });
    frame = requestAnimationFrame(tick);
  }

  function setActive(value) {
    active = value;
    if (active && frame === null) frame = requestAnimationFrame(tick);
  }

  function sleep(ms, step) {
    const id = run;
    return new Promise((resolve, reject) => {
      waiters.add({
        start: time,
        until: time + ms,
        duration: Math.max(ms, 1),
        step,
        resolve,
        reject,
      });
    }).then(() => {
      if (id !== run) throw new Stopped();
    });
  }

  // Layout pixels inside the stage, whatever transform the card is under.
  function scale() {
    return root.getBoundingClientRect().width / root.offsetWidth || 1;
  }

  function box(element) {
    const s = scale();
    const base = root.getBoundingClientRect();
    const r = element.getBoundingClientRect();
    return {
      x: (r.left - base.left) / s,
      y: (r.top - base.top) / s,
      w: r.width / s,
      h: r.height / s,
    };
  }

  function point(name, fx = 0.5, fy = 0.5) {
    // Just below the stage's bottom edge: where the cursor comes in from and leaves to
    if (name === "offstage")
      return {
        x: root.offsetWidth * fx,
        y: root.offsetHeight + 28,
        element: null,
      };
    const element = root.querySelector(`[data-target="${name}"]`);
    const r = box(element);
    return { x: r.x + r.w * fx, y: r.y + r.h * fy, element };
  }

  function place(p) {
    pos = { x: p.x, y: p.y };
    cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  function setHover(element) {
    if (hovered === element) return;
    hovered?.removeAttribute("data-hover");
    hovered = element;
    hovered?.setAttribute("data-hover", "");
  }

  // What sits under the pointer decides its kind: an I-beam over a field, a
  // hand over the popup's buttons, the arrow on Chrome's own toolbar.
  function hitList() {
    const open = root.hasAttribute("data-open");
    return Array.from(root.querySelectorAll("[data-cursor]"))
      .filter((element) => open || !element.closest(".ss-popover"))
      .map((element) => ({ kind: element.dataset.cursor, ...box(element) }));
  }

  function kindAt(p, list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const hit = list[i];
      if (p.x >= hit.x && p.x <= hit.x + hit.w && p.y >= hit.y && p.y <= hit.y + hit.h) return hit.kind;
    }
    return "pointer";
  }

  // Only the changed words roll. The box holds the wider line while the two
  // swap, then eases to the new width, so no edge ever slices a word.
  function roll(element, text, instant) {
    const current = element.querySelector(".ss-roll__item:not([data-out])");
    if (current && current.textContent === text) return;
    const next = document.createElement("span");
    next.className = "ss-roll__item";
    next.textContent = text;
    clearTimeout(element.rollTimer);
    clearTimeout(element.rollSettle);
    if (instant || !current) {
      element.replaceChildren(next);
      element.style.width = "";
      return;
    }
    element.querySelectorAll("[data-out]").forEach((item) => item.remove());
    const s = scale();
    const from = element.getBoundingClientRect().width / s;
    current.setAttribute("data-out", "");
    next.setAttribute("data-in", "");
    element.append(next);
    const to = next.getBoundingClientRect().width / s;
    element.style.width = `${from}px`;
    void element.offsetWidth;
    element.style.width = `${Math.max(from, to)}px`;
    element.rollTimer = setTimeout(() => {
      current.remove();
      next.removeAttribute("data-in");
      element.style.width = `${to}px`;
      element.rollSettle = setTimeout(() => (element.style.width = ""), 460);
    }, 420);
  }

  function render(instant = false) {
    Object.entries(state).forEach(([key, value]) => {
      if (typeof value === "boolean") root.toggleAttribute(`data-${kebab(key)}`, value);
    });
    root.querySelectorAll("[data-text]").forEach((element) => {
      const value = state[element.dataset.text];
      if (value !== undefined && element.textContent !== value) element.textContent = value;
    });
    root.querySelectorAll("[data-roll]").forEach((element) => {
      const value = state[element.dataset.roll];
      if (value !== undefined) roll(element, value, instant);
    });
    scene.render?.(state, root);
  }

  function set(patch) {
    Object.assign(state, patch);
    render();
  }

  // Out of sight, state changes take no time.
  function snap(patch) {
    root.setAttribute("data-instant", "");
    Object.assign(state, patch);
    render(true);
    void root.offsetWidth;
    root.removeAttribute("data-instant");
  }

  async function move(name, fx, fy) {
    const end = point(name, fx, fy);
    anchor = [name, fx, fy];
    const from = { ...pos };
    const distance = Math.hypot(end.x - from.x, end.y - from.y);
    setHover(null);
    if (distance > 0.5) {
      // A hand travels in a shallow arc, quicker over short hops
      const ms = clamp(260 + distance * 0.9, 300, 650);
      const bow = Math.min(distance * 0.08, 24);
      const nx = -(end.y - from.y) / distance;
      const ny = (end.x - from.x) / distance;
      const hits = hitList();
      moving = true;
      try {
        await sleep(ms, (t) => {
          const eased = easeInOutCubic(t);
          const lift = Math.sin(Math.PI * eased) * bow;
          const p = {
            x: from.x + (end.x - from.x) * eased + nx * lift,
            y: from.y + (end.y - from.y) * eased + ny * lift,
          };
          place(p);
          cursor.dataset.kind = kindAt(p, hits);
        });
      } finally {
        moving = false;
      }
    }
    place(end);
    cursor.dataset.kind = kindAt(end, hitList());
    setHover(end.element);
  }

  async function click(name, fx, fy) {
    if (name) {
      await move(name, fx, fy);
      await sleep(120);
    }
    const target = hovered;
    cursor.setAttribute("data-pressed", "");
    target?.setAttribute("data-pressed", "");
    try {
      await sleep(100);
    } finally {
      cursor.removeAttribute("data-pressed");
      target?.removeAttribute("data-pressed");
    }
  }

  const act = {
    wait: (ms) => sleep(ms),
    move,
    click,
    set,
    snap,
    mark: (name) => (root.dataset.mark = name),
    call: (fn) => fn(api),
    showCursor: () => root.setAttribute("data-cursor", ""),
    hideCursor: () => root.removeAttribute("data-cursor"),
    async type(key, text, interval) {
      for (let i = 1; i <= text.length; i++) {
        set({ [key]: text.slice(0, i) });
        await sleep(interval * (0.75 + ((i * 37) % 10) / 20));
      }
    },
    stream: (key, text, ms) => sleep(ms, (t) => set({ [key]: text.slice(0, Math.round(t * text.length)) })),
    // Hands the page's motion to another tile: the scene holds its finished
    // frame, cursor faded out, until the controller gives the turn back.
    async turn() {
      if (!api.shouldYield?.()) return;
      const id = run;
      act.hideCursor();
      api.holding = true;
      setActive(false);
      queueMicrotask(() => api.onHold?.());
      try {
        await new Promise((resolve, reject) => (holdWaiter = { resolve, reject }));
      } finally {
        api.holding = false;
        holdWaiter = null;
      }
      if (id !== run) throw new Stopped();
      act.showCursor();
      await sleep(450);
    },
  };

  function reset(patch) {
    run += 1;
    waiters.forEach((waiter) => waiter.reject(new Stopped()));
    waiters.clear();
    holdWaiter?.reject(new Stopped());
    setHover(null);
    root.querySelectorAll("[data-pressed]").forEach((element) => element.removeAttribute("data-pressed"));
    cursor.removeAttribute("data-pressed");
    act.hideCursor();
    snap(patch);
    const [name, fx, fy] = scene.rest;
    anchor = scene.rest;
    place(point(name, fx, fy));
    cursor.dataset.kind = "pointer";
  }

  const api = {
    root,
    state,
    scale,
    set,
    setActive,
    holding: false,
    shouldYield: null,
    onHold: null,
    release() {
      setActive(true);
      holdWaiter?.resolve();
    },
    unhover: () => setHover(null),
    showPoster: () => reset({ ...scene.poster }),
    prime: () => reset({ ...scene.initial }),
    async play(options) {
      const id = run;
      act.showCursor();
      await scene.script(act, options);
      if (id !== run) throw new Stopped();
    },
    // Keep the cursor on its target when the tile changes size.
    reanchor() {
      if (!moving && anchor) place(point(...anchor));
    },
  };
  return api;
}

// Opens the popup again from its toolbar icon, the way a person replays it:
// the icon closes what is open, the scene resets out of sight, the icon opens it.
async function reopen(a, initial) {
  await a.click("ext", 0.5, 0.5);
  a.set({ open: false });
  await a.wait(420);
  a.snap({ ...initial, open: false });
  await a.wait(260);
  await a.click();
  a.set({ open: true });
  await a.wait(650);
}

const AZK_INITIAL = {
  open: false,
  focus: false,
  tag: "",
  tagged: false,
  saved: false,
  save: "Save bookmark",
};
const URLT_OUT = "https://app.example.com/dashboard?auth_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdGFnaW5nIn0.Hk3vQp8sX2";
const URLT_INITIAL = { open: true, result: false, copied: false, out: "" };
const HK_INITIAL = {
  open: true,
  trace: false,
  traceLabel: "Paused",
  badge: "2",
};

const SCENES = {
  // The featured project loops: open the popup, tag the page, save it.
  azkmark: {
    mode: "loop",
    poster: {
      open: true,
      focus: false,
      tag: "",
      tagged: true,
      saved: true,
      save: "Saved",
    },
    initial: AZK_INITIAL,
    rest: ["page", 0.2, 0.62],
    render(state, root) {
      root.toggleAttribute("data-typed", state.tag !== "");
    },
    async script(a, { first }) {
      await a.wait(first ? 1100 : 600);
      a.mark("open");
      await a.click("ext", 0.5, 0.5);
      a.set({ open: true });
      await a.wait(700);

      a.mark("tag");
      await a.click("tag", 0.62, 0.5);
      a.set({ focus: true });
      await a.wait(250);
      await a.type("tag", "api", 120);
      await a.wait(380);
      await a.click("add", 0.84, 0.62);
      await a.call(addTag);
      await a.wait(850);

      a.mark("save");
      await a.click("save", 0.86, 0.58);
      a.set({ saved: true, focus: false, save: "Saved" });
      await a.wait(2400);
      // If a tile below is waiting to tell its story, it goes now
      await a.turn();

      // The toolbar icon closes its own popup, as it does in Chrome
      a.mark("close");
      await a.click("ext", 0.5, 0.5);
      a.set({ open: false });
      await a.wait(420);
      a.snap({ ...AZK_INITIAL });
      // Step off the icon onto the page, beside the next click
      await a.move("ext", -1.2, 2.4);
    },
  },

  // The pair below plays once each, in turn, then holds its result.
  "url-transformer": {
    mode: "once",
    poster: { open: true, result: true, copied: true, out: URLT_OUT },
    initial: URLT_INITIAL,
    rest: ["offstage", 0.42],
    async script(a, { replay }) {
      await a.wait(replay ? 200 : 1000);
      if (replay) await reopen(a, URLT_INITIAL);
      a.mark("transform");
      await a.click("transform", 0.86, 0.6);
      a.set({ result: true });
      await a.wait(560);
      await a.stream("out", URLT_OUT, 700);
      await a.wait(500);

      a.mark("copy");
      await a.click("copy", 0.82, 0.82);
      a.set({ copied: true });
      await a.wait(1100);
      // Out of the way: the result is left to read
      await a.move("offstage", 0.62);
      a.hideCursor();
    },
  },

  headerkit: {
    mode: "once",
    poster: { open: true, trace: true, traceLabel: "On", badge: "3" },
    initial: HK_INITIAL,
    rest: ["offstage", 0.42],
    async script(a, { replay }) {
      await a.wait(replay ? 200 : 900);
      if (replay) await reopen(a, HK_INITIAL);
      a.mark("toggle");
      await a.click("trace", 0.16, 0.78);
      a.set({ trace: true, traceLabel: "On" });
      // The toolbar badge counts live rules; it follows its cause
      await a.wait(380);
      a.set({ badge: "3" });
      await a.wait(1500);
      await a.move("offstage", 0.62);
      a.hideCursor();
    },
  },
};

// The typed words lift out of the field into the draft chip above it.
function addTag(stage) {
  const { root, scale } = stage;
  const words = root.querySelector(".azk-value").getBoundingClientRect();
  const target = root.querySelector(".azk-chip-text").getBoundingClientRect();
  const chip = root.querySelector(".azk-chip");
  const s = scale();
  chip.style.setProperty("--fx", `${(words.left - target.left) / s}px`);
  chip.style.setProperty("--fy", `${(words.top - target.top) / s}px`);
  root.setAttribute("data-flying", "");
  // The caret waits until the field has dropped clear of the words
  root.setAttribute("data-handoff", "");
  setTimeout(() => root.removeAttribute("data-handoff"), 460);
  stage.set({ tag: "" });
  void root.offsetWidth;
  root.removeAttribute("data-flying");
  stage.set({ tagged: true });
  // The row slides out from under the pointer, and its hover goes with it
  stage.unhover();
}

const items = Array.from(document.querySelectorAll("[data-demo]"), (fit) => {
  const scene = SCENES[fit.dataset.demo];
  const root = fit.querySelector(".ss-stage");
  if (!scene || !root) return null;
  return {
    fit,
    scene,
    stage: createStage(root, scene),
    status: "poster",
    visible: false,
    played: false,
    replay: false,
  };
}).filter(Boolean);
items.forEach((item) => {
  item.stage.shouldYield = onceWaiting;
  item.stage.onHold = update;
});

// One place leads: a tile in view waits while another in view is mid-story.
// The looping tile hands over at its payoff whenever a tile beside it is
// waiting; a replay asked for by hovering only waits for the pair.
function onceWaiting() {
  return items.some(
    (other) =>
      other.scene.mode === "once" &&
      other.visible &&
      (other.status === "playing" || other.status === "idle" || (other.status === "done" && other.replay)),
  );
}

function canStart(item, replay = false) {
  return !items.some(
    (other) =>
      other !== item &&
      other.visible &&
      other.status === "playing" &&
      !other.stage.holding &&
      (!replay || other.scene.mode === "once"),
  );
}

async function start(item, replay) {
  item.status = "playing";
  item.stage.setActive(true);
  let first = true;
  try {
    do {
      await item.stage.play({ first, replay });
      first = false;
    } while (item.scene.mode === "loop");
    item.played = true;
    item.status = "done";
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
  } finally {
    item.stage.setActive(false);
    update();
  }
}

function update() {
  const allowed = hasObservers && motionAllowed() && !isPaused();
  items.forEach((item) => {
    if (!allowed) {
      if (item.status !== "poster") {
        item.stage.showPoster();
        item.status = "poster";
      }
      return;
    }
    if (item.status === "poster") {
      // A pair tile that already played keeps its result; everything else starts over.
      if (item.scene.mode === "once" && item.played) item.status = "done";
      else {
        item.stage.prime();
        item.status = "idle";
      }
    }
    const inView = item.visible && !document.hidden;
    if (item.status === "playing") {
      if (!item.stage.holding) item.stage.setActive(inView);
      else if (inView && !onceWaiting()) item.stage.release();
    } else if (item.status === "idle" && inView && canStart(item)) start(item, false);
    else if (item.status === "done" && item.replay && inView && canStart(item, true)) {
      item.replay = false;
      start(item, true);
    }
  });
}

if (items.length) {
  if (hasObservers) {
    const visibility = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const item = items.find((candidate) => candidate.fit === entry.target);
          item.visible = entry.isIntersecting && entry.intersectionRatio >= 0.4;
        });
        update();
      },
      { threshold: [0, 0.4, 0.7] },
    );
    const sizes = new ResizeObserver((entries) => {
      entries.forEach((entry) => items.find((item) => item.fit === entry.target)?.stage.reanchor());
    });
    items.forEach((item) => {
      visibility.observe(item.fit);
      sizes.observe(item.fit);
      // A finished tile replays when a mouse comes to look at it again.
      item.fit.closest(".project-preview")?.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse" || item.status !== "done") return;
        item.replay = true;
        update();
      });
    });
  }

  onPauseChange(update);
  document.addEventListener("visibilitychange", update);
  reducedMotion.addEventListener("change", update);
  update();
}
