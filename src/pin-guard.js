// The PIN door (NET-02, 2026-10-21 audit). The household PIN is shared by
// every personal app, so this door is held to one pattern:
//  - per address: MAX_ATTEMPTS failures in ATTEMPT_WINDOW_MIN minutes;
//  - household-wide: GLOBAL_PER_HOUR failures from everyone in an hour, on
//    the PIN form only. A stranger can lock the PIN out for up to an hour;
//    for two people that is accepted, and passkeys are never under this cap;
//  - any error reading the count refuses (fail closed);
//  - every PIN failure gets the same status and words (PIN_FAIL), so the
//    reply never says whether the PIN was right and the email was not.
export const MAX_ATTEMPTS = 6;
export const ATTEMPT_WINDOW_MIN = 15;
export const GLOBAL_PER_HOUR = 30;
export const PIN_FAIL = "That PIN and email did not match. Try again.";

/** Per-address check, used by the PIN form and the passkey routes. */
export async function throttled(db, ipHash) {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS c FROM login_attempts WHERE ip_hash = ? AND at > datetime('now', ?)`,
    ).bind(ipHash, `-${ATTEMPT_WINDOW_MIN} minutes`).first();
    return (row?.c ?? 0) >= MAX_ATTEMPTS;
  } catch {
    return true; // fail closed
  }
}

/** Household-wide check, PIN form only. */
export async function globallyThrottled(db) {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS c FROM login_attempts WHERE at > datetime('now', '-1 hour')`,
    ).first();
    return (row?.c ?? 0) >= GLOBAL_PER_HOUR;
  } catch {
    return true; // fail closed
  }
}

export async function recordAttempt(db, ipHash) {
  try {
    await db.prepare("INSERT INTO login_attempts (ip_hash, at) VALUES (?, datetime('now'))").bind(ipHash).run();
    await db.prepare("DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')").run();
  } catch { /* noop */ }
}

export async function clearAttempts(db, ipHash) {
  try { await db.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(ipHash).run(); } catch { /* noop */ }
}
