(() => {
  "use strict";

  const root = document.documentElement;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
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

  // Sections reveal once. No JavaScript leaves all content readable.
  const revealElements = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: "0px 0px -24px 0px" });
    revealElements.forEach((element) => {
      element.classList.add("reveal-pending");
      observer.observe(element);
    });
  }

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
      const count = reducedMotion.matches ? words.length : Math.floor(progress * words.length);
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
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) revealElements.forEach((element) => element.classList.add("is-visible"));
    requestViewportUpdate();
  });
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
