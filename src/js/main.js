(function () {
  "use strict";
  /* -- Header scroll behaviour -- */
  const header = document.getElementById("site-header");

  window.addEventListener(
    "scroll",
    () => {
      const scrollY = window.scrollY;
      if (scrollY > 50) {
        header.classList.add("scrolled");
      } else {
        header.classList.remove("scrolled");
      }
    },
    { passive: true }
  );
  /* -- Mobile Menu -- */
  const mobileToggle = document.getElementById("mobile-menu-toggle");
  const navLinksContainer = document.getElementById("nav-links");

  if (mobileToggle && navLinksContainer) {
    function setMobileMenu(open) {
      navLinksContainer.classList.toggle("open", open);
      mobileToggle.setAttribute("aria-expanded", String(open));
      mobileToggle.setAttribute(
        "aria-label",
        open ? "Close navigation menu" : "Open navigation menu"
      );
    }

    mobileToggle.addEventListener("click", () => {
      setMobileMenu(!navLinksContainer.classList.contains("open"));
    });

    navLinksContainer.querySelectorAll(".nav-link").forEach((link) => {
      link.addEventListener("click", () => setMobileMenu(false));
    });

    document.addEventListener("click", (e) => {
      if (
        navLinksContainer.classList.contains("open") &&
        !navLinksContainer.contains(e.target) &&
        !mobileToggle.contains(e.target)
      ) {
        setMobileMenu(false);
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && navLinksContainer.classList.contains("open")) {
        setMobileMenu(false);
        mobileToggle.focus();
      }
    });
  }
  /* -- Theme Toggle -- */
  const themeToggle = document.getElementById("theme-toggle");
  const metaColorScheme = document.querySelector('meta[name="color-scheme"]');

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    metaColorScheme.content = theme;
    localStorage.setItem("color-scheme", theme);
  }

  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "light" : "dark");
  });

  // Listen for system theme changes
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!localStorage.getItem("color-scheme")) {
        document.documentElement.dataset.theme = e.matches ? "dark" : "light";
      }
    });
  /* -- Role Text Rotation -- */
  const roles = [
    "Senior Software Engineer",
    "Full-Stack Developer",
    "REST API Specialist",
    ".NET & Node.js Engineer",
    "Microservices Architect",
    "Open-Source Contributor",
  ];
  let roleIndex = 0;
  const roleEl = document.getElementById("rotating-role");

  function rotateRole() {
    roleEl.style.opacity = "0";
    roleEl.style.transform = "translateY(12px)";

    setTimeout(() => {
      roleIndex = (roleIndex + 1) % roles.length;
      roleEl.textContent = roles[roleIndex];
      roleEl.style.opacity = "1";
      roleEl.style.transform = "translateY(0)";
    }, 400);
  }

  setInterval(rotateRole, 3000);

})();
