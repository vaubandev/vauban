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


def contours(d, w, h, col, cx=None, cy=None, rot=0.0):
    """Survey contours of a bastioned trace, the same background as site/trace.svg."""
    cx = w * 0.72 if cx is None else cx
    cy = h * 0.5 if cy is None else cy
    span = max(w, h)
    for k, f in enumerate((0.16, 0.225, 0.295, 0.37, 0.45, 0.54, 0.63)):
        pts = trace(cx * SS, cy * SS, span * f * SS, rot=pi / 8 + k * 0.035 + rot)
        if k % 2:
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                for t in range(0, 10, 2):
                    d.line([(a[0] + (b[0] - a[0]) * t / 10, a[1] + (b[1] - a[1]) * t / 10),
                            (a[0] + (b[0] - a[0]) * (t + 1) / 10, a[1] + (b[1] - a[1]) * (t + 1) / 10)], fill=col, width=SS)
        else:
            d.line(pts + [pts[0]], fill=col, width=SS)
    for i in range(8):
        a = pi / 8 + i * pi / 4 + rot
        for t in range(0, 60, 3):
            r0, r1 = span * 0.02 * t, span * 0.02 * (t + 0.4)
            d.line([((cx + r0 * cos(a)) * SS, (cy + r0 * sin(a)) * SS), ((cx + r1 * cos(a)) * SS, (cy + r1 * sin(a)) * SS)], fill=col, width=SS)


def grid(d, w, h, step, col):
    contours(d, w, h, col)


def text(d, xy, s, f, fill, anchor="la"):
    d.text((xy[0] * SS, xy[1] * SS), s, font=f, fill=fill, anchor=anchor)


def avatar():
    img = canvas(400, 400, INK)
    d = ImageDraw.Draw(img)
    mark(d, 72, 76, 256, PAPER)
    done(img, "x-avatar.png")


def token_logo():
    img = canvas(1024, 1024, INK)
    d = ImageDraw.Draw(img)
    mark(d, 184, 194, 656, PAPER)
    done(img, "token-logo.png")


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


def trace_svg():
    """site/trace.svg: survey contours of a bastioned trace, the page background instead of a grid."""
    W, H, cx, cy = 1600, 1000, 1150, 500
    paths = []
    for k, r in enumerate((260, 360, 470, 590, 720, 860, 1010)):
        pts = trace(cx, cy, r, rot=pi / 8 + k * 0.035)
        d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z"
        dash = ' stroke-dasharray="3 7"' if k % 2 else ""
        paths.append(f'<path d="{d}"{dash}/>')
    for i in range(8):
        a = pi / 8 + i * pi / 4
        paths.append(f'<path d="M{cx:.0f} {cy:.0f} L{cx + 1100 * cos(a):.1f} {cy + 1100 * sin(a):.1f}" stroke-dasharray="1 9"/>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMaxYMid slice">'
           f'<g fill="none" stroke="#2a2c22" stroke-width="1">{"".join(paths)}</g></svg>\n')
    (SITE / "trace.svg").write_text(svg)
    print(f"trace.svg      {len(svg)} B")


def npm_card():
    W, H = 1600, 900
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (32, 33, 26))
    S = lambda *p: [v * SS for v in p]
    mono, small = font(MONO, 22), font(MONO, 17)
    bold = font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 22)
    dim = (160, 156, 138)
    text(d, (96, 84), "PLATE VI  ·  ON NPM", small, OLIVE)
    mark(d, 96, 128, 52, PAPER)
    text(d, (166, 134), "VAUBAN", font(SERIF, 52, 500), PAPER)
    text(d, (96, 232), "npm install", font(SERIF, 54, 400), PAPER)
    text(d, (96, 296), "@vaubanworks/sdk", font(SERIF, 54, 400), FIRE)

    # Code and output exactly as run against the live reference vault on 4663.
    d.rectangle(S(96, 396, 1504, 772), fill=(26, 27, 21), outline=(48, 49, 40), width=SS)
    lines = (
        ("$ npm install @vaubanworks/sdk viem", PAPER, mono),
        ("", PAPER, mono),
        ("const agent = new VaubanAgent({ vault, public, wallet });", PAPER, mono),
        ("await agent.rule({ target: \"0x…dEaD\", value: 10n ** 18n });", PAPER, mono),
        ("", PAPER, mono),
        ("Refused  curtain  CurtainNotListed", FIRE, bold),
        ("0x…dEaD selector 0x00000000 is not on the allowlist", dim, mono),
    )
    for i, (ln, col, f) in enumerate(lines):
        text(d, (128, 426 + i * 46), ln, f, col)

    text(d, (96, 812), "Simulated first, so a refusal costs no gas. TypeScript, built on viem. Not audited.", small, dim)
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=FIRE)
    done(img, "tweet-npm.png")


