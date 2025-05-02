// The interactive workspace is introduced in the following commits.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("button, input, select").forEach((control) => {
    control.disabled = true;
  });
  document.querySelector("#db-status-text").textContent = "Storage pending";
  globalThis.lucide?.createIcons();
});
