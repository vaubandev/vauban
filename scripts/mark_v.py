"""Single bastion in plan, open at the gorge — reads as a V. Writes site/favicon.svg, site/mark.svg, prints 32px paths."""
from pathlib import Path

# 32-unit grid: flanks vertical, faces meet at the salient
OUTER = [(5, 3), (5, 13), (16, 29), (27, 13), (27, 3)]
INNER = [(10.5, 3), (10.5, 14.6), (16, 22.6), (21.5, 14.6), (21.5, 3)]


def d(pts, s=1.0):
    return "M" + " L".join(f"{x*s:.2f} {y*s:.2f}" for x, y in pts)


def svg(size, stroke, bg=None):
    s = size / 32
    rect = f'<rect width="{size}" height="{size}" fill="{bg}"/>' if bg else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">{rect}'
        f'<path d="{d(OUTER, s)}" fill="none" stroke="{stroke}" stroke-width="{3*s:.2f}" stroke-linejoin="miter" stroke-miterlimit="10"/>'
        f'<path d="{d(INNER, s)}" fill="none" stroke="{stroke}" stroke-width="{1.4*s:.2f}" stroke-linejoin="miter" opacity=".6"/>'
        f'<rect x="{14*s:.2f}" y="{3*s:.2f}" width="{4*s:.2f}" height="{4*s:.2f}" fill="#ff4a1c"/></svg>'
    )


if __name__ == "__main__":
    site = Path(__file__).resolve().parent.parent / "site"
    (site / "favicon.svg").write_text(svg(64, "#e9e3d2", "#14150f"))
    (site / "mark.svg").write_text(svg(32, "currentColor"))
    print("outer", d(OUTER))
    print("inner", d(INNER))
