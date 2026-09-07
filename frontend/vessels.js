/* Vessel arrivals and port-to-port legs — reads the read-only /api/port
 * endpoints backed by IMF PortWatch.
 *
 * Two cards, one port picker each, both fed by a single fetch of the port list.
 *
 * What the source does NOT carry, and what these cards therefore never imply:
 *   - vessel size or class. PortWatch splits calls by vessel type only.
 *   - transhipment. No free source publishes a transhipment split per port
 *     pair, so the second card offers domestic vs international instead, and
 *     says so rather than letting the reader assume otherwise.
 */
window.Vessels = (function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SVG_NS = "http://www.w3.org/2000/svg";

  /* Keep in step with the viewBox on the matching <svg> in index.html. */
  const CALLS_BOX = { width: 720, height: 320, left: 46, right: 16, top: 12, bottom: 30 };
  const LINKS_BOX = { width: 720, height: 340, left: 210, right: 104, top: 8, bottom: 24 };

  const Y_TICKS = 4;
  const X_TICK_TARGET = 8;
  const TOP_LEGS = 12;

  /* The same validated categorical set the regional chart uses — stepped for
     the dark panel surface and checked as a group for CVD separation and
     contrast. Assigned in fixed order by vessel type, never by size, so a type
     keeps its colour as the filter changes. */
  const TYPE_COLORS = {
    container: "#3987e5",
    dry_bulk: "#d95926",
    general_cargo: "#199e70",
    roro: "#c98500",
    tanker: "#d55181",
  };

  const TYPES = [
    { key: "container", label: "Container" },
    { key: "dry_bulk", label: "Dry bulk" },
    { key: "general_cargo", label: "General cargo" },
    { key: "roro", label: "RoRo" },
    { key: "tanker", label: "Tanker" },
  ];

  /* Two hues from the same validated set, far enough apart to survive CVD, and
     never carrying the split on their own — the legend names both and every
     bar is labelled with its port's country. */
  const SCOPE_COLORS = { international: "#3987e5", domestic: "#c98500" };

  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  /* Every port with arrival data, busiest first. Shared by both pickers. */
  let allPorts = [];
  /* "Name — Country" as typed into a picker -> portid. */
  const portByLabel = new Map();
  /* The month PortWatch has only partly published; excluded from the series. */
  let partialMonth = null;

  let callsPortId = null;
  let callsType = "all";
  let callsRequest = 0;
  let callsData = null;

  let linksPortId = null;
  let linksDirection = "outbound";
  let linksScope = "all";
  let linksRequest = 0;
  let linksData = null;

  function el(name, attrs, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

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
    if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (value >= 1e4) return Math.round(value / 1e3) + "k";
    return String(Math.round(value));
  }

  /* Deadweight tonnage sailing a leg each day. Rounded hard — the underlying
     figure is an AIS-derived average, and decimals would overstate it. */
  function formatCapacity(value) {
    if (!value) return "0";
    if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (value >= 1e3) return Math.round(value / 1e3) + "k";
    return String(Math.round(value));
  }

  /* Axis ticks are whole vessels. A raw max/4 step puts "2" on two ticks at a
     port that sees three ships a month, so the step is rounded up to a 1, 2 or
     5 and the axis top follows it. */
  function niceStep(raw) {
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    const scaled = Math.max(1, raw) / power;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return Math.max(1, step * power);
  }

  /* Port names run past the label gutter on a few of the 2,065. */
  function clip(name, max) {
    return name.length > max ? name.slice(0, max - 1) + "\u2026" : name;
  }

  function formatMonth(iso) {
    const parts = iso.split("-");
    return MONTHS[Number(parts[1]) - 1] + " " + parts[0];
  }

  function portLabel(port) {
    return port.name + " — " + port.country;
  }

  async function getJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Request failed: " + response.status);
    return response.json();
  }

  /* ===== Card 1: arrivals by vessel type ===== */

  /* One point per month, so the x axis is an index over the months the port
     actually reports rather than a date scale — every series in this card comes
     from the same port and so shares that list exactly. */
  function callsScale(months, maxValue) {
    const plotW = CALLS_BOX.width - CALLS_BOX.left - CALLS_BOX.right;
    const plotH = CALLS_BOX.height - CALLS_BOX.top - CALLS_BOX.bottom;
    const span = Math.max(1, months.length - 1);
    const step = niceStep(Math.max(1, maxValue) / Y_TICKS);
    const top = step * Y_TICKS;
    return {
      plotW: plotW,
      plotH: plotH,
      max: top,
      step: step,
      xOf: (i) => CALLS_BOX.left + (i / span) * plotW,
      yOf: (v) => CALLS_BOX.top + plotH - (v / top) * plotH,
    };
  }

  function drawCallsFrame(svg, months, scale) {
    for (let i = 0; i <= Y_TICKS; i++) {
      const value = scale.step * i;
      const gy = scale.yOf(value);
      svg.appendChild(el("line", {
        x1: CALLS_BOX.left, y1: gy,
        x2: CALLS_BOX.width - CALLS_BOX.right, y2: gy, class: "grid",
      }));
      svg.appendChild(el("text", {
        x: CALLS_BOX.left - 8, y: gy + 3, "text-anchor": "end", class: "axis",
      }, formatCount(value)));
    }

    /* Label whole years, not months — a tick per month is unreadable at this
       width, and the year is the unit a reader scans for. */
    const januaries = months
      .map((month, i) => ({ month: month, i: i }))
      .filter((m) => m.month.slice(5, 7) === "01");
    const ticks = januaries.length ? januaries : months.map((m, i) => ({ month: m, i: i }));
    const step = Math.max(1, Math.ceil(ticks.length / X_TICK_TARGET));

    ticks.forEach((tick, n) => {
      if (n % step) return;
      svg.appendChild(el("text", {
        x: scale.xOf(tick.i),
        y: CALLS_BOX.height - CALLS_BOX.bottom + 18,
        "text-anchor": "middle", class: "axis",
      }, tick.month.slice(0, 4)));
    });
  }

  function drawCallsChart(months, series) {
    const svg = $("callsChart");
    const tip = $("callsTip");
    svg.replaceChildren();
    tip.classList.add("hidden");

    const max = Math.max(...series.flatMap((s) => s.values));
    const scale = callsScale(months, max);
    drawCallsFrame(svg, months, scale);

    const single = series.length === 1;

    series.forEach((s) => {
      const path = s.values
        .map((v, i) => (i ? "L" : "M") + scale.xOf(i).toFixed(1) + " " + scale.yOf(v).toFixed(1))
        .join(" ");

      if (single && s.values.length > 1) {
        const base = scale.yOf(0);
        const firstX = scale.xOf(0).toFixed(1);
        const lastX = scale.xOf(s.values.length - 1).toFixed(1);
        svg.appendChild(el("path", {
          d: path + " L" + lastX + " " + base + " L" + firstX + " " + base + " Z",
          class: "series-area", fill: s.color,
        }));
      }

      svg.appendChild(el("path", { d: path, class: "series-line", stroke: s.color }));
    });

    attachCallsHover(svg, tip, months, series, scale);
  }

  function attachCallsHover(svg, tip, months, series, scale) {
    const crosshair = el("line", {
      class: "crosshair hidden", y1: CALLS_BOX.top, y2: CALLS_BOX.top + scale.plotH,
    });
    const dots = el("g", {});
    const overlay = el("rect", {
      x: CALLS_BOX.left, y: CALLS_BOX.top,
      width: scale.plotW, height: scale.plotH, fill: "transparent",
    });
    svg.append(crosshair, dots, overlay);

    function hide() {
      crosshair.classList.add("hidden");
      dots.replaceChildren();
      tip.classList.add("hidden");
    }

    overlay.addEventListener("pointerleave", hide);
    overlay.addEventListener("pointermove", (evt) => {
      const rect = svg.getBoundingClientRect();
      const userX = ((evt.clientX - rect.left) / rect.width) * CALLS_BOX.width;
      const ratio = (userX - CALLS_BOX.left) / scale.plotW;
      const index = Math.min(
        months.length - 1,
        Math.max(0, Math.round(ratio * (months.length - 1)))
      );
      const cx = scale.xOf(index);

      crosshair.setAttribute("x1", cx);
      crosshair.setAttribute("x2", cx);
      crosshair.classList.remove("hidden");

      dots.replaceChildren();
      const hits = series.map((s) => {
        dots.appendChild(el("circle", {
          cx: cx, cy: scale.yOf(s.values[index]), r: 4,
          fill: s.color, class: "series-dot",
        }));
        return { name: s.name, value: s.values[index], color: s.color };
      });
      hits.sort((a, b) => b.value - a.value);

      const frag = document.createDocumentFragment();
      frag.appendChild(h("div", { class: "chart-tip-head" }, formatMonth(months[index])));
      hits.forEach((hit) => {
        const row = h("div", { class: "chart-tip-row" });
        const swatch = h("i");
        swatch.style.background = hit.color;
        row.append(swatch, h("span", {}, hit.name), h("b", {}, formatCount(hit.value)));
        frag.appendChild(row);
      });
      tip.replaceChildren(frag);
      tip.classList.remove("hidden");

      const px = (cx / CALLS_BOX.width) * rect.width;
      tip.style.left = px + "px";
      tip.style.transform =
        px > rect.width / 2 ? "translate(calc(-100% - 12px), 0)" : "translate(12px, 0)";
    });
  }

  function drawCallsLegend(series) {
    const list = $("callsLegend");
    list.replaceChildren();
    /* One series needs no legend — the subtitle already names it. */
    if (series.length < 2) return;

    series.forEach((s) => {
      const item = h("li");
      const swatch = h("i");
      swatch.style.background = s.color;
      item.append(swatch, h("span", {}, s.name));
      list.appendChild(item);
    });
  }

  function renderCalls() {
    if (!callsData) return;

    /* PortWatch publishes weekly, so the newest month is only part of a month.
       Drawing it puts a cliff on the end of every line that is an artefact of
       the release schedule, not of the port. */
    const rows = callsData.series.filter((r) => !partialMonth || r.month < partialMonth);

    if (!rows.length) {
      $("callsChart").replaceChildren();
      $("callsTip").classList.add("hidden");
      $("callsLegend").replaceChildren();
      $("callsSub").textContent =
        "No arrivals recorded at " + callsData.port.name + ".";
      return;
    }

    const months = rows.map((r) => r.month);
    const chosen = callsType === "all"
      ? TYPES
      : TYPES.filter((t) => t.key === callsType);

    const series = chosen.map((t) => ({
      name: t.label,
      color: TYPE_COLORS[t.key],
      values: rows.map((r) => r[t.key] || 0),
    }));

    drawCallsChart(months, series);
    drawCallsLegend(series);

    const total = rows.reduce(
      (sum, r) => sum + chosen.reduce((s, t) => s + (r[t.key] || 0), 0), 0
    );
    const span = formatMonth(months[0]) + "–" + formatMonth(months[months.length - 1]);
    const what = callsType === "all"
      ? "Arrivals per month at " + callsData.port.name + ", split by vessel type"
      : chosen[0].label + " arrivals per month at " + callsData.port.name;

    $("callsSub").textContent =
      what + ", " + span + ". " + formatCount(total) + " calls in total. " +
      "The current month is left off — PortWatch publishes weekly, so it is " +
      "always still filling up. Vessel size is not in the source, so arrivals " +
      "count ships, not capacity.";
  }

  async function loadCalls(portid) {
    const token = ++callsRequest;
    callsPortId = portid;
    $("callsSub").textContent = "Loading…";

    try {
      const data = await getJson("/api/port/calls/" + encodeURIComponent(portid));
      if (token !== callsRequest) return;
      callsData = data;
      if (data.partial_month) partialMonth = data.partial_month;
      renderCalls();
    } catch (err) {
      if (token !== callsRequest) return;
      Log.error("Could not load vessel arrivals for " + portid + ":", err);
      $("callsChart").replaceChildren();
      $("callsLegend").replaceChildren();
      $("callsSub").textContent = "Could not load arrivals for this port.";
    }
  }

  /* ===== Card 2: origin and destination ports ===== */

  function visibleLegs() {
    const side = linksData[linksDirection];
    return side.legs.filter((leg) => {
      if (linksScope === "domestic") return leg.is_domestic;
      if (linksScope === "international") return !leg.is_domestic;
      return true;
    });
  }

  function drawLinksChart(legs) {
    const svg = $("linksChart");
    const tip = $("linksTip");
    svg.replaceChildren();
    tip.classList.add("hidden");

    const data = legs.slice(0, TOP_LEGS);
    if (!data.length) return;

    const max = Math.max(...data.map((d) => d.daily_capacity || 0), 1);
    const plotW = LINKS_BOX.width - LINKS_BOX.left - LINKS_BOX.right;
    const rowHeight = (LINKS_BOX.height - LINKS_BOX.top - LINKS_BOX.bottom) / data.length;
    /* Bars are thin, with a clear band of surface between them — two adjacent
       fills must never read as one block. */
    const barHeight = Math.max(6, rowHeight * 0.66);

    data.forEach((leg, i) => {
      const y = LINKS_BOX.top + i * rowHeight;
      const barY = y + (rowHeight - barHeight) / 2;
      const width = Math.max(1, ((leg.daily_capacity || 0) / max) * plotW);
      const color = leg.is_domestic ? SCOPE_COLORS.domestic : SCOPE_COLORS.international;

      const row = el("g", { class: "leg-row" });

      row.appendChild(el("rect", {
        x: 0, y: y, width: LINKS_BOX.width, height: rowHeight, class: "bar-hit",
      }));

      row.appendChild(el("text", {
        x: LINKS_BOX.left - 10, y: barY + barHeight / 2 + 4,
        "text-anchor": "end", class: "bar-label",
      }, clip(leg.name, 30)));

      row.appendChild(el("rect", {
        x: LINKS_BOX.left, y: barY, width: width, height: barHeight,
        rx: 4, fill: color, class: "leg-bar",
      }));

      const value = el("text", {
        x: LINKS_BOX.left + width + 8, y: barY + barHeight / 2 + 4, class: "bar-value",
      }, formatCapacity(leg.daily_capacity));
      value.appendChild(el("tspan", { dx: "5", class: "bar-year" }, "DWT/day"));
      row.appendChild(value);

      row.addEventListener("pointerenter", () =>
        showLegTip(svg, tip, leg, LINKS_BOX.left + width, barY + barHeight / 2));
      row.addEventListener("pointerleave", () => tip.classList.add("hidden"));

      svg.appendChild(row);
    });
  }

  function showLegTip(svg, tip, leg, userX, userY) {
    const frag = document.createDocumentFragment();
    frag.appendChild(h("div", { class: "chart-tip-head" }, leg.name + ", " + leg.country));

    const rows = [
      ["Capacity", formatCapacity(leg.daily_capacity) + " DWT/day"],
      ["Transit", leg.transit_days === null || leg.transit_days === undefined
        ? "—" : leg.transit_days.toFixed(1) + " days"],
      ["Leg", leg.is_domestic ? "Domestic" : "International"],
    ];
    if (leg.continent) rows.push(["Region", leg.continent]);

    rows.forEach(([label, text]) => {
      const row = h("div", { class: "chart-tip-row" });
      row.append(h("span", {}, label), h("b", {}, text));
      frag.appendChild(row);
    });

    tip.replaceChildren(frag);
    tip.classList.remove("hidden");

    /* Anchored to the end of the bar and flipped at the halfway mark, so it
       never lands on the bar it is describing or on the name beside it. The
       80px clears the DWT/day figure sitting just past the bar. */
    const rect = svg.getBoundingClientRect();
    const px = (userX / LINKS_BOX.width) * rect.width;
    tip.style.left = px + "px";
    tip.style.top = ((userY / LINKS_BOX.height) * rect.height) + "px";
    tip.style.transform = px > rect.width / 2
      ? "translate(calc(-100% - 12px), -50%)"
      : "translate(80px, -50%)";
  }

  function drawLinksLegend(legs) {
    const list = $("linksLegend");
    list.replaceChildren();

    const shown = legs.slice(0, TOP_LEGS);
    const kinds = [];
    if (shown.some((leg) => !leg.is_domestic)) {
      kinds.push(["International", SCOPE_COLORS.international]);
    }
    if (shown.some((leg) => leg.is_domestic)) {
      kinds.push(["Domestic", SCOPE_COLORS.domestic]);
    }
    if (kinds.length < 2) return;

    kinds.forEach(([label, color]) => {
      const item = h("li");
      const swatch = h("i");
      swatch.style.background = color;
      item.append(swatch, h("span", {}, label));
      list.appendChild(item);
    });
  }

  function renderLinks() {
    if (!linksData) return;

    const legs = visibleLegs();
    const side = linksData[linksDirection];
    const noun = linksDirection === "outbound" ? "destination" : "origin";
    const verb = linksDirection === "outbound" ? "sailing from" : "arriving at";

    if (!legs.length) {
      $("linksChart").replaceChildren();
      $("linksTip").classList.add("hidden");
      $("linksLegend").replaceChildren();
      $("linksSub").textContent =
        "No " + (linksScope === "all" ? "" : linksScope + " ") + noun +
        " ports recorded for " + linksData.port.name + ".";
      return;
    }

    drawLinksChart(legs);
    drawLinksLegend(legs);

    /* The API caps each scope separately, so say what the cap is against — a
       "top 12 of 60" that is really a top 12 of 812 would misdescribe the port. */
    const totals = side.totals;
    const available = linksScope === "domestic" ? totals.domestic.legs
      : linksScope === "international" ? totals.international.legs
      : totals.domestic.legs + totals.international.legs;

    const scopeWord = linksScope === "all" ? "" :
      linksScope === "domestic" ? "domestic " : "international ";

    $("linksSub").textContent =
      "Top " + Math.min(TOP_LEGS, legs.length) + " of " + available + " " +
      scopeWord + noun + " ports for " + linksData.port.name + ", by the cargo " +
      "capacity observed " + verb + " each one. Domestic legs stay inside " +
      linksData.port.country + "; international legs cross a border. " +
      "PortWatch publishes no transhipment split, so this is not one — a leg " +
      "here is an observed sailing, whatever the cargo was doing.";
  }

  async function loadLinks(portid) {
    const token = ++linksRequest;
    linksPortId = portid;
    $("linksSub").textContent = "Loading…";

    try {
      const data = await getJson("/api/port/connections/" + encodeURIComponent(portid));
      if (token !== linksRequest) return;
      linksData = data;
      renderLinks();
    } catch (err) {
      if (token !== linksRequest) return;
      Log.error("Could not load port connections for " + portid + ":", err);
      $("linksChart").replaceChildren();
      $("linksLegend").replaceChildren();
      $("linksSub").textContent = "Could not load this port's network.";
    }
  }

  /* ===== Pickers ===== */

  function fillPortList() {
    const list = $("portList");
    list.replaceChildren();
    allPorts.forEach((port) => {
      const label = portLabel(port);
      portByLabel.set(label, port.portid);
      list.appendChild(new Option(label, label));
    });
  }

  /* A datalist hands back whatever is in the box, which is only a port once it
     matches one exactly. Anything else is left alone — mid-typing is not an
     error worth reporting. */
  function bindPicker(inputId, current, onPick) {
    const input = $(inputId);
    input.addEventListener("change", () => {
      const portid = portByLabel.get(input.value.trim());
      if (!portid || portid === current()) return;
      onPick(portid);
    });
  }

  function bindSegmented(groupId, read, write) {
    $(groupId).querySelectorAll(".seg").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset.value;
        if (read() === value) return;
        write(value);
        $(groupId).querySelectorAll(".seg").forEach((other) => {
          other.setAttribute("aria-pressed", String(other === button));
        });
      });
    });
  }

  async function load() {
    bindPicker("callsPort", () => callsPortId, loadCalls);
    bindPicker("linksPort", () => linksPortId, loadLinks);

    bindSegmented("callsType", () => callsType, (value) => {
      callsType = value;
      renderCalls();
    });
    bindSegmented("linksDirection", () => linksDirection, (value) => {
      linksDirection = value;
      renderLinks();
    });
    bindSegmented("linksScope", () => linksScope, (value) => {
      linksScope = value;
      renderLinks();
    });

    try {
      const data = await getJson("/api/port/calls/ports");
      allPorts = data.ports || [];
      partialMonth = data.partial_month;
    } catch (err) {
      Log.error("Could not load the port list:", err);
      $("callsSub").textContent = "Could not load the port list.";
      $("linksSub").textContent = "Could not load the port list.";
      return;
    }

    if (!allPorts.length) {
      $("callsSub").textContent = "No vessel arrival data available.";
      $("linksSub").textContent = "No vessel arrival data available.";
      return;
    }

    fillPortList();

    /* Opens on the busiest port, the same way the leaderboard opens on the
       largest countries — something to read before anything is chosen. */
    const first = allPorts[0];
    $("callsPort").value = portLabel(first);
    $("linksPort").value = portLabel(first);
    loadCalls(first.portid);
    loadLinks(first.portid);
  }

  return { load: load };
})();
