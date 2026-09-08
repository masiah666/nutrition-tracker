/* Section rail — which cards are on screen.
 *
 * A section is a group of cards, not a separate page: the dashboard's panels
 * carry a `data-section` and are shown or hidden here, while the register is a
 * section like any other. The rail is therefore the single place a view is
 * chosen from, and the page head reads its title and lede off the chosen item
 * so a section is named once, in index.html.
 *
 * Anything that needs to know a section was shown listens for `nav:section`;
 * register.js uses it to load itself the first time it is opened. */
window.Nav = (function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* Which view each section lives in. Everything not named here is a group of
     dashboard panels. */
  const VIEWS = { register: "registerView" };
  const DASHBOARD = "dashboardView";

  let current = null;

  function items() {
    return $("sideNav").querySelectorAll(".nav-item");
  }

  function itemFor(section) {
    return $("sideNav").querySelector('[data-section="' + section + '"]');
  }

  function show(section, options) {
    const item = itemFor(section);
    if (!item || section === current) {
      if (item && options && options.focus) item.focus();
      return;
    }
    current = section;

    items().forEach((button) => {
      if (button === item) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });

    const view = VIEWS[section] || DASHBOARD;
    $(DASHBOARD).classList.toggle("hidden", view !== DASHBOARD);
    $("registerView").classList.toggle("hidden", view !== "registerView");

    /* Only the dashboard's panels are filtered; the register view is one card. */
    if (view === DASHBOARD) {
      $(DASHBOARD).querySelectorAll(".panel[data-section]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.section !== section);
      });
    }

    $("viewTitle").textContent = item.querySelector(".nav-name").textContent;
    $("viewLede").textContent = item.dataset.lede || "";

    if (options && options.focus) item.focus();
    /* Switching sections moves the reader to a different card; the scroll
       position of the one they left would land them mid-chart. */
    window.scrollTo({ top: 0, behavior: "auto" });

    document.dispatchEvent(new CustomEvent("nav:section", { detail: { section: section } }));
  }

  items().forEach((button) => {
    button.addEventListener("click", () => show(button.dataset.section));
  });

  /* The rail's own markup says which section opens first. */
  const initial = $("sideNav").querySelector('[aria-current="page"]') || items()[0];
  if (initial) {
    initial.removeAttribute("aria-current");
    show(initial.dataset.section);
  }

  return { show: show };
})();
