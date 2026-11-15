#!/usr/bin/env python3
"""Build one song for the choir practice site.

    python3 build_song.py songs/<id>.json

Inputs (named in the config): a MuseScore file (.mscz) and the score PDF.
Output: ../site/songs/<id>/song.js plus one image per system of the score.

Pipeline
  1. export.cjs (webmscore) turns the .mscz into MusicXML and MIDI.
  2. MusicXML gives notes, measures, dynamics and MuseScore's note spacing.
  3. The MIDI file gives the tempo map (fermatas, tempo changes).
  4. layout.py finds systems and barlines on the PDF pages.
  5. Everything is merged into song.js; the PDF is cut into system images.
"""
import json
import math
import os
import statistics
import struct
import subprocess
import sys
import warnings
import xml.etree.ElementTree as ET

warnings.filterwarnings("ignore", category=DeprecationWarning)
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import layout  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
DETECT_DPI = 200


# ----------------------------------------------------------------- MIDI tempo
def read_tempo_map(mid_path):
    """Return [(quarter_position, bpm)] from the tempo events of a MIDI file."""
    with open(mid_path, "rb") as _f:
        d = _f.read()
    ntracks, div = struct.unpack(">HH", d[10:14])
    p = 14
    out = []

    def vlq(q):
        v = 0
        while True:
            b = d[q]
            q += 1
            v = (v << 7) | (b & 0x7F)
            if not b & 0x80:
                return v, q

    for _ in range(ntracks):
        ln = struct.unpack(">I", d[p + 4:p + 8])[0]
        q, end = p + 8, p + 8 + ln
        p = end
        tick, status = 0, 0
        while q < end:
            dt, q = vlq(q)
            tick += dt
            b = d[q]
            if b == 0xFF:
                kind = d[q + 1]
                ln2, q2 = vlq(q + 2)
                if kind == 0x51:
                    out.append((tick / div, 60000000 / int.from_bytes(d[q2:q2 + ln2], "big")))
                q = q2 + ln2
            elif b in (0xF0, 0xF7):
                ln2, q2 = vlq(q + 1)
                q = q2 + ln2
            else:
                if b & 0x80:
                    status = b
                    q += 1
                q += 1 if (status & 0xF0) in (0xC0, 0xD0) else 2
    out.sort()
    if not out or out[0][0] > 0:
        out.insert(0, (0.0, 120.0))
    return out


class Clock:
    """Maps a position in quarter notes to seconds."""

    def __init__(self, tempo_map, tempo_override=None, swing=0.0):
        scale = (tempo_map[0][1] / tempo_override) if tempo_override else 1.0
        self.base_bpm = tempo_override or tempo_map[0][1]
        self.swing = swing
        self.segs = []
        t = 0.0
        for i, (q, bpm) in enumerate(tempo_map):
            if i:
                pq, pbpm = tempo_map[i - 1]
                t += (q - pq) * 60.0 / pbpm * scale
            self.segs.append((q, t, 60.0 / bpm * scale))

    def warp(self, q):
        """Swing: an eighth note off the beat is played late."""
        if self.swing:
            b = math.floor(q + 1e-9)
            if abs(q - b - 0.5) < 1e-3:
                return b + self.swing
        return q

    def at(self, q):
        q = self.warp(q)
        seg = self.segs[0]
        for s in self.segs:
            if s[0] <= q + 1e-9:
                seg = s
            else:
                break
        return seg[1] + (q - seg[0]) * seg[2]


