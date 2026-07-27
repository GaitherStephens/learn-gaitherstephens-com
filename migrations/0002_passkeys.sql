-- Passkeys (WebAuthn) + settings, matching the recipes/gaithernews pattern.
-- Single user, so credentials are not bound to a user_id. PIN stays as the
-- fallback path. The challenge-signing secret self-bootstraps into settings
-- under key 'webauthn_chal_secret'.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id           TEXT PRIMARY KEY,            -- base64url credential id
  public_key   TEXT NOT NULL,               -- base64 SPKI from getPublicKey()
  alg          INTEGER NOT NULL,            -- -7 ES256 | -257 RS256
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
