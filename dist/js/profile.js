let index = 0;
let deleting = false;

const abc = () => {
  const type = document.getElementById("effect");
  const text = type.getAttribute("data-word");
  let displayText = "";

  displayText = text.substring(0, index);
  type.innerHTML = '<span class="typewriter">' + displayText + "</span>";

  if (deleting) index -= 1;
  else index += 1;

  if (index === text.length + 1) deleting = true;
  else if (index === 0) deleting = false;

  setTimeout(abc, 300);
};
abc();
