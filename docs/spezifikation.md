# Rezeptsammlung — Datenmodell & Pipeline (Spezifikation)

**Version:** 1.0 — gültig
**Erstfassung:** 2026-07-19 · **Zuletzt aktualisiert:** 2026-07-20
**Repo:** https://github.com/adbstyle/rezeptesammlung

Dies ist die **gültige, massgebliche Spezifikation** des Datenmodells und der
Build-Pipeline. Sie beschreibt den umgesetzten Stand, nicht mehr einen Entwurf.
`schema/recipe.schema.json` ist die maschinenlesbare Durchsetzung dieses
Dokuments; bei Abweichungen gilt das Schema als Referenz. Änderungen am Modell
werden zuerst hier und im Schema festgehalten.

## 1. Ziel

Eine strukturierte Rezeptsammlung in YAML (ein Rezept = eine Datei) als einzige
Quelle der Wahrheit. Aus den YAML-Dateien generieren Scripts:

1. **PDF-Kochbuch** (Pandoc/LaTeX) — Standard-Rendering für 4 Personen
2. **Statische Webseite** — gleiche Renderlogik, pro Rezept eingebettetes
   schema.org/Recipe JSON-LD (SEO / Google Rich Results)
3. **Datenbank-Import** (optional, später) — die YAML-Struktur bildet 1:1 auf
   Tabellen ab