def try_card():
    W, H = 1600, 900
    img = canvas(W, H, PAPER)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (222, 215, 196))
    S = lambda *p: [v * SS for v in p]
    mono, small = font(MONO, 22), font(MONO, 17)
    bold = font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 22)
    field_bg = (241, 236, 222)
    text(d, (96, 84), "VAUBAN.WORKS/TABLE  ·  RULE A CALL", small, MUTED)
    mark(d, 96, 128, 52, INK)
    text(d, (166, 134), "VAUBAN", font(SERIF, 52, 500), INK)
    text(d, (96, 232), "Try it in the browser.", font(SERIF, 54, 400), INK)
    text(d, (96, 296), "No wallet, nothing signed.", font(SERIF, 54, 400), FIRE)

    # Same fields and verdict the live form returned for the reference vault on 4663.
    d.rectangle(S(96, 400, 1504, 760), fill=(236, 230, 214), outline=INK, width=2 * SS)
    lab = font(MONO, 15)
    fields = ((128, 432, 900, "TARGET", "0x000000000000000000000000000000000000dEaD"),
              (940, 432, 1472, "VALUE (ETH)", "1"),
              (128, 532, 1472, "CALLDATA", "0x  (empty: a plain ETH send)"))
    for x0, y, x1, label, val in fields:
        text(d, (x0, y), label, lab, MUTED)
        d.rectangle(S(x0, y + 26, x1, y + 76), fill=field_bg, outline=INK, width=SS)
        text(d, (x0 + 16, y + 40), val, mono, INK if label != "CALLDATA" else MUTED)
    d.rectangle(S(128, 638, 268, 688), fill=FIRE)
    text(d, (198, 652), "RULE", bold, INK, anchor="ma")
    text(d, (300, 652), "REFUSED at the CURTAIN", bold, FIRE)
    text(d, (300, 690), "0x…dEaD selector 0x00000000 is not on the allowlist.", small, INK)

    text(d, (96, 800), "Reference vault 0xf9322f15…30e4097 on Robinhood Chain. Not audited.", small, MUTED)
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=INK)
    done(img, "tweet-try.png")


