"""Motion-graphics film, 1920x1080 30fps h264. Drawn frame by frame, not a screen recording.
Every ruling and figure on screen is real: the four verdicts are the ones the vault returns
(sdk e2e on anvil), the handover lines are the reference vault's real events on 4663.
Run: python3 scripts/flow_video.py out.mp4 [--stills]"""
import subprocess
import sys
from math import cos, sin, pi, hypot
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import x_assets as X  # noqa: E402

W, H, FPS, SS = 1920, 1080, 30, 2
PAPER, INK, FIRE, OLIVE = X.PAPER, X.INK, X.FIRE, X.OLIVE
FAINT, DIM, LINE = (70, 72, 58), (160, 156, 138), (44, 46, 37)
SERIF, MONO = X.SERIF, X.MONO
MONO_B = "/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf"
OUT = sys.argv[1]
STILLS = "--stills" in sys.argv

_fc = {}


def font(path, px, w=None):
    k = (path, px, w)
    if k not in _fc:
        f = ImageFont.truetype(path, int(px * SS))
        if w and path == SERIF:
            try:
                f.set_variation_by_axes([144, w])
            except Exception:
                pass
        _fc[k] = f
    return _fc[k]


def clamp(t):
    return 0.0 if t < 0 else 1.0 if t > 1 else t


