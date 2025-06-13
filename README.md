# Portfolio

Static portfolio and browser tools. Plain HTML, CSS, and JavaScript.

## Run locally

```sh
npm run serve
```

Open <http://127.0.0.1:8000>

## Use

- `/` — Browse projects, experience, credentials, and animated extension demos.
- `/scratchpad/` — Create documents. Write, preview, and search Markdown notes.
- `/mermaid/` — Paste Mermaid code for a live preview. Group diagrams into profiles, such as Personal and Work, and move them between profiles. Download PNG, SVG, or Mermaid source.
- `/v0/` — Open the archived portfolio.

Keep notes and diagrams in browser storage. Load fonts and rendering libraries from CDNs.

## Layout

```text
src/
├── index.html, 404.html  # Public entry points
├── shared/               # Theme and assets used across the site
├── site/                 # Portfolio scripts and styles
│   └── demos/            # Extension previews and their assets
├── folio/                # Styles and storage shared by both tools
├── scratchpad/           # Markdown notebook
├── mermaid/              # Diagram editor
└── v0/                   # Archived portfolio
```

Keep files with the page that uses them. Move them to `folio/` when both tools need them, or to `shared/` when the portfolio and tools both use them. Source artwork lives in `design/` outside the deployed tree.

## Check and deploy

- Use Node.js 24 and run `npm ci` to install the pinned formatter.
- Run `npm run check` to check JavaScript syntax and local references under `src/`.
- Run `npm run fmt` to format HTML, CSS, and JavaScript under `src/` and `scripts/`, or `npm run fmt:check` to check without editing files.
- The archived site in `src/v0/` is excluded from syntax and formatting checks.
- Push to `master` to deploy `src/` to GitHub Pages after both checks pass.

[MIT license](LICENSE)
