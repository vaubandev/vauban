"""Assemble pages/*.html into site/<route>/index.html with a shared shell. Run: python3 scripts/build.py"""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PAGES, SITE = ROOT / "pages", ROOT / "site"
ORIGIN = "https://vauban.works"

NAV = [("/works/", "The works"), ("/drawing/", "The drawing"), ("/construction/", "Construction"), ("/name/", "The name"), ("/table/", "Owner's table")]

MARK = (
    '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true">'
    '<path d="M5 3 L5 13 L16 29 L27 13 L27 3" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="miter" stroke-miterlimit="10"/>'
    '<path d="M10.5 3 L10.5 14.6 L16 22.6 L21.5 14.6 L21.5 3" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".6"/>'
    '<rect x="14" y="3" width="4" height="4" fill="#ff4a1c"/></svg>'
)

SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#14150f">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="{origin}{route}">
<meta property="og:site_name" content="Vauban">
<meta property="og:image" content="{origin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@vaubanworks">
<meta name="twitter:image" content="{origin}/og.png">
<link rel="canonical" href="{origin}{route}">
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;1,9..144,400&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap nav-in">
    <a class="brand" href="/" aria-label="Vauban — home">{mark}<span class="wordmark">VAUBAN</span></a>
    <nav class="links" aria-label="Primary">{links}</nav>
    <span class="plate-no">{plate}</span>
    <button class="menu" type="button" aria-expanded="false" aria-label="Menu">MENU</button>
  </div>
</header>
<main id="main">
{body}
</main>
<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand small" href="/">{mark}VAUBAN</a>
        <p class="lead">A fortification for autonomous agents. Four ramparts between an agent and its wallet, drawn once and held by the owner.</p>
      </div>
      <div><h4>Sheets</h4><a href="/works/">The works</a><a href="/drawing/">The drawing</a><a href="/construction/">Construction</a><a href="/name/">The name</a></div>
      <div><h4>Ramparts</h4><a href="/works/#ditch">Ditch</a><a href="/works/#curtain">Curtain</a><a href="/works/#gate">Gate</a><a href="/works/#keep">Keep</a></div>
      <div><h4>Status</h4><a href="/construction/">What is built</a><a href="/construction/#faq">Questions</a><a href="/table/">Owner's table</a><a href="https://x.com/vaubanworks">X</a><a href="https://github.com/vaubandev/vauban">GitHub</a></div>
    </div>
    <div class="foot-in">
      <p>An independent work. Not affiliated with Aeon or Robinhood.</p>
      <p>Nothing on these sheets is financial advice. <a href="https://x.com/vaubanworks">@vaubanworks</a></p>
    </div>
  </div>
</footer>
<script src="/app.js" defer></script>{extra}
</body>
</html>
"""


def bundle():
    sdk = ROOT / "sdk"
    subprocess.run(
        ["npx", "esbuild", "src/table.ts", "--bundle", "--minify", "--format=esm", "--target=es2020",
         "--outfile=" + str(SITE / "table.js")],
        cwd=sdk, check=True, capture_output=True,
    )
    print(f"table.js       -> site/table.js  ({(SITE / 'table.js').stat().st_size} B)")


def build():
    bundle()
    for src in sorted(PAGES.glob("*.html")):
        raw = src.read_text()
        meta = dict(re.findall(r"^<!--\s*(\w+):\s*(.*?)\s*-->$", raw, re.M))
        body = re.sub(r"^<!--\s*\w+:.*?-->\n", "", raw, flags=re.M).strip()
        route = meta["route"]
        links = "".join(f'<a href="{h}">{t}</a>' for h, t in NAV)
        extra = "".join(
            f'\n<script type="module" src="{s}"></script>' if s == "/table.js" else f'\n<script src="{s}" defer></script>'
            for s in meta.get("scripts", "").split() if s
        )
        html = SHELL.format(
            title=meta["title"], desc=meta["desc"], plate=meta.get("plate", "PLATE I"),
            mark=MARK, links=links, body=body, extra=extra, origin=ORIGIN, route=route,
        )
        out = SITE / route.strip("/") / "index.html" if route != "/" else SITE / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html)
        print(f"{route:16} -> {out.relative_to(ROOT)}  ({len(html)} B)")


if __name__ == "__main__":
    build()
