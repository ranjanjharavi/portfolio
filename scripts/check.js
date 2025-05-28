const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = "src";
const BASE_URL = "https://local.invalid";

const extractors = {
  ".html": (src) => matchAll(src, /\b(?:href|src)=["']([^"']+)["']/gi),
  ".js": (src) => matchAll(src, /\b(?:from|import)\s*\(?["'](\.?\.?\/[^"']+)["']/g),
  ".css": (src) => matchAll(src, /url\(\s*["']?([^"')]+)["']?\s*\)/gi),
};

function matchAll(text, regex) {
  return [...text.matchAll(regex)].map((match) => match[1]);
}

function isLocalRefValid(file, ref) {
  if (!ref || ref.startsWith("#")) return true;

  try {
    const url = new URL(ref, `${BASE_URL}/${file.replaceAll(path.sep, "/")}`);
    if (url.origin !== BASE_URL) return true; // external link (http, mailto, //cdn, etc.)

    const target = path.join(ROOT, decodeURIComponent(url.pathname));
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    return Boolean(
      stat?.isFile() || (stat?.isDirectory() && fs.existsSync(path.join(target, "index.html"))),
    );
  } catch {
    return false;
  }
}

function main() {
  const files = fs
    .readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)))
    .filter((f) => !f.split(path.sep).some((part) => part.startsWith(".")))
    .filter((f) => path.extname(f) in extractors);

  for (const file of files) {
    const fullPath = path.join(ROOT, file);
    const ext = path.extname(file);

    if (ext === ".js") {
      console.log(`Checking ${file}...`);
      try {
        execFileSync(process.execPath, ["--check", fullPath], { stdio: "inherit" });
      } catch {
        process.exitCode = 1;
      }
    }

    const source = fs.readFileSync(fullPath, "utf8");
    for (const ref of extractors[ext](source)) {
      if (!isLocalRefValid(file, ref)) {
        console.error(`${ROOT}/${file}: missing local reference ${ref}`);
        process.exitCode = 1;
      }
    }
  }
}

main();