Die Metadaten konsolidieren schema.org/Recipe und die Google-Recipe-Richtlinien
(https://developers.google.com/search/docs/appearance/structured-data/recipe),
das Mengenmodell übernimmt die Kernidee von Cooklang (Mengen am Einsatzort,
Liste generiert), aber typisiert in YAML statt als Text-Markup.

## 2. Kernprinzip

- **Mengen leben in den Schritten** (`steps[].ingredients`), typisiert als
  Zahl + Einheit + Zutat. Keine Menge steht zweimal.
- **Die Zutatenliste wird generiert:** Das Script summiert alle Mengen pro
  Zutaten-`id` über alle Schritte. Die Liste kann nie von den Schritten
  abweichen, weil sie daraus berechnet wird.
- **Skalierung:** `faktor = ziel_personen / yield.servings`. Jede Menge wird
  vor Summierung und Rendering multipliziert. `scalable: false` (Salz, Hefe,
  Lorbeer …) bleibt unverändert.
- **Schritt-Texte referenzieren Zutaten** mit `{id}`; der Renderer ersetzt die
  Referenz durch „Menge Einheit Zutat" des jeweiligen Schritts
  (z. B. `{milch}` → „125 ml Milch").

## 3. Repository-Struktur

```
rezeptesammlung/
├── rezepte/                  # ein rezept = eine YAML-datei, dateiname = id
│   ├── butterzopf.yaml
│   └── images/
│       ├── butterzopf.jpg    # hauptbild:   <id>.jpg
│       └── butterzopf.2.jpg  # schrittbild: <id>.<schritt-nr>.jpg (1-basiert)
├── schema/
│   ├── recipe.schema.json    # JSON Schema — validiert jede rezept-datei
│   └── units.yaml            # erlaubte einheiten + umrechnungen
├── scripts/                  # python (pyyaml, jsonschema, jinja2)
│   ├── validate.py           # alle validierungsregeln (kap. 7)
│   ├── build_pdf.py          # YAML → markdown/LaTeX → pandoc → PDF
│   ├── build_web.py          # YAML → statische HTML-seiten + JSON-LD
│   └── lib/                  # gemeinsame render-/skalierungslogik
├── book/
│   ├── metadata.yaml         # buchtitel, autor, copyright
│   └── layout.yaml           # kapitel-reihenfolge (liste von rezept-ids)
└── docs/spezifikation.md     # diese spezifikation
```

## 4. Feldkatalog (Rezept-Datei)

### 4.1 Top-Level

| Feld | Typ | Pflicht | schema.org-Mapping |
|---|---|---|---|
| `id` | string (slug, = Dateiname) | ✓ | `@id` / URL-Slug |
| `title` | string | ✓ | `name` |
| `description` | string | ✓ | `description` |
| `lang` | string (ISO 639, z. B. `de`) | ✓ | `inLanguage` |
| `author` | string | ✓ | `author.name` |
| `date_published` | date (ISO) | ✓ | `datePublished` |
| `images` | list\<pfad relativ zu `rezepte/`\> | ✓ (min. 1) | `image` (Google: Pflicht) |
| `image_credit` | objekt `{name, license, url}` | – | – (Bildnachweis) |
| `category` | enum: Gang (Kap. 4.7) | ✓ | `recipeCategory` |
| `dish_type` | enum: Gerichtsart (Kap. 4.7) | – | `keywords` |
| `cuisine` | string (z. B. Schweiz) | – | `recipeCuisine` |
| `season` | list\<enum\> (Kap. 4.7) | – | `keywords` |
| `occasions` | list\<enum\> (Kap. 4.7) | – | `keywords` |
| `keywords` | list\<string\> | – | `keywords` |
| `diet` | list\<enum\> (Kap. 4.5) | – | `suitableForDiet` |
| `difficulty` | enum: `einfach` \| `mittel` \| `anspruchsvoll` | – | – (nur Buch/Web) |
| `times` | objekt (Kap. 4.2) | ✓ | `prepTime`, `cookTime`, `totalTime` |
| `yield` | objekt (Kap. 4.3) | ✓ | `recipeYield` |
| `nutrition` | objekt (Kap. 4.6) | – | `nutrition` |
| `steps` | list (Kap. 4.4) | ✓ (min. 1) | `recipeInstructions` |
| `equipment` | list\<string\> | – | `tool` |
| `source` | objekt `{name, url}` | – | `isBasedOn` / `citation` |
| `notes` | string | – | – (nur Buch/Web) |

### 4.2 `times` — Minuten als ganze Zahlen

```yaml
times:
  prep: 20        # → PT20M beim JSON-LD-export
  cook: 35
  rest: 90        # eigenes feld; schema.org kennt kein rest
```

`total` wird **berechnet** (`prep + cook + rest`), nie erfasst. Export:
`totalTime = PT145M`. ISO-8601-Dauern (`PT20M`) sind reines Exportformat.

### 4.3 `yield`

```yaml
yield:
  servings: 4                      # basis für skalierung — pflicht
  description: 1 Zopf à ca. 750 g  # menschenlesbar → recipeYield
```

### 4.4 `steps` — Herzstück

```yaml
steps:
  - section: Teig            # optional → HowToSection; aufeinanderfolgende
                             # schritte gleicher section werden gruppiert
    text: "{milch} lauwarm erwärmen und die {hefe} darin auflösen."
    ingredients:
      - id: milch            # referenz-schlüssel, eindeutig pro rezept-zutat
        amount: 125          # zahl (int oder float), > 0; weglassen ⇒ „nach Belieben"
        unit: ml             # muss in units.yaml existieren; optional bei stückzahl
        item: Milch          # anzeigename
        note: 3.5 % Fett     # optional, erscheint in der zutatenliste
      - id: hefe
        amount: 20
        unit: g
        item: Frischhefe
        scalable: false      # default: true
    image: true              # optional; erwartet rezepte/images/<id>.<nr>.jpg
```

Regeln:

- Dieselbe `id` darf in **mehreren Schritten** vorkommen (geteilte Verwendung,
  z. B. Milch 125 ml + 375 ml). `item`, `unit`, `scalable` und `note` müssen
  dann bei jedem Vorkommen identisch sein (Validierungsfehler sonst); nur
  `amount` variiert.
- Schritte ohne `ingredients` sind normal („90 Minuten gehen lassen").
- `unit` entfällt bei reinen Stückzahlen (`amount: 1, item: Ei`).
- **`amount` weglassen ⇒ „nach Belieben"** (Salz, Koriander zum Garnieren …):
  keine `unit`, kein `scalable`, keine Skalierung. Die Zutatenliste zeigt
  „Zutat, nach Belieben"; `{id}` im Schritt-Text wird zum blossen
  Zutatennamen. Eine `id` ist entweder in allen Vorkommen mit oder in allen
  ohne `amount` erfasst (Validierungsfehler sonst).

### 4.5 `diet` — kontrolliertes Vokabular

`vegetarian`, `vegan`, `gluten_free`, `lactose_free`, `low_carb` —
gemappt auf schema.org `RestrictedDiet` (z. B. `VegetarianDiet`).
Erweiterung nur über Anpassung des JSON Schemas.

### 4.6 `nutrition` — optional, pro Portion

```yaml
nutrition:
  calories: 320      # kcal → "320 calories"
  protein: 9         # g   → proteinContent
  carbohydrates: 45  # g
  fat: 11            # g
```

### 4.7 Klassifikation — kontrollierte Vokabulare

Facetten nach dem Vorbild der Migusto-Rezeptfilter (Analyse 2026-07-19).
Erweiterung nur über Anpassung des JSON Schemas (wie `diet`).

- **`category` (Gang, Pflicht):** `Apéro` | `Vorspeise` | `Hauptgericht` |
  `Beilage` | `Dessert` | `Brunch & Frühstück` | `Getränk` —
  bestimmt auch die Kapitelbildung im PDF-Buch (Kap. 10.1).
- **`dish_type` (Gerichtsart, optional):** `Salat` | `Suppe` | `Eintopf` |
  `Pasta` | `Risotto` | `Auflauf & Gratin` | `Burger` | `Kuchen & Torten` |
  `Brot & Zopf` | `Gebäck` | `Glace`
- **`season` (optional):** `fruehling` | `sommer` | `herbst` | `winter`
- **`occasions` (optional):** `weihnachten` | `ostern` | `grill` |
  `gaeste` | `party` | `familie`

**Berechnete Facetten (nie erfasst):** „Fertig in …" folgt aus der
Zeitsumme, „< 7 Zutaten" aus der Länge der generierten Zutatenliste,
„Schnell & einfach" aus `difficulty` + Zeitsumme. Konsequenz des
Kernprinzips (Kap. 2): Ableitbares wird berechnet, damit es nie veraltet.

## 5. Referenz-Syntax in Schritt-Texten

- `{id}` → wird ersetzt durch „<amount> <unit> <item>" des **selben Schritts**,
  skaliert (z. B. `{milch}` → „125 ml Milch"; bei 8 Personen „250 ml Milch").
- Prosa-Erwähnungen ohne Menge sind frei („den Teig", „die Hefemilch") und
  werden nicht angetastet.
- Literale geschweifte Klammern im Text: `{{` bzw. `}}`.

## 6. Generierte Zutatenliste

1. Skaliere alle `amount`-Werte mit dem Personenfaktor (außer `scalable: false`).
2. Summiere pro `id` über alle Schritte. Einheiten derselben `id` sind per
   Validierung identisch (Kap. 4.4) — keine Umrechnung bei Summierung nötig.
3. Reihenfolge: erste Verwendung im Rezept. Bei `section`-Nutzung wird die
   Liste nach Sections gruppiert (wie klassische Kochbücher: „Für den Teig: …").
4. Anzeige-Rundung (Kap. 8) erst nach dem Summieren.

## 7. Validierungsregeln (`validate.py`, Build bricht bei Fehler ab)

1. **Schema:** Jede Rezept-Datei validiert gegen `recipe.schema.json`.
2. **Dateiname = `id`**, `id` ist repo-weit eindeutig.
3. **Referenz-Integrität pro Schritt:** Jede in `ingredients` deklarierte `id`
   kommt genau als `{id}` im `text` des Schritts vor, und jedes `{id}` im Text
   ist im selben Schritt deklariert.
4. **Konsistenz geteilter Zutaten:** gleiche `id` ⇒ gleiches
   `item`/`unit`/`scalable`/`note` in allen Schritten.
5. **Einheiten:** Jede `unit` existiert in `units.yaml`.
6. **Bilder:** Alle referenzierten Bilddateien existieren
   (`images`-Liste und `image: true`-Schritte).
7. **Layout:** Jede `id` in `book/layout.yaml` existiert als Rezept; Rezepte,
   die in keinem Kapitel vorkommen, erzeugen eine Warnung (kein Fehler).

## 8. Skalierung & Anzeige-Rundung

- Faktor = `ziel / yield.servings`; Standard-Rendering: Faktor 1
  (also die erfassten Basiswerte, Konvention: Rezepte werden für 4 Personen
  erfasst, wo sinnvoll).
- PDF: gerendert wird **nur** die Basis-Portionierung (4 Personen). Die
  Skalierung ist ein CLI-Feature (`build_pdf.py --servings 8`) für
  Sonderausgaben.
- Web: Basis-Rendering wie PDF; interaktive Skalierung im Browser ist ein
  mögliches späteres Feature (die Daten dafür liegen als JSON bereit),
  gehört aber nicht zum ersten Wurf.
- Anzeige-Rundung (nur Darstellung, nie Datenhaltung):
  - Dezimalbrüche als Küchenbrüche: 0.25 → ¼, 0.5 → ½, 0.75 → ¾, 1.5 → 1½
  - g/ml ≥ 100: auf 5 runden; TL/EL: auf ¼ runden
  - Rundung erfolgt pro Anzeige-Stelle (Liste und Schritt-Text getrennt,
    nach Summierung bzw. pro Schritt).

## 9. `units.yaml`

```yaml
mass:      { base: g,  units: { g: 1, kg: 1000 } }
volume:    { base: ml, units: { ml: 1, cl: 10, dl: 100, l: 1000 } }
spoons:    { base: TL, units: { TL: 1, EL: 3 } }
misc:      { units: [Prise, Bund, Blatt, Zweig, Würfel, Msp] }
# stückzahlen: unit weglassen
```

Dient der Validierung (Kap. 7.5) und späteren Features (Einkaufsliste,
Umrechnung). Erweiterung = Eintrag ergänzen.

## 10. Outputs

### 10.1 PDF (`build_pdf.py`)

Pipeline: YAML → gerendertes Markdown (Jinja2-Template: Titel, Bild,
Metazeile mit Zeiten/Schwierigkeit, generierte Zutatenliste, nummerierte
Schritte, Notizen) → Pandoc mit LaTeX-Template → ein PDF-Buch gemäß
`book/layout.yaml` (Kapitel = Kategorien). Vorbild für das LaTeX-Template:
keeferrourke/pandoc-cookbook (Tufte-Book).

### 10.2 Web (`build_web.py`)

Gleiche Renderlogik, HTML-Template statt LaTeX. Pro Rezeptseite wird ein
`<script type="application/ld+json">` mit schema.org/Recipe eingebettet:

| YAML | JSON-LD |
|---|---|
| Zutatenliste (generiert, Basis-Portionen) | `recipeIngredient`: Strings „500 g Zopfmehl" |
| `steps[].text` (gerendert) | `recipeInstructions`: `HowToStep` / `HowToSection` |
| `times.prep` = 20 | `prepTime: "PT20M"`; `totalTime` inkl. `rest` |
| `yield` | `recipeYield: ["4", "1 Zopf à ca. 750 g"]` |
| `nutrition.calories` | `nutrition.calories: "320 calories"` |
| `diet: [vegetarian]` | `suitableForDiet: VegetarianDiet` |

### 10.3 Datenbank (später, kein Teil des ersten Wurfs)

Abbildung liegt auf der Hand: `recipes` (Top-Level-Felder),
`recipe_steps` (rezept_id, nr, section, text),
`step_ingredients` (rezept_id, schritt_nr, ingredient_id, amount, unit, item,
scalable, note). Kein Script im ersten Wurf.

## 11. Vollständiges Beispielrezept

```yaml
id: butterzopf
title: Butterzopf
description: >
  Klassischer Schweizer Sonntagszopf — aussen goldig, innen weich.
lang: de
author: Adrian Bader
date_published: 2026-07-19
images: [images/butterzopf.jpg]
category: Backen
cuisine: Schweiz
keywords: [hefeteig, sonntag, brunch]
diet: [vegetarian]
difficulty: mittel
times: { prep: 25, cook: 35, rest: 90 }
yield:
  servings: 4
  description: 1 Zopf à ca. 750 g
nutrition:
  calories: 320

steps:
  - section: Teig
    text: "{milch} lauwarm erwärmen und die {hefe} darin auflösen."
    ingredients:
      - { id: milch, amount: 125, unit: ml, item: Milch }
      - { id: hefe, amount: 20, unit: g, item: Frischhefe, scalable: false }

  - section: Teig
    text: >
      {mehl} und {salz} in einer Schüssel mischen. {butter} beigeben,
      Hefemilch und {milch} dazugiessen und zu einem glatten Teig kneten.
    ingredients:
      - { id: mehl, amount: 500, unit: g, item: Zopfmehl }
      - { id: salz, amount: 1.5, unit: TL, item: Salz, scalable: false }
      - { id: butter, amount: 60, unit: g, item: Butter, note: weich }
      - { id: milch, amount: 375, unit: ml, item: Milch }

  - section: Teig
    text: Den Teig zugedeckt 90 Minuten aufs Doppelte aufgehen lassen.

  - section: Formen & Backen
    text: Teig halbieren, zu Strängen rollen und zu einem Zopf flechten.
    image: true

  - section: Formen & Backen
    text: >
      Zopf mit {eigelb} bestreichen und in der unteren Ofenhälfte bei
      200 °C 35 Minuten backen.
    ingredients:
      - { id: eigelb, amount: 1, item: Eigelb, scalable: false }

equipment: [Backblech, Küchenmaschine]
source: { name: Familienrezept, url: null }
notes: >
  Über Nacht im Kühlschrank aufgegangen wird er noch feiner.
```

Generierte Zutatenliste daraus (4 Personen):
**Teig:** 500 ml Milch · 20 g Frischhefe · 500 g Zopfmehl · 1½ TL Salz ·
60 g Butter (weich) — **Formen & Backen:** 1 Eigelb

## 12. Nicht-Ziele (bewusste Entscheidungen)

- **Kein Cooklang:** Das App-Ökosystem (iOS/Android, Einkaufslisten) wird
  bewusst aufgegeben zugunsten typisierter, direkt DB- und Pandoc-tauglicher
  Daten. Abwägung dokumentiert in der Design-Diskussion vom 2026-07-19.
- **Keine Bruch-DSL** (`{milch:1/4}`): Teilmengen werden absolut erfasst
  (125 + 375), das Script summiert. Einfachheit im Werkzeug schlägt Eleganz
  im Format.
- **Keine relationalen Gesamtmengen:** Gesamtmenge ändern = alle Teilmengen
  der `id` anfassen. Akzeptierter Trade-off.
- **Keine Nährwert-Berechnung**, nur optionale manuelle Erfassung.
- **Keine interaktive Web-Skalierung im ersten Wurf** (Kap. 8).

## 13. Umsetzungsstand

**Umgesetzt und in Betrieb:**

- `schema/recipe.schema.json` + `schema/units.yaml` — Feldkatalog und
  Einheiten, maschinenlesbar durchgesetzt.
- `scripts/validate.py` — alle Validierungsregeln aus Kap. 7.
- `scripts/lib/recipe.py` — Skalierung, generierte Zutatenliste,
  `{id}`-Ersetzung, Anzeige-Rundung.
- `scripts/build_pdf.py` — PDF-Pipeline (YAML → Markdown → Pandoc → PDF),
  Einzelrezept und Gesamtbuch, `--servings` für skalierte Ausgaben.
- Rezeptsammlung in `rezepte/` (laufend erweitert).

**Erweiterungen gegenüber der Erstfassung** (aus realen Rezept-Importen
hervorgegangen): Klassifikation `dish_type`/`season`/`occasions` (Kap. 4.7),
Zutaten ohne Menge = „nach Belieben" (Kap. 4.4), `image_credit` für
Fremdbilder (Kap. 4.1), menschenlesbare Dauer-Anzeige (Std./Min.).

**Offen / möglich:**

- `scripts/build_web.py` — statische HTML-Seiten + JSON-LD (Kap. 10.2).
- Datenbank-Import (Kap. 10.3), interaktive Web-Skalierung (Kap. 8),
  Einkaufslisten-Aggregation über mehrere Rezepte.
