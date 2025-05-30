import {
  easeIo,
  hasIntersectionObserver,
  isPaused,
  motionAllowed,
  onPauseChange,
  reducedMotion,
  setPaused,
  stillMode,
} from "./motion.js";

const root = document.documentElement;

// The native menu dialog provides focus containment, Escape, and focus restoration.
const mobileMenu = document.getElementById("mobile-menu");
const menuToggle = document.getElementById("mobile-menu-toggle");
if (mobileMenu && menuToggle) {
  function closeMenu() {
    mobileMenu.close();
  }
  menuToggle.addEventListener("click", () => {
    if (mobileMenu.open) closeMenu();
    else {
      menuToggle.setAttribute("aria-expanded", "true");
      menuToggle.setAttribute("aria-label", "Close navigation");
      mobileMenu.showModal();
    }
  });
  mobileMenu.addEventListener("close", () => {
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open navigation");
  });
  mobileMenu.querySelector(".menu-close").addEventListener("click", closeMenu);
  mobileMenu.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", closeMenu);
  });
  matchMedia("(min-width: 801px)").addEventListener("change", (event) => {
    if (event.matches && mobileMenu.open) closeMenu();
  });
}

// Entrances play once; only the illustrative visuals keep telling stories.
const heroElements = document.querySelectorAll("[data-hero]");
const revealElements = document.querySelectorAll("[data-reveal], [data-motion-card]");
const motionToggle = document.getElementById("motion-toggle");
const storyDuration = 6;
let storyFrame = null;
let previousFrame = null;

function track(keys, time) {
  if (time <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [end, to] = keys[i];
    const [start, from] = keys[i - 1];
    if (time <= end) return from + (to - from) * easeIo((time - start) / (end - start));
  }
  return keys[keys.length - 1][1];
}

function focusNode(node, amount) {
  node.style.setProperty("--story-focus", amount.toFixed(3));
  node.style.setProperty("--story-scale", (1 + amount * 0.2).toFixed(3));
}

function makeStory(element) {
  const nodes = element.querySelectorAll(".system-layer");
  nodes.forEach((node) => node.classList.add("story-node"));

  if (element.dataset.story === "system") {
    const layers = element.querySelectorAll(".system-layer");
    const connectors = element.querySelectorAll(".system-connector");
    return (time, selected = null) => {
      if (selected !== null) {
        layers.forEach((layer, index) => focusNode(layer, index === selected ? 1 : 0));
        connectors.forEach((connector) => connector.style.setProperty("--packet-opacity", "0"));
        return;
      }
      layers.forEach((layer, index) => {
        const start = 0.3 + index * 1.8;
        focusNode(
          layer,
          track(
            [
              [0, 0],
              [start, 0],
              [start + 0.35, 1],
              [start + 1.1, 1],
              [start + 1.5, 0],
              [storyDuration, 0],
            ],
            time,
          ),
        );
      });
      connectors.forEach((connector, index) => {
        const start = 1.2 + index * 1.8;
        const opacity = track(
          [
            [0, 0],
            [start, 0],
            [start + 0.2, 1],
            [start + 0.8, 1],
            [start + 1, 0],
            [storyDuration, 0],
          ],
          time,
        );
        const y = track(
          [
            [0, -10],
            [start, -10],
            [start + 1, 32],
            [storyDuration, 32],
          ],
          time,
        );
        connector.style.setProperty("--packet-opacity", opacity.toFixed(3));
        connector.style.setProperty("--packet-y", `${y.toFixed(3)}px`);
      });
    };
  }

  return null;
}

// The project previews run their own stages (demos.js); this clock drives the hero diagram.
const stories = Array.from(document.querySelectorAll("[data-story]"), (element, index) => ({
  element,
  draw: makeStory(element),
  elapsed: 0,
  offset: index * 0.6,
  visible: false,
  hovered: false,
  focused: false,
  hoveredNode: null,
  focusedNode: null,
}));

// Pause only the inspected card; hover and keyboard focus select its individual nodes.
stories.forEach((story) => {
  function inspect() {
    if (story.hovered || story.focused) story.draw(0, story.hoveredNode ?? story.focusedNode);
    refreshStoryClock();
  }
  story.element.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    story.hovered = true;
    inspect();
  });
  story.element.addEventListener("pointerleave", () => {
    story.hovered = false;
    story.hoveredNode = null;
    inspect();
  });
  story.element.querySelectorAll(".story-node").forEach((node, index) => {
    node.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      story.hoveredNode = index;
      inspect();
    });
    node.addEventListener("pointerleave", () => {
      story.hoveredNode = null;
      inspect();
    });
  });
  story.element.addEventListener("focusin", (event) => {
    story.focused = true;
    const node = event.target.closest(".story-node");
    story.focusedNode = node ? Array.from(story.element.querySelectorAll(".story-node")).indexOf(node) : null;
    inspect();
  });
  story.element.addEventListener("focusout", (event) => {
    story.focused = story.element.contains(event.relatedTarget);
    if (!story.focused) story.focusedNode = null;
    inspect();
  });
});

