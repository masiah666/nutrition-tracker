/* NutriTrack auth — CLIENT-SIDE ONLY.
 *
 * This is a demo authentication layer: accounts and password hashes live in
 * this browser's localStorage. It is NOT a substitute for server-side auth.
 * The module is deliberately self-contained so it can later be swapped for a
 * real backend: replace signUp()/logIn() with fetch() calls and keep the same
 * Auth.onLogin(username) contract that app.js depends on.
 */
window.Auth = (function () {
  "use strict";

  const USERS_KEY = "nutritrack.users";       // { username: { salt, hash, createdAt } }
  const SESSION_KEY = "nutritrack.session";    // username currently logged in
  const PBKDF2_ITERS = 100000;

  let onLoginCallback = null;

  // ---- crypto helpers -------------------------------------------------------
  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function hashPassword(password, saltHex) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    );
    const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
      keyMaterial, 256
    );
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ---- store ----------------------------------------------------------------
  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveUsers(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

  // ---- public API -----------------------------------------------------------
  async function signUp(username, password) {
    username = username.trim();
    if (username.length < 3) throw new Error("Username must be at least 3 characters.");
    if (password.length < 6) throw new Error("Password must be at least 6 characters.");
    const users = loadUsers();
    if (users[username.toLowerCase()]) throw new Error("That username is taken.");

    const salt = randomSalt();
    const hash = await hashPassword(password, salt);
    users[username.toLowerCase()] = { salt, hash, displayName: username, createdAt: Date.now() };
    saveUsers(users);
    startSession(username);
  }

  async function logIn(username, password) {
    const users = loadUsers();
    const rec = users[username.trim().toLowerCase()];
    if (!rec) throw new Error("No account with that username.");
    const hash = await hashPassword(password, rec.salt);
    if (hash !== rec.hash) throw new Error("Incorrect password.");
    startSession(rec.displayName || username);
  }

  function startSession(username) {
    localStorage.setItem(SESSION_KEY, username);
    if (onLoginCallback) onLoginCallback(username);
  }

  function currentUser() { return localStorage.getItem(SESSION_KEY); }

  function logOut() {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  }

  function onLogin(cb) { onLoginCallback = cb; }

  return { signUp, logIn, logOut, currentUser, onLogin };
})();

// ---- Auth screen wiring -----------------------------------------------------
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // Tab switching
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isLogin = tab.dataset.tab === "login";
      $("loginForm").classList.toggle("hidden", !isLogin);
      $("signupForm").classList.toggle("hidden", isLogin);
      $("loginError").textContent = "";
      $("signupError").textContent = "";
    });
  });

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginError").textContent = "";
    try {
      await Auth.logIn($("loginUser").value, $("loginPass").value);
    } catch (err) {
      $("loginError").textContent = err.message;
    }
  });

  $("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("signupError").textContent = "";
    if ($("signupPass").value !== $("signupPass2").value) {
      $("signupError").textContent = "Passwords do not match.";
      return;
    }
    try {
      await Auth.signUp($("signupUser").value, $("signupPass").value);
    } catch (err) {
      $("signupError").textContent = err.message;
    }
  });
})();
