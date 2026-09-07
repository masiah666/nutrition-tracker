/* Port traffic dashboard — reads the read-only /api/port endpoints. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const SVG_NS = "http://www.w3.org/2000/svg";

  /* Top-countries bar chart */
  const WIDTH = 600;
  const HEIGHT = 320;
  const PAD_LEFT = 186;
  /* Rank sits in its own column at the left edge, so names stay right-aligned
     against the bars however long they are. */
  const RANK_X = 34;
  const PAD_RIGHT = 96;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 20;
  const TOP_N = 10;

  /* Comparison card. Capped one below SERIES_COLORS so every selection keeps a
     distinct, validated colour. */
  const COMPARE_MAX = 6;

  /* Time-series charts. Both are year-on-x, TEU-on-y, so they share a drawing
     routine and differ only in these box dimensions. Keep in step with the
     viewBox on the matching <svg> in index.html. */
  const TREND_BOX = { width: 720, height: 340, left: 62, right: 16, top: 12, bottom: 30 };
  const COUNTRY_BOX = { width: 720, height: 260, left: 62, right: 16, top: 12, bottom: 30 };
  const Y_TICKS = 4;
  const X_TICK_TARGET = 8;
  const MAX_DOTS = 30;

  /* World Bank coverage drops sharply after 2019. A regional total summed over
     a shrinking set of reporting countries reads as a collapse that never
     happened, so the regional trend stops at the last well-covered year. A
     single country's own series has no such problem and is drawn in full. */
  const LAST_SOLID_YEAR = 2019;

  /* Categorical series colours, stepped for the dark panel surface and
     validated as a set for CVD separation and contrast. Assigned in fixed
     order by region name — never by rank, so a series keeps its colour. */
  const SERIES_COLORS = [
    "#3987e5", "#d95926", "#199e70", "#c98500",
    "#d55181", "#008300", "#9085e9",
  ];
  const COUNTRY_COLOR = "#38bdf8";

  /* iso3 -> the <g> wrapping that country's bar, for the selected state. */
  const barRows = new Map();
  let countryRequest = 0;

  /* Every reporting country, ranked once on latest_teu. The API ranks on 2019,
     which is not what the chart draws, so rank is computed here instead. */
  let allCountries = [];

  /* iso3 -> that country's full year/TEU points. One fetch per country, shared
     by the detail modal and the comparison card. */
  const seriesCache = new Map();

  /* [{ iso3, colorIndex }] — colorIndex is held per selection so removing one
     country does not recolour the others. */
  const compareSelection = [];
  let compareMeasure = "indexed";
  let compareRequest = 0;

  function el(name, attrs, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatTeu(value) {
    if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (value >= 1e3) return Math.round(value / 1e3) + "k";
    return String(Math.round(value));
  }

  function formatIndex(value) {
    return String(Math.round(value));
  }

  function formatCagr(value) {
    if (value === null || value === undefined) return "—";
    return (value >= 0 ? "+" : "") + (value * 100).toFixed(1) + "%/yr";
  }

  /* ===== Top countries ===== */

  function drawTopCountries(countries) {
    const svg = $("topCountriesChart");
    svg.replaceChildren();
    barRows.clear();

    const data = countries.slice(0, TOP_N);
    if (!data.length) return;

    const max = Math.max(...data.map((d) => d.latest_teu));

    const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
    const rowHeight = (HEIGHT - PAD_TOP - PAD_BOTTOM) / data.length;
    const barHeight = rowHeight * 0.7;

    data.forEach((d, i) => {
      const y = PAD_TOP + i * rowHeight;
      const barWidth = (d.latest_teu / max) * plotWidth;

      const row = el("g", {
        class: "bar-row",
        role: "button",
        tabindex: "0",
        "aria-label":
          d.name + ", ranked " + d.globalRank + " worldwide, " + formatTeu(d.latest_teu) +
          " TEU in " + d.latest_year + " — show time series",
      });

      /* Hit target spans the whole row, not just the bar, so short bars are
         no harder to click than long ones. */
      row.appendChild(el("rect", {
        x: 0, y: y - (rowHeight - barHeight) / 2,
        width: WIDTH, height: rowHeight,
        class: "bar-hit",
      }));

      /* Rank is against the whole field, not the filtered view, so a country
         found by search still shows where it really sits. */
      row.appendChild(el("text", {
        x: RANK_X,
        y: y + barHeight / 2 + 4,
        "text-anchor": "end",
        class: "bar-rank",
      }, "#" + d.globalRank));

      row.appendChild(el("text", {
        x: PAD_LEFT - 8,
        y: y + barHeight / 2 + 4,
        "text-anchor": "end",
        class: "bar-label",
      }, d.name));

      row.appendChild(el("rect", {
        x: PAD_LEFT,
        y: y,
        width: barWidth,
        height: barHeight,
        class: "bar",
      }));

      /* Years differ from bar to bar, so each value carries its own. */
      const value = el("text", {
        x: PAD_LEFT + barWidth + 6,
        y: y + barHeight / 2 + 4,
        class: "bar-value",
      }, formatTeu(d.latest_teu));
      value.appendChild(el("tspan", { dx: "6", class: "bar-year" }, String(d.latest_year)));
      row.appendChild(value);

      row.addEventListener("click", () => selectCountry(d, row));
      row.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" && evt.key !== " ") return;
        evt.preventDefault();
        selectCountry(d, row);
      });

      barRows.set(d.iso3, row);
      svg.appendChild(row);
    });
  }

  /* ===== Leaderboard filters ===== */

  function fillRegionFilter() {
    const select = $("regionFilter");
    [...new Set(allCountries.map((d) => d.region))].sort().forEach((region) => {
      select.appendChild(new Option(region, region));
    });
  }

  function filteredCountries() {
    const region = $("regionFilter").value;
    const query = $("countrySearch").value.trim().toLowerCase();
    return allCountries.filter(
      (d) =>
        (!region || d.region === region) &&
        (!query || d.name.toLowerCase().includes(query))
    );
  }

  function renderTopCountries() {
    const matches = filteredCountries();
    drawTopCountries(matches);

    if (!matches.length) {
      $("chartSub").textContent = "No reporting country matches this filter.";
      return;
    }

    const region = $("regionFilter").value;
    const query = $("countrySearch").value.trim();
    const scope = [];
    if (region) scope.push("in " + region);
    if (query) scope.push('matching "' + query + '"');

    $("chartSub").textContent =
      "Top " + Math.min(TOP_N, matches.length) + " of " + matches.length +
      " reporting countries" + (scope.length ? " " + scope.join(" ") : "") +
      ". Each bar shows that country's most recent reported year — the year sits beside " +
      "the value, and it can differ from country to country. Select a country for its " +
      "full series.";
  }

  function selectCountry(country, trigger) {
    barRows.forEach((row, iso3) => {
      if (iso3 === country.iso3) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    });
    openCountryModal(trigger);
    loadCountry(country);
  }

  /* ===== Country modal ===== */

  /* The bar that opened the modal, so focus goes back where it came from. */
  let modalOpener = null;

  function modalFocusables() {
    return [...$("countryModal").querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((node) => !node.disabled && node.offsetParent !== null);
  }

  function modalIsOpen() {
    return !$("countryModal").classList.contains("hidden");
  }

  function openCountryModal(trigger) {
    modalOpener = trigger || null;
    $("countryModal").classList.remove("hidden");
    document.body.classList.add("modal-open");
    $("countryClose").focus();
  }

  function closeCountryModal() {
    if (!modalIsOpen()) return;

    /* A response still in flight must not paint into a closed modal. */
    countryRequest++;

    $("countryModal").classList.add("hidden");
    document.body.classList.remove("modal-open");
    $("countryTip").classList.add("hidden");
    barRows.forEach((row) => row.removeAttribute("aria-current"));

    if (modalOpener && modalOpener.isConnected) modalOpener.focus();
    modalOpener = null;
  }

  /* ===== Shared time-series drawing ===== */

  function scaleFor(box, series) {
    const points = series.flatMap((s) => s.points);
    const minYear = Math.min(...points.map((p) => p.year));
    const maxYear = Math.max(...points.map((p) => p.year));
    const maxTeu = Math.max(...points.map((p) => p.teu));
    const yearSpan = Math.max(1, maxYear - minYear);

    const plotW = box.width - box.left - box.right;
    const plotH = box.height - box.top - box.bottom;

    return {
      minYear: minYear,
      maxYear: maxYear,
      maxTeu: maxTeu,
      yearSpan: yearSpan,
      plotW: plotW,
      plotH: plotH,
      xOf: (year) => box.left + ((year - minYear) / yearSpan) * plotW,
      yOf: (teu) => box.top + plotH - (teu / Math.max(1, maxTeu)) * plotH,
    };
  }

  function drawFrame(svg, box, scale, format) {
    for (let i = 0; i <= Y_TICKS; i++) {
      const value = (scale.maxTeu / Y_TICKS) * i;
      const gy = scale.yOf(value);
      svg.appendChild(el("line", {
        x1: box.left, y1: gy, x2: box.width - box.right, y2: gy, class: "grid",
      }));
      svg.appendChild(el("text", {
        x: box.left - 8, y: gy + 3, "text-anchor": "end", class: "axis",
      }, format(value)));
    }

    const step = Math.max(1, Math.ceil((scale.yearSpan + 1) / X_TICK_TARGET));
    for (let year = scale.minYear; year <= scale.maxYear; year += step) {
      svg.appendChild(el("text", {
        x: scale.xOf(year), y: box.height - box.bottom + 18,
        "text-anchor": "middle", class: "axis",
      }, String(year)));
    }
  }

  function linePath(points, scale) {
    return points
      .map((p, i) => (i ? "L" : "M") + scale.xOf(p.year).toFixed(1) + " " + scale.yOf(p.teu).toFixed(1))
      .join(" ");
  }

  /* Renders one or more year/TEU series into svg, with a crosshair tooltip.
     `area` fills under the line — only sensible for a single series.
     `format` renders axis and tooltip values; defaults to TEU. */
  function drawSeriesChart(svg, box, series, tip, area, format) {
    const fmt = format || formatTeu;

    svg.replaceChildren();
    tip.classList.add("hidden");

    const scale = scaleFor(box, series);
    drawFrame(svg, box, scale, fmt);

    series.forEach((s) => {
      const path = linePath(s.points, scale);

      if (area && s.points.length > 1) {
        const base = scale.yOf(0);
        const firstX = scale.xOf(s.points[0].year).toFixed(1);
        const lastX = scale.xOf(s.points[s.points.length - 1].year).toFixed(1);
        svg.appendChild(el("path", {
          d: path + " L" + lastX + " " + base + " L" + firstX + " " + base + " Z",
          class: "series-area",
          fill: s.color,
        }));
      }

      svg.appendChild(el("path", { d: path, class: "series-line", stroke: s.color }));

      /* Individual readings are worth marking when there are few enough that
         the dots don't merge into the line. */
      if (series.length === 1 && s.points.length <= MAX_DOTS) {
        s.points.forEach((p) => {
          svg.appendChild(el("circle", {
            cx: scale.xOf(p.year), cy: scale.yOf(p.teu), r: 4,
            fill: s.color, class: "series-dot",
          }));
        });
      }
    });

    attachHover(svg, box, scale, series, tip, fmt);
  }

  function attachHover(svg, box, scale, series, tip, format) {
    const crosshair = el("line", {
      class: "crosshair hidden", y1: box.top, y2: box.top + scale.plotH,
    });
    const dots = el("g", {});
    const overlay = el("rect", {
      x: box.left, y: box.top, width: scale.plotW, height: scale.plotH, fill: "transparent",
    });
    svg.appendChild(crosshair);
    svg.appendChild(dots);
    svg.appendChild(overlay);

    function yearAt(evt) {
      const rect = svg.getBoundingClientRect();
      const userX = ((evt.clientX - rect.left) / rect.width) * box.width;
      const ratio = (userX - box.left) / scale.plotW;
      const year = Math.round(scale.minYear + ratio * scale.yearSpan);
      return Math.min(scale.maxYear, Math.max(scale.minYear, year));
    }

    function hide() {
      crosshair.classList.add("hidden");
      dots.replaceChildren();
      tip.classList.add("hidden");
    }

    function show(evt) {
      const year = yearAt(evt);
      const cx = scale.xOf(year);

      crosshair.setAttribute("x1", cx);
      crosshair.setAttribute("x2", cx);
      crosshair.classList.remove("hidden");

      dots.replaceChildren();
      const hits = [];
      series.forEach((s) => {
        const point = s.points.find((p) => p.year === year);
        if (!point) return;
        dots.appendChild(el("circle", {
          cx: cx, cy: scale.yOf(point.teu), r: 4, fill: s.color, class: "series-dot",
        }));
        hits.push({ name: s.name, teu: point.teu, color: s.color });
      });

      if (!hits.length) return hide();
      hits.sort((a, b) => b.teu - a.teu);

      tip.replaceChildren(tipContent(year, hits, format));
      tip.classList.remove("hidden");

      const rect = svg.getBoundingClientRect();
      const px = (cx / box.width) * rect.width;
      tip.style.left = px + "px";
      tip.style.transform =
        px > rect.width / 2 ? "translate(calc(-100% - 12px), 0)" : "translate(12px, 0)";
    }

    overlay.addEventListener("pointermove", show);
    overlay.addEventListener("pointerleave", hide);
  }

  function tipContent(year, hits, format) {
    const frag = document.createDocumentFragment();

    const head = document.createElement("div");
    head.className = "chart-tip-head";
    head.textContent = String(year);
    frag.appendChild(head);

    hits.forEach((h) => {
      const row = document.createElement("div");
      row.className = "chart-tip-row";

      const swatch = document.createElement("i");
      swatch.style.background = h.color;

      const name = document.createElement("span");
      name.textContent = h.name;

      const value = document.createElement("b");
      value.textContent = format(h.teu);

      row.append(swatch, name, value);
      frag.appendChild(row);
    });

    return frag;
  }

  /* ===== Regional trend ===== */

  /* Rows arrive as one record per region per year. Fold them into one series
     per region, colour-keyed by name so the mapping is stable. */
  function toRegionSeries(rows) {
    const byRegion = new Map();

    rows.forEach((r) => {
      if (r.total_teu === null || r.year > LAST_SOLID_YEAR) return;
      if (!byRegion.has(r.region)) byRegion.set(r.region, []);
      byRegion.get(r.region).push({ year: r.year, teu: r.total_teu });
    });

    const names = [...byRegion.keys()].sort();
    const dropped = names.slice(SERIES_COLORS.length);
    if (dropped.length) {
      Log.warn("Not enough series colours; omitting " + dropped.join(", "), null);
    }

    return names.slice(0, SERIES_COLORS.length).map((name, i) => {
      const points = byRegion.get(name).sort((a, b) => a.year - b.year);
      return {
        name: name,
        points: points,
        color: SERIES_COLORS[i],
        last: points[points.length - 1].teu,
      };
    });
  }

  function drawRegionLegend(series) {
    const list = $("regionLegend");
    list.replaceChildren();

    /* Ordered by latest value so the legend reads like the chart's right edge,
       while each region keeps the colour assigned in toRegionSeries. */
    [...series].sort((a, b) => b.last - a.last).forEach((s) => {
      const item = document.createElement("li");

      const swatch = document.createElement("i");
      swatch.style.background = s.color;

      const name = document.createElement("span");
      name.textContent = s.name;

      item.append(swatch, name);
      list.appendChild(item);
    });
  }

  /* ===== Comparison ===== */

  function fillCompareOptions() {
    const select = $("compareAdd");
    [...allCountries]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((d) => select.appendChild(new Option(d.name, d.iso3)));
  }

  function addCompareCountry(iso3) {
    if (compareSelection.length >= COMPARE_MAX) return;
    if (compareSelection.some((sel) => sel.iso3 === iso3)) return;

    const used = new Set(compareSelection.map((sel) => sel.colorIndex));
    let colorIndex = 0;
    while (used.has(colorIndex)) colorIndex++;

    compareSelection.push({ iso3: iso3, colorIndex: colorIndex });
    renderComparison();
  }

  function removeCompareCountry(iso3) {
    const at = compareSelection.findIndex((sel) => sel.iso3 === iso3);
    if (at === -1) return;
    compareSelection.splice(at, 1);
    renderComparison();
  }

  function countryByIso3(iso3) {
    return allCountries.find((d) => d.iso3 === iso3);
  }

  function renderCompareChips() {
    const list = $("compareChips");
    list.replaceChildren();

    compareSelection.forEach((sel) => {
      const country = countryByIso3(sel.iso3);
      if (!country) return;

      const item = document.createElement("li");
      item.className = "chip";

      const swatch = document.createElement("i");
      swatch.style.background = SERIES_COLORS[sel.colorIndex];

      const name = document.createElement("span");
      name.textContent = country.name;

      const cagr = document.createElement("span");
      cagr.className = "chip-cagr";
      cagr.textContent = formatCagr(country.cagr);
      cagr.title = "Average annual growth, 2010–2019";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove " + country.name);
      remove.addEventListener("click", () => removeCompareCountry(sel.iso3));

      item.append(swatch, name, cagr, remove);
      list.appendChild(item);
    });

    /* A country already on the chart should not be offerable again. */
    const chosen = new Set(compareSelection.map((sel) => sel.iso3));
    [...$("compareAdd").options].forEach((option) => {
      option.disabled = option.value !== "" && chosen.has(option.value);
    });
    $("compareAdd").disabled = compareSelection.length >= COMPARE_MAX;
  }

  /* The earliest year every selected country reports a non-zero figure.
     Indexing needs one shared starting point, or the lines are not saying the
     same thing — and a zero base would divide the series into infinities. */
  function commonBaseYear(pointsList) {
    for (const point of pointsList[0]) {
      const shared = pointsList.every((list) =>
        list.some((p) => p.year === point.year && p.teu > 0)
      );
      if (shared && point.teu > 0) return point.year;
    }
    return null;
  }

  async function renderComparison() {
    const token = ++compareRequest;
    renderCompareChips();

    if (!compareSelection.length) {
      $("compareChart").replaceChildren();
      $("compareTip").classList.add("hidden");
      $("compareSub").textContent = "Add a country to start a comparison.";
      return;
    }

    try {
      await Promise.all(compareSelection.map((sel) => fetchSeries(sel.iso3)));
    } catch (err) {
      if (token !== compareRequest) return;
      Log.error("Could not load comparison series:", err);
      $("compareSub").textContent = "Could not load one of these countries.";
      return;
    }
    if (token !== compareRequest) return;

    drawComparison();
  }

  function drawComparison() {
    /* Cross-country comparison stops at the last well-covered year for the same
       reason the regional chart does, and because latest_year differs by
       country — a shared window is the only like-for-like read. */
    const chosen = compareSelection
      .map((sel) => ({
        country: countryByIso3(sel.iso3),
        color: SERIES_COLORS[sel.colorIndex],
        points: (seriesCache.get(sel.iso3) || []).filter((p) => p.year <= LAST_SOLID_YEAR),
      }))
      .filter((c) => c.country && c.points.length);

    if (!chosen.length) {
      $("compareChart").replaceChildren();
      $("compareTip").classList.add("hidden");
      $("compareSub").textContent =
        "No reported traffic through " + LAST_SOLID_YEAR + " for these countries.";
      return;
    }

    if (compareMeasure === "absolute") {
      drawSeriesChart(
        $("compareChart"),
        TREND_BOX,
        chosen.map((c) => ({ name: c.country.name, points: c.points, color: c.color })),
        $("compareTip"),
        false
      );
      $("compareSub").textContent =
        "Total TEU per year through " + LAST_SOLID_YEAR + ". On an absolute scale the " +
        "largest country sets the axis, so smaller ones flatten — switch to Indexed to " +
        "compare their growth. Growth rates below are 2010–2019.";
      return;
    }

    const base = commonBaseYear(chosen.map((c) => c.points));
    if (base === null) {
      $("compareChart").replaceChildren();
      $("compareTip").classList.add("hidden");
      $("compareSub").textContent =
        "These countries share no reporting year, so they cannot be indexed to a common " +
        "base. Switch to Absolute TEU to see them side by side.";
      return;
    }

    const series = chosen.map((c) => {
      const baseValue = c.points.find((p) => p.year === base).teu;
      return {
        name: c.country.name,
        color: c.color,
        points: c.points
          .filter((p) => p.year >= base)
          .map((p) => ({ year: p.year, teu: (p.teu / baseValue) * 100 })),
      };
    });

    drawSeriesChart($("compareChart"), TREND_BOX, series, $("compareTip"), false, formatIndex);
    $("compareSub").textContent =
      "Each country indexed to 100 in " + base + ", its earliest year in common with the " +
      "others, through " + LAST_SOLID_YEAR + ". Size drops out, so a small port's growth " +
      "reads against a large one's. Growth rates below are 2010–2019.";
  }

  /* ===== Loading ===== */

  async function getJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Request failed: " + response.status);
    return response.json();
  }

  async function fetchSeries(iso3) {
    if (seriesCache.has(iso3)) return seriesCache.get(iso3);

    const data = await getJson("/api/port/country/" + encodeURIComponent(iso3));
    const points = data.series
      .filter((p) => p.teu !== null)
      .map((p) => ({ year: p.year, teu: p.teu }))
      .sort((a, b) => a.year - b.year);

    seriesCache.set(iso3, points);
    return points;
  }

  async function loadCountries() {
    try {
      const rows = await getJson("/api/port/countries");

      /* Rank once, on the value the charts actually draw, and carry it so a
         filtered leaderboard can still show a country's true position. */
      allCountries = rows
        .filter((d) => d.latest_teu !== null && d.latest_year !== null)
        .sort((a, b) => b.latest_teu - a.latest_teu)
        .map((d, i) => Object.assign({}, d, { globalRank: i + 1 }));

      if (!allCountries.length) {
        $("chartSub").textContent = "No country traffic data available.";
        $("compareSub").textContent = "No country traffic data available.";
        return;
      }

      fillRegionFilter();
      fillCompareOptions();
      renderTopCountries();

      /* Seeded with the three largest so the card opens with something to read;
         everything in it is removable. */
      allCountries.slice(0, 3).forEach((d, i) => {
        compareSelection.push({ iso3: d.iso3, colorIndex: i });
      });
      renderComparison();
    } catch (err) {
      Log.error("Could not load country data:", err);
      $("chartSub").textContent = "Could not load data.";
      $("compareSub").textContent = "Could not load data.";
    }
  }

  async function loadRegions() {
    try {
      const series = toRegionSeries(await getJson("/api/port/regions"));
      if (!series.length) {
        $("regionSub").textContent = "No regional data available.";
        return;
      }

      drawSeriesChart($("regionsChart"), TREND_BOX, series, $("regionTip"), false);
      drawRegionLegend(series);

      const firstYear = Math.min(...series.flatMap((s) => s.points.map((p) => p.year)));
      $("regionSub").textContent =
        "Every reporting country summed into one total per region, " + firstYear + "–" +
        LAST_SOLID_YEAR + ". Later years are omitted — country coverage drops sharply " +
        "after " + LAST_SOLID_YEAR + ", so totals are not comparable.";
    } catch (err) {
      Log.error("Could not load regional data:", err);
      $("regionSub").textContent = "Could not load data.";
    }
  }

  async function loadCountry(country) {
    /* Clicking a second country while the first is in flight must not let the
       slower response win. */
    const token = ++countryRequest;

    $("countryTitle").textContent = country.name;
    $("countrySub").textContent = "Loading…";
    $("countryChart").replaceChildren();
    $("countryTip").classList.add("hidden");

    try {
      const points = await fetchSeries(country.iso3);
      if (token !== countryRequest) return;

      if (!points.length) {
        $("countrySub").textContent = "No reported traffic for this country.";
        return;
      }

      drawSeriesChart(
        $("countryChart"),
        COUNTRY_BOX,
        [{ name: country.name, points: points, color: COUNTRY_COLOR }],
        $("countryTip"),
        true
      );

      $("countrySub").textContent =
        "Container throughput, " + points[0].year + "–" +
        points[points.length - 1].year + " · " + country.region;
    } catch (err) {
      if (token !== countryRequest) return;
      Log.error("Could not load series for " + country.iso3 + ":", err);
      $("countrySub").textContent = "Could not load this country's series.";
    }
  }

  function load() {
    loadCountries();
    loadRegions();
    /* The vessel-arrival cards keep their own state and their own fetches; this
       is the only hand-off, because Auth.onLogin takes a single callback and it
       is held here. */
    Vessels.load();
    /* Fills the quality badge in each panel's corner from the data register. */
    Quality.load();
  }

  function showApp(email) {
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userName").textContent = email;
    $("userAvatar").textContent = email.charAt(0).toUpperCase();
    load();
  }

  $("regionFilter").addEventListener("change", renderTopCountries);
  $("countrySearch").addEventListener("input", renderTopCountries);

  $("compareAdd").addEventListener("change", (evt) => {
    const iso3 = evt.target.value;
    evt.target.value = "";
    if (iso3) addCompareCountry(iso3);
  });

  $("compareMeasure").querySelectorAll(".seg").forEach((button) => {
    button.addEventListener("click", () => {
      if (compareMeasure === button.dataset.measure) return;
      compareMeasure = button.dataset.measure;
      $("compareMeasure").querySelectorAll(".seg").forEach((other) => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      drawComparison();
    });
  });

  $("countryClose").addEventListener("click", closeCountryModal);

  /* The modal's own quality badge links through to the register, which is
     behind the overlay — so the overlay goes first. */
  document.addEventListener("registry:open", closeCountryModal);

  /* Only a click on the backdrop itself closes; clicks inside the panel bubble
     up to it but arrive with the panel as target. */
  $("countryModal").addEventListener("click", (evt) => {
    if (evt.target === evt.currentTarget) closeCountryModal();
  });

  document.addEventListener("keydown", (evt) => {
    if (!modalIsOpen()) return;

    if (evt.key === "Escape") {
      evt.preventDefault();
      closeCountryModal();
      return;
    }

    /* Keep Tab inside the modal while it is up. */
    if (evt.key !== "Tab") return;
    const focusable = modalFocusables();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (evt.shiftKey && document.activeElement === first) {
      evt.preventDefault();
      last.focus();
    } else if (!evt.shiftKey && document.activeElement === last) {
      evt.preventDefault();
      first.focus();
    }
  });

  $("logoutBtn").addEventListener("click", () => Auth.logOut());
  Auth.onLogin(showApp);

  const existing = Auth.currentUser();
  if (existing) showApp(existing);
})();
