# Portfolio

A lightweight, single-page static portfolio.

## Features

- Responsive portfolio with a full-height, keyboard-accessible mobile menu
- Light mode by default, with a manual dark mode toggle and saved preference
- Selected projects, career history, technical toolkit, and credentials
- Scroll reveals and a word-by-word tagline, respecting reduced motion


## Tech stack

Vanilla HTML, CSS, and JavaScript. Google Fonts, and Phosphor icons.

## Run locally

Prerequisites: Node.js and Python 3.

```bash
npm run serve
```

Open <http://127.0.0.1:8000>. The command serves the `src` directory.

To check the JavaScript syntax:

```bash
npm run check
```

## Project structure

```text
src/
├── index.html      # Portfolio content and metadata
├── 404.html        # Branded not-found page
├── style.css       # Portfolio styles and themes
├── main.js         # Portfolio interactions and reveals
└── img/            # Avatar, favicon, icons, and social sharing image
```

## License

[MIT](LICENSE)

