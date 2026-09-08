/* Data register — reads the read-only /api/registry endpoints.
 *
 * Master-detail: the asset list on the left, one asset in full on the right.
 * A status is reported exactly as the API computes it. Red and amber are
 * information; nothing here softens or hides them.
 *
 * The register is one section of the rail in nav.js. It loads lazily, the
 * first time that section is opened, rather than on login. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* Status vocabulary, the stale threshold and the time formatting are shared
     with the dashboard's panel badges, so one status reads the same in both
     places and the amber rule is stated once. */
  const STALE_AFTER_HOURS = Quality.STALE_AFTER_HOURS;
  const QUALITY = Quality.QUALITY;
  const formatWhen = Quality.formatWhen;
  const fullWhen = Quality.fullWhen;
  const qualityNote = Quality.qualityNote;
  const qualityPill = Quality.pill;

  /* The API orders assets by layer alphabetically, which puts mart before raw.
     The list reads as the data flows instead; any layer not named here falls
     in behind, in the order the API sent it. */
  const LAYER_ORDER = ["raw", "mart"];

  let assets = [];
  let selectedKey = null;
  /* Set the first time the register view is shown; awaited by a deep link
     from a dashboard badge, which can arrive while the load is still running. */
  let loadPromise = null;
  /* A click on a lineage chip while an earlier detail is in flight must not
     let the slower response win. */
  let detailRequest = 0;

  function h(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const key in attrs) {
      if (key === "class") node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatCount(value) {
    if (value === null || value === undefined) return "—";
    return value.toLocaleString();
  }

  /* ===== Asset list ===== */

  function renderList() {
    const list = $("assetList");
    list.replaceChildren();

    if (!assets.length) {
      list.appendChild(h("p", { class: "empty-note" }, "The register holds no assets."));
      return;
    }

    /* Grouped by layer so the list reads in build order. */
    const layers = [...new Set(assets.map((a) => a.layer))].sort((a, b) => {
      const ai = LAYER_ORDER.indexOf(a);
      const bi = LAYER_ORDER.indexOf(b);
      return (ai === -1 ? LAYER_ORDER.length : ai) - (bi === -1 ? LAYER_ORDER.length : bi);
    });

    layers.forEach((layer) => {
      const group = h("div", { class: "asset-group" });
      group.appendChild(h("h3", { class: "asset-group-title" }, layer));

      const items = h("ul", { class: "asset-list-items" });
      assets
        .filter((a) => a.layer === layer)
        .forEach((asset) => {
          const item = h("li", {});
          const button = h("button", {
            class: "asset-item",
            type: "button",
            "aria-pressed": String(asset.asset_key === selectedKey),
          });

          const meta = QUALITY[asset.quality] || QUALITY.red;
          button.appendChild(h("span", {
            class: "q-dot q-" + asset.quality,
            role: "img",
            "aria-label": meta.label,
          }, meta.glyph));

          const body = h("span", { class: "asset-item-body" });
          body.appendChild(h("span", { class: "asset-key" }, asset.asset_key));
          body.appendChild(h("span", { class: "asset-item-meta" }, [
            asset.row_count === null || asset.row_count === undefined
              ? "row count unknown"
              : formatCount(asset.row_count) + " rows",
            asset.checks_total
              ? asset.checks_passed + "/" + asset.checks_total + " checks"
              : "no checks",
          ].join(" · ")));
          button.appendChild(body);

          button.addEventListener("click", () => selectAsset(asset.asset_key));
          item.appendChild(button);
          items.appendChild(item);
        });

      group.appendChild(items);
      list.appendChild(group);
    });
  }

  function renderSummary() {
    const counts = { green: 0, amber: 0, red: 0 };
    assets.forEach((a) => { counts[a.quality] = (counts[a.quality] || 0) + 1; });

    $("registerSub").textContent =
      assets.length + " asset" + (assets.length === 1 ? "" : "s") + " · " +
      counts.green + " green, " + counts.amber + " amber, " + counts.red + " red. " +
      "Green: every check passed and the data was refreshed within " + STALE_AFTER_HOURS +
      " hours. Amber: checks passed, but the refresh is older than that. Red: a check " +
      "failed, or the asset has no checks.";
  }

  /* ===== Asset detail ===== */

  function section(title) {
    return h("h4", { class: "detail-section-title" }, title);
  }

  function metaList(asset) {
    const pairs = [
      ["Layer", asset.layer],
      ["Owner", asset.owner],
      ["Grain", asset.grain],
      ["Rows", formatCount(asset.row_count)],
      ["Source", asset.source_system],
      ["Last run", formatWhen(asset.last_run_at)],
    ];

    const list = h("dl", { class: "meta-grid" });
    pairs.forEach(([label, value]) => {
      const item = h("div", { class: "meta-item" });
      item.appendChild(h("dt", {}, label));
      const dd = h("dd", {}, value === null || value === undefined ? "—" : String(value));
      if (label === "Last run") dd.setAttribute("title", fullWhen(asset.last_run_at));
      item.appendChild(dd);
      list.appendChild(item);
    });
    return list;
  }

  function lineageChips(keys) {
    const chips = h("ul", { class: "chips lineage-chips" });
    if (!keys.length) {
      chips.appendChild(h("li", { class: "lineage-none" }, "None"));
      return chips;
    }

    keys.forEach((key) => {
      const item = h("li", {});
      /* Known assets are navigable; an edge to something outside the register
         is still shown, just not as a link. */
      if (assets.some((a) => a.asset_key === key)) {
        const button = h("button", { class: "chip chip-link", type: "button" }, key);
        button.addEventListener("click", () => selectAsset(key));
        item.appendChild(button);
      } else {
        item.appendChild(h("span", { class: "chip" }, key));
      }
      chips.appendChild(item);
    });
    return chips;
  }

  function lineageBlock(asset) {
    const block = h("div", { class: "lineage" });

    [["Upstream", asset.upstream], ["Downstream", asset.downstream]].forEach(([label, keys]) => {
      const group = h("div", { class: "lineage-group" });
      group.appendChild(h("span", { class: "lineage-label" }, label));
      group.appendChild(lineageChips(keys || []));
      block.appendChild(group);
    });

    return block;
  }

  function checksBlock(checks) {
    if (!checks.length) {
      /* No checks is itself a red status upstream, and it says so here too. */
      return h("p", { class: "empty-note empty-bad" },
        "No quality checks are defined for this asset. Nothing is verifying it.");
    }

    const list = h("ul", { class: "check-list" });
    checks.forEach((check) => {
      const item = h("li", { class: "check " + (check.passed ? "check-pass" : "check-fail") });

      const head = h("span", { class: "check-head" });
      head.appendChild(h("span", {
        class: "check-glyph",
        role: "img",
        "aria-label": check.passed ? "Passed" : "Failed",
      }, check.passed ? "✓" : "✕"));
      head.appendChild(h("span", { class: "check-name" }, check.name));
      head.appendChild(h("span", {
        class: "check-when",
        title: fullWhen(check.checked_at),
      }, formatWhen(check.checked_at)));
      item.appendChild(head);

      item.appendChild(h("span", { class: "check-detail" }, check.detail || "No detail reported."));
      list.appendChild(item);
    });
    return list;
  }

  function fieldsBlock(fields) {
    if (!fields.length) {
      return h("p", { class: "empty-note" }, "No fields are recorded for this asset.");
    }

    const table = h("table", { class: "field-table" });

    const head = h("thead", {});
    const headRow = h("tr", {});
    ["Field", "Type", "Unit", "Null", "Description"].forEach((label) => {
      headRow.appendChild(h("th", { scope: "col" }, label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    const body = h("tbody", {});
    fields.forEach((field) => {
      const row = h("tr", {});
      row.appendChild(h("td", { class: "field-name" }, field.name));
      row.appendChild(h("td", { class: "field-type" }, field.type || "—"));
      row.appendChild(h("td", { class: "field-unit" }, field.unit || "—"));
      row.appendChild(h("td", { class: "field-null" }, field.nullable ? "yes" : "no"));
      row.appendChild(h("td", {}, field.description || "—"));
      body.appendChild(row);
    });
    table.appendChild(body);

    /* Five columns do not fit a narrow detail pane; the table scrolls, the
       page does not. */
    const wrap = h("div", { class: "table-wrap" });
    wrap.appendChild(table);
    return wrap;
  }

  function renderDetail(asset) {
    const detail = $("assetDetail");
    detail.replaceChildren();

    const checks = asset.checks || [];
    const passed = checks.filter((c) => c.passed).length;
    /* The list endpoint computes quality; the detail endpoint does not return
       it, so carry it across from the row this asset was opened from. */
    const summary = assets.find((a) => a.asset_key === asset.asset_key);
    const quality = summary ? summary.quality : "red";

    const header = h("div", { class: "detail-header" });
    header.appendChild(h("h3", { class: "detail-key" }, asset.asset_key));
    header.appendChild(qualityPill(quality));
    detail.appendChild(header);

    detail.appendChild(h("p", { class: "detail-quality-note" },
      qualityNote(checks.length, passed, quality, asset.last_run_at)));

    if (asset.description) {
      detail.appendChild(h("p", { class: "detail-description" }, asset.description));
    }

    detail.appendChild(metaList(asset));

    if (asset.source_detail) {
      detail.appendChild(h("p", { class: "detail-source" }, asset.source_detail));
    }

    detail.appendChild(section("Lineage"));
    detail.appendChild(lineageBlock(asset));

    detail.appendChild(section("Quality checks"));
    detail.appendChild(checksBlock(checks));

    detail.appendChild(section("Fields (" + (asset.fields || []).length + ")"));
    detail.appendChild(fieldsBlock(asset.fields || []));
  }

  function detailMessage(text) {
    const detail = $("assetDetail");
    detail.replaceChildren(h("p", { class: "empty-note" }, text));
  }

  /* ===== Loading ===== */

  async function getJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Request failed: " + response.status);
    return response.json();
  }

  async function selectAsset(key) {
    const token = ++detailRequest;

    selectedKey = key;
    renderList();
    detailMessage("Loading…");

    try {
      const asset = await getJson("/api/registry/asset/" + encodeURIComponent(key));
      if (token !== detailRequest) return;
      renderDetail(asset);
    } catch (err) {
      if (token !== detailRequest) return;
      Log.error("Could not load registry asset " + key + ":", err);
      detailMessage("Could not load this asset.");
    }
  }

  async function loadRegister() {
    try {
      assets = await Quality.assets();

      if (!assets.length) {
        $("registerSub").textContent = "The register holds no assets.";
        renderList();
        detailMessage("Nothing to show.");
        return;
      }

      renderSummary();
      renderList();

      /* Opens on the first asset that needs attention, so a problem is not
         one click away from being missed. */
      const worst = assets.find((a) => a.quality === "red")
        || assets.find((a) => a.quality === "amber")
        || assets[0];
      selectAsset(worst.asset_key);
    } catch (err) {
      Log.error("Could not load the data register:", err);
      $("registerSub").textContent = "Could not load the register.";
      detailMessage("Could not load the register.");
    }
  }

  /* ===== Shown from the rail ===== */

  /* The register loads the first time its section is opened, not on login. */
  document.addEventListener("nav:section", (evt) => {
    if (evt.detail.section === "register" && !loadPromise) loadPromise = loadRegister();
  });

  /* "Full details" on a dashboard quality badge opens that asset here. */
  async function openAsset(key) {
    /* Synchronous, so the load it starts is already in loadPromise below. */
    Nav.show("register", { focus: true });

    await loadPromise;
    /* Nothing to open onto if the register itself could not be loaded — its
       own error message stands rather than a detail with no status beside it. */
    if (!assets.length) return;
    if (key !== selectedKey) selectAsset(key);
  }

  document.addEventListener("registry:open", (evt) => openAsset(evt.detail.assetKey));
})();