def rule_card():
    W, H = 1600, 900
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (32, 33, 26))
    S = lambda *p: [v * SS for v in p]
    mono, small = font(MONO, 21), font(MONO, 18)
    bold = font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 30)
    dim = (160, 156, 138)
    text(d, (96, 84), "PLATE V  ·  RULE BEFORE YOU SIGN", small, OLIVE)
    mark(d, 96, 128, 52, PAPER)
    text(d, (166, 134), "VAUBAN", font(SERIF, 52, 500), PAPER)
    text(d, (96, 232), "Ask the vault", font(SERIF, 54, 400), PAPER)
    text(d, (96, 296), "before you sign.", font(SERIF, 54, 400), FIRE)

    # Command and verdict as the live reference vault on 4663 returned them.
    d.rectangle(S(96, 400, 1010, 720), fill=(26, 27, 21), outline=(48, 49, 40), width=SS)
    term = (
        ("$ node rule.mjs 0xf9322f15…30e4097 \\", PAPER, mono),
        ("    --to 0x0000…dEaD \\", PAPER, mono),
        ("    --value 1000000000000000000", PAPER, mono),
        ("", PAPER, mono),
        ("REFUSED at the CURTAIN", FIRE, font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 24)),
        ("0x0000…dead selector 0x00000000 is not on the allowlist", dim, mono),
    )
    for i, (ln, col, f) in enumerate(term):
        text(d, (128, 432 + i * 44), ln, f, col)

    verdicts = (("PASS", "lands now", OLIVE), ("HOLD", "waits at the gate", PAPER), ("REFUSED", "names the rampart", FIRE))
    for i, (label, what, col) in enumerate(verdicts):
        y = 412 + i * 104
        d.line(S(1090, y - 14, 1504, y - 14), fill=(60, 61, 50), width=SS)
        text(d, (1090, y), label, bold, col)
        text(d, (1090, y + 44), what, font(SERIF, 28, 400), PAPER)

    text(d, (96, 800), "One read-only eth_call. Nothing signed, nothing sent, no key.", small, dim)
    text(d, (W - 96, 800), "vauban.works", small, dim, anchor="ra")
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=FIRE)
    done(img, "tweet-rule.png")


def walls():
    W, H = 1600, 900
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (32, 33, 26))
    S = lambda *p: [v * SS for v in p]
    mono, bold = font(MONO, 18), font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 22)
    head, body = font(SERIF, 46, 500), font(SERIF, 30, 400)
    dim = (160, 156, 138)
    text(d, (96, 84), "PLATE IV  ·  TRUST OR WALLS", mono, OLIVE)
    d.line(S(800, 170, 800, 760), fill=(60, 61, 50), width=SS)

    # Left: on trust, the key reaches everything.
    text(d, (96, 190), "On trust", head, PAPER)
    for box, label in (((96, 360, 300, 440), "AGENT"), ((470, 360, 740, 440), "ALL FUNDS")):
        d.rectangle(S(*box), outline=PAPER, width=2 * SS)
        text(d, ((box[0] + box[2]) / 2, 388), label, bold, PAPER, anchor="ma")
    d.line(S(300, 400, 458, 400), fill=FIRE, width=3 * SS)
    d.polygon(S(470, 400, 452, 390, 452, 410), fill=FIRE)
    text(d, (96, 520), "Anything the key can sign,", body, PAPER)
    text(d, (96, 562), "it can spend.", body, FIRE)

    # Right: on walls, every call meets the fort first.
    text(d, (860, 190), "On walls", head, PAPER)
    fort(d, 1260, 430, 180, PAPER, (95, 96, 80))
    x = 1260 - 180 * 1.16 - 18
    d.polygon(S(x, 416, x + 14, 430, x, 444, x - 14, 430), fill=FIRE)
    for k in range(1, 6):
        r = 3
        cx = x - k * 24
        d.ellipse(S(cx - r, 430 - r, cx + r, 430 + r), fill=(110, 108, 94))
    text(d, (860, 660), "Only what the sheet allows", body, PAPER)
    text(d, (860, 702), "gets through.", body, FIRE)

    mark(d, 96, 800, 40, PAPER)
    text(d, (152, 806), "VAUBAN", font(SERIF, 34, 500), PAPER)
    text(d, (W - 96, 812), "vauban.works", mono, dim, anchor="ra")
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=FIRE)
    done(img, "tweet-walls.png")