function stopStoryClock() {
  if (storyFrame !== null) cancelAnimationFrame(storyFrame);
  storyFrame = null;
  previousFrame = null;
}

function shouldRunStories() {
  return (
    motionAllowed() &&
    !isPaused() &&
    !document.hidden &&
    !mobileMenu?.open &&
    stories.some((story) => story.visible && !story.hovered && !story.focused)
  );
}

function drawStories(now) {
  storyFrame = null;
  if (!shouldRunStories()) {
    previousFrame = null;
    return;
  }
  const dt = previousFrame === null ? 0 : Math.min((now - previousFrame) / 1000, 0.08);
  previousFrame = now;
  stories.forEach((story) => {
    if (!story.visible || story.hovered || story.focused || !story.element.classList.contains("is-visible")) return;
    story.elapsed += dt;
    // Each section owns its clock. Leaving the viewport does not skip any beats.
    const time = Math.max(0, story.elapsed - 2.4 - story.offset) % storyDuration;
    story.draw(time);
  });
  storyFrame = requestAnimationFrame(drawStories);
}

function refreshStoryClock() {
  if (!shouldRunStories()) stopStoryClock();
  else if (storyFrame === null) storyFrame = requestAnimationFrame(drawStories);
}

revealElements.forEach((element) => {
  let items = [];
  if (element.matches(".project-card")) {
    items = element.querySelectorAll(".project-content > *");
  } else if (element.matches(".system-visual")) {
    items = element.querySelectorAll(".visual-top, .system-layer, .system-connector, figcaption");
  }
  items.forEach((item, index) => {
    item.classList.add("motion-item");
    item.style.setProperty("--item-delay", `${150 + index * 60}ms`);
  });
});

let revealObserver;
if (hasIntersectionObserver) {
  revealObserver = new IntersectionObserver(
    (entries) => {
      const sectionStaggers = new Map();
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const element = entry.target;
        if (element.matches(".project-card")) {
          const section = element.closest("section");
          const index = sectionStaggers.get(section) || 0;
          element.style.setProperty("--d", `${index * 85}ms`);
          sectionStaggers.set(section, index + 1);
        }
        element.classList.add("is-visible");
        revealObserver.unobserve(element);
      });
    },
    { threshold: 0, rootMargin: "0px 0px -48px 0px" },
  );
  revealElements.forEach((element) => {
    if (motionAllowed()) {
      element.classList.add("reveal-pending");
      revealObserver.observe(element);
    } else element.classList.add("is-visible");
  });

  const storyObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const story = stories.find((item) => item.element === entry.target);
      story.visible = entry.isIntersecting;
    });
    refreshStoryClock();
  });
  stories.forEach((story) => storyObserver.observe(story.element));
} else revealElements.forEach((element) => element.classList.add("is-visible"));

// Keyboard navigation must never land inside a still-hidden reveal.
document.addEventListener("focusin", (event) => {
  const reveal = event.target.closest(".reveal-pending");
  if (!reveal) return;
  reveal.classList.add("is-visible");
  revealObserver?.unobserve(reveal);
});

// Two paints establish the empty state before CSS transitions are triggered.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    heroElements.forEach((element) => element.classList.add("is-visible"));
    root.classList.add("motion-initialized");
  }),
);

function syncMotionPreference() {
  if (!motionAllowed()) {
    root.classList.remove("motion-ready");
    heroElements.forEach((element) => element.classList.add("is-visible"));
    revealElements.forEach((element) => element.classList.add("is-visible"));
    revealObserver?.disconnect();
    stories.forEach((story) => {
      story.elapsed = 0;
      story.draw(0);
    });
  }
  if (motionToggle) motionToggle.hidden = !motionAllowed();
  refreshStoryClock();
}

motionToggle?.addEventListener("click", () => setPaused(!isPaused()));
onPauseChange((paused) => {
  if (paused) stories.forEach((story) => story.draw(0));
  if (motionToggle) {
    const label = `${paused ? "Resume" : "Pause"} visual animations`;
    motionToggle.setAttribute("aria-pressed", String(paused));
    motionToggle.setAttribute("aria-label", label);
    motionToggle.title = label;
  }
  refreshStoryClock();
});
document.addEventListener("visibilitychange", refreshStoryClock);
mobileMenu?.addEventListener("toggle", refreshStoryClock);
reducedMotion.addEventListener("change", syncMotionPreference);
syncMotionPreference();

// Keep one accessible sentence while splitting only the visual words.
const tagline = document.querySelector("[data-word-reveal]");
let words = [];
let revealedWordCount = 0;
if (tagline) {
  const accessibleText = Array.from(tagline.childNodes)
    .map((node) => (node.nodeName === "BR" ? " " : node.textContent))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const readable = document.createElement("span");
  readable.className = "sr-only";
  readable.textContent = accessibleText;
  const visual = document.createElement("span");
  visual.setAttribute("aria-hidden", "true");
  Array.from(tagline.childNodes).forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) visual.append(document.createTextNode(part));
        else {
          const word = document.createElement("span");
          word.className = "tagline-word";
          word.textContent = part;
          visual.append(word);
          words.push(word);
        }
      });
    } else visual.append(node.cloneNode(true));
  });
  tagline.replaceChildren(readable, visual);
}

