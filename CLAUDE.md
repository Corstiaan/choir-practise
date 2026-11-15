# Choir practice app

Static practice site for choir pieces: plays every part, per-singer mixer, and
follows the printed score with a moving highlighter. See README.md for the
feature list and the song build pipeline.

## Layout

- `site/` is the deployable website. Plain HTML/CSS/JS, no build step, no
  framework, no server-side code. It must keep working from `file://`
  (songs load as `.js` files, not fetched JSON, for that reason).
  - `js/app.js` UI and score following, `js/audio.js` Web Audio engine,
    `js/piano-samples.js` embedded samples (generated, do not hand-edit).
  - `songs/<id>/` is build output (`song.js` + `sys-NN.webp`); regenerate via
    the tools, do not hand-edit.
- `tools/` is the build pipeline (Node + Python) that turns a MuseScore file
  and score PDF into `site/songs/<id>/`. Source `.mscz`/`.pdf` files are
  gitignored (licensed material).

## Working here

- Preview: the `site` config in `.claude/launch.json` serves `site/` on
  port 8123.
- Current priorities: phone/tablet experience and look/usability. Singers are
  not technical; favour large touch targets and plain wording.
- The score images are licensed: the GitHub repo stays private and the hosted
  site stays behind a password.
- Remote: `git@github.com:Corstiaan/choir-practise.git` (SSH), branch `main`.
- The folder lives in Synology Drive. Avoid committing from two machines at
  once; `.git` sync conflicts corrupt the repo.
