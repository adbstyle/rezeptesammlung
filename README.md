# Rezeptesammlung

Persönliche Rezeptsammlung als strukturierte YAML-Dateien mit Validierung und
PDF-Build. Jedes Rezept ist eine Datei in [rezepte/](rezepte/), die Zutaten
werden direkt in den Zubereitungsschritten deklariert — die Zutatenliste wird
daraus automatisch generiert. Das Datenmodell ist in der
[Design-Spec](docs/superpowers/specs/2026-07-19-rezept-datenmodell-design.md)
beschrieben.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Für den PDF-Build werden zusätzlich **Pandoc** (Markdown → HTML) und ein
**Chromium/Chrome** (HTML → PDF) benötigt.

## Verwendung

```bash
# Alle Rezepte validieren (Schema + Konsistenzregeln)
.venv/bin/python scripts/validate.py

# Einzelne Datei prüfen
.venv/bin/python scripts/validate.py rezepte/goldenes-dal.yaml

# Gesamtes Rezeptbuch bauen → build/rezeptbuch.pdf
.venv/bin/python scripts/build_pdf.py

# Ein Rezept als PDF → build/goldenes-dal.pdf
.venv/bin/python scripts/build_pdf.py rezepte/goldenes-dal.yaml

# Skalierte Sonderausgabe (z. B. für 8 Personen)
.venv/bin/python scripts/build_pdf.py --servings 8 rezepte/goldenes-dal.yaml
```

## Rezeptformat

Kernidee: Zutaten stehen **beim Schritt, in dem sie gebraucht werden**, und
werden im Schritttext mit `{id}` referenziert. Beim Rendern wird die Referenz
durch «Menge Einheit Zutat» ersetzt (skaliert), und die Zutatenliste am Anfang
des Rezepts wird aus allen Schritten zusammengeführt.

```yaml
id: goldenes-dal            # muss dem Dateinamen entsprechen
title: Goldenes Dal
description: >
  Kurzbeschreibung des Gerichts.
lang: de
category: Hauptgericht
cuisine: Indien
diet: [vegan, gluten_free]
difficulty: einfach
times: { prep: 15, cook: 30 }   # Minuten; optional rest
yield: { servings: 4 }
images: [images/goldenes-dal.jpg]

steps:
  - text: >
      {linsen} waschen und mit {wasser} aufkochen.
    ingredients:
      - { id: linsen, amount: 250, unit: g, item: rote Linsen }
      - { id: wasser, amount: 750, unit: ml, item: Wasser }
  - text: >
      Mit {salz} abschmecken.
    ingredients:
      - { id: salz, item: Salz }   # ohne amount = «nach Belieben»
```

Wichtige Regeln (werden von `validate.py` geprüft):

- Jede in einem Schritt deklarierte Zutat muss als `{id}` im Schritttext
  vorkommen — und umgekehrt.
- Dieselbe `id` darf in mehreren Schritten vorkommen; `item`, `unit`, `note`
  und `scalable` müssen dann übereinstimmen. Die Mengen werden für die
  Zutatenliste summiert.
- Einheiten müssen in [schema/units.yaml](schema/units.yaml) definiert sein
  (`g`, `kg`, `ml`, `dl`, `l`, `TL`, `EL`, `Prise`, …); Stückzahlen kommen
  ohne `unit` aus.
- `scalable: false` schützt Mengen, die beim Skalieren nicht mitwachsen
  sollen (z. B. 1 Lorbeerblatt).
- Bilder liegen in [rezepte/images/](rezepte/images/) und heissen wie die
  Rezept-`id`; Schrittbilder folgen dem Muster `<id>.<schrittnr>.jpg`.

Das vollständige Schema mit allen Feldern (Klassifikation, Saison, Anlässe,
Nährwerte, Quelle, Bild-Credits, …) steht in
[schema/recipe.schema.json](schema/recipe.schema.json).

## Projektstruktur

```
rezepte/            Rezept-YAMLs + images/
schema/             JSON Schema (recipe.schema.json) + Einheiten (units.yaml)
scripts/            validate.py, build_pdf.py
scripts/lib/        Gemeinsame Lade-, Skalierungs- und Renderlogik
docs/               Design-Spec zum Datenmodell
build/              Generierte PDFs (nicht eingecheckt)
```
