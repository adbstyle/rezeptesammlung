(function () {
  "use strict";

  const CFG = window.REZEPTE_CONFIG;
  const API_LIST = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${CFG.path}?ref=${CFG.branch}`;
  const RAW_BASE = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}`;

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
    repoLink: document.getElementById("repoLink"),
    branchLabel: document.getElementById("branchLabel"),
  };

  els.repoLink.href = `https://github.com/${CFG.owner}/${CFG.repo}`;
  els.branchLabel.textContent = CFG.branch;

  let allRecipes = [];
  let activeCategory = null;
  let activeDiet = null;

  function setStatus(msg, isError) {
    els.status.hidden = !msg;
    els.status.textContent = msg || "";
    els.status.classList.toggle("status-line--error", !!isError);
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) {
      throw new Error(`${url} → HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.text();
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
    return (text || "").replace(/\{(\w[\w-]*)\}/g, (m, id) => {
      const ing = ingredients.find((i) => i.id === id);
      if (!ing) return m;
      const amt = formatAmount(ing);
      return amt ? `${amt} ${ing.item}` : ing.item;
    });
  }

  function imageUrl(recipe) {
    const img = (recipe.images || [])[0];
    if (!img) return null;
    return `${RAW_BASE}/${CFG.path}/${img}`;
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
      <article class="rcard" data-id="${recipe.id}" tabindex="0">
        <div class="rcard__media" ${img ? "" : 'data-empty="1"'}>
          ${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.parentElement.dataset.empty='1'; this.remove();">` : ""}
          ${recipe.category ? `<span class="rcard__pin">${recipe.category}</span>` : ""}
        </div>
        <div class="rcard__body">
          <h3 class="rcard__title">${recipe.title}</h3>
          ${recipe.description ? `<p class="rcard__desc">${recipe.description}</p>` : ""}
          <div class="rcard__meta">
            ${tt ? `<span>${tt} Min.</span>` : ""}
            ${recipe.difficulty ? `<span>${recipe.difficulty}</span>` : ""}
            ${recipe.yield && recipe.yield.servings ? `<span>${recipe.yield.servings} Port.</span>` : ""}
          </div>
          ${diet.length ? `<div class="rcard__tags">${diet.map((d) => `<span class="tag">${d}</span>`).join("")}</div>` : ""}
        </div>
      </article>`;
  }

  function detailTemplate(recipe) {
    const ingredients = collectIngredients(recipe.steps);
    const img = imageUrl(recipe);
    return `
      ${img ? `<div class="detail__media"><img src="${img}" alt=""></div>` : ""}
      <div class="detail__head">
        <span class="detail__eyebrow">${[recipe.category, recipe.cuisine].filter(Boolean).join(" · ")}</span>
        <h2>${recipe.title}</h2>
        ${recipe.description ? `<p class="detail__desc">${recipe.description}</p>` : ""}
        <div class="detail__meta">
          ${timeLabel(recipe) ? `<span>${timeLabel(recipe)}</span>` : ""}
          ${recipe.difficulty ? `<span>Schwierigkeit: ${recipe.difficulty}</span>` : ""}
          ${recipe.yield && recipe.yield.servings ? `<span>${recipe.yield.servings} Portionen</span>` : ""}
        </div>
      </div>
      <div class="detail__grid">
        <div class="detail__ingredients">
          <h3>Zutaten</h3>
          <ul>
            ${ingredients
              .map((i) => `<li><span class="amt">${formatAmount(i) || "n. Belieben"}</span> ${i.item}${i.note ? ` <em>(${i.note})</em>` : ""}</li>`)
              .join("")}
          </ul>
        </div>
        <div class="detail__steps">
          <h3>Zubereitung</h3>
          <ol>
            ${(recipe.steps || [])
              .map((s) => `<li>${renderStepText(s.text, ingredients)}</li>`)
              .join("")}
          </ol>
        </div>
      </div>`;
  }

  function openDetail(id) {
    const recipe = allRecipes.find((r) => r.id === id);
    if (!recipe) return;
    els.detail.innerHTML = detailTemplate(recipe);
    els.overlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeDetail() {
    els.overlay.hidden = true;
    document.body.style.overflow = "";
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

    els.chips.innerHTML = chips
      .map(
        (c) =>
          `<button class="chip" data-type="${c.type}" data-value="${c.value}">${c.label}</button>`
      )
      .join("");
  }

  function applyFilters() {
    const q = els.search.value.trim().toLowerCase();
    const filtered = allRecipes.filter((r) => {
      if (activeCategory && r.category !== activeCategory) return false;
      if (activeDiet && !(r.diet || []).includes(activeDiet)) return false;
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

      els.chips.querySelectorAll(".chip").forEach((c) => {
        const active =
          (c.dataset.type === "category" && c.dataset.value === activeCategory) ||
          (c.dataset.type === "diet" && c.dataset.value === activeDiet);
        c.classList.toggle("chip--active", active);
      });
      applyFilters();
    });

    els.grid.addEventListener("click", (e) => {
      const card = e.target.closest(".rcard");
      if (card) openDetail(card.dataset.id);
    });
    els.grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const card = e.target.closest(".rcard");
      if (card) openDetail(card.dataset.id);
    });

    els.close.addEventListener("click", closeDetail);
    els.overlay.addEventListener("click", (e) => {
      if (e.target === els.overlay) closeDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.overlay.hidden) closeDetail();
    });
  }

  async function loadRecipes() {
    setStatus("Rezeptliste wird von main geladen …");
    const files = await fetchJSON(API_LIST);
    const yamlFiles = files.filter((f) => f.type === "file" && /\.ya?ml$/i.test(f.name));

    setStatus(`0 / ${yamlFiles.length} Rezepte geladen …`);
    const results = [];
    let done = 0;
    for (const file of yamlFiles) {
      try {
        const text = await fetchText(`${RAW_BASE}/${CFG.path}/${file.name}`);
        const data = jsyaml.load(text);
        if (data && data.id) {
          data._search = buildSearchIndex(data);
          results.push(data);
        }
      } catch (err) {
        console.warn("Rezept konnte nicht geladen werden:", file.name, err);
      }
      done += 1;
      setStatus(`${done} / ${yamlFiles.length} Rezepte geladen …`);
    }

    results.sort((a, b) => a.title.localeCompare(b.title, "de"));
    allRecipes = results;
    setStatus("");
    buildChips();
    applyFilters();
  }

  wireEvents();
  loadRecipes().catch((err) => {
    console.error(err);
    setStatus(
      "Rezepte konnten nicht geladen werden — evtl. GitHub-API-Limit erreicht. Später erneut versuchen.",
      true
    );
  });
})();
