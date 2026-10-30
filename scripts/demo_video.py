"""Demo film, 1920x1080 30fps h264. Scene results come from a real anvil run (sdk/scripts/demo-capture.ts).
Run: python3 scripts/demo_video.py /root/vauban-demo-run.json /root/vauban-demo.mp4"""
import json
import subprocess
import sys
from math import cos, sin, pi
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
import x_assets as X  # noqa: E402

W, H, FPS = 1920, 1080, 30
PAPER, INK, FIRE, OLIVE, MUTED = X.PAPER, X.INK, X.FIRE, X.OLIVE, X.MUTED
GRID, FAINT, DIM = (31, 32, 25), (95, 96, 80), (160, 156, 138)
X.SS = 1  # render at 1:1, video does its own antialiasing via supersample below
SS = 2

RUN = json.loads(Path(sys.argv[1]).read_text())
OUT = sys.argv[2]
STEP = {s["scene"]: s for s in RUN["steps"]}


def font(path, px, w=None):
    return X.font(path, px * SS // 1, w) if False else _font(path, px, w)


_cache = {}


def _font(path, px, w=None):
    k = (path, px, w)
    if k not in _cache:
        from PIL import ImageFont
        f = ImageFont.truetype(path, px * SS)
        if w and path == X.SERIF:
            try:
                f.set_variation_by_axes([144, w])
            except Exception:
                pass
        _cache[k] = f
    return _cache[k]


SERIF, MONO = X.SERIF, X.MONO
MONO_B = "/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf"


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


class F:
    """One frame at 2x, downsampled on save."""

    def __init__(self, bg=INK):
        self.im = Image.new("RGB", (W * SS, H * SS), bg)
        self.d = ImageDraw.Draw(self.im)

    def text(self, xy, s, f, fill, anchor="la", alpha=1.0, bg=INK):
        if alpha <= 0:
            return
        self.d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=mix(bg, fill, alpha), anchor=anchor)

    def rect(self, box, fill=None, outline=None, width=1):
        self.d.rectangle([v * SS for v in box], fill=fill, outline=outline, width=width * SS)

    def line(self, pts, fill, width=1):
        self.d.line([(x * SS, y * SS) for x, y in pts], fill=fill, width=max(1, round(width * SS)))

    def grid(self, step=60, col=GRID, drift=0.0):
        off = int(drift * SS) % (step * SS)
        for x in range(-off, W * SS, step * SS):
            self.d.line([x, 0, x, H * SS], fill=col, width=1)
        for y in range(0, H * SS, step * SS):
            self.d.line([0, y, W * SS, y], fill=col, width=1)

    def frame(self):
        return self.im.resize((W, H), Image.LANCZOS)


def fort(f, cx, cy, r, ink, faint, draw=1.0, rot=0.0, lit=None):
    """Bastion plan; `draw` 0..1 reveals the trace, `lit` picks a ring to fire-highlight."""
    rings = {"ditch": 1.16, "curtain": 1.0, "gate": 0.9, "keep": 0.22}
    pts = X.trace(cx * SS, cy * SS, r * SS, rot=pi / 8 + rot)
    n = max(2, int(len(pts) * ease(draw)))
    col = FIRE if lit == "curtain" else ink
    f.d.line(pts[:n] + ([pts[0]] if draw >= 1 else []), fill=col, width=round((3.2 if lit == "curtain" else 2.2) * SS), joint="curve")
    if draw < 0.35:
        return
    a = ease((draw - 0.35) / 0.65)
    glacis = X.trace(cx * SS, cy * SS, r * rings["ditch"] * SS, rot=pi / 8 + rot)
    gcol = FIRE if lit == "ditch" else mix(INK, faint, a)
    for i in range(len(glacis)):
        p, q = glacis[i], glacis[(i + 1) % len(glacis)]
        for k in range(0, 14, 2):
            s0, s1 = k / 14, (k + 1) / 14
            f.d.line([(p[0] + (q[0] - p[0]) * s0, p[1] + (q[1] - p[1]) * s0), (p[0] + (q[0] - p[0]) * s1, p[1] + (q[1] - p[1]) * s1)], fill=gcol, width=round((2.4 if lit == "ditch" else 1) * SS))
    inner = X.trace(cx * SS, cy * SS, r * rings["gate"] * SS, rot=pi / 8 + rot)
    f.d.polygon(inner, outline=FIRE if lit == "gate" else mix(INK, faint, a), width=round((2.6 if lit == "gate" else 1) * SS))
    k = r * rings["keep"] * SS
    kc = FIRE if lit == "keep" else mix(INK, ink, a)
    f.d.rectangle([cx * SS - k, cy * SS - k, cx * SS + k, cy * SS + k], outline=kc, width=round((3 if lit == "keep" else 1.6) * SS))
    s = r * 0.06 * SS
    f.d.rectangle([cx * SS - s, cy * SS - s, cx * SS + s, cy * SS + s], fill=FIRE)


