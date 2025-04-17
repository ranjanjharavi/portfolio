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

})();
