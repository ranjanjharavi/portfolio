(() => {
  // Keep these in sync with --bg in theme.css.
  const THEME_COLORS = { dark: "#181818", light: "#f6f7f4" };
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  let preference;
  try {
    preference = localStorage.getItem("color-scheme");
  } catch {}

  function applyTheme() {
    const theme = preference === "light" || preference === "dark" ? preference : systemTheme.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
    const toggle = document.getElementById("theme-toggle");
    toggle?.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
    toggle?.setAttribute("aria-pressed", String(theme === "dark"));
  }

  applyTheme();
  systemTheme.addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.key === "color-scheme" || event.key === null) {
      preference = event.newValue;
      applyTheme();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("theme-toggle");
    if (!toggle) return;
    toggle.hidden = false;
    applyTheme();
    toggle.addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme();
      try {
        localStorage.setItem("color-scheme", preference);
      } catch {}
    });
  });
})();