def mark(f, x, y, size, stroke, alpha=1.0):
    X.mark(f.d, x * SS / 1, y * SS / 1, size * SS, mix(INK, stroke, alpha)) if False else _mark(f, x, y, size, stroke, alpha)


def _mark(f, x, y, size, stroke, alpha):
    s = size * SS / 32
    pt = lambda p: (x * SS + p[0] * s, y * SS + p[1] * s)
    c = mix(INK, stroke, alpha)
    f.d.line([pt(p) for p in X.OUTER], fill=c, width=round(3 * s), joint="curve")
    f.d.line([pt(p) for p in X.INNER], fill=mix(INK, stroke, alpha * 0.6), width=max(1, round(1.4 * s)), joint="curve")
    f.d.rectangle([pt((14, 3)), pt((18, 7))], fill=mix(INK, FIRE, alpha))


def dot(f, x, y, r, col):
    f.d.ellipse([(x - r) * SS, (y - r) * SS, (x + r) * SS, (y + r) * SS], fill=col)


def caption(f, kicker, title, a, y=860):
    f.text((120, y), kicker, _font(MONO, 22), OLIVE, alpha=a)
    f.text((120, y + 40), title, _font(SERIF, 54, 500), PAPER, alpha=a)


def chrome(f, idx, t_scene):
    f.text((120, 70), "VAUBAN", _font(MONO_B, 20), DIM)
    f.text((W - 120, 70), f"{idx:02d} / 08", _font(MONO, 20), DIM, anchor="ra")  # scenes 02-08 carry chrome
    f.rect([0, H - 6, W * t_scene, H], fill=FIRE)


# ---------------------------------------------------------------- scenes
# Each scene: (seconds, fn(f, t, local_seconds)). t is 0..1 inside the scene.

def s_open(f, t, s):
    f.grid(drift=s * 8)
    fort(f, 960, 470, 300, PAPER, FAINT, draw=min(1, s / 2.6), rot=s * 0.02)
    a = ease((s - 2.4) / 0.8)
    f.text((960, 880), "An agent with a key can spend everything.", _font(SERIF, 56, 400), PAPER, "ma", a)
    f.text((960, 960), "Vauban is the fort you build around it first.", _font(SERIF, 40, 400), DIM, "ma", ease((s - 3.4) / 0.8))


def s_title(f, t, s):
    f.grid(drift=40 + s * 8)
    a = ease(s / 0.8)
    _mark(f, 960 - 70, 300, 140, PAPER, a)
    f.text((960, 500), "VAUBAN", _font(SERIF, 132, 500), PAPER, "ma", a)
    f.text((960, 680), "A vault for autonomous agents on Robinhood Chain.", _font(SERIF, 40, 400), DIM, "ma", ease((s - 0.8) / 0.8))
    f.text((960, 770), "DITCH  ·  CURTAIN  ·  GATE  ·  KEEP", _font(MONO, 26), FIRE, "ma", ease((s - 1.6) / 0.8))


SHEET = [
    ("owner.allow(router, [buy()])", "CURTAIN", "Only listed contracts and functions"),
    ("owner.setLimits(ETH, { perTx: 0.1,", "DITCH", "Caps per tx, hour and UTC day"),
    ("   perHour: 0.3, perDay: 1,", "", ""),
    ("   holdAbove: 0.05 })", "GATE", "Bigger moves wait 6 hours"),
    ("owner.freeze()", "KEEP", "One switch stops everything"),
]


