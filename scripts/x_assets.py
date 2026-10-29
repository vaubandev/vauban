"""Brand PNGs: site/og.png 1200x630, site/x-avatar.png 400x400, site/x-banner.png 1500x500. Run: python3 scripts/x_assets.py"""
from math import cos, sin, pi
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SITE = Path(__file__).resolve().parent.parent / "site"
PAPER, INK, FIRE, OLIVE, MUTED = (233, 227, 210), (20, 21, 15), (255, 74, 28), (167, 178, 100), (93, 90, 76)
SS = 3  # supersample
SERIF = "/usr/local/share/fonts/Fraunces.ttf"
MONO = "/usr/local/share/fonts/IBMPlexMono-Medium.ttf"

OUTER = [(5, 3), (5, 13), (16, 29), (27, 13), (27, 3)]
INNER = [(10.5, 3), (10.5, 14.6), (16, 22.6), (21.5, 14.6), (21.5, 3)]


def font(path, px, weight=None):
    f = ImageFont.truetype(path, px * SS)
    if weight and path == SERIF:
        try:
            f.set_variation_by_axes([144, weight])
        except Exception:
            pass
    return f


def canvas(w, h, bg):
    return Image.new("RGB", (w * SS, h * SS), bg)


def done(img, name):
    w, h = img.size
    img.resize((w // SS, h // SS), Image.LANCZOS).save(SITE / name, optimize=True)
    print(f"{name:14} {w // SS}x{h // SS}")


def mark(d, x, y, size, stroke):
    s = size * SS / 32
    pt = lambda p: (x * SS + p[0] * s, y * SS + p[1] * s)
    d.line([pt(p) for p in OUTER], fill=stroke, width=round(3 * s), joint="curve")
    faded = tuple(round(c * 0.6 + b * 0.4) for c, b in zip(stroke, INK if stroke == PAPER else PAPER))
    d.line([pt(p) for p in INNER], fill=faded, width=max(1, round(1.4 * s)), joint="curve")
    d.rectangle([pt((14, 3)), pt((18, 7))], fill=FIRE)


def trace(cx, cy, r, sides=8, rot=pi / 8):
    """Bastioned polygon in plan: curtain, flank, face, salient, face, flank per side."""
    pts = []
    for i in range(sides):
        a = rot + i * 2 * pi / sides
        for da, k in ((-0.20, 0.80), (-0.17, 0.88), (0, 1.0), (0.17, 0.88), (0.20, 0.80)):
            pts.append((cx + r * k * cos(a + da), cy + r * k * sin(a + da)))
    return pts


def fort(d, cx, cy, r, ink, faint):
    cx, cy, r = cx * SS, cy * SS, r * SS
    w = lambda n: max(1, round(n * SS))
    glacis = trace(cx, cy, r * 1.16)
    for i in range(0, len(glacis), 1):
        a, b = glacis[i], glacis[(i + 1) % len(glacis)]
        steps = 14
        for k in range(0, steps, 2):
            p = (a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps)
            q = (a[0] + (b[0] - a[0]) * (k + 1) / steps, a[1] + (b[1] - a[1]) * (k + 1) / steps)
            d.line([p, q], fill=faint, width=w(1))
    main = trace(cx, cy, r)
    d.polygon(main, outline=ink, width=w(2.2))
    d.polygon(trace(cx, cy, r * 0.9), outline=faint, width=w(1))
    for i in range(8):
        a = pi / 8 + i * pi / 4 + pi / 8
        rx, ry = cx + r * 0.95 * cos(a), cy + r * 0.95 * sin(a)
        d.regular_polygon((rx, ry, r * 0.07), 3, rotation=-a * 180 / pi + 90, outline=faint, width=w(1))
    k = r * 0.22
    d.rectangle([cx - k, cy - k, cx + k, cy + k], outline=ink, width=w(1.6))
    d.line([cx - r * 0.9, cy, cx + r * 0.9, cy], fill=faint, width=w(1))
    d.line([cx, cy - r * 0.9, cx, cy + r * 0.9], fill=faint, width=w(1))
    s = r * 0.06
    d.rectangle([cx - s, cy - s, cx + s, cy + s], fill=FIRE)


def grid(d, w, h, step, col):
    for x in range(0, w * SS, step * SS):
        d.line([x, 0, x, h * SS], fill=col, width=1)
    for y in range(0, h * SS, step * SS):
        d.line([0, y, w * SS, y], fill=col, width=1)


def text(d, xy, s, f, fill, anchor="la"):
    d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=fill, anchor=anchor)


def avatar():
    img = canvas(400, 400, INK)
    d = ImageDraw.Draw(img)
    mark(d, 72, 76, 256, PAPER)
    done(img, "x-avatar.png")


def banner():
    W, H = 1500, 500
    img = canvas(W, H, PAPER)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (222, 215, 196))
    # X avatar covers bottom-left (~x<420, y>320); mobile crops ~60px top/bottom
    fort(d, 620, 250, 175, INK, (150, 146, 128))
    mono = font(MONO, 15)
    X = 880
    text(d, (X, 108), "PLATE I  ·  ROBINHOOD CHAIN 4663", mono, MUTED)
    mark(d, X, 146, 64, INK)
    text(d, (X + 84, 152), "VAUBAN", font(SERIF, 70, 500), INK)
    tag = font(SERIF, 29, 400)
    text(d, (X, 258), "The fort you build around an agent", tag, INK)
    text(d, (X, 296), "before you hand it a key.", tag, MUTED)
    text(d, (X, 362), "DITCH · CURTAIN · GATE · KEEP", mono, FIRE)
    d.rectangle([0, (H - 6) * SS, W * SS, H * SS], fill=INK)
    done(img, "x-banner.png")


