#!/usr/bin/env python3
"""build_pdf.py — YAML → Markdown → Pandoc (HTML) → Chromium → PDF.

Aufruf:
  .venv/bin/python scripts/build_pdf.py                          # alle rezepte/ → build/rezeptbuch.pdf
  .venv/bin/python scripts/build_pdf.py rezepte/butterzopf.yaml  # ein Rezept → build/butterzopf.pdf
  .venv/bin/python scripts/build_pdf.py --servings 8 ...         # Sonderausgabe, skaliert (Kap. 8)

Gerendert wird standardmässig die Basis-Portionierung. Die Spec sieht
Pandoc/LaTeX vor; solange keine LaTeX-Engine installiert ist, übernimmt
Chromium (Playwright-Cache oder System-Chrome) den PDF-Druck aus HTML.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import recipe as rlib  # noqa: E402
import validate  # noqa: E402

BUILD_DIR = rlib.REPO_ROOT / "build"
PAGEBREAK = '<div style="page-break-after: always;"></div>'

CSS = """
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
       Helvetica, Arial, sans-serif; max-width: 900px; margin: 0 auto;
       padding: 2rem; line-height: 1.6; font-size: 14px; }
h1 { border-bottom: 2px solid #333; padding-bottom: 0.3rem; }
h2 { border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; margin-top: 2rem; }
img { max-width: 100%; max-height: 480px; width: auto; height: auto;
      display: block; margin: 1rem auto; border-radius: 6px; }
ol li, ul li { margin-bottom: 0.4rem; }
blockquote { border-left: 4px solid #0366d6; margin: 1rem 0;
             padding: 0.5rem 1rem; background: #f8f9fa; }
@media print { body { padding: 0; } }
"""


def find_chromium() -> Path | None:
    """Playwright-Chromium bevorzugen, sonst System-Browser."""
    playwright = Path.home() / "Library/Caches/ms-playwright"
    candidates = sorted(playwright.glob(
        "chromium-*/chrome-mac*/Google Chrome for Testing.app"
        "/Contents/MacOS/Google Chrome for Testing"))
    candidates += [
        Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def markdown_to_pdf(md: str, title: str, output: Path) -> None:
    html_body = subprocess.run(
        ["pandoc", "--from", "gfm", "--to", "html"],
        input=md, capture_output=True, text=True, check=True).stdout
    html = (f'<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">'
            f"<title>{title}</title><style>{CSS}</style></head>"
            f"<body>{html_body}</body></html>")

    browser = find_chromium()
    if browser is None:
        sys.exit("Kein Chromium/Chrome gefunden. "
                 "Installation: npx playwright install chromium")

    with tempfile.TemporaryDirectory() as tmp:
        html_file = Path(tmp) / "recipe.html"
        html_file.write_text(html)
        pdf_file = Path(tmp) / "recipe.pdf"
        subprocess.run(
            [str(browser), "--headless", "--disable-gpu",
             f"--print-to-pdf={pdf_file}", "--no-pdf-header-footer",
             html_file.as_uri()],
            check=True, capture_output=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(pdf_file.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", type=Path,
                        help="Rezept-Dateien (Default: alle in rezepte/)")
    parser.add_argument("--servings", type=int, default=None,
                        help="auf N Personen skalieren (Default: Basiswerte)")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Ziel-PDF (Default: build/<id>.pdf bzw. "
                             "build/rezeptbuch.pdf)")
    args = parser.parse_args()

    files = args.files or sorted(rlib.RECIPE_DIR.glob("*.yaml"))
    if not files:
        sys.exit("Keine Rezept-Dateien gefunden.")

    # Build bricht bei Validierungsfehlern ab (Spec Kap. 7)
    if validate.main_for(files) != 0:
        return 1

    units = rlib.load_units()
    rendered = []
    for path in files:
        recipe = rlib.load_recipe(path)
        factor = (args.servings / recipe["yield"]["servings"]
                  if args.servings else 1.0)
        resolve = lambda rel, base=path.parent: (base / rel).resolve().as_uri()
        rendered.append(rlib.render_markdown(recipe, factor, units, resolve))

    if args.output:
        output = args.output
    elif len(files) == 1:
        output = BUILD_DIR / f"{files[0].stem}.pdf"
    else:
        output = BUILD_DIR / "rezeptbuch.pdf"

    title = (rlib.load_recipe(files[0])["title"] if len(files) == 1
             else "Rezeptsammlung")
    markdown_to_pdf(f"\n\n{PAGEBREAK}\n\n".join(rendered), title, output)
    print(f"PDF erstellt: {output.relative_to(Path.cwd()) if output.is_relative_to(Path.cwd()) else output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