const navLinks = Array.from(document.querySelectorAll(".desktop-nav .nav-link"));
const mobileNavLinks = Array.from(document.querySelectorAll(".mobile-menu nav a"));
function sectionsFor(links) {
  return links
    .map((link) => ({
      link,
      section: document.querySelector(link.getAttribute("href")),
    }))
    .filter((item) => item.section)
    .sort((a, b) => (a.section.compareDocumentPosition(b.section) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}
const navSections = sectionsFor(navLinks);
const mobileSections = sectionsFor(mobileNavLinks);
let framePending = false;

function updateActiveLinks(links, sections) {
  // The final section above the reading line owns the current nav state.
  let current = sections[0];
  sections.forEach((item) => {
    if (item.section.getBoundingClientRect().top <= innerHeight * 0.35) current = item;
  });
  links.forEach((link) => {
    const active = link === current?.link;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

function updateViewport() {
  framePending = false;
  updateActiveLinks(navLinks, navSections);
  updateActiveLinks(mobileNavLinks, mobileSections);
  if (tagline) {
    const top = tagline.getBoundingClientRect().top;
    const progress = Math.max(0, Math.min(1, (innerHeight * 0.8 - top) / (innerHeight * 0.4)));
    // Each word has its own scroll threshold, in reading order; never a block fade.
    const count = reducedMotion.matches || stillMode ? words.length : Math.floor(progress * words.length);
    revealedWordCount = Math.max(revealedWordCount, count);
    words.forEach((word, index) => word.classList.toggle("is-active", index < revealedWordCount));
  }
}
function requestViewportUpdate() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(updateViewport);
}
window.addEventListener("scroll", requestViewportUpdate, { passive: true });
window.addEventListener("resize", requestViewportUpdate, { passive: true });
reducedMotion.addEventListener("change", requestViewportUpdate);
updateViewport();

// Report validation and the email-app handoff without claiming a message was sent.
const contactLink = document.querySelector('.contact-email a[href^="mailto:"]');
const contactEmail = contactLink ? new URL(contactLink.href).pathname : "";
const form = document.getElementById("contact-form");
if (form && contactEmail) {
  form.action = contactLink.href;
  form.noValidate = true;
  const status = document.getElementById("form-status");
  const fields = [
    {
      input: form.elements.namedItem("name"),
      error: document.getElementById("name-error"),
      empty: "Enter your name.",
    },
    {
      input: form.elements.namedItem("email"),
      error: document.getElementById("email-error"),
      empty: "Enter your email address.",
    },
    {
      input: form.elements.namedItem("message"),
      error: document.getElementById("message-error"),
      empty: "Add a short description of the role or project.",
    },
  ];
  function validate(field) {
    let error = "";
    if (!field.input.value.trim()) error = field.empty;
    else if (field.input.validity.typeMismatch) error = "Enter a valid email address, such as alex@company.com.";
    else if (field.input.validity.tooLong) error = "Shorten this field to fit the character limit.";
    field.error.textContent = error;
    field.error.hidden = !error;
    field.input.setAttribute("aria-invalid", String(Boolean(error)));
    return !error;
  }
  fields.forEach((field) => {
    field.input.addEventListener("input", () => {
      if (field.input.hasAttribute("aria-invalid")) validate(field);
      status.hidden = true;
    });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    status.hidden = true;
    const results = fields.map(validate);
    const firstInvalid = results.indexOf(false);
    if (firstInvalid !== -1) {
      fields[firstInvalid].input.focus();
      return;
    }
    const name = form.elements.namedItem("name").value.trim();
    const email = form.elements.namedItem("email").value.trim();
    const message = form.elements.namedItem("message").value.trim();
    const subject = encodeURIComponent(`Portfolio inquiry from ${name}`);
    const body = encodeURIComponent(`Name: ${name}\nEmail: ${email}\n\n${message}`);
    const draftUrl = `mailto:${contactEmail}?subject=${subject}&body=${body}`;
    const fallback = document.createElement("a");
    fallback.href = draftUrl;
    fallback.textContent = "open the draft again";
    status.replaceChildren(
      "Your email app should open with a draft. If it does not, ",
      fallback,
      ` or email ${contactEmail} directly. Nothing has been sent yet.`,
    );
    status.hidden = false;
    window.location.href = draftUrl;
  });
  form.hidden = false;
}

const copyEmail = document.getElementById("copy-email");
if (copyEmail) copyEmail.hidden = !contactEmail;
copyEmail?.addEventListener("click", async () => {
  if (!contactEmail) return;
  const status = document.getElementById("copy-status");
  copyEmail.disabled = true;
  copyEmail.setAttribute("aria-busy", "true");
  try {
    await navigator.clipboard.writeText(contactEmail);
    status.textContent = "Email address copied.";
  } catch {
    status.textContent = "Copy is unavailable here. Select the email address above.";
  } finally {
    copyEmail.disabled = false;
    copyEmail.removeAttribute("aria-busy");
  }
});

const year = document.getElementById("copyright-year");
if (year) year.textContent = String(new Date().getFullYear());
