/* NutriTrack logging — tiny shared wrapper over console.
 *
 * Keeps error/warning output consistent across the app. Each call leads with a
 * short message describing the operation that failed, and passes the original
 * Error object as the last argument so the console keeps the stack trace.
 * Swap the console calls here for a remote logging endpoint later if needed. */
window.Log = (function () {
  "use strict";

  const PREFIX = "[NutriTrack]";

  function logError(message, err) {
    console.error(PREFIX, message, err);
  }

  function logWarn(message, err) {
    console.warn(PREFIX, message, err);
  }

  return { error: logError, warn: logWarn };
})();