def s_sheet(f, t, s):
    f.grid(drift=80 + s * 8)
    chrome(f, 2, t)
    caption(f, "STEP 1  ·  THE OWNER DRAWS THE SHEET", "You set the rules once.", ease(s / 0.6), y=150)
    f.rect([120, 320, 1060, 760], fill=(26, 27, 21), outline=(48, 49, 40))
    f.text((150, 345), "owner.ts", _font(MONO, 20), DIM)
    for i, (code, rp, desc) in enumerate(SHEET):
        a = ease((s - 0.6 - i * 0.55) / 0.5)
        y = 410 + i * 64
        shown = code[: int(len(code) * ease((s - 0.6 - i * 0.55) / 0.45))]
        f.text((150, y), shown, _font(MONO, 26), PAPER, alpha=1.0 if shown else 0)
        if rp:
            f.text((1140, y - 4), rp, _font(MONO_B, 26), FIRE, alpha=a)
            f.text((1340, y - 2), desc, _font(SERIF, 28, 400), DIM, alpha=a)


def run_scene(rampart, title, sub, idx, ask):
    step = STEP[rampart]

    def fn(f, t, s):
        f.grid(drift=160 + idx * 40 + s * 8)
        chrome(f, idx, t)
        lit = None if rampart == "pass" else rampart
        fort(f, 1380, 520, 300, PAPER, FAINT, lit=lit if s > 1.6 else None)
        caption(f, sub, title, ease(s / 0.6), y=150)
        f.text((120, 360), "agent.execute(", _font(MONO, 28), DIM, alpha=ease((s - 0.3) / 0.4))
        f.text((150, 410), ask, _font(MONO, 30), PAPER, alpha=ease((s - 0.4) / 0.4))
        f.text((120, 460), ")", _font(MONO, 28), DIM, alpha=ease((s - 0.4) / 0.4))

        # The move travels in from the left towards the fort and stops at its rampart.
        stop = {"pass": 0.0, "curtain": 300, "ditch": 348, "gate": 270, "keep": 66}[rampart]
        p = ease((s - 0.6) / 1.0)
        start = 980
        end = 1380 - stop if rampart != "pass" else 1380
        x = start + (end - start) * p
        if 0.6 < s:
            col = FIRE if p >= 1 and rampart != "pass" else PAPER
            f.d.polygon([((x) * SS, (520 - 14) * SS), ((x + 14) * SS, 520 * SS), (x * SS, (520 + 14) * SS), ((x - 14) * SS, 520 * SS)], fill=col)
            for k in range(1, 6):
                tx = x - k * 22 * p
                if tx > start:
                    dot(f, tx, 520, 3, mix(INK, PAPER, 0.5 - k * 0.08))

        ok = rampart in ("pass", "gate")
        a = ease((s - 1.7) / 0.5)
        label = "PASSED" if rampart == "pass" else ("HELD AT THE GATE" if rampart == "gate" else "REFUSED")
        f.rect([120, 560, 860, 560 + 4], fill=mix(INK, FIRE if not ok or rampart == "gate" else OLIVE, a))
        f.text((120, 600), label, _font(MONO_B, 40), FIRE if rampart != "pass" else OLIVE, alpha=a)
        msg = step["result"]
        words, lines, cur = msg.split(" "), [], ""
        for w in words:
            if len(cur) + len(w) + 1 > 44:
                lines.append(cur)
                cur = w
            else:
                cur = (cur + " " + w).strip()
        lines.append(cur)
        for i, ln in enumerate(lines[:4]):
            f.text((120, 670 + i * 40), ln, _font(MONO, 26), PAPER, alpha=ease((s - 2.0 - i * 0.12) / 0.4))
        if rampart not in ("pass", "gate"):
            f.text((120, 860), "Simulated first. Refused before any gas was spent.", _font(SERIF, 30, 400), DIM, alpha=ease((s - 2.8) / 0.5))
        if rampart == "gate":
            f.text((120, 860), "The owner can cancel it before then.", _font(SERIF, 30, 400), DIM, alpha=ease((s - 2.8) / 0.5))
    return fn