def build_log():
    W, H = 1600, 900
    img = canvas(W, H, PAPER)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (222, 215, 196))
    fort(d, 1260, 450, 260, INK, (150, 146, 128))
    mono, small = font(MONO, 18), font(MONO, 16)
    X0 = 96
    text(d, (X0, 92), "PLATE III  ·  BUILD LOG", mono, MUTED)
    mark(d, X0, 132, 56, INK)
    text(d, (X0 + 76, 138), "VAUBAN", font(SERIF, 56, 500), INK)
    text(d, (X0, 244), "What is standing,", font(SERIF, 50, 400), INK)
    text(d, (X0, 304), "not what is promised.", font(SERIF, 50, 400), FIRE)
    # Every figure here is checked against the repo, CI or chain before rendering.
    rows = (
        ("36", "contract tests, fuzzing and reentrancy included"),
        ("2", "pull requests merged into Aeon"),
        ("1", "reference vault live on Robinhood Chain"),
        ("0", "keys asked for by the Aeon skill"),
        ("CI", "runs every test on every push"),
    )
    num, line = font(SERIF, 44, 500), font(SERIF, 28, 400)
    for i, (n, what) in enumerate(rows):
        y = 420 + i * 72
        d.line([X0 * SS, (y - 16) * SS, 900 * SS, (y - 16) * SS], fill=(196, 189, 168), width=SS)
        text(d, (X0, y - 6), n, num, FIRE)
        text(d, (X0 + 110, y + 4), what, line, INK)
    text(d, (X0, 806), "Not audited yet.   vauban.works   ·   github.com/vaubandev/vauban", small, MUTED)
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=INK)
    done(img, "tweet-buildlog.png")


def dex_header():
    # DexScreener crops nothing but shows it small: keep text large and centred-left.
    W, H = 1500, 500
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (32, 33, 26))
    fort(d, 1180, 250, 200, PAPER, (95, 96, 80))
    mark(d, 110, 150, 96, PAPER)
    text(d, (230, 160), "VAUBAN", font(SERIF, 104, 500), PAPER)
    text(d, (112, 310), "A vault for autonomous agents on Robinhood Chain", font(SERIF, 34, 400), PAPER)
    text(d, (112, 372), "DITCH  ·  CURTAIN  ·  GATE  ·  KEEP", font(MONO, 22), FIRE)
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=FIRE)
    done(img, "dex-header.png")


def rulings():
    W, H = 1600, 900
    img = canvas(W, H, INK)
    d = ImageDraw.Draw(img)
    grid(d, W, H, 50, (32, 33, 26))
    fort(d, 1250, 470, 250, PAPER, (95, 96, 80))
    mono, bold, small = font(MONO, 22), font("/usr/local/share/fonts/IBMPlexMono-SemiBold.ttf", 22), font(MONO, 17)
    X0 = 96
    text(d, (X0, 92), "PLATE II  ·  RULINGS", font(MONO, 18), OLIVE)
    mark(d, X0, 136, 56, PAPER)
    text(d, (X0 + 76, 142), "VAUBAN", font(SERIF, 56, 500), PAPER)
    head = font(SERIF, 50, 400)
    text(d, (X0, 250), "Every call crosses", head, PAPER)
    text(d, (X0, 310), "four ramparts.", head, FIRE)
    # Same five moves and outcomes as sdk/scripts/demo-capture.ts on a local chain.
    rows = (
        ("buy 0.04 ETH on a listed router", "PASSED", OLIVE),
        ("send 1 ETH to an unknown address", "CURTAIN  refused", FIRE),
        ("buy 0.2 ETH, cap is 0.1 per tx", "DITCH  refused", FIRE),
        ("buy 0.08 ETH, holds above 0.05", "GATE  held 6h", FIRE),
        ("any move after the owner freezes", "KEEP  refused", FIRE),
    )
    text(d, (X0, 418), "agent.execute(", small, (160, 156, 138))
    text(d, (X0 + 560, 418), "ruling", small, (160, 156, 138))
    for i, (ask, ruling, col) in enumerate(rows):
        y = 470 + i * 64
        d.line([X0 * SS, (y - 18) * SS, 880 * SS, (y - 18) * SS], fill=(48, 49, 40), width=SS)
        text(d, (X0, y), ask, mono, PAPER)
        text(d, (X0 + 560, y), ruling, bold, col)
    text(d, (X0, 812), "Refusals are simulated first, so they cost no gas.   vauban.works", small, (160, 156, 138))
    d.rectangle([0, (H - 8) * SS, W * SS, H * SS], fill=FIRE)
    done(img, "tweet-rulings.png")


if __name__ == "__main__":
    avatar()
    banner()
    og()
    tweet()
