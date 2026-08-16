/* NutriTrack auth — talks to the FastAPI backend.
 *
 * Accounts live in PostgreSQL behind /api; passwords are hashed server-side
 * with bcrypt and never touch this file. The session (which account is signed
 * in) is still kept in localStorage, so a reload keeps you logged in.
 * app.js depends on the Auth.onLogin(identifier) contract — the identifier is
 * now the account's email address.
 */
window.Auth = (function () {
  "use strict";

  const SESSION_KEY = "nutritrack.session";    // email currently logged in
  const REGISTER_URL = "/api/register";
  const LOGIN_URL = "/api/login";

  // Matches the backend's Credentials model (password: Field(min_length=8)).
  const MIN_PASSWORD_LENGTH = 8;

  let onLoginCallback = null;

  // ---- API ------------------------------------------------------------------
  /* Turn a non-2xx response into an Error with a message worth showing.
   * FastAPI puts a string in `detail` for our own HTTPExceptions (409, 401)
   * and a list of field errors there for request-validation failures (422). */
  async function errorFromResponse(response, fallback) {
    let detail;
    try {
      detail = (await response.json()).detail;
    } catch (e) {
      Log.error("Could not parse error response:", e);
    }

    if (typeof detail === "string") return new Error(detail);
    if (Array.isArray(detail) && detail.length) {
      return new Error(detail.map((d) => d.msg).filter(Boolean).join(" "));
    }
    return new Error(fallback);
  }

  async function post(url, email, password, fallbackError) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (e) {
      Log.error("Request to " + url + " failed:", e);
      throw new Error("Could not reach the server. Check your connection and try again.");
    }

    if (!response.ok) throw await errorFromResponse(response, fallbackError);
    return response.json();
  }

  // ---- public API -----------------------------------------------------------
  async function signUp(email, password) {
    email = email.trim();
    if (!email) throw new Error("Enter your email address.");
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error("Password must be at least " + MIN_PASSWORD_LENGTH + " characters.");
    }

    // 201 -> { id, email, created_at }; 409 -> email already registered.
    const account = await post(
      REGISTER_URL, email, password, "Could not create your account. Please try again."
    );
    startSession(account.email);
  }

  async function logIn(email, password) {
    email = email.trim();
    if (!email) throw new Error("Enter your email address.");
    if (!password) throw new Error("Enter your password.");

    // 200 -> { id, email }; 401 -> wrong email or password.
    const account = await post(
      LOGIN_URL, email, password, "Could not log you in. Please try again."
    );
    startSession(account.email);
  }

  // The server normalises the email (trimmed, lowercased), so session state is
  // keyed off what it returns rather than what was typed.
  function startSession(email) {
    localStorage.setItem(SESSION_KEY, email);
    if (onLoginCallback) onLoginCallback(email);
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

  function showError(id, message) {
    $(id).textContent = message;
  }

  // Tab switching
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const isLogin = tab.dataset.tab === "login";
      $("loginForm").classList.toggle("hidden", !isLogin);
      $("signupForm").classList.toggle("hidden", isLogin);
      showError("loginError", "");
      showError("signupError", "");
    });
  });

  // Disable the submit button while the request is in flight so a slow
  // response can't be double-submitted.
  async function submitting(form, run) {
    const button = form.querySelector("button[type=submit]");
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Please wait…";
    try {
      await run();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("loginError", "");
    await submitting(e.target, async () => {
      try {
        await Auth.logIn($("loginEmail").value, $("loginPass").value);
      } catch (err) {
        showError("loginError", err.message);
      }
    });
  });

  $("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("signupError", "");
    if ($("signupPass").value !== $("signupPass2").value) {
      showError("signupError", "Passwords do not match.");
      return;
    }
    await submitting(e.target, async () => {
      try {
        await Auth.signUp($("signupEmail").value, $("signupPass").value);
      } catch (err) {
        showError("signupError", err.message);
      }
    });
  });
})();
