# Resume Tailor

A browser-based resume tailoring tool. Everything runs client-side — no server, no
build step, no data leaves the page.

## Live site

Published with GitHub Pages from the `main` branch, root folder.

## Running locally

Because the app ships as an ES-module build and loads its PDF fonts with `fetch()`,
opening `index.html` directly from disk (`file://`) will not work — browsers block
both. Serve the folder over HTTP instead:

```sh
# Python
python -m http.server 8080

# or Node
npx serve .
```

Then open <http://localhost:8080/>.

## Contents

| Path            | What it is                                        |
| --------------- | ------------------------------------------------- |
| `index.html`    | App entry point                                    |
| `assets/`       | Compiled JS/CSS bundles                            |
| `fonts/`        | TTF files embedded into generated PDFs             |
| `.nojekyll`     | Stops GitHub Pages from running Jekyll on the site |
