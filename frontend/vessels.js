/* Vessel arrivals and port-to-port legs — reads the read-only /api/port
 * endpoints backed by IMF PortWatch.
 *
 * Both cards open on the whole world and stay there unless a port is picked:
 * the dashboard's story is global, and a card that silently opened on whichever
 * port happened to rank first read as "the data only covers Singapore". The
 * per-port endpoints are still here, behind the picker, as a drill-down.
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
  const LINKS_BOX = {
    width: 720, height: 340, left: 210, right: 104, top: 8, bottom: 24,
    /* Wider gutter for the worldwide view, whose labels name both ends. */
    routeLeft: 268,
  };

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

  /* The picker entry, and the sentinel, for the worldwide view. Both cards
     start here and return here when their box is cleared. */
  const GLOBAL_LABEL = "All ports \u2014 worldwide";
  const GLOBAL = null;

  /* Every port with arrival data, busiest first. Shared by both pickers. */
  let allPorts = [];
  /* How many ports the worldwide arrivals series is summed over, from the API. */
  let globalPortCount = 0;
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

  /* "at Singapore" and "across all 2,065 ports worldwide" are not the same
     shape of phrase. Built in one place, and naming the port count, because a
     world total that does not say what it is a total of invites the reader to
     guess at its coverage. */
  function scopePhrase(portid, name) {
    if (portid !== GLOBAL) return "at " + name;
    const count = globalPortCount ? globalPortCount.toLocaleString() + " " : "";
    return "across all " + count + "ports worldwide";
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
        "No arrivals recorded " + scopePhrase(callsPortId, callsScopeName()) + ".";
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
    const where = scopePhrase(callsPortId, callsScopeName());
    const what = callsType === "all"
      ? "Arrivals per month " + where + ", split by vessel type"
      : chosen[0].label + " arrivals per month " + where;

    /* A world line can move because more ships sailed or because more ports
       started reporting, and those are not the same story. Coverage is flat
       today, so the caveat only appears if that stops being true. */
    const counts = rows.map((r) => r.ports_reporting).filter((n) => n);
    const coverage = counts.length && Math.min(...counts) !== Math.max(...counts)
      ? " Reporting coverage varies across this period, so part of the movement " +
        "reflects coverage rather than traffic."
      : "";

    const hint = callsPortId === GLOBAL
      ? " Select a port for its own arrivals."
      : " Clear the box to return to the worldwide view.";

    $("callsSub").textContent =
      what + ", " + span + ". " + formatCount(total) + " arrivals in total." +
      coverage + hint;
  }

  /* The worldwide response has no single port behind it, so it carries a
     `scope` where the per-port one carries a `port`. */
  function callsScopeName() {
    return callsData && callsData.port ? callsData.port.name : "";
  }

  async function loadCalls(portid) {
    const token = ++callsRequest;
    callsPortId = portid;
    $("callsSub").textContent = "Loading…";

    const path = portid === GLOBAL
      ? "/api/port/calls/global"
      : "/api/port/calls/" + encodeURIComponent(portid);

    try {
      const data = await getJson(path);
      if (token !== callsRequest) return;
      callsData = data;
      if (data.partial_month) partialMonth = data.partial_month;
      if (data.scope && data.scope.ports) globalPortCount = data.scope.ports;
      renderCalls();
    } catch (err) {
      if (token !== callsRequest) return;
      Log.error("Could not load vessel arrivals (" + (portid || "worldwide") + "):", err);
      $("callsChart").replaceChildren();
      $("callsLegend").replaceChildren();
      $("callsSub").textContent = portid === GLOBAL
        ? "Could not load worldwide arrivals."
        : "Could not load arrivals for this port.";
    }
  }

  /* ===== Card 2: origin and destination ports ===== */

  /* One row shape for both scopes. A worldwide row is a route with two ends;
     a per-port row is the single counterpart port, the anchor being the port
     already named in the subtitle. The chart draws a labelled bar either way,
     so the difference is flattened here instead of inside the drawing. */
  function normalizeLegs() {
    if (linksPortId === GLOBAL) {
      return (linksData.routes || []).map((route) => ({
        name: clip(route.from.name, 16) + " → " + clip(route.to.name, 16),
        head: route.from.name + " → " + route.to.name,
        country: route.from.country + " → " + route.to.country,
        ends: [
          ["From", route.from.name + ", " + route.from.country],
          ["To", route.to.name + ", " + route.to.country],
        ],
        transit_days: route.transit_days,
        daily_capacity: route.daily_capacity,
        relative_capacity: route.relative_capacity,
        is_domestic: route.is_domestic,
        continent: route.to.continent,
      }));
    }

    const side = linksData[linksDirection];
    return (side.legs || []).map((leg) => Object.assign({}, leg, {
      head: leg.name + ", " + leg.country,
      ends: [],
    }));
  }

  function visibleLegs() {
    return normalizeLegs().filter((leg) => {
      if (linksScope === "domestic") return leg.is_domestic;
      if (linksScope === "international") return !leg.is_domestic;
      return true;
    });
  }

  /* The cap the API applied, and what it is a cap on: per direction for one
     port, over every pair for the world. */
  function linksTotals() {
    return linksPortId === GLOBAL ? linksData.totals : linksData[linksDirection].totals;
  }

  function drawLinksChart(legs) {
    const svg = $("linksChart");
    const tip = $("linksTip");
    svg.replaceChildren();
    tip.classList.add("hidden");

    const data = legs.slice(0, TOP_LEGS);
    if (!data.length) return;

    const max = Math.max(...data.map((d) => d.daily_capacity || 0), 1);
    /* A route label carries two port names and an arrow, so it needs more
       gutter than a single port name does. The bars give up the difference. */
    const left = linksPortId === GLOBAL ? LINKS_BOX.routeLeft : LINKS_BOX.left;
    const plotW = LINKS_BOX.width - left - LINKS_BOX.right;
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
        x: left - 10, y: barY + barHeight / 2 + 4,
        "text-anchor": "end", class: "bar-label",
      }, clip(leg.name, 36)));

      row.appendChild(el("rect", {
        x: left, y: barY, width: width, height: barHeight,
        rx: 4, fill: color, class: "leg-bar",
      }));

      const value = el("text", {
        x: left + width + 8, y: barY + barHeight / 2 + 4, class: "bar-value",
      }, formatCapacity(leg.daily_capacity));
      value.appendChild(el("tspan", { dx: "5", class: "bar-year" }, "DWT/day"));
      row.appendChild(value);

      row.addEventListener("pointerenter", () =>
        showLegTip(svg, tip, leg, left + width, barY + barHeight / 2));
      row.addEventListener("pointerleave", () => tip.classList.add("hidden"));

      svg.appendChild(row);
    });
  }

  function showLegTip(svg, tip, leg, userX, userY) {
    const frag = document.createDocumentFragment();
    frag.appendChild(h("div", { class: "chart-tip-head" }, leg.head));

    /* The bar label is clipped to fit the gutter; the tooltip is where both
       ends get their full name and country. */
    const rows = leg.ends.slice();
    rows.push(
      ["Capacity", formatCapacity(leg.daily_capacity) + " DWT/day"],
      ["Transit", leg.transit_days === null || leg.transit_days === undefined
        ? "—" : leg.transit_days.toFixed(1) + " days"],
      ["Leg", leg.is_domestic ? "Domestic" : "International"]
    );
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

    const global = linksPortId === GLOBAL;

    /* A route already has both ends on it, so outbound/inbound has nothing to
       say about the worldwide view — the control is put away rather than left
       sitting there doing nothing. */
    $("linksDirection").classList.toggle("hidden", global);

    /* The heading follows the scope: the worldwide view ranks routes, the
       drill-down describes one port's own origins and destinations. */
    $("linksTitle").textContent = global
      ? "Busiest Trade Routes"
      : "Port Origins and Destinations";

    const legs = visibleLegs();
    const noun = global
      ? "route"
      : linksDirection === "outbound" ? "destination port" : "origin port";
    const verb = global
      ? "sailing each one"
      : linksDirection === "outbound" ? "sailing from each one" : "arriving at each one";

    if (!legs.length) {
      $("linksChart").replaceChildren();
      $("linksTip").classList.add("hidden");
      $("linksLegend").replaceChildren();
      $("linksSub").textContent = global
        ? "No " + (linksScope === "all" ? "" : linksScope + " ") + "routes recorded."
        : "No " + (linksScope === "all" ? "" : linksScope + " ") + noun +
          "s recorded for " + linksData.port.name + ".";
      return;
    }

    drawLinksChart(legs);
    drawLinksLegend(legs);

    /* The API caps each scope separately, so say what the cap is against — a
       "top 12 of 60" that is really a top 12 of 812 would misdescribe the
       port, and a top 12 of 226,904 is the whole point of the world view. */
    const totals = linksTotals();
    const available = linksScope === "domestic" ? totals.domestic.legs
      : linksScope === "international" ? totals.international.legs
      : totals.domestic.legs + totals.international.legs;

    const scopeWord = linksScope === "all" ? "" :
      linksScope === "domestic" ? "domestic " : "international ";

    const where = global
      ? " worldwide"
      : " for " + linksData.port.name;
    const inside = global
      ? "Domestic routes stay within one country; international routes cross a border."
      : "Domestic legs stay within " + linksData.port.country +
        "; international legs cross a border.";
    const hint = global
      ? " Select a port for its own network."
      : " Clear the box to return to the worldwide view.";

    $("linksSub").textContent =
      "Top " + Math.min(TOP_LEGS, legs.length) + " of " + available.toLocaleString() +
      " " + scopeWord + noun + "s" + where + ", ranked by the cargo capacity observed " +
      verb + ". " + inside + hint;
  }

  async function loadLinks(portid) {
    const token = ++linksRequest;
    linksPortId = portid;
    $("linksSub").textContent = "Loading…";

    const path = portid === GLOBAL
      ? "/api/port/connections/global"
      : "/api/port/connections/" + encodeURIComponent(portid);

    try {
      const data = await getJson(path);
      if (token !== linksRequest) return;
      linksData = data;
      renderLinks();
    } catch (err) {
      if (token !== linksRequest) return;
      Log.error("Could not load port connections (" + (portid || "worldwide") + "):", err);
      $("linksChart").replaceChildren();
      $("linksLegend").replaceChildren();
      $("linksSub").textContent = portid === GLOBAL
        ? "Could not load the worldwide route list."
        : "Could not load this port's network.";
    }
  }

  /* ===== Pickers ===== */

  function fillPortList() {
    const list = $("portList");
    list.replaceChildren();
    /* First entry is the way back out of a drill-down. */
    list.appendChild(new Option(GLOBAL_LABEL, GLOBAL_LABEL));
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
      const text = input.value.trim();

      /* An empty box, or the worldwide entry, asks for the world. That is the
         card's home view, not a filter left unset, so it loads rather than
         leaving the last port on screen with an empty picker above it. */
      if (!text || text === GLOBAL_LABEL) {
        if (current() !== GLOBAL) onPick(GLOBAL);
        return;
      }

      const portid = portByLabel.get(text);
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

    /* Both cards open on the world, the same way the throughput charts open on
       every country. The picker is a drill-down, so it is not waited on: the
       world view is fetched first and the port list fills in behind it. */
    loadCalls(GLOBAL);
    loadLinks(GLOBAL);

    try {
      const data = await getJson("/api/port/calls/ports");
      allPorts = data.ports || [];
      if (data.partial_month) partialMonth = data.partial_month;
    } catch (err) {
      /* Only the drill-down is lost here — both cards are already drawing. */
      Log.error("Could not load the port list:", err);
      allPorts = [];
    }

    if (!allPorts.length) {
      $("callsPort").disabled = true;
      $("linksPort").disabled = true;
      return;
    }

    fillPortList();
  }

  return { load: load };
})();
