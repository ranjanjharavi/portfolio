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
  /* -- Starfield Canvas -- */
  const canvas = document.getElementById("starfield");
  const ctx = canvas.getContext("2d");
  let stars = [];
  const STAR_COUNT = 220;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function createStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        radius: Math.random() * 1.6 + 0.3,
        opacity: Math.random() * 0.7 + 0.3,
        speed: Math.random() * 0.3 + 0.05,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }
  }

  function drawStars(time) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    stars.forEach((star) => {
      const flicker =
        Math.sin(time * star.twinkleSpeed + star.twinklePhase) * 0.3 + 0.7;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity * flicker})`;
      ctx.fill();

      // Slow drift upward
      star.y -= star.speed;
      if (star.y < -5) {
        star.y = canvas.height + 5;
        star.x = Math.random() * canvas.width;
      }
    });
    requestAnimationFrame(drawStars);
  }

  resizeCanvas();
  createStars();
  requestAnimationFrame(drawStars);

  window.addEventListener("resize", () => {
    resizeCanvas();
    createStars();
  });
  /* -- Skills Tabs -- */
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;

      tabButtons.forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");

      tabPanels.forEach((panel) => {
        panel.classList.remove("active");
        panel.hidden = true;
      });

      const target = document.getElementById(`tab-${targetTab}`);
      if (target) {
        target.classList.add("active");
        target.hidden = false;
      }
    });
  });

  /* -- Scroll-to-Top Button -- */
  const scrollTopBtn = document.getElementById("scroll-top");

  window.addEventListener(
    "scroll",
    () => {
      if (window.scrollY > 500) {
        scrollTopBtn.classList.add("visible");
      } else {
        scrollTopBtn.classList.remove("visible");
      }
    },
    { passive: true }
  );

  scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

})();