# ------------------------------------------------------------------ MusicXML
def parse_musicxml(path):
    root = ET.parse(path).getroot()
    names = {sp.get("id"): (sp.findtext("part-name") or sp.get("id")) for sp in root.find("part-list").findall("score-part")}
    measures, parts = [], []
    for pi, part in enumerate(root.findall("part")):
        pid = part.get("id")
        notes = []
        div, vel = 1, 80
        key, beats, beat_type = 0, 4, 4
        for mi, m in enumerate(part.findall("measure")):
            if pi == 0:
                measures.append({"number": m.get("number"), "len": 0.0, "width": float(m.get("width") or 0),
                                 "ms_first": mi == 0, "header": False, "marks": [], "xs": {}})
            meas = measures[mi]
            cur = last_onset = maxcur = 0
            for el in m:
                tag = el.tag
                if tag == "attributes":
                    if el.findtext("divisions"):
                        div = int(el.findtext("divisions"))
                    if pi == 0:
                        if el.find("key") is not None:
                            key = int(el.findtext("key/fifths") or 0)
                            meas["header"] = meas["header"] or (mi > 0 and cur == 0)
                        if el.find("time") is not None:
                            beats = int(el.findtext("time/beats") or 4)
                            beat_type = int(el.findtext("time/beat-type") or 4)
                            meas["header"] = meas["header"] or (mi > 0 and cur == 0)
                            meas["time_shown"] = True
                elif tag == "note":
                    if el.find("grace") is not None:
                        continue
                    dur = int(el.findtext("duration") or 0)
                    chord = el.find("chord") is not None
                    onset = last_onset if chord else cur
                    if not chord:
                        cur += dur
                        last_onset = onset
                    maxcur = max(maxcur, cur)
                    if el.find("rest") is not None or el.find("pitch") is None:
                        continue
                    p = el.find("pitch")
                    midi = 12 * (int(p.findtext("octave")) + 1) + STEP[p.findtext("step")] + int(float(p.findtext("alter") or 0))
                    ties = {t.get("type") for t in el.findall("tie")}
                    x = el.get("default-x")
                    notes.append({"m": mi, "q": onset / div, "d": dur / div, "midi": midi, "vel": vel,
                                  "staff": int(el.findtext("staff") or 1), "voice": int(el.findtext("voice") or 1),
                                  "tie_start": "start" in ties, "tie_stop": "stop" in ties})
                    if x is not None:
                        meas["xs"].setdefault(round(onset / div, 5), []).append(float(x))
                elif tag == "backup":
                    cur -= int(el.findtext("duration") or 0)
                elif tag == "forward":
                    cur += int(el.findtext("duration") or 0)
                    maxcur = max(maxcur, cur)
                elif tag in ("direction", "sound"):
                    snd = el if tag == "sound" else el.find("sound")
                    if snd is not None and snd.get("dynamics"):
                        vel = int(max(30, min(120, float(snd.get("dynamics")) * 0.9)))
                    reh = el.find("direction-type/rehearsal") if tag == "direction" else None
                    if reh is not None and (reh.text or "").strip() and pi == 0:
                        meas["marks"].append(reh.text.strip())
                elif tag == "print" and pi == 0:
                    if el.get("new-system") == "yes" or el.get("new-page") == "yes":
                        meas["ms_first"] = True
                elif tag == "barline" and el.find("repeat") is not None:
                    meas["repeat"] = True
            meas["len"] = max(meas["len"], maxcur / div)
            if pi == 0:
                meas.update(key=key, beats=beats, beat_type=beat_type)
        parts.append({"id": pid, "name": names.get(pid, pid), "notes": notes})
    q = 0.0
    for meas in measures:
        meas["q"] = q
        q += meas["len"]
    # a short first measure is a pickup: printed scores start counting after it
    first = measures[0]
    if len(measures) > 1 and first["len"] < first["beats"] * 4 / first["beat_type"] - 1e-6 and first["number"] == "1":
        for i, meas in enumerate(measures):
            meas["number"] = str(i)
    return parts, measures, q


# ------------------------------------------------------------------ channels
def find_part(parts, ref):
    for i, p in enumerate(parts):
        if ref in (p["id"], p["name"], i + 1):
            return p
    raise SystemExit(f"config: no part {ref!r}; the file has {[p['name'] for p in parts]}")


def pick_notes(part, pick, staff=None):
    """pick = all | top | bottom. Splits two singers who share one staff:
    two voices in a measure -> voice 1 is the upper singer, voice 2 the lower;
    one voice -> top note / remaining notes of each chord, a single note is unison."""
    notes = [n for n in part["notes"] if staff is None or n["staff"] == staff]
    if pick == "all":
        return notes
    by_measure = {}
    for n in notes:
        by_measure.setdefault(n["m"], []).append(n)
    out = []
    for mi, ns in by_measure.items():
        voices = sorted({n["voice"] for n in ns})
        groups = {}
        for n in ns:
            groups.setdefault((n["voice"], round(n["q"], 5)), []).append(n)
        for (voice, _), g in groups.items():
            g.sort(key=lambda n: -n["midi"])
            if len(voices) >= 2:
                if voice == voices[0]:
                    out += [g[0]] if pick == "top" else g[1:]
                elif pick == "bottom":
                    out += g
            elif len(g) == 1:
                out += g
            else:
                out += [g[0]] if pick == "top" else g[1:]
    out.sort(key=lambda n: (n["m"], n["q"], n["midi"]))
    return out


