(function () {
  "use strict";

  const CFG = window.REZEPTE_CONFIG;
  const API_LIST = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${CFG.path}?ref=${CFG.branch}`;
  const RAW_BASE = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}`;
  const REMOTE_BASE = `${RAW_BASE}/${CFG.path}`;
  const CACHE_KEY = "rezeptkasten.cache.v1";

  // GitHub Pages served den main-Branch mit: liegen die YAMLs auf derselben
  // Origin wie die Seite, werden Rezepte und Bilder relativ geladen —
  // CDN-gecacht statt über raw.githubusercontent. Sonst bleibt raw die Quelle.
  const baseFor = (mode) => (mode === "local" ? CFG.path : REMOTE_BASE);
  let assetBase = REMOTE_BASE;

  const els = {
    grid: document.getElementById("grid"),
    search: document.getElementById("searchInput"),
    chips: document.getElementById("filterChips"),
    count: document.getElementById("recipeCount"),
    status: document.getElementById("statusLine"),
    empty: document.getElementById("emptyState"),
    overlay: document.getElementById("overlay"),
    detail: document.getElementById("detailContent"),
    close: document.getElementById("closeDetail"),
    notice: document.getElementById("deepLinkNotice"),
    repoLink: document.getElementById("repoLink"),
    branchLabel: document.getElementById("branchLabel"),
  };

  els.repoLink.href = `https://github.com/${CFG.owner}/${CFG.repo}`;
  els.branchLabel.textContent = CFG.branch;

  let allRecipes = [];
  let activeCategory = null;
  let activeDiet = null;
  let activeTag = null;
  // Kuratierte Keywords, die als eigener Filter-Chip erscheinen.
  const TAG_CHIPS = [{ value: "meze", label: "Meze" }];

  // Deep-Links: der Hash ist die einzige Quelle der Wahrheit dafür, welches
  // Rezept offen ist. Die UI ändert nur den Hash, handleRoute() zieht daraus
  // den Overlay-Zustand nach — so bleiben Adresszeile, History und Ansicht
  // zwangsläufig synchron.
  const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // = id-Pattern aus recipe.schema.json
  const BASE_TITLE = document.title;
  let currentDetailId = null; // offenes Rezept, null = Overlay zu
  let currentDetailJson = null; // Vergleichsstand, um Re-Render nur bei Änderung zu machen
  let pendingId = null; // adressiertes Rezept, das noch nicht geladen ist
  let needsBaseEntry = false; // Direkteinstieg per Link: Basis-Eintrag fehlt noch in der History
  let listIsFresh = false; // die Liste wurde in dieser Sitzung erfolgreich frisch geladen
  let loadFailed = false; // das frische Laden ist gescheitert — es kommt nichts mehr nach

  const LOAD_ERROR_MSG =
    "Das verlinkte Rezept konnte nicht geladen werden — keine Verbindung oder GitHub-API-Limit erreicht. Lade die Seite später neu, der Link bleibt gültig.";

  function setStatus(msg, isError) {
    els.status.hidden = !msg;
    els.status.textContent = msg || "";
    els.status.classList.toggle("status-line--error", !!isError);
  }

  // Eigene Zeile für Deep-Link-Meldungen: die Statuszeile wird vom Laden
  // laufend überschrieben und am Ende geleert, ein Hinweis dort wäre weg.
  function setNotice(msg, isError) {
    els.notice.hidden = !msg;
    els.notice.textContent = msg || "";
    els.notice.classList.toggle("status-line--error", !!isError);
  }

  // Rohwert hinter "#/" — leer heisst: keine Rezept-URL. decodeURIComponent
  // wirft bei kaputten Sequenzen wie "%", darum abgesichert.
  function hashRaw() {
    const raw = location.hash.replace(/^#\/?/, "").trim();
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  }

  // Liefert die adressierte Rezept-id oder null. Ein Wert, der nicht dem
  // id-Pattern entspricht, kann kein Rezept sein und gilt als nicht adressiert.
  function parseHash() {
    const raw = hashRaw();
    return SLUG_RE.test(raw) ? raw : null;
  }

  const basePath = () => location.pathname + location.search;

  // Bei direkt geöffneter Datei (file://, Origin "null") werfen replaceState/
  // pushState eine SecurityError. Die URL-Pflege ist dort Komfort, kein Grund,
  // den Ablauf abzubrechen — der Rest der Seite funktioniert weiter.
  function rewriteHistory(method, url) {
    try {
      history[method](null, "", url);
    } catch (_) { /* file:// — egal */ }
  }

  // Vergleichsstand ohne den abgeleiteten Suchindex — der ändert sich mit dem
  // Inhalt und würde sonst jeden Vergleich unnötig verrauschen.
  function detailFingerprint(recipe) {
    return JSON.stringify(recipe, (key, value) => (key === "_search" ? undefined : value));
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) {
      throw new Error(`${url} → HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchText(url) {
    // "no-cache" = jedes Mal per ETag revalidieren (304 ist billig). Ohne das
    // hält der Browser eine geänderte YAML bis zu 10 Min. (Pages max-age) alt.
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
  }

  // Rezeptdaten sind freier Text und werden per innerHTML gerendert — daher
  // im HTML-Kontext maskieren (Ausgabe-Encoding). Schützt zugleich vor
  // kaputtem Rendering bei legitimen Zeichen wie & < > " in Titel/Zutat.
  const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESCAPE[c]);
  }

  // Merge ingredients across steps: same id must share item/unit, amounts sum.
  function collectIngredients(steps) {
    const byId = new Map();
    for (const step of steps || []) {
      for (const ing of step.ingredients || []) {
        const existing = byId.get(ing.id);
        if (existing) {
          if (typeof existing.amount === "number" && typeof ing.amount === "number") {
            existing.amount += ing.amount;
          }
        } else {
          byId.set(ing.id, { ...ing });
        }
      }
    }
    return Array.from(byId.values());
  }

  function formatAmount(ing) {
    if (typeof ing.amount !== "number") return "";
    const amount = Number.isInteger(ing.amount) ? ing.amount : Math.round(ing.amount * 100) / 100;
    return ing.unit ? `${amount} ${ing.unit}` : `${amount}`;
  }

  function renderStepText(text, ingredients) {
    const raw = (text || "").replace(/\{(\w[\w-]*)\}/g, (m, id) => {
      const ing = ingredients.find((i) => i.id === id);
      if (!ing) return m;
      const amt = formatAmount(ing);
      return amt ? `${amt} ${ing.item}` : ing.item;
    });
    return esc(raw); // Ergebnis geht direkt in innerHTML
  }

  function imageUrl(recipe) {
    const img = (recipe.images || [])[0];
    if (!img) return null;
    return `${assetBase}/${img}`;
  }

  function timeLabel(recipe) {
    const t = recipe.times || {};
    const parts = [];
    if (t.prep) parts.push(`${t.prep} Min. vorbereiten`);
    if (t.cook) parts.push(`${t.cook} Min. kochen`);
    if (t.rest) parts.push(`${t.rest} Min. ruhen`);
    return parts.join(" · ");
  }

  function totalTime(recipe) {
    const t = recipe.times || {};
    return (t.prep || 0) + (t.cook || 0) + (t.rest || 0);
  }

  function dietLabel(d) {
    const map = {
      vegan: "vegan",
      vegetarian: "vegetarisch",
      vegetarisch: "vegetarisch",
      gluten_free: "glutenfrei",
      lactose_free: "laktosefrei",
    };
    return map[d] || d.replace(/_/g, " ");
  }

  function buildSearchIndex(recipe) {
    const ingredients = collectIngredients(recipe.steps).map((i) => i.item).join(" ");
    return [
      recipe.title,
      recipe.description,
      recipe.category,
      recipe.cuisine,
      (recipe.diet || []).map(dietLabel).join(" "),
      (recipe.keywords || []).join(" "),
      ingredients,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function cardTemplate(recipe) {
    const img = imageUrl(recipe);
    const diet = (recipe.diet || []).map(dietLabel);
    const tt = totalTime(recipe);
    return `
      <article class="rcard" data-id="${esc(recipe.id)}" tabindex="0">
        <div class="rcard__media" ${img ? "" : 'data-empty="1"'}>
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}
          ${recipe.category ? `<span class="rcard__pin">${esc(recipe.category)}</span>` : ""}
        </div>
        <div class="rcard__body">
          <h3 class="rcard__title">${esc(recipe.title)}</h3>
          ${recipe.description ? `<p class="rcard__desc">${esc(recipe.description)}</p>` : ""}
          <div class="rcard__meta">
            ${tt ? `<span>${tt} Min.</span>` : ""}
            ${recipe.difficulty ? `<span>${esc(recipe.difficulty)}</span>` : ""}
            ${recipe.yield && recipe.yield.servings ? `<span>${esc(recipe.yield.servings)} Port.</span>` : ""}
          </div>
          ${diet.length ? `<div class="rcard__tags">${diet.map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div>` : ""}
        </div>
      </article>`;
  }

  function detailTemplate(recipe) {
    const ingredients = collectIngredients(recipe.steps);
    const img = imageUrl(recipe);
    return `
      ${img ? `<div class="detail__media"><img src="${esc(img)}" alt=""></div>` : ""}
      <div class="detail__head">
        <span class="detail__eyebrow">${[recipe.category, recipe.cuisine].filter(Boolean).map(esc).join(" · ")}</span>
        <h2>${esc(recipe.title)}</h2>
        ${recipe.description ? `<p class="detail__desc">${esc(recipe.description)}</p>` : ""}
        <div class="detail__meta">
          ${timeLabel(recipe) ? `<span>${esc(timeLabel(recipe))}</span>` : ""}
          ${recipe.difficulty ? `<span>Schwierigkeit: ${esc(recipe.difficulty)}</span>` : ""}
          ${recipe.yield && recipe.yield.servings ? `<span>${esc(recipe.yield.servings)} Portionen</span>` : ""}
        </div>
      </div>
      <div class="detail__grid">
        <div class="detail__ingredients">
          <h3>Zutaten</h3>
          <ul>
            ${ingredients
              .map((i) => `<li><span class="amt">${esc(formatAmount(i) || "n. Belieben")}</span> ${esc(i.item)}${i.note ? ` <em>(${esc(i.note)})</em>` : ""}</li>`)
              .join("")}
          </ul>
        </div>
        <div class="detail__steps">
          <h3>Zubereitung</h3>
          <ol>
            ${(recipe.steps || [])
              .map((s) => `<li>${renderStepText(s.text, s.ingredients || [])}</li>`)
              .join("")}
          </ol>
        </div>
      </div>`;
  }

  function openDetail(id) {
    const recipe = allRecipes.find((r) => r.id === id);
    if (!recipe) return;

    // Direkteinstieg per Link: die History enthält nur den Deep-Link selbst,
    // "Zurück" würde die Seite verlassen. Darum den Deep-Link-Eintrag zur
    // Basis-URL umschreiben und die Rezept-URL neu obendrauf legen — danach
    // sieht die History aus wie beim Öffnen über die Übersicht.
    if (needsBaseEntry) {
      rewriteHistory("replaceState", basePath());
      rewriteHistory("pushState", `#/${id}`);
      needsBaseEntry = false;
    }

    els.detail.innerHTML = detailTemplate(recipe);
    els.overlay.hidden = false;
    document.body.style.overflow = "hidden";
    currentDetailId = id;
    currentDetailJson = detailFingerprint(recipe);
    document.title = `${recipe.title} – ${BASE_TITLE}`;
    setNotice("");
  }

  function closeDetail() {
    els.overlay.hidden = true;
    document.body.style.overflow = "";
    currentDetailId = null;
    currentDetailJson = null;
    document.title = BASE_TITLE;
  }

  // Schliessen geht immer über die History zurück, damit die Adresszeile
  // mitkommt. closeDetail() direkt nur, wenn gar keine Rezept-URL aktiv ist.
  function requestClose() {
    if (parseHash()) history.back();
    else closeDetail();
  }

  // Einziger Einstiegspunkt für Zustandswechsel. Idempotent: ein erneuter
  // Aufruf mit derselben id rendert nicht doppelt.
  function handleRoute() {
    const id = parseHash();
    if (id && id === currentDetailId) {
      // Zurück zum bereits offenen Rezept: ein evtl. gemerkter anderer
      // Deep-Link ist damit hinfällig und darf später nichts mehr auslösen.
      if (pendingId) {
        pendingId = null;
        setStatus("");
      }
      return;
    }

    if (!id) {
      pendingId = null;
      const raw = hashRaw();
      if (!els.overlay.hidden) closeDetail();
      // Ein Hash, der kein gültiger Rezept-Slug ist, kann nie ein Rezept
      // treffen — das ist sofort ein toter Link, ohne auf Daten zu warten.
      if (raw) notFound(raw);
      return;
    }

    setNotice("");
    if (allRecipes.some((r) => r.id === id)) {
      pendingId = null;
      openDetail(id);
      return;
    }

    // Ab hier zeigt die Adresszeile ein Rezept, das (noch) nicht da ist —
    // ein offenes anderes Rezept darf dann nicht stehen bleiben.
    if (!els.overlay.hidden) closeDetail();

    // Liegt die frische Liste schon vor, ist die Sache entschieden.
    if (listIsFresh) {
      notFound(id);
      return;
    }

    // Ist das Laden bereits gescheitert, kommt nichts mehr nach — statt
    // ewig "wird geladen" ehrlich den Ladefehler zeigen. Hash bleibt.
    if (loadFailed) {
      setNotice(LOAD_ERROR_MSG, true);
      return;
    }

    // Sonst: merken und auf die frischen Daten warten. Ob das Rezept fehlt
    // oder nur noch nicht da ist, lässt sich jetzt nicht sagen.
    pendingId = id;
    setStatus(`Rezept «${id}» wird geladen …`);
  }

  function notFound(id) {
    pendingId = null;
    needsBaseEntry = false;
    if (!els.overlay.hidden) closeDetail();
    rewriteHistory("replaceState", basePath());
    setStatus("");
    setNotice(`Das Rezept «${id}» gibt es hier nicht (mehr). Vielleicht wirst du unten in der Sammlung fündig.`);
  }

  // Läuft nach jedem erfolgreichen Laden: erst jetzt ist entscheidbar, ob ein
  // adressiertes Rezept wirklich fehlt — ein alter Schnappschuss darf dieses
  // Urteil nicht fällen.
  function syncAfterFreshLoad(recipes) {
    if (pendingId) {
      const id = pendingId;
      if (recipes.some((r) => r.id === id)) {
        pendingId = null;
        openDetail(id);
      } else {
        notFound(id);
      }
      return;
    }

    if (!currentDetailId) return;

    // Das offene Rezept kam evtl. aus dem Schnappschuss: auf den frischen
    // Stand nachziehen, aber nur bei echter Änderung (sonst springt der Scroll).
    const fresh = recipes.find((r) => r.id === currentDetailId);
    if (!fresh) {
      notFound(currentDetailId);
      return;
    }
    const fingerprint = detailFingerprint(fresh);
    if (fingerprint !== currentDetailJson) {
      els.detail.innerHTML = detailTemplate(fresh);
      currentDetailJson = fingerprint;
    }
  }

  function buildChips() {
    const categories = new Set();
    const diets = new Set();
    allRecipes.forEach((r) => {
      if (r.category) categories.add(r.category);
      (r.diet || []).forEach((d) => diets.add(d));
    });

    const chips = [];
    categories.forEach((c) => chips.push({ type: "category", value: c, label: c }));
    diets.forEach((d) => chips.push({ type: "diet", value: d, label: dietLabel(d) }));
    TAG_CHIPS.forEach((t) => {
      if (allRecipes.some((r) => (r.keywords || []).includes(t.value))) {
        chips.push({ type: "tag", value: t.value, label: t.label });
      }
    });

    els.chips.innerHTML = chips
      .map(
        (c) =>
          `<button class="chip" data-type="${c.type}" data-value="${esc(c.value)}">${esc(c.label)}</button>`
      )
      .join("");
  }

  function applyFilters() {
    const q = els.search.value.trim().toLowerCase();
    const filtered = allRecipes.filter((r) => {
      if (activeCategory && r.category !== activeCategory) return false;
      if (activeDiet && !(r.diet || []).includes(activeDiet)) return false;
      if (activeTag && !(r.keywords || []).includes(activeTag)) return false;
      if (q && !r._search.includes(q)) return false;
      return true;
    });

    els.grid.innerHTML = filtered.map(cardTemplate).join("");
    els.empty.hidden = filtered.length !== 0;
    els.count.textContent = `${filtered.length} von ${allRecipes.length} Rezepten`;
  }

  function wireEvents() {
    els.search.addEventListener("input", applyFilters);

    els.chips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      const { type, value } = btn.dataset;
      if (type === "category") activeCategory = activeCategory === value ? null : value;
      if (type === "diet") activeDiet = activeDiet === value ? null : value;
      if (type === "tag") activeTag = activeTag === value ? null : value;

      els.chips.querySelectorAll(".chip").forEach((c) => {
        const active =
          (c.dataset.type === "category" && c.dataset.value === activeCategory) ||
          (c.dataset.type === "diet" && c.dataset.value === activeDiet) ||
          (c.dataset.type === "tag" && c.dataset.value === activeTag);
        c.classList.toggle("chip--active", active);
      });
      applyFilters();
    });

    // Bild-Fallback ohne inline onerror (CSP-freundlich): error-Events
    // bubbeln nicht, werden aber in der Capture-Phase am grid sichtbar.
    els.grid.addEventListener("error", (e) => {
      const img = e.target;
      if (img.tagName !== "IMG") return;
      const media = img.closest(".rcard__media");
      if (media) media.dataset.empty = "1";
      img.remove();
    }, true);

    // Öffnen heisst navigieren: der Hash-Wechsel löst handleRoute() aus und
    // erzeugt zugleich den History-Eintrag für den Zurück-Button.
    els.grid.addEventListener("click", (e) => {
      const card = e.target.closest(".rcard");
      if (card) location.hash = `#/${card.dataset.id}`;
    });
    els.grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const card = e.target.closest(".rcard");
      if (card) location.hash = `#/${card.dataset.id}`;
    });

    els.close.addEventListener("click", requestClose);
    els.overlay.addEventListener("click", (e) => {
      if (e.target === els.overlay) requestClose();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.overlay.hidden) requestClose();
    });

    window.addEventListener("hashchange", handleRoute);
  }

  function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (cached && Array.isArray(cached.recipes) && cached.recipes.length) return cached;
    } catch (_) { /* kein/kaputter Cache — egal */ }
    return null;
  }

  function writeCache(mode, recipes) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ mode, recipes }));
    } catch (_) { /* Storage voll/gesperrt — egal, reine Optimierung */ }
  }

  function showRecipes(recipes) {
    allRecipes = recipes;
    buildChips();
    applyFilters();
  }

  async function detectMode(ids) {
    // Same-Origin-Probe: das erste YAML relativ laden; die Antwort bleibt
    // im HTTP-Cache, der Versuch kostet also praktisch nichts.
    try {
      await fetchText(`${CFG.path}/${ids[0]}.yaml`);
      return "local";
    } catch (_) {
      return "remote";
    }
  }

  async function loadRecipes(quiet) {
    // Das Verzeichnis auf main ist die einzige Quelle der Wahrheit dafür,
    // welche Rezepte existieren — die Liste kommt darum von der GitHub-API.
    if (!quiet) setStatus("Rezeptliste wird von main geladen …");
    const files = await fetchJSON(API_LIST);
    const ids = files
      .filter((f) => f.type === "file" && /\.ya?ml$/i.test(f.name))
      .map((f) => f.name.replace(/\.ya?ml$/i, ""));
    const mode = await detectMode(ids);
    assetBase = baseFor(mode);

    // Alle Rezepte parallel laden (HTTP/2 bündelt das auf eine Verbindung)
    let done = 0;
    if (!quiet) setStatus(`0 / ${ids.length} Rezepte geladen …`);
    const results = (await Promise.all(ids.map(async (id) => {
      try {
        const text = await fetchText(`${assetBase}/${id}.yaml`);
        const data = jsyaml.load(text);
        if (data && data.id) {
          data._search = buildSearchIndex(data);
          return data;
        }
      } catch (err) {
        console.warn("Rezept konnte nicht geladen werden:", id, err);
      } finally {
        done += 1;
        if (!quiet) setStatus(`${done} / ${ids.length} Rezepte geladen …`);
      }
      return null;
    }))).filter(Boolean);

    results.sort((a, b) => a.title.localeCompare(b.title, "de"));
    setStatus("");
    showRecipes(results);
    writeCache(mode, results);
    listIsFresh = true;
    syncAfterFreshLoad(results);
  }

  wireEvents();

  // Direkteinstieg über eine Rezept-URL erkennen, bevor irgendetwas rendert.
  if (parseHash()) needsBaseEntry = true;

  // Wiederbesuch: sofort aus dem localStorage-Schnappschuss rendern,
  // frische Daten kommen im Hintergrund nach.
  const cached = readCache();
  if (cached) {
    assetBase = baseFor(cached.mode);
    showRecipes(cached.recipes);
  }
  handleRoute();
  loadRecipes(!!cached).catch((err) => {
    console.error(err);
    loadFailed = true;
    if (pendingId) {
      // Hash bewusst stehen lassen: ein Reload versucht den Link erneut. Ein
      // Ladefehler ist kein Beweis, dass das Rezept fehlt.
      pendingId = null;
      setNotice(LOAD_ERROR_MSG, true);
      setStatus("");
    }
    if (!cached) {
      setStatus(
        "Rezepte konnten nicht geladen werden — evtl. GitHub-API-Limit erreicht. Später erneut versuchen.",
        true
      );
    }
  });
})();
