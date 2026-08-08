/* NutriTrack — calorie & weight tracker.
 * Data is per-user and lives in localStorage under nutritrack.data.<username>.
 * The app only boots once Auth confirms a logged-in user. */
(function () {
  "use strict";

  const DEFAULT_GOAL = 2000;

  let data = null;          // current user's data object
  let user = null;          // current username
  let storageKey = null;    // per-user storage key
  let currentDate = toISODate(new Date());
  let analyticsRange = 14;  // days

  // ---- Storage (per user) ---------------------------------------------------
  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const p = JSON.parse(raw);
        return {
          goal: typeof p.goal === "number" ? p.goal : DEFAULT_GOAL,
          targetWeight: typeof p.targetWeight === "number" ? p.targetWeight : null,
          heightCm: typeof p.heightCm === "number" ? p.heightCm : null,
          days: p.days || {},
          weights: Array.isArray(p.weights) ? p.weights : [],
        };
      }
    } catch (e) {
      Log.warn("Could not read saved data:", e);
    }
    return { goal: DEFAULT_GOAL, targetWeight: null, heightCm: null, days: {}, weights: [] };
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch (e) {
      // Quota exceeded or storage unavailable (e.g. private mode). Keep the
      // in-memory data and UI responsive; the write just didn't persist.
      Log.error("Could not save data:", e);
      showToast("Couldn't save your changes — your browser storage may be full.",
        { icon: "⚠️", type: "error" });
    }
  }

  // ---- Helpers --------------------------------------------------------------
  function toISODate(d) {
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }
  function shiftDate(iso, days) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }
  function dayData(iso) {
    if (!data.days[iso]) data.days[iso] = { foods: [] };
    return data.days[iso];
  }
  function consumedOn(iso) {
    const d = data.days[iso];
    return d ? d.foods.reduce((s, f) => s + f.cals, 0) : 0;
  }
  function uid() {
    return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function toKg(w) { return w.unit === "lb" ? w.value * 0.453592 : w.value; }
  function $(id) { return document.getElementById(id); }

  // BMI = weight(kg) / height(m)^2. Returns null if height not set.
  function bmiFor(weight) {
    if (data.heightCm == null || data.heightCm <= 0 || !weight) return null;
    const m = data.heightCm / 100;
    return +(toKg(weight) / (m * m)).toFixed(1);
  }
  function bmiCategory(bmi) {
    if (bmi == null) return "BMI";
    if (bmi < 18.5) return "Underweight";
    if (bmi < 25) return "Normal";
    if (bmi < 30) return "Overweight";
    return "Obese";
  }
  // CSS class for the BMI badge/zone (matches .bmi-cat-badge.* in styles.css).
  function bmiClass(bmi) {
    if (bmi == null) return "";
    if (bmi < 18.5) return "under";
    if (bmi < 25) return "normal";
    if (bmi < 30) return "over";
    return "obese";
  }

  // ---- Rendering ------------------------------------------------------------
  function renderAll() {
    $("datePicker").value = currentDate;
    renderFood();
    renderSummary();
    renderWeight();
    renderAnalytics();
    $("goalInput").value = data.goal;
    $("heightInput").value = data.heightCm != null ? data.heightCm : "";
    $("targetWeightInput").value = data.targetWeight != null ? data.targetWeight : "";
    $("goalValue").textContent = data.goal;
  }

  function renderFood() {
    const list = $("foodList");
    const foods = dayData(currentDate).foods;
    list.innerHTML = "";
    $("foodEmpty").style.display = foods.length ? "none" : "block";
    foods.forEach((f) => {
      const li = document.createElement("li");
      li.className = "entry";
      li.innerHTML =
        '<span class="entry-name"></span><span class="entry-cals"></span>' +
        '<button class="entry-del" aria-label="Delete">×</button>';
      li.querySelector(".entry-name").textContent = f.name;
      li.querySelector(".entry-cals").textContent = f.cals + " kcal";
      li.querySelector(".entry-del").addEventListener("click", () => {
        dayData(currentDate).foods = foods.filter((x) => x.id !== f.id);
        save(); renderFood(); renderSummary(); renderAnalytics();
      });
      list.appendChild(li);
    });
  }

  function renderSummary() {
    const consumed = consumedOn(currentDate);
    const goal = data.goal;
    const remaining = goal - consumed;
    $("consumed").textContent = consumed;
    $("remaining").textContent = remaining;
    const pct = goal > 0 ? Math.round((consumed / goal) * 100) : 0;
    const bar = $("progressBar");
    bar.style.width = Math.min(pct, 100) + "%";
    bar.classList.toggle("over", consumed > goal);
    $("progressText").textContent =
      pct + "% of goal" + (remaining < 0 ? " · " + Math.abs(remaining) + " kcal over" : "");
  }

  function sortedWeights() {
    return data.weights.slice().sort((a, b) => a.date.localeCompare(b.date));
  }

  function renderWeight() {
    const weights = sortedWeights();
    const latestEl = $("latestWeight");
    const changeEl = $("weightChange");
    const bmiEl = $("bmiValue");
    const bmiCatEl = $("bmiCategory");
    const bmiMarker = $("bmiMarker");
    if (!weights.length) {
      latestEl.textContent = "—";
      changeEl.textContent = "—";
      changeEl.className = "stat-num";
      bmiEl.textContent = "—";
      bmiCatEl.textContent = "BMI";
      bmiCatEl.className = "bmi-cat-badge";
      bmiMarker.style.display = "none";
      $("weightEmpty").style.display = "block";
      $("weightChart").innerHTML = "";
      return;
    }
    const latest = weights[weights.length - 1];
    latestEl.textContent = latest.value + " " + latest.unit;
    const diff = +(latest.value - weights[0].value).toFixed(1);
    changeEl.textContent = (diff > 0 ? "+" : "") + diff + " " + latest.unit;
    changeEl.className = "stat-num " + (diff > 0 ? "up" : diff < 0 ? "down" : "");
    const bmi = bmiFor(latest);
    bmiEl.textContent = bmi != null ? bmi : "—";
    bmiCatEl.textContent = bmi != null ? bmiCategory(bmi) : "BMI · set height";
    bmiCatEl.className = "bmi-cat-badge " + bmiClass(bmi);
    if (bmi != null) {
      // Map BMI to a position across the 15–40 visual scale (matches zone widths in CSS).
      const pct = Math.max(0, Math.min(100, ((bmi - 15) / 25) * 100));
      bmiMarker.style.left = pct + "%";
      bmiMarker.style.display = "block";
    } else {
      bmiMarker.style.display = "none";
    }
    $("weightEmpty").style.display = "none";
    drawWeightChart(weights);
  }

  function drawWeightChart(weights) {
    const svg = $("weightChart");
    const W = 400, H = 180, pad = 24;
    const vals = weights.map(toKg);
    const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1;
    const x = (i) => (weights.length === 1 ? W / 2 : pad + (i / (weights.length - 1)) * (W - 2 * pad));
    const y = (v) => H - pad - ((v - min) / range) * (H - 2 * pad);
    const pts = vals.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
    const area = line + " L" + pts[pts.length - 1][0] + " " + (H - pad) + " L" + pts[0][0] + " " + (H - pad) + " Z";
    let s = '<line class="grid" x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '"/>';
    s += '<path class="area" d="' + area + '"/><path class="line" d="' + line + '"/>';
    pts.forEach((p) => { s += '<circle class="dot" cx="' + p[0] + '" cy="' + p[1] + '" r="3.5"/>'; });
    svg.innerHTML = s;
  }

  // ---- Analytics ------------------------------------------------------------
  function rangeDates(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(shiftDate(currentDate, -i));
    return out;
  }

  function renderAnalytics() {
    const dates = rangeDates(analyticsRange);
    const consumedSeries = dates.map(consumedOn);

    // Summary stats
    const loggedDays = dates.filter((d) => consumedOn(d) > 0).length;
    const totalCals = consumedSeries.reduce((a, b) => a + b, 0);
    const avg = loggedDays ? Math.round(totalCals / loggedDays) : 0;
    const overDays = dates.filter((d) => consumedOn(d) > data.goal && consumedOn(d) > 0).length;
    const underDays = dates.filter((d) => { const c = consumedOn(d); return c > 0 && c <= data.goal; }).length;
    const streak = currentStreak();

    const weights = sortedWeights();
    let weightStat = "—";
    if (weights.length >= 2) {
      const diff = +(weights[weights.length - 1].value - weights[0].value).toFixed(1);
      weightStat = (diff > 0 ? "+" : "") + diff + " " + weights[weights.length - 1].unit;
    } else if (weights.length === 1) {
      weightStat = weights[0].value + " " + weights[0].unit;
    }

    const tiles = [
      { label: "Avg / logged day", value: avg, unit: "kcal" },
      { label: "Days logged", value: loggedDays, unit: "of " + analyticsRange },
      { label: "Days over goal", value: overDays, unit: "" },
      { label: "Days under goal", value: underDays, unit: "" },
      { label: "Current streak", value: streak, unit: streak === 1 ? "day" : "days" },
      { label: "Weight change", value: weightStat, unit: "" },
    ];
    $("statGrid").innerHTML = tiles.map((t) =>
      '<div class="stat-tile"><div class="stat-tile-val">' + t.value +
      '<span class="stat-tile-unit">' + (t.unit ? " " + t.unit : "") + '</span></div>' +
      '<div class="stat-tile-lbl">' + t.label + '</div></div>'
    ).join("");

    drawCalorieChart(dates, consumedSeries);
    drawWeightTrend();
  }

  function currentStreak() {
    let streak = 0;
    let cursor = currentDate;
    // Count back from selected date while each day has food logged.
    while (consumedOn(cursor) > 0) {
      streak++;
      cursor = shiftDate(cursor, -1);
    }
    return streak;
  }

  function drawCalorieChart(dates, series) {
    const svg = $("calorieChart");
    const empty = $("calorieEmpty");
    if (series.every((v) => v === 0)) {
      svg.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    const W = 600, H = 220, padL = 38, padR = 12, padT = 14, padB = 28;
    const maxVal = Math.max(data.goal, ...series) * 1.1 || 1;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = dates.length;
    const slot = plotW / n;
    const barW = Math.max(2, Math.min(slot * 0.7, 34));
    const yOf = (v) => padT + plotH - (v / maxVal) * plotH;

    let s = "";
    // y-axis gridlines (0, half, max)
    [0, maxVal / 2, maxVal].forEach((v) => {
      const y = yOf(v);
      s += '<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      s += '<text class="axis" x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    });
    // goal line
    const gy = yOf(data.goal);
    s += '<line class="goal-line" x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '"/>';
    s += '<text class="axis goal-text" x="' + (W - padR) + '" y="' + (gy - 5) + '" text-anchor="end">goal ' + data.goal + '</text>';
    // bars
    series.forEach((v, i) => {
      const cx = padL + slot * i + slot / 2;
      const bx = cx - barW / 2;
      const by = yOf(v);
      const h = padT + plotH - by;
      const over = v > data.goal;
      s += '<rect class="bar' + (over ? " over" : "") + '" x="' + bx + '" y="' + by +
        '" width="' + barW + '" height="' + Math.max(0, h) + '" rx="3"/>';
      // sparse date labels
      if (n <= 14 || i % Math.ceil(n / 10) === 0) {
        s += '<text class="axis" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' +
          dates[i].slice(5) + '</text>';
      }
    });
    svg.innerHTML = s;
  }

  function drawWeightTrend() {
    const svg = $("weightTrendChart");
    const empty = $("weightTrendEmpty");
    const weights = sortedWeights();
    if (weights.length < 2) {
      svg.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    const W = 600, H = 220, padL = 40, padR = 12, padT = 14, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const vals = weights.map(toKg);

    // 7-point trailing moving average
    const ma = vals.map((_, i) => {
      const start = Math.max(0, i - 6);
      const slice = vals.slice(start, i + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });

    const targetKg = data.targetWeight != null
      ? (weights[weights.length - 1].unit === "lb" ? data.targetWeight * 0.453592 : data.targetWeight)
      : null;

    const allVals = targetKg != null ? vals.concat(ma, [targetKg]) : vals.concat(ma);
    const min = Math.min(...allVals), max = Math.max(...allVals), range = max - min || 1;
    const x = (i) => padL + (i / (weights.length - 1)) * plotW;
    const y = (v) => padT + plotH - ((v - min) / range) * plotH;

    const path = (arr) => arr.map((v, i) => (i ? "L" : "M") + x(i) + " " + y(v)).join(" ");

    let s = "";
    [min, (min + max) / 2, max].forEach((v) => {
      const yy = y(v);
      s += '<line class="grid" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>';
      s += '<text class="axis" x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + v.toFixed(1) + '</text>';
    });
    if (targetKg != null) {
      const ty = y(targetKg);
      s += '<line class="goal-line" x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '"/>';
      s += '<text class="axis goal-text" x="' + (W - padR) + '" y="' + (ty - 5) + '" text-anchor="end">target</text>';
    }
    s += '<path class="line" d="' + path(vals) + '"/>';
    s += '<path class="ma-line" d="' + path(ma) + '"/>';
    vals.forEach((v, i) => { s += '<circle class="dot" cx="' + x(i) + '" cy="' + y(v) + '" r="3"/>'; });
    svg.innerHTML = s;
  }

  // ---- Events ---------------------------------------------------------------
  function wireEvents() {
    $("foodForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("foodName").value.trim();
      const cals = Math.round(parseFloat($("foodCals").value));
      if (!name || isNaN(cals)) return;
      dayData(currentDate).foods.push({ id: uid(), name, cals });
      save();
      $("foodName").value = ""; $("foodCals").value = ""; $("foodName").focus();
      renderFood(); renderSummary(); renderAnalytics();
    });

    $("weightForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const value = parseFloat($("weightValue").value);
      const unit = $("weightUnit").value;
      if (isNaN(value)) return;
      data.weights = data.weights.filter((w) => w.date !== currentDate);
      data.weights.push({ date: currentDate, value: +value.toFixed(1), unit });
      save();
      $("weightValue").value = "";
      renderWeight(); renderAnalytics();
    });

    $("settingsForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const goal = Math.round(parseFloat($("goalInput").value));
      if (!isNaN(goal) && goal >= 0) data.goal = goal;
      const h = parseFloat($("heightInput").value);
      data.heightCm = isNaN(h) || h <= 0 ? null : +h.toFixed(1);
      const tw = parseFloat($("targetWeightInput").value);
      data.targetWeight = isNaN(tw) ? null : +tw.toFixed(1);
      save();
      renderAll();
    });

    $("prevDay").addEventListener("click", () => { currentDate = shiftDate(currentDate, -1); renderAll(); });
    $("nextDay").addEventListener("click", () => { currentDate = shiftDate(currentDate, 1); renderAll(); });
    $("todayBtn").addEventListener("click", () => { currentDate = toISODate(new Date()); renderAll(); });
    $("datePicker").addEventListener("change", (e) => {
      if (e.target.value) { currentDate = e.target.value; renderAll(); }
    });

    $("rangeToggle").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        analyticsRange = parseInt(btn.dataset.range, 10);
        $("rangeToggle").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderAnalytics();
      });
    });

    $("exportBtn").addEventListener("click", () => {
      try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "nutritrack-" + user + ".json"; a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        Log.error("Could not export data:", e);
      }
    });

    $("clearBtn").addEventListener("click", () => {
      if (confirm("Delete ALL of " + user + "'s tracked data? This cannot be undone.")) {
        data = { goal: DEFAULT_GOAL, targetWeight: null, heightCm: null, days: {}, weights: [] };
        save();
        currentDate = toISODate(new Date());
        renderAll();
      }
    });

    $("logoutBtn").addEventListener("click", () => Auth.logOut());

    // Tab navigation (Today / Analytics / Settings)
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".tab-panel").forEach((p) =>
          p.classList.toggle("active", p.id === "tab-" + tab)
        );
      });
    });
  }

  // ---- Boot (after login) ---------------------------------------------------
  function boot(username) {
    user = username;
    storageKey = "nutritrack.data." + username.toLowerCase();
    const returning = localStorage.getItem(storageKey) != null;
    data = load();
    currentDate = toISODate(new Date());

    $("authScreen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("userName").textContent = username;
    $("userAvatar").textContent = username.charAt(0).toUpperCase();

    wireEvents();
    renderAll();
    showWelcome(username, returning);
  }

  // Reusable notification toast. Reuses the single #toast element for
  // both the login greeting and error notices (e.g. a failed save).
  // opts: { icon, type: "info"|"error", timeout (ms; 0 = stay until dismissed) }
  let toastTimer = null;
  function showToast(message, opts) {
    opts = opts || {};
    const toast = $("toast");
    $("toastIco").textContent = opts.icon || "👋";
    $("toastText").textContent = message;
    toast.classList.toggle("error", opts.type === "error");
    toast.classList.remove("hidden");
    // Next frame so the entrance transition runs.
    requestAnimationFrame(() => toast.classList.add("show"));
    $("toastClose").onclick = dismissToast;
    clearTimeout(toastTimer);
    if (opts.timeout !== 0) {
      toastTimer = setTimeout(dismissToast, opts.timeout || 5000);
    }
  }

  function dismissToast() {
    const toast = $("toast");
    clearTimeout(toastTimer);
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 250);
  }

  // Greet the user with a toast on login; auto-dismisses after a few seconds.
  function showWelcome(username, returning) {
    showToast(
      returning
        ? "Welcome back, " + username + "!"
        : "Welcome to NutriTrack, " + username + "! Log your first meal to get started.",
      { icon: "👋", type: "info" }
    );
  }

  // Wire the auth → app handoff.
  Auth.onLogin(boot);
  const existing = Auth.currentUser();
  if (existing) boot(existing);
})();
