"""Gemeinsame Lade-, Skalierungs- und Renderlogik der Rezept-Pipeline.

Implementiert die Spec docs/superpowers/specs/2026-07-19-rezept-datenmodell-design.md:
Referenz-Syntax (Kap. 5), generierte Zutatenliste (Kap. 6),
Skalierung & Anzeige-Rundung (Kap. 8). Wird von build_pdf.py und
später build_web.py verwendet.
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
RECIPE_DIR = REPO_ROOT / "rezepte"
UNITS_FILE = REPO_ROOT / "schema" / "units.yaml"

# {id}-Referenzen; {{ und }} sind literale Klammern (Kap. 5)
REF_RE = re.compile(r"(?<!\{)\{([a-z0-9_]+)\}(?!\})")

FRACTIONS = {0.25: "¼", 0.5: "½", 0.75: "¾"}

DIET_LABELS = {
    "vegetarian": "vegetarisch",
    "vegan": "vegan",
    "gluten_free": "glutenfrei",
    "lactose_free": "laktosefrei",
    "low_carb": "low carb",
}


# ---------------------------------------------------------------- Laden

def load_units(path: Path = UNITS_FILE) -> dict[str, str]:
    """units.yaml → {einheit: kategorie}, z. B. {'g': 'mass', 'EL': 'spoons'}."""
    data = yaml.safe_load(path.read_text())
    mapping: dict[str, str] = {}
    for category, spec in data.items():
        units = spec["units"]
        names = units if isinstance(units, list) else units.keys()
        for name in names:
            mapping[name] = category
    return mapping


def load_recipe(path: Path) -> dict:
    """Rezept-YAML laden; Datumswerte als ISO-Strings (fürs JSON Schema)."""
    recipe = yaml.safe_load(path.read_text())
    published = recipe.get("date_published")
    if isinstance(published, (datetime.date, datetime.datetime)):
        recipe["date_published"] = published.date().isoformat() if isinstance(
            published, datetime.datetime) else published.isoformat()
    return recipe


# ------------------------------------------------- Skalierung & Rundung

def scaled(ingredient: dict, factor: float) -> float:
    """Menge skalieren; scalable: false bleibt unverändert (Kap. 2)."""
    if ingredient.get("scalable", True):
        return ingredient["amount"] * factor
    return float(ingredient["amount"])


def display_amount(value: float, unit: str | None, units: dict[str, str]) -> str:
    """Anzeige-Rundung (Kap. 8) — nur Darstellung, nie Datenhaltung."""
    category = units.get(unit or "")
    if category == "spoons":
        value = round(value * 4) / 4
    elif unit in ("g", "ml") and value >= 100:
        value = round(value / 5) * 5
    whole = int(value)
    frac = round(value - whole, 4)
    if frac == 0:
        return str(whole)
    if frac in FRACTIONS:
        return (str(whole) if whole else "") + FRACTIONS[frac]
    return f"{value:.2f}".rstrip("0").rstrip(".")


def format_ingredient(amount: float, ingredient: dict,
                      units: dict[str, str], with_note: bool = False) -> str:
    """„Menge Einheit Zutat" — optional mit note für die Zutatenliste."""
    parts = [display_amount(amount, ingredient.get("unit"), units)]
    if ingredient.get("unit"):
        parts.append(ingredient["unit"])
    parts.append(ingredient["item"])
    text = " ".join(parts)
    if with_note and ingredient.get("note"):
        text += f" ({ingredient['note']})"
    return text


# ------------------------------------------------ Generierte Zutatenliste

def ingredient_list(recipe: dict, factor: float,
                    units: dict[str, str]) -> list[tuple[str | None, list[str]]]:
    """Kap. 6: skalieren, pro id summieren, Reihenfolge = erste Verwendung.

    Rückgabe: [(section, [zeilen])]; section ist None, wenn das Rezept
    keine Sections nutzt.
    """
    order: list[str] = []
    totals: dict[str, float] = {}
    first: dict[str, dict] = {}
    section_of: dict[str, str | None] = {}
    for step in recipe["steps"]:
        for ing in step.get("ingredients", []):
            iid = ing["id"]
            if iid not in totals:
                order.append(iid)
                totals[iid] = 0.0
                first[iid] = ing
                section_of[iid] = step.get("section")
            totals[iid] += scaled(ing, factor)

    grouped: list[tuple[str | None, list[str]]] = []
    for iid in order:
        line = format_ingredient(totals[iid], first[iid], units, with_note=True)
        section = section_of[iid]
        if grouped and grouped[-1][0] == section:
            grouped[-1][1].append(line)
        else:
            grouped.append((section, [line]))
    return grouped