def ease(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def inout(t):
    t = clamp(t)
    return t * t * (3 - 2 * t)


def back(t):
    t = clamp(t)
    c = 1.4
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def span(t, a, b):
    """Progress of t through [a, b]."""
    return clamp((t - a) / (b - a))


class F:
    def __init__(self):
        self.img = Image.new("RGB", (W * SS, H * SS), INK)
        self.d = ImageDraw.Draw(self.img)

    def p(self, x, y):
        return (x * SS, y * SS)

    def text(self, xy, s, f, fill, anchor="la", alpha=1.0):
        if alpha <= 0:
            return
        col = mix(INK, fill, alpha)
        self.d.text(self.p(*xy), s, font=f, fill=col, anchor=anchor)

    def line(self, pts, fill, w=1.0):
        self.d.line([self.p(*q) for q in pts], fill=fill, width=max(1, round(w * SS)), joint="curve")

    def poly_partial(self, pts, frac, fill, w=1.0, closed=True):
        """Draw the first `frac` of a polyline's length: a line being ruled across the sheet."""
        if frac <= 0:
            return
        seq = pts + [pts[0]] if closed else pts
        segs = [(seq[i], seq[i + 1]) for i in range(len(seq) - 1)]
        total = sum(hypot(b[0] - a[0], b[1] - a[1]) for a, b in segs)
        left = total * clamp(frac)
        out = [seq[0]]
        for a, b in segs:
            L = hypot(b[0] - a[0], b[1] - a[1])
            if left >= L:
                out.append(b)
                left -= L
            else:
                k = left / L if L else 0
                out.append((a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k))
                break
        if len(out) > 1:
            self.line(out, fill, w)

    def rect(self, box, fill=None, outline=None, w=1.0):
        x0, y0, x1, y1 = box
        self.d.rectangle([x0 * SS, y0 * SS, x1 * SS, y1 * SS], fill=fill, outline=outline, width=max(1, round(w * SS)) if outline else 0)

    def frame(self):
        return self.img.resize((W, H), Image.LANCZOS)


def trace(cx, cy, r, rot=pi / 8):
    """Bastioned octagon in plan, after Neuf-Brisach (Vauban, 1698)."""
    pts = []
    for i in range(8):
        a = rot + i * 2 * pi / 8
        for da, k in ((-0.20, 0.80), (-0.17, 0.88), (0, 1.0), (0.17, 0.88), (0.20, 0.80)):
            pts.append((cx + r * k * cos(a + da), cy + r * k * sin(a + da)))
    return pts


def survey(f, t, cx, cy, span_r, draw=1.0, rot=0.0, col=LINE):
    """Contour lines of the trace, ruled in one after another."""
    for k, s in enumerate((0.30, 0.42, 0.55, 0.69, 0.84, 1.0)):
        p = clamp(draw * 1.6 - k * 0.12)
        f.poly_partial(trace(cx, cy, span_r * s, rot=pi / 8 + k * 0.035 + rot), p, col, 1.1)


def mark(f, x, y, size, alpha=1.0):
    s = size / 32
    pt = lambda q: (x + q[0] * s, y + q[1] * s)
    f.line([pt(q) for q in X.OUTER], mix(INK, PAPER, alpha), 3 * s)
    f.line([pt(q) for q in X.INNER], mix(INK, (150, 146, 128), alpha), 1.4 * s)
    a, b = pt((14, 3)), pt((18, 7))
    f.rect((a[0], a[1], b[0], b[1]), fill=mix(INK, FIRE, alpha))


def kicker(f, t, x, y, s):
    a = ease(span(t, 0, 0.5))
    f.line([(x, y + 11), (x + 40 * a, y + 11)], FIRE, 1.4)
    f.text((x + 56, y), s, font(MONO, 17), FIRE, alpha=a)


# ---------------------------------------------------------------- scenes
# Each scene draws itself from its own local time ts (seconds) and its length L.


def s_open(f, ts, L):
    cx, cy = W * 0.5, H * 0.5
    survey(f, ts, cx, cy, 760, draw=ts / 2.2, rot=ts * 0.01)
    fort = trace(cx, cy, 300)
    f.poly_partial(fort, ease(span(ts, 0.5, 2.6)), PAPER, 3.0)
    f.poly_partial(trace(cx, cy, 270), ease(span(ts, 1.0, 3.0)), FAINT, 1.2)
    if ts > 2.4:
        a = ease(span(ts, 2.4, 3.0))
        k = 22 * back(span(ts, 2.4, 3.0))
        f.rect((cx - k, cy - k, cx + k, cy + k), fill=mix(INK, FIRE, a))
    a = ease(span(ts, 3.0, 3.8))
    out = ease(span(ts, L - 0.6, L))
    f.text((cx, cy + 380 - 20 * a), "A FORTIFICATION FOR AUTONOMOUS AGENTS", font(MONO, 22), DIM, "ma", alpha=a * (1 - out))


def s_problem(f, ts, L):
    kicker(f, ts, 140, 150, "THE PROBLEM")
    rows = (("Give an agent a key,", PAPER), ("and it can do anything", PAPER), ("the key can sign.", FIRE))
    for i, (s, c) in enumerate(rows):
        a = ease(span(ts, 0.3 + i * 0.35, 1.0 + i * 0.35))
        f.text((140, 260 + i * 100 + 30 * (1 - a)), s, font(SERIF, 84, 400), c, alpha=a)
    # agent -> key -> everything
    y = 790
    a = ease(span(ts, 1.8, 2.4))
    for x, lab in ((140, "AGENT"), (1180, "ALL FUNDS")):
        f.rect((x, y - 44, x + 360, y + 44), outline=mix(INK, PAPER, a), w=2)
        f.text((x + 180, y - 14), lab, font(MONO_B, 26), PAPER, "ma", alpha=a)
    run = ease(span(ts, 2.4, 3.4))
    f.line([(500, y), (500 + 680 * run, y)], FIRE, 4)
    if run > 0.98:
        f.d.polygon([f.p(1180, y), f.p(1160, y - 12), f.p(1160, y + 12)], fill=FIRE)
    f.text((840, y + 80), "nothing in between", font(MONO, 22), DIM, "ma", alpha=ease(span(ts, 3.4, 4.0)))


WALLS = (("DITCH", "spend caps"), ("CURTAIN", "allowlist"), ("GATE", "time-lock"), ("KEEP", "kill switch"))


def s_walls(f, ts, L):
    kicker(f, ts, 140, 150, "THE ANSWER")
    a = ease(span(ts, 0.2, 0.9))
    f.text((140, 240), "Four walls between", font(SERIF, 76, 400), PAPER, alpha=a)
    f.text((140, 330), "the agent and its wallet.", font(SERIF, 76, 400), FIRE, alpha=ease(span(ts, 0.5, 1.2)))
    cx, cy = 1360, 640
    for i, (name, what) in enumerate(WALLS):
        r = 330 - i * 70
        p = ease(span(ts, 0.8 + i * 0.45, 2.0 + i * 0.45))
        f.poly_partial(trace(cx, cy, r), p, mix(FAINT, FIRE, 0.25 + i * 0.25), 2.4 - i * 0.2)
        la = ease(span(ts, 1.6 + i * 0.45, 2.2 + i * 0.45))
        y = 520 + i * 92
        f.text((140, y), f"0{i + 1}", font(SERIF, 44, 500), FIRE, alpha=la)
        f.text((230, y + 4), name, font(MONO_B, 30), PAPER, alpha=la)
        f.text((460, y + 8), what, font(MONO, 24), DIM, alpha=la)
    k = 18 * back(span(ts, 2.6, 3.2))
    f.rect((cx - k, cy - k, cx + k, cy + k), fill=FIRE)


# The four rulings: (label, amount, outcome, where the move stops, colour). Real SDK results.
RULINGS = (
    ("buy 0.04 ETH on a listed router", "PASS", "lands now", 4, OLIVE),
    ("buy 0.08 ETH, holds above 0.05", "HOLD", "waits 6 h at the gate", 2, PAPER),
    ("buy 0.2 ETH, cap is 0.1 per call", "REFUSED", "at the ditch", 0, FIRE),
    ("send to an address not on the list", "REFUSED", "at the curtain", 1, FIRE),
)


def s_rulings(f, ts, L):
    kicker(f, ts, 140, 150, "EVERY CALL IS RULED")
    cx, cy = 1360, 600
    radii = [330, 260, 190, 120]
    for i in range(4):
        f.poly_partial(trace(cx, cy, radii[i]), 1.0, mix(FAINT, FIRE, 0.2 + i * 0.2), 2.0 - i * 0.2)
    f.rect((cx - 18, cy - 18, cx + 18, cy + 18), fill=FIRE)
    per = (L - 0.6) / 4
    for i, (ask, verdict, sub, stop, col) in enumerate(RULINGS):
        t0 = 0.4 + i * per
        lt = ts - t0
        # the list on the left fills in as each ruling lands
        y = 280 + i * 150
        la = ease(span(lt, 1.7, 2.2))
        f.text((140, y), ask, font(MONO, 25), PAPER if lt > 0 else DIM, alpha=max(0.25, ease(span(lt, -0.3, 0.2))))
        f.text((140, y + 46), verdict, font(MONO_B, 34), col, alpha=la)
        f.text((140 + 30 + len(verdict) * 21, y + 52), sub, font(MONO, 24), DIM, alpha=la)
        if lt < 0 or lt > per + 0.2:
            continue
        # a move travels in from open ground and stops at its wall, or reaches the keep
        target = radii[stop] if stop < 4 else 0
        travel = ease(span(lt, 0.1, 1.5))
        r = 560 - (560 - target) * travel
        ang = -pi * 0.82
        x, yy = cx + r * cos(ang), cy + r * sin(ang)
        trail = [(cx + (r + k * 26) * cos(ang), cy + (r + k * 26) * sin(ang)) for k in range(1, 6)]
        for k, q in enumerate(trail):
            s = 5 - k * 0.7
            f.d.ellipse([f.p(q[0] - s, q[1] - s), f.p(q[0] + s, q[1] + s)], fill=mix(INK, col, 0.5 - k * 0.08))
        hit = span(lt, 1.5, 2.1)
        s = 14 + (30 * ease(hit) if verdict == "REFUSED" else 0)
        if verdict == "REFUSED" and hit > 0:
            f.line([(x - s, yy - s), (x + s, yy + s)], FIRE, 5)
            f.line([(x - s, yy + s), (x + s, yy - s)], FIRE, 5)
        else:
            f.d.polygon([f.p(x, yy - 16), f.p(x + 16, yy), f.p(x, yy + 16), f.p(x - 16, yy)], fill=col)
        if verdict == "HOLD" and hit > 0:
            f.d.arc([f.p(x - 34, yy - 34), f.p(x + 34, yy + 34)], -90, -90 + 360 * ease(hit), fill=PAPER, width=3 * SS)


def s_check(f, ts, L):
    kicker(f, ts, 140, 150, "RULES THAT LOOK SAFE")
    a = ease(span(ts, 0.2, 0.9))
    f.text((140, 240), "Hold above 0.1 ETH.", font(SERIF, 76, 400), PAPER, alpha=a)
    f.text((140, 330), "Cap 0.1 ETH per call.", font(SERIF, 76, 400), PAPER, alpha=ease(span(ts, 0.5, 1.2)))
    f.text((140, 430), "Looks careful.", font(SERIF, 52, 400), DIM, alpha=ease(span(ts, 1.2, 1.8)))
    # a gauge: the cap line sits on the hold line, so the hold band has zero width
    x0, x1, y = 140, 1100, 640
    g = ease(span(ts, 1.6, 2.4))
    f.line([(x0, y), (x0 + (x1 - x0) * g, y)], FAINT, 2)
    cap = x0 + (x1 - x0) * 0.6
    if g > 0.6:
        ca = ease(span(ts, 2.2, 2.7))
        f.line([(cap, y - 60 * ca), (cap, y + 60 * ca)], FIRE, 4)
        f.text((cap, y - 100), "cap 0.1  =  hold 0.1", font(MONO_B, 24), FIRE, "ma", alpha=ca)
        f.text((x0, y + 40), "lands at once", font(MONO, 22), OLIVE, alpha=ca)
        f.text((x1, y + 40), "refused first", font(MONO, 22), FIRE, "ra", alpha=ca)
    flag = ease(span(ts, 3.0, 3.6))
    f.rect((140, 780, 140 + 1140 * flag, 880), fill=mix(INK, (34, 26, 20), flag), outline=mix(INK, FIRE, flag), w=2)
    f.text((176, 808), "CHECK", font(MONO_B, 26), FIRE, alpha=ease(span(ts, 3.4, 3.9)))
    f.text((320, 808), "the gate can never hold anything", font(MONO, 28), PAPER, alpha=ease(span(ts, 3.5, 4.0)))
    f.text((140, 930), "Inspection flags it before you sign.", font(MONO, 24), DIM, alpha=ease(span(ts, 4.2, 4.8)))


def s_handover(f, ts, L):
    kicker(f, ts, 140, 150, "OWNERSHIP MOVES IN TWO STEPS")
    a = ease(span(ts, 0.2, 0.9))
    f.text((140, 240), "Offered, then accepted.", font(SERIF, 76, 400), PAPER, alpha=a)
    f.text((140, 330), "Nothing changes in between.", font(SERIF, 76, 400), FIRE, alpha=ease(span(ts, 0.5, 1.2)))
    # two wallets, a key travelling between them on accept
    y = 640
    for i, (x, lab) in enumerate(((240, "OLD KEY"), (1240, "NEW WALLET"))):
        ba = ease(span(ts, 1.0 + i * 0.2, 1.6 + i * 0.2))
        f.rect((x, y - 60, x + 440, y + 60), outline=mix(INK, PAPER, ba), w=2)
        f.text((x + 220, y - 16), lab, font(MONO_B, 28), PAPER, "ma", alpha=ba)
    offer = ease(span(ts, 1.8, 2.8))
    for k in range(0, 20):
        if k / 20 > offer:
            break
        if k % 2 == 0:
            xa, xb = 680 + 560 * k / 20, 680 + 560 * (k + 1) / 20
            f.line([(xa, y), (xb, y)], DIM, 2)
    f.text((960, y - 70), "1 · offer", font(MONO, 24), DIM, "ma", alpha=ease(span(ts, 2.0, 2.5)))
    acc = ease(span(ts, 3.0, 3.9))
    if acc > 0:
        kx = 460 + (1460 - 460) * inout(span(ts, 3.0, 3.9))
        f.rect((kx - 20, y - 20, kx + 20, y + 20), fill=FIRE)
        f.text((960, y + 50), "2 · accept", font(MONO_B, 24), FIRE, "ma", alpha=acc)
    # the reference vault's real record lines
    rec = (("Owner offered the vault to 0xEF77…239C", 4.2), ("Owner is now 0xEF77…239C", 4.7))
    for i, (s, t0) in enumerate(rec):
        ra = ease(span(ts, t0, t0 + 0.5))
        yy = 820 + i * 56
        f.rect((140, yy + 10, 152, yy + 22), fill=mix(INK, FIRE if i else DIM, ra))
        f.text((176, yy), s, font(MONO, 28), PAPER if i else DIM, alpha=ra)
    f.text((1780, 876), "reference vault, Robinhood Chain", font(MONO, 20), DIM, "ra", alpha=ease(span(ts, 5.0, 5.5)))


def s_end(f, ts, L):
    cx, cy = W * 0.5, H * 0.42
    survey(f, ts + 3, cx, cy, 760, draw=1.0, rot=ts * 0.01)
    a = ease(span(ts, 0.2, 1.0))
    mark(f, cx - 210, cy - 70, 110 * (0.9 + 0.1 * a), a)
    f.text((cx - 70, cy - 52), "VAUBAN", font(SERIF, 110, 500), PAPER, alpha=a)
    items = ("vauban.works", "npm i @vaubanworks/sdk", "Not audited. Built in the open.")
    for i, s in enumerate(items):
        ia = ease(span(ts, 1.0 + i * 0.3, 1.6 + i * 0.3))
        f.text((cx, cy + 170 + i * 56), s, font(MONO_B if i == 0 else MONO, 30 if i == 0 else 26), FIRE if i == 0 else DIM, "ma", alpha=ia)


SCENES = [(s_open, 4.2), (s_problem, 4.6), (s_walls, 4.4), (s_rulings, 9.6), (s_check, 5.6), (s_handover, 6.0), (s_end, 4.0)]
XF = 0.5  # cross-fade between scenes


def render_at(t):
    acc = 0.0
    for i, (fn, L) in enumerate(SCENES):
        if t < acc + L or i == len(SCENES) - 1:
            ts = t - acc
            f = F()
            fn(f, ts, L)
            img = f.frame()
            # fade the next scene in over the tail of this one
            if i + 1 < len(SCENES) and ts > L - XF:
                g = F()
                SCENES[i + 1][0](g, ts - L + XF, SCENES[i + 1][1])
                img = Image.blend(img, g.frame(), inout((ts - (L - XF)) / XF))
            return img
        acc += L - XF
    return None


def total():
    return sum(L for _, L in SCENES) - XF * (len(SCENES) - 1)


def main():
    T = total()
    n = int(T * FPS)
    if STILLS:
        acc = 0.0
        for i, (fn, L) in enumerate(SCENES):
            render_at(acc + L * 0.75).save(f"{OUT}.{i}.png")
            acc += L - XF
        print("stills", len(SCENES))
        return
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT],
        stdin=subprocess.PIPE)
    for k in range(n):
        proc.stdin.write(render_at(k / FPS).tobytes())
    proc.stdin.close()
    proc.wait()
    print(OUT, round(T, 1), "s", n, "frames")


if __name__ == "__main__":
    main()
