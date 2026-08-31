/* Port traffic dashboard — reads the read-only /api/port endpoints. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const SVG_NS = "http://www.w3.org/2000/svg";
  const WIDTH = 600;
  const HEIGHT = 320;
  const PAD_LEFT = 110;
  const PAD_RIGHT = 60;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 20;
  const TOP_N = 10;

  function el(name, attrs, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatTeu(value) {
    if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (value >= 1e3) return Math.round(value / 1e3) + "k";
    return String(value);
  }

  function drawTopCountries(countries) {
    const svg = $("topCountriesChart");
    svg.innerHTML = "";

    const data = countries.slice(0, TOP_N);
    const max = Math.max(...data.map((d) => d.teu_2019));

    const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
    const rowHeight = (HEIGHT - PAD_TOP - PAD_BOTTOM) / data.length;
    const barHeight = rowHeight * 0.7;

    data.forEach((d, i) => {
      const y = PAD_TOP + i * rowHeight;
      const barWidth = (d.teu_2019 / max) * plotWidth;

      svg.appendChild(el("text", {
        x: PAD_LEFT - 8,
        y: y + barHeight / 2 + 4,
        "text-anchor": "end",
        class: "bar-label",
      }, d.name));

      svg.appendChild(el("rect", {
        x: PAD_LEFT,
        y: y,
        width: barWidth,
        height: barHeight,
        class: "bar",
      }));

      svg.appendChild(el("text", {
        x: PAD_LEFT + barWidth + 6,
        y: y + barHeight / 2 + 4,
        class: "bar-value",
      }, formatTeu(d.teu_2019)));
    });
  }

  async function load() {
    try {
      const response = await fetch("/api/port/countries");
      if (!response.ok) throw new Error("Request failed: " + response.status);
      const countries = await response.json();

      drawTopCountries(countries);
      $("chartSub").textContent =
        "Top " + TOP_N + " of " + countries.length + " reporting countries, TEU";
    } catch (err) {
      Log.error("Could not load port data:", err);
      $("chartSub").textContent = "Could not load data.";
    }
  }

  function showApp(email) {
    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userName").textContent = email;
    $("userAvatar").textContent = email.charAt(0).toUpperCase();
    load();
  }

  $("logoutBtn").addEventListener("click", () => Auth.logOut());
  Auth.onLogin(showApp);

  const existing = Auth.currentUser();
  if (existing) showApp(existing);
})();