# ----------------------------------------------------- Schritt-Rendering

def render_step_text(step: dict, factor: float, units: dict[str, str]) -> str:
    """{id} → „Menge Einheit Zutat" des selben Schritts, skaliert (Kap. 5)."""
    declared = {i["id"]: i for i in step.get("ingredients", [])}

    def substitute(match: re.Match) -> str:
        ing = declared[match.group(1)]
        return format_ingredient(scaled(ing, factor), ing, units)

    text = REF_RE.sub(substitute, " ".join(step["text"].split()))
    return text.replace("{{", "{").replace("}}", "}")


# ---------------------------------------------------- Markdown-Rendering

def render_markdown(recipe: dict, factor: float, units: dict[str, str],
                    resolve_image=None) -> str:
    """Ein Rezept als Markdown: Titel, Bild, Metazeile, Zutaten, Schritte,
    Nährwerte, Notizen, Quelle (Spec Kap. 10.1).

    resolve_image: optionaler Callback pfad-relativ-zu-rezepte/ → src fürs
    Markdown (z. B. absolute Pfade für den PDF-Build).
    """
    resolve_image = resolve_image or (lambda p: p)
    times = recipe["times"]
    total = sum(times.get(k, 0) for k in ("prep", "cook", "rest"))
    meta = [f"Zubereitung: {times['prep']} Min."]
    if times.get("cook"):
        meta.append(f"Kochen: {times['cook']} Min.")
    if times.get("rest"):
        meta.append(f"Ruhen: {times['rest']} Min.")
    meta.append(f"Total: {total} Min.")
    if recipe.get("difficulty"):
        meta.append(f"Schwierigkeit: {recipe['difficulty']}")
    servings = recipe["yield"]["servings"]
    portions = round(servings * factor)
    meta.append(recipe["yield"].get("description", f"Für {servings} Personen")
                if factor == 1 else f"Für {portions} Personen (skaliert)")

    out = [f"# {recipe['title']}", ""]
    out += [f"![{recipe['title']}]({resolve_image(recipe['images'][0])})", ""]
    out += [" ".join(recipe["description"].split()), ""]
    out += [" · ".join(f"**{m}**" for m in meta)]
    if recipe.get("diet"):
        out += ["", "*" + " · ".join(DIET_LABELS[d] for d in recipe["diet"]) + "*"]

    out += ["", "## Zutaten", ""]
    for section, lines in ingredient_list(recipe, factor, units):
        if section:
            out.append(f"**{section}**")
            out.append("")
        out += [f"- {line}" for line in lines]
        out.append("")

    out += ["## Zubereitung", ""]
    current_section = object()  # ungleich allem beim ersten Schritt
    for nr, step in enumerate(recipe["steps"], 1):
        section = step.get("section")
        if section != current_section:
            if section:
                out += [f"**{section}**", ""]
            current_section = section
        out.append(f"{nr}. {render_step_text(step, factor, units)}")
        if step.get("image"):
            step_image = f"images/{recipe['id']}.{nr}.jpg"
            out.append(f"   ![Schritt {nr}]({resolve_image(step_image)})")
        out.append("")

    if recipe.get("equipment"):
        out += ["**Utensilien:** " + ", ".join(recipe["equipment"]), ""]

    if recipe.get("nutrition"):
        n = recipe["nutrition"]
        values = []
        if "calories" in n:
            values.append(f"{n['calories']:g} kcal")
        for key, label in (("protein", "Eiweiss"),
                           ("carbohydrates", "Kohlenhydrate"), ("fat", "Fett")):
            if key in n:
                values.append(f"{n[key]:g} g {label}")
        out += ["## Nährwerte pro Portion", "", " · ".join(values), ""]

    if recipe.get("notes"):
        out += [f"> **Tipp:** {' '.join(recipe['notes'].split())}", ""]

    if recipe.get("source"):
        source = recipe["source"]
        reference = source["name"]
        if source.get("url"):
            reference += f" — {source['url']}"
        out += [f"*Quelle: {reference}*", ""]

    return "\n".join(out)
