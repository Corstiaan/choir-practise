"""Find systems, staves and barlines on the pages of a score PDF.

Works on a rasterised page: staff lines are long horizontal runs, barlines are
vertical runs that cross every staff of a system at the same x.
"""
import numpy as np
import cv2
import fitz  # PyMuPDF


def render_pages(pdf_path, dpi=200):
    doc = fitz.open(pdf_path)
    pages = []
    for page in doc:
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY, alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).copy()
        pages.append(img)
    return pages


def _runs(mask):
    """Start/end (exclusive) of consecutive True runs in a 1-D boolean array."""
    m = np.concatenate(([0], mask.astype(np.int8), [0]))
    d = np.diff(m)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def find_staves(bw):
    H, W = bw.shape
    klen = max(40, int(W * 0.18))
    lines = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (klen, 1)))
    rows = lines.sum(axis=1)
    bands = [(a, b) for a, b in _runs(rows > W * 0.15)]
    centers = [((a + b - 1) / 2.0, a, b) for a, b in bands]
    staves = []
    i = 0
    while i + 4 < len(centers):
        ys = [c[0] for c in centers[i:i + 5]]
        gaps = np.diff(ys)
        if gaps.min() > 3 and gaps.max() - gaps.min() <= max(2.0, 0.22 * gaps.mean()):
            y0, y1 = int(round(ys[0])), int(round(ys[4]))
            cols = np.where(lines[centers[i][1]:centers[i + 4][2]].sum(axis=0) > 0)[0]
            staves.append({"y0": y0, "y1": y1, "sp": float(gaps.mean()), "x0": int(cols.min()), "x1": int(cols.max())})
            i += 5
        else:
            i += 1
    return staves


def _vertical_candidates(bw, y0, y1, xa, xb, thresh=0.9):
    cov = bw[y0:y1 + 1, xa:xb + 1].mean(axis=0)
    return [((a + b - 1) / 2.0 + xa, b - a) for a, b in _runs(cov >= thresh)]


def _gap_covered(bw, ya, yb, x, tol):
    if yb <= ya:
        return True
    xa, xb = int(max(0, x - tol)), int(min(bw.shape[1] - 1, x + tol))
    return bw[ya:yb + 1, xa:xb + 1].mean(axis=0).max() >= 0.9