def s_aeon(f, t, s):
    f.grid(drift=420 + s * 8)
    chrome(f, 8, t)
    caption(f, "STEP 3  ·  WATCH IT FROM AEON", "Listed in the Aeon skill packs.", ease(s / 0.6), y=150)
    f.rect([120, 330, 1800, 830], fill=(26, 27, 21), outline=(48, 49, 40))
    lines = [
        ("$ bin/install-skill-pack vaubandev/vauban --path aeon", PAPER, MONO),
        ("  ✓ security scan passed: vauban-vault", OLIVE, MONO),
        ("", PAPER, MONO),
        ("$ node skills/vauban-vault/status.mjs 0xf932…4097", PAPER, MONO),
        ("# Vauban vault 0xf9322f1546de5a121cdc09522e70af79e30e4097", PAPER, MONO),
        ("- Frozen: no      - Gate delay 21600s      - Revision 0", DIM, MONO),
        ("Keyless. Read-only. Never signs.", FIRE, MONO_B),
    ]
    for i, (ln, col, fnt) in enumerate(lines):
        k = ease((s - 0.6 - i * 0.45) / 0.35)
        shown = ln[: int(len(ln) * k)]
        f.text((160, 380 + i * 60), shown, _font(fnt, 30), col)


def s_end(f, t, s):
    f.grid(drift=480 + s * 8)
    fort(f, 1440, 540, 260, mix(INK, PAPER, 0.35), FAINT)
    a = ease(s / 0.8)
    _mark(f, 120, 300, 96, PAPER, a)
    f.text((240, 310), "VAUBAN", _font(SERIF, 96, 500), PAPER, alpha=a)
    f.text((120, 470), "vauban.works", _font(MONO_B, 44), FIRE, alpha=ease((s - 0.6) / 0.6))
    f.text((120, 540), "x.com/vaubanworks   ·   github.com/vaubandev/vauban", _font(MONO, 28), DIM, alpha=ease((s - 1.0) / 0.6))
    f.text((120, 640), "Reference vault live on Robinhood Chain (4663). Empty on purpose.", _font(SERIF, 32, 400), PAPER, alpha=ease((s - 1.4) / 0.6))
    f.text((120, 690), "Contract not audited. Do not route real funds through it yet.", _font(SERIF, 32, 400), DIM, alpha=ease((s - 1.8) / 0.6))


SCENES = [
    (5.2, s_open),
    (3.6, s_title),
    (5.4, s_sheet),
    (4.6, run_scene("pass", "A small buy lands.", "STEP 2  ·  THE AGENT ACTS  ·  1 / 5", 3, STEP["pass"]["ask"])),
    (4.6, run_scene("curtain", "Unknown address: refused at the curtain.", "STEP 2  ·  THE AGENT ACTS  ·  2 / 5", 4, STEP["curtain"]["ask"])),
    (4.6, run_scene("ditch", "Over the cap: refused at the ditch.", "STEP 2  ·  THE AGENT ACTS  ·  3 / 5", 5, STEP["ditch"]["ask"])),
    (4.6, run_scene("gate", "A big move waits at the gate.", "STEP 2  ·  THE AGENT ACTS  ·  4 / 5", 6, STEP["gate"]["ask"])),
    (4.6, run_scene("keep", "Frozen: the keep stops everything.", "STEP 2  ·  THE AGENT ACTS  ·  5 / 5", 7, STEP["keep"]["ask"])),
    (5.4, s_aeon),
    (4.8, s_end),
]
FADE = 0.35


def render():
    total = sum(d for d, _ in SCENES)
    n = int(total * FPS)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT],
        stdin=subprocess.PIPE,
    )
    for i in range(n):
        t_abs = i / FPS
        acc = 0.0
        for dur, fn in SCENES:
            if t_abs < acc + dur:
                break
            acc += dur
        s = t_abs - acc
        f = F()
        fn(f, s / dur, s)
        img = f.frame()
        fade = min(1.0, s / FADE, (dur - s) / FADE)
        if fade < 1:
            img = Image.blend(Image.new("RGB", (W, H), INK), img, max(0.0, fade))
        ff.stdin.write(img.tobytes())
        if i % 60 == 0:
            print(f"\r{i}/{n}", end="", flush=True)
    ff.stdin.close()
    ff.wait()
    print(f"\n{OUT}  {total:.1f}s  {n} frames")


if __name__ == "__main__":
    if len(sys.argv) > 3 and sys.argv[3] == "--stills":
        for k, (dur, fn) in enumerate(SCENES):
            f = F()
            fn(f, 0.85, dur * 0.85)
            f.frame().save(f"/root/vauban-still-{k:02d}.png")
        print("stills written")
    else:
        render()