def to_events(notes, measures, clock):
    """Merge ties and convert to [start_sec, dur_sec, midi, velocity]."""
    merged, open_ties = [], {}
    for n in sorted(notes, key=lambda n: (measures[n["m"]]["q"] + n["q"], n["midi"])):
        qa = measures[n["m"]]["q"] + n["q"]
        qb = qa + n["d"]
        key = n["midi"]
        prev = open_ties.get(key)
        if n["tie_stop"] and prev is not None and abs(prev[1] - qa) < 1e-4:
            prev[1] = qb
            if not n["tie_start"]:
                del open_ties[key]
            continue
        ev = [qa, qb, n["midi"], n["vel"]]
        merged.append(ev)
        if n["tie_start"]:
            open_ties[key] = ev
        else:
            open_ties.pop(key, None)
    out = []
    for qa, qb, midi, vel in merged:
        ta, tb = clock.at(qa), clock.at(qb)
        out.append([round(ta, 4), round(max(0.06, tb - ta), 4), midi, vel])
    out.sort()
    return out


# ------------------------------------------------- note spacing -> score scan
def spacing_fractions(measures):
    """For every measure: [(q, u)] with u in 0..1 between first note and end barline,
    taken from MuseScore's own layout of the same music."""
    known = {True: [], False: []}
    for m in measures:
        m["pts"] = sorted((q, statistics.median(xs)) for q, xs in m["xs"].items())
        if m["pts"] and m["pts"][0][0] == 0 and m["width"]:
            known[m["ms_first"] or m["header"]].append(m["pts"][0][1])
    default = {True: statistics.median(known[True]) if known[True] else 90.0,
               False: statistics.median(known[False]) if known[False] else 14.0}
    for m in measures:
        w = m["width"]
        frac = []
        if w and m["pts"]:
            x0 = m["pts"][0][1] if m["pts"][0][0] == 0 else min(default[m["ms_first"] or m["header"]], m["pts"][0][1] * 0.6)
            last = -1.0
            for q, x in m["pts"]:
                u = max(0.0, min(0.985, (x - x0) / max(1.0, w - x0)))
                if q > 0 and u > last + 1e-4:
                    frac.append((q, u))
                    last = u
        m["frac"] = frac


def content_start(bw, system, b0, b1, first_in_line, key_change, key_count, time_shown):
    """x of the first note of a measure on the scan (centre of the notehead)."""
    sp = system["sp"]
    xa, xb = int(b0 + 0.4 * sp), int(b1 - 0.3 * sp)
    if xb - xa < 4:
        return b0 + sp
    # A column counts as ink when it holds clearly more than the five staff
    # lines: noteheads, rests, accidentals and clefs do, thin ties and slurs do not.
    prof = np.zeros(xb - xa, dtype=bool)
    for st in system["staves"]:
        band = bw[st["y0"]:st["y1"] + 1]
        base = np.median(band[:, int(system["x0"]):int(system["x1"])].sum(axis=0))
        prof |= band[:, xa:xb].sum(axis=0) >= base + max(3.0, 0.32 * sp)
    ink = [(a + xa, b + xa) for a, b in layout._runs(prof)]
    if not ink:
        return b0 + sp
    limit = b0 + 0.6 * (b1 - b0)
    if not (first_in_line or key_change):
        return min(ink[0][0] + 0.6 * sp, b0 + 0.4 * (b1 - b0))
    # Clef, key signature and time signature come first. Their glyphs sit close
    # together; the first real gap after them is where the music starts.
    if first_in_line:
        reach = (5.0 + 1.1 * key_count) if time_shown else (2.5 + 0.9 * key_count)
        fallback = 5.2 + 1.25 * key_count + (2.8 if time_shown else 0) + 3.0
    else:
        reach = 0.4 * key_count
        fallback = 1.0 + 1.25 * key_count + 2.5
    for (a0, a1), (c0, c1) in zip(ink, ink[1:]):
        if a1 >= b0 + reach * sp and c0 - a1 >= 1.1 * sp:
            return min(c0 + 0.6 * sp, limit)
    return min(b0 + fallback * sp, limit)