def og():
    W, H = 1200, 630
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 45, (32, 33, 26))
    fort(d, 930, 315, 220, PAPER, (95, 96, 80))
    mono = font(MONO, 16)
    text(d, (72, 84), "A FORTIFICATION FOR AUTONOMOUS AGENTS", mono, OLIVE)
    mark(d, 72, 140, 64, PAPER)
    text(d, (152, 146), "VAUBAN", font(SERIF, 64, 500), PAPER)
    body = font(SERIF, 40, 400)
    for i, line in enumerate(("Spend caps, allowlist,", "time-lock, kill switch.", "Enforced on-chain.")):
        text(d, (72, 270 + i * 52), line, body, PAPER if i < 2 else FIRE)
    text(d, (72, 540), "IV RAMPARTS  ·  0 APPROVAL PROMPTS  ·  I KILL SWITCH", mono, (160, 156, 138))
    done(img, "og.png")


def tweet():
    W, H = 1600, 900
    img = canvas(W, H, PAPER)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (222, 215, 196))
    fort(d, 420, 450, 300, INK, (150, 146, 128))
    mono, small = font(MONO, 18), font(MONO, 15)
    X = 860
    text(d, (X, 110), "PLATE I  ·  ORDER OF RULING", mono, MUTED)
    mark(d, X, 152, 60, INK)
    text(d, (X + 80, 158), "VAUBAN", font(SERIF, 64, 500), INK)
    rows = (
        ("I", "DITCH", "Spend caps per tx, hour, day"),
        ("II", "CURTAIN", "Only listed contracts + functions"),
        ("III", "GATE", "Big moves wait. Owner can cancel"),
        ("IV", "KEEP", "One switch freezes everything"),
    )
    name, desc = font(SERIF, 38, 500), font(SERIF, 27, 400)
    for i, (n, label, line) in enumerate(rows):
        y = 300 + i * 112
        d.line([X * SS, (y - 22) * SS, (W - 110) * SS, (y - 22) * SS], fill=(196, 189, 168), width=SS)
        text(d, (X, y + 4), n, mono, FIRE)
        text(d, (X + 70, y - 6), label, name, INK)
        text(d, (X + 70, y + 42), line, desc, MUTED)
    text(d, (X, 770), "ENFORCED ON-CHAIN  ·  vauban.works", mono, INK)
    text(d, (X, 802), "Not audited. One empty reference vault live on chain 4663.", small, MUTED)
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=INK)
    done(img, "tweet-1.png")


if __name__ == "__main__":
    avatar()
    banner()
    og()
    tweet()
