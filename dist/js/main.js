const menuBtn = document.querySelector(".menu-btn");
const menu = document.querySelector(".menu");
const menuNav = document.querySelector(".menu-nav");
const menuBranding = document.querySelector(".menu-branding");
const navItems = document.querySelectorAll(".nav-item");
const closeOpen = document.querySelector(".close-open");

let showMenu = false;
// clicking the hamburger menu will give this effect.
menuBtn.addEventListener("click", () => {
  if (!showMenu) {
    menuBtn.classList.add("close");
    menu.classList.add("show");
    menuNav.classList.add("show");
    menuBranding.classList.add("show");
    closeOpen.classList.add("fa-times");
    closeOpen.classList.remove("fa-bars");
    navItems.forEach(item => item.classList.add("show"));
    menuBtn.setAttribute("style", "transform:rotate(90deg)");

    showMenu = true;
  } else {
    menuBtn.classList.remove("close");
    menu.classList.remove("show");
    menuNav.classList.remove("show");
    menuBranding.classList.remove("show");
    closeOpen.classList.remove("fa-times");
    closeOpen.classList.add("fa-bars");
    navItems.forEach(item => item.classList.remove("show"));
    menuBtn.setAttribute("style", "transform:rotate(0deg)");

    showMenu = false;
  }
});
