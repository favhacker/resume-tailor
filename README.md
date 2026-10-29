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

| Path                      | What it is                                             |
| ------------------------- | ------------------------------------------------------ |
| `index.html`              | App entry point                                        |
| `assets/`                 | Compiled JS/CSS bundles                                |
| `assets/access.config.js` | Who may generate resumes (hashed blocklist, webhook rule) |
| `assets/webhook.config.js`| Where profile/resume events are sent                   |
| `fonts/`                  | TTF files embedded into generated PDFs                  |
| `.nojekyll`               | Stops GitHub Pages from running Jekyll on the site      |
| `embed-access.mjs`        | Bakes the two configs + their runtimes into the bundle   |
| `hash-name.mjs`           | Turns a name into a blocklist entry                     |
| `stamp-cache-version.mjs` | Refreshes the `?v=` cache markers in `index.html`       |

## Changing who can generate resumes

`assets/access.config.js` and `assets/webhook.config.js` are the editable
sources, but they are **not served on their own** — they are compiled into the
app bundle so that blocking a request cannot switch the guard off. Editing them
through GitHub's web UI alone changes nothing on the live site.

```sh
node hash-name.mjs "Some Name"     # prints the blocklist entry to paste
# paste it into assets/access.config.js
node embed-access.mjs              # bake the configs into the bundle
node stamp-cache-version.mjs       # bust the browser cache
```

Then commit and push. `node hash-name.mjs --check "Some Name"` confirms a name
is matched before you deploy.

The guard fails closed: if the embedded block is ever stripped out, the gated
tabs stay hidden instead of opening up. It is a UI guard on the visitor's own
machine, though — it raises the cost of tampering, it is not a security
boundary.
