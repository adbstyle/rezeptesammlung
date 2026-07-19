#!/usr/bin/env python3
"""validate.py — alle Validierungsregeln der Spec (Kap. 7).

Aufruf:  .venv/bin/python scripts/validate.py [rezept.yaml ...]
Ohne Argumente werden alle Dateien in rezepte/ geprüft.
Exit-Code 1 bei Fehlern (Build bricht ab); Warnungen sind kein Fehler.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import jsonschema
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import recipe as rlib  # noqa: E402

SCHEMA_FILE = rlib.REPO_ROOT / "schema" / "recipe.schema.json"
LAYOUT_FILE = rlib.REPO_ROOT / "book" / "layout.yaml"


def check_file(path: Path, validator: jsonschema.Draft202012Validator,
               units: dict[str, str]) -> list[str]:
    """Regeln 1–6 für eine Rezept-Datei. Rückgabe: Fehlermeldungen."""
    try:
        recipe = rlib.load_recipe(path)
    except yaml.YAMLError as exc:
        return [f"YAML nicht lesbar: {exc}"]

    # 1. JSON Schema
    errors = [f"Schema: {err.json_path}: {err.message}"
              for err in validator.iter_errors(recipe)]
    if errors:
        return errors  # Struktur kaputt → Folgeregeln wären Rauschen

    # 2. Dateiname = id
    if path.stem != recipe["id"]:
        errors.append(f"id '{recipe['id']}' ≠ Dateiname '{path.stem}'")

    seen: dict[str, tuple] = {}  # id → (item, unit, scalable, note)
    for nr, step in enumerate(recipe["steps"], 1):
        declared = {i["id"]: i for i in step.get("ingredients", [])}
        if len(declared) != len(step.get("ingredients", [])):
            errors.append(f"Schritt {nr}: doppelte Zutaten-id im selben Schritt")
        refs = set(rlib.REF_RE.findall(step["text"]))

        # 3. Referenz-Integrität pro Schritt
        for iid in sorted(set(declared) - refs):
            errors.append(f"Schritt {nr}: Zutat '{iid}' deklariert, "
                          f"aber nicht als {{{iid}}} im Text")
        for iid in sorted(refs - set(declared)):
            errors.append(f"Schritt {nr}: Referenz {{{iid}}} ohne "
                          f"Deklaration im selben Schritt")

        for iid, ing in declared.items():
            # 4. Konsistenz geteilter Zutaten
            signature = (ing["item"], ing.get("unit"),
                         ing.get("scalable", True), ing.get("note"))
            if iid in seen and seen[iid] != signature:
                errors.append(f"Zutat '{iid}': item/unit/scalable/note "
                              f"weichen zwischen Schritten ab")
            seen.setdefault(iid, signature)

            # 5. Einheiten
            unit = ing.get("unit")
            if unit is not None and unit not in units:
                errors.append(f"Schritt {nr}: Einheit '{unit}' ('{iid}') "
                              f"fehlt in schema/units.yaml")

    # 6. Bilder
    image_paths = list(recipe["images"])
    image_paths += [f"images/{recipe['id']}.{nr}.jpg"
                    for nr, step in enumerate(recipe["steps"], 1)
                    if step.get("image")]
    for rel in image_paths:
        if not (path.parent / rel).is_file():
            errors.append(f"Bild fehlt: {rel}")

    return errors


def layout_ids(node) -> list[str]:
    """Alle Rezept-ids aus book/layout.yaml (Strings in Listen/Maps)."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, list):
        return [i for child in node for i in layout_ids(child)]
    if isinstance(node, dict):
        return [i for child in node.values() for i in layout_ids(child)]
    return []


def main_for(files: list[Path]) -> int:
    """Alle Regeln für die gegebenen Dateien prüfen; 0 = ok, 1 = Fehler."""
    schema = json.loads(SCHEMA_FILE.read_text())
    validator = jsonschema.Draft202012Validator(
        schema, format_checker=jsonschema.FormatChecker())
    units = rlib.load_units()

    failed = False
    for path in files:
        errors = check_file(path, validator, units)
        if errors:
            failed = True
            print(f"✗ {path.name}")
            for error in errors:
                print(f"    {error}")
        else:
            print(f"✓ {path.name}")

    # 7. Layout (falls book/layout.yaml existiert)
    if LAYOUT_FILE.is_file():
        layout = layout_ids(yaml.safe_load(LAYOUT_FILE.read_text()))
        all_ids = {p.stem for p in rlib.RECIPE_DIR.glob("*.yaml")}
        for rid in layout:
            if rid not in all_ids:
                failed = True
                print(f"✗ layout.yaml: Rezept '{rid}' existiert nicht")
        for rid in sorted(all_ids - set(layout)):
            print(f"⚠ Warnung: '{rid}' kommt in keinem Kapitel vor")

    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path,
                        help="Rezept-Dateien (Default: alle in rezepte/)")
    args = parser.parse_args()

    files = args.files or sorted(rlib.RECIPE_DIR.glob("*.yaml"))
    if not files:
        print("Keine Rezept-Dateien gefunden.", file=sys.stderr)
        return 1
    return main_for(files)


if __name__ == "__main__":
    sys.exit(main())
