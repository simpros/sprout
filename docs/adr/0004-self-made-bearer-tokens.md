# Self-made bearer tokens in SQLite, not better-auth

Authentication is two scopes — **deploy** (one canonical repo) and **admin**
(operator) — implemented as random bearer tokens with SHA-256 hashes stored in
SQLite. Revocation via `revoked_at`; no expiry in v0.1.

better-auth was considered and rejected: no browser UI in v0.1, no user
accounts, and API-key semantics map cleanly to a small custom table. Adopting
CI never receives admin capability or Postgres admin credentials — only a
deploy token and `SPROUT_URL`.
