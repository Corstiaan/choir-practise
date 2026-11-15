# Choir practice

A static practice site for choir pieces. Per song it plays every part, lets each
singer mix the parts, and follows the printed score line by line with a moving
highlighter.

```
site/     the website: upload this folder to your web host
tools/    the build pipeline that turns a MuseScore file + score PDF into a song
```

## Put it online

Upload the contents of `site/` to any web host (FTP is fine). There is no
server-side code and nothing to install. It also runs straight from disk:
double-click `site/index.html`.

Open a specific song with `index.html?song=rudolph`.

### Keep it private

The site shows the printed score, so keep it to the singers who hold a licensed
copy. On Apache hosting:

1. Rename `site/.htaccess.example` to `.htaccess`.
2. Create a password file with `htpasswd -c .htpasswd choir` and upload it
   outside the web root if you can.
3. Set `AuthUserFile` in `.htaccess` to the absolute server path of that file.

`index.html` already asks search engines not to index the page.

## What singers can do

- Play, pause, stop, step by measure.
- Mixer per part (volume, mute, solo), a click track, and three presets tied to
  "I sing": everyone, my part louder, without my part.
- Tempo from 40 to 130 percent without changing pitch.
- Loop: drag across the timeline, type measure numbers, or loop the current line.
- Count-in of one measure, optional metronome click.
- Click a measure in the score or on the timeline to jump there.
- Keys: Space play/pause, arrows one measure, Home to the start, L loop.

Settings are remembered per browser.

## Add or rebuild a song

Requirements: Node 18 or newer, Python 3.10 or newer.

```
cd tools
npm install
pip install pymupdf opencv-python-headless numpy pillow
```

1. Copy the MuseScore file and the score PDF into `tools/songs/`.
2. Write `tools/songs/<id>.json` (copy one of the two that are there).
3. Run `python3 build_song.py songs/<id>.json`.

The result lands in `site/songs/<id>/` and the song list `site/songs/index.js`
is updated. The source files for the two existing songs are not in this
package: copy yours in as `rudolph.mscz`, `rudolph.pdf`, `christmas-magic.mscz`
and `christmas-magic.pdf`.

### Config fields

| Field | Meaning |
| --- | --- |
| `id`, `title`, `subtitle`, `order` | Folder name, texts, position in the song list |
| `mscz`, `pdf` | File names inside `tools/songs/` |
| `tempo` | Quarter notes per minute. Needed when the MuseScore file has no tempo mark (it then plays at 120) |
| `swing` | `0` for straight eighths, `0.667` for triplet swing |
| `marks` | Measure numbers to box on the timeline, on top of rehearsal marks found in the file |
| `channels` | One mixer strip each: `id`, `name`, `kind` (`voice` or `piano`), `part` (part name in MuseScore), optional `staff`, optional `pick` |
| `skipSystems` | 1-based numbers of systems on the PDF to ignore |
| `imageWidth`, `imageQuality` | Size and WebP quality of the system images (default 2000 and 72) |

`pick` splits two singers who share one staff: `top` takes the upper note of
each chord, `bottom` the rest, and a single note counts as unison for both.
With two voices in a measure, voice 1 is the upper singer. If you give every
singer a staff of their own in MuseScore you do not need `pick`.

### How the pieces fit

- `export.cjs` reads the .mscz with webmscore (MuseScore as WebAssembly) and
  writes MusicXML and MIDI.
- Notes, dynamics and measure lengths come from the MusicXML. The tempo map
  (fermatas, tempo changes) comes from the MIDI.
- `layout.py` finds staves, systems and barlines on the PDF pages. The build
  stops if the PDF and the MuseScore file disagree on the number of measures.
- Inside a measure the highlighter follows MuseScore's note spacing, mapped
  onto the printed measure.

After a build, look at `tools/build/<id>/debug/`: red lines are barlines, green
ticks are where the highlighter stops for each note.

### Getting better sound

The notes are exactly what is in the MuseScore file. Anything the scan
recognition got wrong is audible, so fix it in MuseScore and rebuild.

## Credits

- Piano samples: FluidR3_GM soundfont by Frank Wen, CC BY 3.0, via
  github.com/gleitz/midi-js-soundfonts.
- Font: Atkinson Hyperlegible, Braille Institute, SIL Open Font License.
- Build tool: webmscore by LibreScore (GPL), used at build time only.
