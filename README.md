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
| `assets/access.config.js` | Who may generate resumes (access codes, hashed blocklist, webhook rule) |
| `assets/webhook.config.js`| Where profile/resume events are sent                   |
| `fonts/`                  | TTF files embedded into generated PDFs                  |
| `.nojekyll`               | Stops GitHub Pages from running Jekyll on the site      |
| `embed-access.mjs`        | Bakes the two configs + their runtimes into the bundle   |
| `hash-name.mjs`           | Issues access codes, and turns a name into a blocklist entry |
| `stamp-cache-version.mjs` | Refreshes the `?v=` cache markers in `index.html`       |

## Changing who can generate resumes

`assets/access.config.js` and `assets/webhook.config.js` are the editable
sources, but they are **not served on their own** — they are compiled into the
app bundle so that blocking a request cannot switch the guard off. Editing them
through GitHub's web UI alone changes nothing on the live site.

Four rules decide whether the Preview tab (and so resume generation) is
available. Any one of them failing hides it:

| Rule          | Config key          | What it checks                            |
| ------------- | ------------------- | ----------------------------------------- |
| Access code   | `requireAccessCode` | the profile holds a code you issued       |
| Blocklist     | `blocklist`         | the profile name is not on the list       |
| Name shape    | `nameRules`         | the name could be somebody's name at all  |
| Webhook       | `requireWebhook`    | an endpoint is selected under Integrations |

### Access codes — the one to reach for

The blocklist names the people who may **not** generate, so it has to be
widened every time somebody retypes their name, and each widening also catches
strangers whose name happens to start the same way. Access codes invert that:
only a profile holding an issued code gets in, so editing the Profile tab buys
nothing.

```sh
node hash-name.mjs --new-code 3    # issue three codes; prints them ONCE
# paste the lines it prints into `accessCodes` in assets/access.config.js
node embed-access.mjs              # bake the configs into the bundle
node stamp-cache-version.mjs       # bust the browser cache
```

Hand each person one code. The config stores only the digest, so a code nobody
wrote down has to be reissued. `node hash-name.mjs --check-code "ABCDE-FGHJK"`
confirms one against the list as it stands. To revoke somebody, delete their
line and redeploy — nobody else is affected.

Two things to know. A code identifies an issue of access, not a person, so
whoever it is passed to can use it until you delete that entry. And `note:`
fields ship inside the bundle to every visitor, so keep names out of them —
a name in a note undoes the point of hashing the list.

If `accessCodes` is empty the rule is ignored rather than enforced, so turning
the flag on before issuing a code cannot lock you out of your own app.

### Blocking a name

```sh
node hash-name.mjs "Some Name"     # prints the blocklist entry to paste
# paste it into assets/access.config.js
node embed-access.mjs
node stamp-cache-version.mjs
```

`node hash-name.mjs --check "Some Name"` confirms a name is matched before you
deploy. Matching runs on a folded *skeleton* of the name, so accents, fullwidth
characters and lookalikes (`CarI` for `Carl`, `Kev1n`, `Jam3s`) match too. The
cost is that `i` and `l` are deliberately merged, because nothing distinguishes
them on screen — names differing only by those letters will collide.

Then commit and push.

The guard fails closed: if the embedded block is ever stripped out, the gated
tabs stay hidden instead of opening up. It is a UI guard on the visitor's own
machine, though — it raises the cost of tampering, it is not a security
boundary.
