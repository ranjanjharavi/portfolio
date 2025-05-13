(() => {
  "use strict";

  const root = document.documentElement;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const stillMode = new URLSearchParams(location.search).has("still");
  const themeToggle = document.getElementById("theme-toggle");

  function applyTheme(theme) {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content", theme === "dark" ? "#181818" : "#f6f7f4"
    );
    themeToggle?.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
    themeToggle?.setAttribute("aria-pressed", String(theme === "dark"));
  }

  applyTheme(root.dataset.theme === "dark" ? "dark" : "light");
  themeToggle?.addEventListener("click", () => {
    const theme = root.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    try { localStorage.setItem("color-scheme", theme); } catch {}
  });

  // The native menu dialog provides focus containment, Escape, and focus restoration.
  const mobileMenu = document.getElementById("mobile-menu");
  const menuToggle = document.getElementById("mobile-menu-toggle");
  if (mobileMenu && menuToggle) {
    function closeMenu() { mobileMenu.close(); }
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
  const hasObserver = "IntersectionObserver" in window;
  const motionAllowed = () => hasObserver && !reducedMotion.matches && !stillMode;
  const storyDuration = 6;
  let storiesPaused = false;
  let storyFrame = null;
  let previousFrame = null;

  // Evaluate the same in/out curve as --io, including its non-linear x axis.
  function easeInOut(progress) {
    let t = progress;
    for (let i = 0; i < 5; i++) {
      t -= (1.95 * t - 2.85 * t * t + 1.9 * t * t * t - progress)
        / (1.95 - 5.7 * t + 5.7 * t * t);
    }
    return t * t * (3 - 2 * t);
  }

  function track(keys, time) {
    if (time <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [end, to] = keys[i];
      const [start, from] = keys[i - 1];
      if (time <= end) return from + (to - from) * easeInOut((time - start) / (end - start));
    }
    return keys[keys.length - 1][1];
  }

  function focusNode(node, amount) {
    node.style.setProperty("--story-focus", amount.toFixed(3));
    node.style.setProperty("--story-scale", (1 + amount * 0.2).toFixed(3));
  }

  function resolveNode(node, amount, distance = 6) {
    if (amount === 1) {
      ["opacity", "filter", "transform"].forEach((property) => node.style.removeProperty(property));
      return;
    }
    node.style.opacity = String(0.35 + amount * 0.65);
    node.style.filter = `blur(${(1 - amount) * 4}px)`;
    node.style.transform = `translateY(${(1 - amount) * distance}px)`;
  }

  // Preserve the original text and its line wrapping. Only an aria-hidden copy types.
  function prepareTyping(target) {
    const text = target.textContent;
    const original = document.createElement("span");
    original.textContent = text;
    const visual = document.createElement("span");
    visual.className = "typing-visual";
    visual.setAttribute("aria-hidden", "true");
    const characters = Array.from(text, (character) => {
      const span = document.createElement("span");
      span.className = "typing-char";
      span.textContent = character;
      visual.append(span);
      return span;
    });
    target.classList.add("typing-target");
    target.replaceChildren(original, visual);
    let previousCount = -1;
    return {
      length: characters.length,
      draw(count, time) {
        if (count !== previousCount) {
          characters.forEach((character, index) => {
            character.style.opacity = index < count ? "1" : "0";
            character.classList.toggle("is-current", index === count - 1 && count < characters.length);
          });
          original.style.opacity = count === characters.length ? "1" : "0";
          visual.style.opacity = count === characters.length ? "0" : "1";
          previousCount = count;
        }
        visual.style.setProperty("--caret-opacity", String(Math.floor(time * 2) % 2));
      },
    };
  }

  function makeStory(element) {
    const nodes = element.querySelectorAll(".system-layer, .demo-field, .request-rule");
    nodes.forEach((node) => node.classList.add("story-node"));

    if (element.dataset.story === "system") {
      const layers = element.querySelectorAll(".system-layer");
      const connectors = element.querySelectorAll(".system-connector");
      return (time) => {
        layers.forEach((layer, index) => {
          const start = 0.3 + index * 1.8;
          focusNode(layer, track([[0, 0], [start, 0], [start + 0.35, 1], [start + 1.1, 1], [start + 1.5, 0], [storyDuration, 0]], time));
        });
        connectors.forEach((connector, index) => {
          const start = 1.2 + index * 1.8;
          const opacity = track([[0, 0], [start, 0], [start + 0.2, 1], [start + 0.8, 1], [start + 1, 0], [storyDuration, 0]], time);
          const y = track([[0, -10], [start, -10], [start + 1, 32], [storyDuration, 32]], time);
          connector.style.setProperty("--packet-opacity", opacity.toFixed(3));
          connector.style.setProperty("--packet-y", `${y.toFixed(3)}px`);
        });
      };
    }

    if (element.dataset.story === "bookmark") {
      const source = element.querySelector(".demo-field");
      const result = element.querySelector(".demo-result");
      const arrow = element.querySelector(".demo-arrow .icon");
      const typing = prepareTyping(result.querySelector("strong"));
      const deleteStart = 0.6;
      const deleteEnd = deleteStart + typing.length * 0.035;
      const typeStart = deleteEnd + 0.3;
      const typeEnd = typeStart + typing.length * 0.06;
      return (time) => {
        let count = typing.length;
        if (time >= deleteStart && time < deleteEnd) count -= Math.floor((time - deleteStart) / 0.035);
        else if (time >= deleteEnd && time < typeStart) count = 0;
        else if (time >= typeStart && time < typeEnd) count = Math.floor((time - typeStart) / 0.06);
        typing.draw(count, time);
        focusNode(source, track([[0, 0], [0.3, 1], [1.1, 1], [1.6, 0], [storyDuration, 0]], time));
        resolveNode(result, track([[0, 1], [deleteStart, 1], [deleteEnd, 0.3], [typeStart, 0.3], [typeStart + 0.7, 1], [storyDuration, 1]], time));
        const y = track([[0, 0], [deleteEnd, 0], [typeStart, 6], [typeStart + 0.7, 0], [storyDuration, 0]], time);
        arrow.style.transform = y ? `translateY(${y}px)` : "";
      };
    }

    if (element.dataset.story === "url") {
      const source = element.querySelector(".demo-field");
      const result = element.querySelector(".demo-result");
      const arrow = element.querySelector(".demo-arrow .icon");
      const token = element.querySelector(".url-token");
      return (time) => {
        focusNode(source, track([[0, 0], [0.4, 1], [1.2, 1], [1.7, 0], [storyDuration, 0]], time));
        resolveNode(result, track([[0, 1], [0.6, 1], [1.1, 0.2], [2.2, 0.2], [3.1, 1], [storyDuration, 1]], time));
        const opacity = track([[0, 1], [0.6, 1], [1, 0], [2.2, 0], [2.9, 1], [storyDuration, 1]], time);
        token.style.opacity = String(opacity);
        token.style.filter = `blur(${(1 - opacity) * 4}px)`;
        const y = track([[0, 0], [1.2, 0], [1.9, 6], [2.6, 0], [storyDuration, 0]], time);
        arrow.style.transform = y ? `translateY(${y}px)` : "";
        focusNode(result, track([[0, 0], [2.7, 0], [3.1, 1], [4, 1], [4.6, 0], [storyDuration, 0]], time));
      };
    }

    const host = element.querySelector(".request-rule");
    const header = element.querySelector(".rule-header");
    const status = element.querySelector(".rule-status");
    const badge = element.querySelector(".demo-badge");
    return (time) => {
      focusNode(host, track([[0, 0], [0.5, 1], [1.4, 1], [2, 0], [storyDuration, 0]], time));
      resolveNode(header, track([[0, 1], [0.6, 1], [1.2, 0.15], [2, 0.15], [2.9, 1], [storyDuration, 1]], time), 10);
      status.style.opacity = String(track([[0, 1], [0.6, 1], [1.1, 0.35], [2.3, 0.35], [2.9, 1], [storyDuration, 1]], time));
      focusNode(header, track([[0, 0], [2.4, 0], [2.9, 1], [3.8, 1], [4.4, 0], [storyDuration, 0]], time));
      const scale = track([[0, 1], [3, 1], [3.35, 1.12], [3.7, 1], [storyDuration, 1]], time);
      badge.style.transform = scale === 1 ? "" : `scale(${scale})`;
    };
  }

  const stories = Array.from(document.querySelectorAll("[data-story]"), (element, index) => ({
    element,
    draw: makeStory(element),
    elapsed: 0,
    offset: index * 0.6,
    visible: false,
  }));

  function stopStoryClock() {
    if (storyFrame !== null) cancelAnimationFrame(storyFrame);
    storyFrame = null;
    previousFrame = null;
  }

  function shouldRunStories() {
    return motionAllowed() && !storiesPaused && !document.hidden && !mobileMenu?.open
      && stories.some((story) => story.visible);
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
      if (!story.visible || !story.element.classList.contains("is-visible")) return;
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
      items = element.querySelectorAll(".preview-toolbar, .url-demo, .reqkit-demo, .open-source-art > *, .project-content > *");
    } else if (element.matches(".system-visual")) {
      items = element.querySelectorAll(".visual-top, .system-layer, .system-connector, figcaption");
    }
    items.forEach((item, index) => {
      item.classList.add("motion-item");
      item.style.setProperty("--item-delay", `${150 + index * 60}ms`);
    });
  });

  let revealObserver;
  if (hasObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      const sectionStaggers = new Map();
      entries.forEach((entry) => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.3) return;
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
    }, { threshold: 0.3 });
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

  // Two paints establish the empty state before CSS transitions are triggered.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    heroElements.forEach((element) => element.classList.add("is-visible"));
    root.classList.add("motion-initialized");
  }));

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

  motionToggle?.addEventListener("click", () => {
    storiesPaused = !storiesPaused;
    const label = `${storiesPaused ? "Resume" : "Pause"} visual animations`;
    motionToggle.setAttribute("aria-pressed", String(storiesPaused));
    motionToggle.setAttribute("aria-label", label);
    motionToggle.title = label;
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
      .map((node) => node.nodeName === "BR" ? " " : node.textContent).join("").replace(/\s+/g, " ").trim();
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
    return links.map((link) => ({
      link,
      section: document.querySelector(link.getAttribute("href")),
    })).filter((item) => item.section).sort((a, b) =>
      a.section.compareDocumentPosition(b.section) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    );
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
  const form = document.getElementById("contact-form");
  if (form) {
    form.noValidate = true;
    const status = document.getElementById("form-status");
    const fields = [
      { input: form.elements.namedItem("name"), error: document.getElementById("name-error"), empty: "Enter your name." },
      { input: form.elements.namedItem("email"), error: document.getElementById("email-error"), empty: "Enter your email address." },
      { input: form.elements.namedItem("message"), error: document.getElementById("message-error"), empty: "Add a short description of the role or project." },
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
      const draftUrl = `mailto:hey@raviranjanjha.com?subject=${subject}&body=${body}`;
      const fallback = document.createElement("a");
      fallback.href = draftUrl;
      fallback.textContent = "open the draft again";
      status.replaceChildren("Your email app should open with a draft. If it does not, ", fallback,
        " or email hey@raviranjanjha.com directly. Nothing has been sent yet.");
      status.hidden = false;
      window.location.href = draftUrl;
    });
  }

  const copyEmail = document.getElementById("copy-email");
  copyEmail?.addEventListener("click", async () => {
    const status = document.getElementById("copy-status");
    copyEmail.disabled = true;
    copyEmail.setAttribute("aria-busy", "true");
    try {
      await navigator.clipboard.writeText("hey@raviranjanjha.com");
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
})();