def detect_page(gray, ink_threshold=150):
    bw = (gray < ink_threshold).astype(np.uint8)
    H, W = bw.shape
    staves = find_staves(bw)
    if not staves:
        return []
    # group staves into systems: joined by the line at the left edge
    groups = [[staves[0]]]
    for prev, cur in zip(staves, staves[1:]):
        tol = max(3, int(prev["sp"] * 0.6))
        joined = abs(prev["x0"] - cur["x0"]) <= tol * 2 and _gap_covered(bw, prev["y1"], cur["y0"], prev["x0"], tol)
        if joined:
            groups[-1].append(cur)
        else:
            groups.append([cur])
    systems = []
    for g in groups:
        sp = float(np.mean([s["sp"] for s in g]))
        x0 = min(s["x0"] for s in g)
        x1 = max(s["x1"] for s in g)
        tol = max(2.0, sp * 0.3)
        xa, xb = max(0, int(x0 - sp * 0.2)), min(W - 1, int(x1 + sp * 0.2))
        per_staff = [_vertical_candidates(bw, s["y0"], s["y1"], xa, xb) for s in g]
        cands = []
        for x, w in per_staff[0]:
            if all(any(abs(x - x2) <= tol for x2, _ in other) for other in per_staff[1:]):
                cands.append(x)
        # which neighbouring staves are barline-connected (piano grand staff)?
        connected = []
        for a, b in zip(g, g[1:]):
            hits = [_gap_covered(bw, a["y1"], b["y0"], x, tol) for x in cands]
            connected.append(len(hits) > 0 and np.mean(hits) >= 0.5)
        keep = []
        for x in cands:
            ok = True
            for (a, b), conn in zip(zip(g, g[1:]), connected):
                if conn and not _gap_covered(bw, a["y1"], b["y0"], x, tol):
                    ok = False
            if ok:
                keep.append(x)
        # merge double / final barlines
        merged = []
        for x in keep:
            if merged and x - merged[-1][-1] < sp * 1.3:
                merged[-1].append(x)
            else:
                merged.append([x])
        bars = [float(np.mean(m)) for m in merged]
        systems.append({"staves": g, "sp": sp, "x0": x0, "x1": x1, "y0": g[0]["y0"], "y1": g[-1]["y1"], "barlines": bars})
    # vertical crop bounds: cut in the emptiest row between systems
    ink = bw.sum(axis=1)
    for i, s in enumerate(systems):
        sh = s["staves"][0]["y1"] - s["staves"][0]["y0"]
        cap = int(sh * 2.6)
        # top
        if i > 0:
            a, b = systems[i - 1]["y1"], s["y0"]
            lo, hi = a + int((b - a) * 0.3), b - int(sh * 0.5)
            cut = lo + int(np.argmin(ink[lo:hi])) if hi > lo else (a + b) // 2
            s["top"] = max(cut, s["y0"] - cap)
        else:
            s["top"] = _blank_search(ink, s["y0"] - int(sh * 0.6), -1, cap, sh)
        if i + 1 < len(systems):
            a, b = s["y1"], systems[i + 1]["y0"]
            lo, hi = a + int((b - a) * 0.3), b - int(sh * 0.5)
            cut = lo + int(np.argmin(ink[lo:hi])) if hi > lo else (a + b) // 2
            s["bottom"] = min(cut, s["y1"] + cap)
        else:
            s["bottom"] = _blank_search(ink, s["y1"] + int(sh * 0.6), 1, cap, sh)
    return systems


def _blank_search(ink, start, step, cap, sh):
    """Walk from start until a blank band (no ink) of ~0.3 staff heights; stop at cap."""
    need = max(4, int(sh * 0.3))
    blank = 0
    y = start
    n = len(ink)
    limit = start + step * cap
    while 0 < y < n - 1 and y != limit:
        if ink[y] == 0:
            blank += 1
            if blank >= need:
                return y - step * (need // 2)
        else:
            blank = 0
        y += step
    return max(0, min(n - 1, y))


def detect_pdf(pdf_path, dpi=200):
    pages = render_pages(pdf_path, dpi)
    out = []
    for pi, gray in enumerate(pages):
        for s in detect_page(gray):
            s["page"] = pi
            out.append(s)
    return pages, out


def debug_overlay(gray, systems, path):
    img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    for s in systems:
        cv2.rectangle(img, (int(s["x0"]), int(s["top"])), (int(s["x1"]), int(s["bottom"])), (255, 160, 0), 2)
        for x in s["barlines"]:
            cv2.line(img, (int(x), int(s["y0"]) - 12), (int(x), int(s["y1"]) + 12), (0, 0, 255), 3)
        for x, lab in s.get("labels", []):
            cv2.putText(img, lab, (int(x) + 4, int(s["y0"]) - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 140, 0), 2)
        for x in s.get("onsets", []):
            cv2.line(img, (int(x), int(s["y0"])), (int(x), int(s["y0"]) + 40), (0, 170, 0), 2)
    cv2.imwrite(path, img)


if __name__ == "__main__":
    import sys
    pages, systems = detect_pdf(sys.argv[1])
    total = 0
    for i, s in enumerate(systems):
        n = len(s["barlines"]) - 1
        total += n
        print(f"system {i+1:2d} page {s['page']+1} staves {len(s['staves'])} measures {n} (running total {total})")
    if len(sys.argv) > 2:
        import os
        os.makedirs(sys.argv[2], exist_ok=True)
        for pi, g in enumerate(pages):
            debug_overlay(g, [s for s in systems if s["page"] == pi], os.path.join(sys.argv[2], f"dbg-{pi+1:02d}.jpg"))
