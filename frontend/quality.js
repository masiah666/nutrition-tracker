/* Data quality badges — the register's verdict, shown on the charts it feeds.
 *
 * The register tab answers "is this data any good?" only for someone who
 * thinks to go and ask. A reader looking at a chart gets the same answer here,
 * in the corner of the panel the data is drawn on.
 *
 * One fetch of /api/registry/assets on dashboard load fills every badge; the
 * per-check detail behind a badge is fetched the first time that badge is
 * opened. The status is whatever the API computed — a badge never softens it,
 * and never shows a status at all until it knows one. */
window.Quality = (function () {
  "use strict";

  /* Matches STALE_AFTER_HOURS in backend/main.py. Shown to the reader so the
     amber rule is stated, not guessed at. */
  const STALE_AFTER_HOURS = 48;

  const QUALITY = {
    green: { label: "Green", glyph: "✓" },
    amber: { label: "Amber", glyph: "!" },
    red: { label: "Red", glyph: "✕" },
  };

  /* The one-line provenance under a badge: where the data came from, and what
     verifying it actually established. */
  const SOURCE_STATE = {
    green: "validated",
    amber: "validated, but not re-run recently",
    red: "not validated",
  };

  /* asset_key -> summary row from /api/registry/assets. */
  let assetsPromise = null;
  /* asset_key -> promise of the full asset, fetched when a badge first opens. */
  const detailPromises = new Map();

  const badges = [];
  let openBadge = null;
  /* Unique per badge, so a button can point at the panel it controls. */
  let badgeSeq = 0;

  function h(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const key in attrs) {
      if (key === "class") node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* Elapsed time, floored — a run 90 minutes old reads as 1 h, never 2. */
  function formatWhen(iso) {
    if (!iso) return "never";
    const then = new Date(iso);
    if (isNaN(then.getTime())) return "unknown";

    const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    const hours = Math.floor(minutes / 60);
    if (hours < STALE_AFTER_HOURS) return hours + " h ago";
    return Math.floor(hours / 24) + " d ago";
  }

  function fullWhen(iso) {
    if (!iso) return "No run recorded";
    const then = new Date(iso);
    return isNaN(then.getTime()) ? String(iso) : then.toLocaleString();
  }

  /* Says why a status is what it is, in the register's own terms. */
  function qualityNote(total, passed, quality, lastRunAt) {
    const when = formatWhen(lastRunAt);
    if (!total) return "No quality checks defined · last run " + when;

    const failed = total - passed;
    if (failed > 0) {
      return failed + " of " + total + " checks failing · last run " + when;
    }
    if (quality === "amber") {
      return total + "/" + total + " checks passed, but the last run was " + when;
    }
    return total + "/" + total + " checks passed · ran " + when;
  }

  function qualityPill(quality, extraClass) {
    const meta = QUALITY[quality] || QUALITY.red;
    const pill = h("span", { class: "q-pill q-" + quality + (extraClass ? " " + extraClass : "") });
    pill.appendChild(h("span", { class: "q-glyph", "aria-hidden": "true" }, meta.glyph));
    pill.appendChild(h("span", {}, meta.label));
    return pill;
  }

  async function getJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Request failed: " + response.status);
    return response.json();
  }

  /* Every consumer shares one request. A failed one is not cached, so the
     register can still try again after a badge could not load. */
  function assets() {
    if (!assetsPromise) {
      assetsPromise = getJson("/api/registry/assets").catch((err) => {
        assetsPromise = null;
        throw err;
      });
    }
    return assetsPromise;
  }

  function assetDetail(key) {
    if (!detailPromises.has(key)) {
      const request = getJson("/api/registry/asset/" + encodeURIComponent(key))
        .catch((err) => {
          detailPromises.delete(key);
          throw err;
        });
      detailPromises.set(key, request);
    }
    return detailPromises.get(key);
  }

  /* ===== One badge ===== */

  function closeOpen() {
    if (openBadge) openBadge.close();
  }

  function makeBadge(key) {
    const popId = "qBadgePop" + (++badgeSeq);

    const wrap = h("div", { class: "q-badge" });
    const button = h("button", {
      class: "q-badge-btn",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": popId,
    });
    const pop = h("div", {
      class: "q-badge-pop hidden",
      id: popId,
      role: "group",
      "aria-label": "Data quality for " + key,
    });
    wrap.append(button, pop);

    /* Summary fields, filled once the register answers. Nothing is drawn
       before that: an unknown status must not read as a good one. */
    let summary = null;
    let detailLoaded = false;
    /* Set while focus is being moved back to the button after a close, so the
       focus event that move fires does not reopen what was just closed. */
    let refocusing = false;

    const badge = {
      key: key,
      close: function () {
        pop.classList.add("hidden");
        button.setAttribute("aria-expanded", "false");
        if (openBadge === badge) openBadge = null;
      },
      focusButton: function () {
        refocusing = true;
        button.focus();
        refocusing = false;
      },
      open: function () {
        if (!summary || refocusing) return;
        if (openBadge && openBadge !== badge) openBadge.close();
        openBadge = badge;
        pop.classList.remove("hidden");
        button.setAttribute("aria-expanded", "true");
        loadChecks();
      },
    };

    function checkLine(check) {
      const item = h("li", { class: "q-check " + (check.passed ? "q-check-pass" : "q-check-fail") });
      const head = h("span", { class: "q-check-head" });
      head.appendChild(h("span", {
        class: "q-check-glyph",
        role: "img",
        "aria-label": check.passed ? "Passed" : "Failed",
      }, check.passed ? "✓" : "✕"));
      head.appendChild(h("span", { class: "q-check-name" }, check.name));
      item.appendChild(head);
      item.appendChild(h("span", { class: "q-check-detail" }, check.detail || "No detail reported."));
      return item;
    }

    function renderChecks(node, checks) {
      node.replaceChildren();
      if (!checks.length) {
        /* No checks is itself a red status upstream, and it says so here too. */
        node.appendChild(h("p", { class: "q-pop-note q-pop-bad" },
          "No quality checks are defined for this asset. Nothing is verifying it."));
        return;
      }
      const list = h("ul", { class: "q-check-list" });
      checks.forEach((check) => list.appendChild(checkLine(check)));
      node.appendChild(list);
    }

    function loadChecks() {
      if (detailLoaded) return;
      detailLoaded = true;

      const slotNode = pop.querySelector(".q-pop-checks");
      assetDetail(key).then(
        (asset) => renderChecks(slotNode, asset.checks || []),
        (err) => {
          detailLoaded = false;
          Log.error("Could not load quality checks for " + key + ":", err);
          slotNode.replaceChildren(h("p", { class: "q-pop-note" },
            "Could not load the individual checks."));
        }
      );
    }

    function renderPop() {
      pop.replaceChildren();

      const head = h("div", { class: "q-pop-head" });
      head.appendChild(qualityPill(summary.quality));
      head.appendChild(h("span", { class: "q-pop-key" }, key));
      pop.appendChild(head);

      pop.appendChild(h("p", { class: "q-pop-note" }, qualityNote(
        summary.checks_total, summary.checks_passed, summary.quality, summary.last_run_at)));

      pop.appendChild(h("div", { class: "q-pop-checks" }, "Loading checks…"));

      const foot = h("div", { class: "q-pop-foot" });
      foot.appendChild(h("p", { class: "q-pop-source" },
        (summary.source_system || "Source unrecorded") + " → " +
        (SOURCE_STATE[summary.quality] || SOURCE_STATE.red)));
      foot.appendChild(h("p", { class: "q-pop-run" }, summary.last_run_at
        ? "Last run " + fullWhen(summary.last_run_at)
        : "No run recorded"));

      const link = h("button", { class: "q-pop-link", type: "button" }, "Full details");
      link.addEventListener("click", () => {
        badge.close();
        document.dispatchEvent(new CustomEvent("registry:open", { detail: { assetKey: key } }));
      });
      foot.appendChild(link);
      pop.appendChild(foot);
    }

    function renderButton() {
      const meta = QUALITY[summary.quality] || QUALITY.red;
      button.replaceChildren();
      button.appendChild(h("span", {
        class: "q-dot q-badge-dot q-" + summary.quality,
        "aria-hidden": "true",
      }, meta.glyph));

      /* Green is a quiet dot. Amber and red say so in words as well, so a
         problem is never left to colour alone in the corner of a chart. */
      if (summary.quality !== "green") {
        button.appendChild(h("span", { class: "q-badge-word q-" + summary.quality }, meta.label));
      }

      button.setAttribute("aria-label", "Data quality, " + meta.label + ": " + qualityNote(
        summary.checks_total, summary.checks_passed, summary.quality, summary.last_run_at));
    }

    /* The register could not be reached. Neither green nor a silent gap — the
       badge says the status is unknown. */
    function showUnknown() {
      summary = null;
      button.replaceChildren(h("span", {
        class: "q-dot q-badge-dot q-unknown",
        "aria-hidden": "true",
      }, "?"));
      button.setAttribute("aria-label", "Data quality unknown — the register could not be reached");
      button.setAttribute("title", "The data register could not be reached, so this panel's status is unknown.");
      button.disabled = true;
      wrap.classList.add("q-badge-ready");
    }

    badge.setSummary = function (row) {
      if (!row) return showUnknown();
      summary = row;
      renderButton();
      renderPop();
      wrap.classList.add("q-badge-ready");
    };
    badge.fail = showUnknown;

    /* Hover and focus both open it; the pointer can travel into the panel
       because the panel sits inside the same wrapper. */
    wrap.addEventListener("mouseenter", badge.open);
    /* The pointer leaving does not close a panel the keyboard is inside. */
    wrap.addEventListener("mouseleave", () => {
      if (!wrap.contains(document.activeElement)) badge.close();
    });
    wrap.addEventListener("focusin", badge.open);
    wrap.addEventListener("focusout", (evt) => {
      if (!wrap.contains(evt.relatedTarget)) badge.close();
    });
    /* Toggle on click, for touch, where there is no hover. */
    button.addEventListener("click", () => {
      if (pop.classList.contains("hidden")) badge.open();
      else badge.close();
    });

    return { badge: badge, node: wrap };
  }

  /* ===== Loading ===== */

  function load() {
    if (badges.length) return;

    document.querySelectorAll("[data-quality-asset]").forEach((slot) => {
      const made = makeBadge(slot.dataset.qualityAsset);
      slot.replaceChildren(made.node);
      badges.push(made.badge);
    });
    if (!badges.length) return;

    assets().then(
      (rows) => {
        const byKey = new Map(rows.map((row) => [row.asset_key, row]));
        badges.forEach((badge) => badge.setSummary(byKey.get(badge.key) || null));
      },
      (err) => {
        Log.error("Could not load data quality statuses:", err);
        badges.forEach((badge) => badge.fail());
      }
    );
  }

  /* Escape closes an open panel and stops there — inside the country modal it
     must not also close the modal behind it. Capture runs ahead of the modal's
     own document handler. */
  document.addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape" || !openBadge) return;
    const focus = openBadge.focusButton;
    evt.stopPropagation();
    closeOpen();
    focus();
  }, true);

  return {
    STALE_AFTER_HOURS: STALE_AFTER_HOURS,
    QUALITY: QUALITY,
    load: load,
    assets: assets,
    formatWhen: formatWhen,
    fullWhen: fullWhen,
    qualityNote: qualityNote,
    pill: qualityPill,
  };
})();