# ---------------------------------------------------------------------- main
def main(cfg_path):
    with open(cfg_path) as _f:
        cfg = json.load(_f)
    base = os.path.dirname(os.path.abspath(cfg_path))
    sid = cfg["id"]
    mscz = os.path.join(base, cfg["mscz"])
    pdf = os.path.join(base, cfg["pdf"])
    work = os.path.join(HERE, "build", sid)
    out_dir = os.path.join(HERE, "..", "site", "songs", sid)
    os.makedirs(work, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    print(f"[{sid}] exporting MuseScore file")
    r = subprocess.run(["node", os.path.join(HERE, "export.cjs"), mscz, work], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(os.path.join(work, "score.musicxml")):
        raise SystemExit("export failed:\n" + r.stdout[-2000:] + r.stderr[-2000:])

    parts, measures, total_q = parse_musicxml(os.path.join(work, "score.musicxml"))
    clock = Clock(read_tempo_map(os.path.join(work, "score.mid")), cfg.get("tempo"), cfg.get("swing", 0))
    if any(m.get("repeat") for m in measures):
        print("  WARNING: the score has repeat barlines; playback is linear, repeats are not unrolled")
    print(f"  {len(measures)} measures, parts: {[p['name'] + ' (' + str(len(p['notes'])) + ')' for p in parts]}")

    channels = []
    for ch in cfg["channels"]:
        part = find_part(parts, ch["part"])
        notes = to_events(pick_notes(part, ch.get("pick", "all"), ch.get("staff")), measures, clock)
        lo, hi = (min(n[2] for n in notes), max(n[2] for n in notes)) if notes else (0, 0)
        print(f"  channel {ch['id']:>2} {ch['name']:<10} {len(notes):4d} notes, range {lo}-{hi}")
        channels.append({"id": ch["id"], "name": ch["name"], "kind": ch.get("kind", "voice"), "notes": notes})

    print(f"[{sid}] reading the score layout from the PDF")
    pages, systems = layout.detect_pdf(pdf, DETECT_DPI)
    skip = set(cfg.get("skipSystems", []))
    systems = [s for i, s in enumerate(systems) if (i + 1) not in skip]
    counts = [len(s["barlines"]) - 1 for s in systems]
    if sum(counts) != len(measures):
        raise SystemExit(f"measure count differs: PDF has {sum(counts)} (per system: {counts}), "
                         f"the MuseScore file has {len(measures)}. Fix the file or use skipSystems.")

    spacing_fractions(measures)
    bw_pages = [(g < 150).astype(np.uint8) for g in pages]
    widths = [s["x1"] - s["x0"] + 3.2 * s["sp"] for s in systems]
    hi_dpi = int(min(400, max(150, DETECT_DPI * cfg.get("imageWidth", 2000) / statistics.median(widths))))
    hi_pages = layout.render_pages(pdf, hi_dpi)
    k = hi_dpi / DETECT_DPI

    out_systems, out_measures = [], []
    mi = 0
    for si, s in enumerate(systems):
        sp = s["sp"]
        page = pages[s["page"]]
        left = max(0, int(s["x0"] - 2.4 * sp))
        right = min(page.shape[1] - 1, int(s["x1"] + 0.8 * sp))
        top, bottom = int(s["top"]), int(s["bottom"])
        cw, chh = right - left, bottom - top
        pts = []
        s["labels"], s["onsets"] = [], []
        first = mi
        for bi in range(len(s["barlines"]) - 1):
            m = measures[mi]
            b0, b1 = s["barlines"][bi], s["barlines"][bi + 1]
            s0 = content_start(bw_pages[s["page"]], s, b0, b1, bi == 0, m["header"], abs(m["key"]),
                               mi == 0 or m.get("time_shown", False))
            t0 = clock.at(m["q"])
            t1 = clock.at(m["q"] + m["len"])
            pts.append((t0, s0))
            for q, u in m["frac"]:
                pts.append((clock.at(m["q"] + q), s0 + u * (b1 - s0)))
            s["labels"].append((b0, m["number"]))
            out_measures.append({"n": m["number"], "t": round(t0, 4), "d": round(t1 - t0, 4), "sys": si,
                                 "x0": round((b0 - left) / cw, 4), "x1": round((b1 - left) / cw, 4),
                                 "beats": max(1, round(m["len"] * m["beat_type"] / 4))})
            mi += 1
        pts.append((clock.at(measures[mi - 1]["q"] + measures[mi - 1]["len"]), s["barlines"][-1]))
        clean = []
        for t, x in sorted(pts):
            if clean and t - clean[-1][0] < 1e-4:
                continue
            x = max(x, clean[-1][1]) if clean else x
            clean.append((t, x))
        s["onsets"] = [x for _, x in clean]
        name = f"sys-{si + 1:02d}.webp"
        crop = hi_pages[s["page"]][int(top * k):int(bottom * k), int(left * k):int(right * k)]
        Image.fromarray(crop).save(os.path.join(out_dir, name), "WEBP", quality=cfg.get("imageQuality", 72), method=6)
        out_systems.append({"img": name, "w": crop.shape[1], "h": crop.shape[0], "first": first, "last": mi - 1,
                            "y0": round((s["y0"] - top) / chh, 4), "y1": round((s["y1"] - top) / chh, 4),
                            "pts": [[round(t, 4), round((x - left) / cw, 4)] for t, x in clean]})

    marks = []
    for i, m in enumerate(measures):
        for label in m["marks"]:
            marks.append({"label": label, "m": i})
    for mk in cfg.get("marks", []):
        num = str(mk["measure"] if isinstance(mk, dict) else mk)
        idx = next((i for i, m in enumerate(measures) if m["number"] == num), None)
        if idx is not None and not any(x["m"] == idx for x in marks):
            marks.append({"label": str(mk.get("label", num)) if isinstance(mk, dict) else num, "m": idx})
    marks.sort(key=lambda x: x["m"])

    song = {"id": sid, "title": cfg["title"], "subtitle": cfg.get("subtitle", ""), "bpm": round(clock.base_bpm, 1),
            "duration": round(clock.at(total_q), 3), "channels": channels, "measures": out_measures,
            "systems": out_systems, "marks": marks}
    with open(os.path.join(out_dir, "song.js"), "w") as f:
        f.write("window.CHOIR_SONGS=window.CHOIR_SONGS||{};window.CHOIR_SONGS[%s]=%s;\n"
                % (json.dumps(sid), json.dumps(song, separators=(",", ":"))))

    dbg = os.path.join(work, "debug")
    os.makedirs(dbg, exist_ok=True)
    for pi, g in enumerate(pages):
        layout.debug_overlay(g, [s for s in systems if s["page"] == pi], os.path.join(dbg, f"page-{pi + 1:02d}.jpg"))

    # keep the song list in sync
    index_path = os.path.join(HERE, "..", "site", "songs", "index.js")
    index = []
    if os.path.exists(index_path):
        with open(index_path) as _f:
            txt = _f.read()
        index = json.loads(txt[txt.index("=") + 1:].rstrip().rstrip(";"))
    index = [e for e in index if e["id"] != sid] + [{"id": sid, "title": cfg["title"], "order": cfg.get("order", 99)}]
    index.sort(key=lambda e: (e.get("order", 99), e["title"]))
    with open(index_path, "w") as f:
        f.write("window.CHOIR_SONG_INDEX=" + json.dumps(index) + ";\n")

    size = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
    print(f"[{sid}] done: {len(out_systems)} systems, {song['duration']:.0f} s at {song['bpm']} bpm, "
          f"{size / 1e6:.1f} MB in site/songs/{sid} (images at {hi_dpi} dpi). Debug overlays: tools/build/{sid}/debug")


def _test_tempo_map():
    """Smoke-test the MIDI binary parser. Run: python3 build_song.py --test"""
    import tempfile, os
    # Minimal format-0 MIDI: 1 track, 480 ticks/quarter, one tempo event (120 BPM), end-of-track.
    midi_bytes = bytes([
        0x4D,0x54,0x68,0x64, 0x00,0x00,0x00,0x06, 0x00,0x00, 0x00,0x01, 0x01,0xE0,
        0x4D,0x54,0x72,0x6B, 0x00,0x00,0x00,0x0B,
        0x00,0xFF,0x51,0x03, 0x07,0xA1,0x20,
        0x00,0xFF,0x2F,0x00,
    ])
    with tempfile.NamedTemporaryFile(suffix=".mid", delete=False) as f:
        f.write(midi_bytes)
        path = f.name
    try:
        result = read_tempo_map(path)
        assert len(result) == 1, f"expected 1 tempo event, got {len(result)}"
        assert abs(result[0][1] - 120.0) < 0.01, f"expected 120 BPM, got {result[0][1]}"
    finally:
        os.unlink(path)


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--test":
        _test_tempo_map()
        print("ok")
        raise SystemExit(0)
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
