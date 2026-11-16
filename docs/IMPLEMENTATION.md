# Implementation Status

## Delivered prototype

### Foundation

- pnpm monorepo with Next.js, Fastify, shared contracts, SQLite, Redis/BullMQ, and a local Lore deployment.
- First-run setup page for the initial administrator, Web/Lore addresses, registration policy, and optional Lore TLS certificate.
- Pinned Lore Server `0.13.0`.
- Single-file SQLite storage with WAL, Redis, OIDC key, Lore data, and generated internal TLS certificates.
- Health endpoint, origin checks on cookie mutations, rate limiting, security headers, and graceful shutdown.

### Accounts and ACL

- Invite-only built-in accounts with Argon2id password hashes.
- Email verification through invitation acceptance.
- Password reset links and session revocation.
- One-time API tokens stored as SHA-256 hashes.
- Global administrator, organization owner/admin/member, and direct user/team repository grants.
- Lore Tier 2 tokens with `read`, `write`, `owner`, `admin`, `migrate`, `obliterate`, `presign`, and `push-protected` actions derived from ACL state.
- OAuth device authorization, refresh tokens, API-key exchange, RFC 8693-style repository exchange, revocation, userinfo, and JWKS.
- User and Repository Registry gRPC services over TLS.

### Repository browsing

- Repository creation through the Lore Repository service and Registry callback.
- Repository visibility filtered in SQLite before Lore calls.
- Branch listing, revision history, file tree, blob streaming, and bounded text diff.
- Repository access management UI and audit log.
- Admin invite/user/audit UI and personal API-token UI.
- Administrator Git import jobs for allowlisted local repositories and public HTTPS URLs.
- Background progress, cancellation, retained warning reports, branch/tag mapping, and failed-import cleanup.

## Next phases

1. Repository mutation hardening: delete/restore workflows, branch protection and locks, failed-creation reconciliation, request idempotency, and background operation status.
2. Git import hardening: replace the initial CLI orchestration path with the pinned Lore revision-tree API, preserve timestamps exactly, preserve rename identity, and add resumable imports.
3. Online editing: shared-store instances, serialized jobs, conflict handling, and merge/rebase/cherry-pick workflows.
4. Collaboration: change requests, reviews, line comments, issues, labels, milestones, notifications, and webhooks.
5. Product breadth: wiki, releases, projects, OAuth applications, packages, search, and administration.
6. Production hardening: TOTP, quotas, backup/restore drills, load tests, S3/DynamoDB stores, multi-node deployment, and upgrade automation.

## Decisions

- Do not fork Lore Server. The portal is an independent control plane.
- Keep repository content out of the portal database.
- Use UUIDv7 IDs at API and database boundaries and 16-byte IDs at Lore boundaries.
- Deny repository existence and permission detail together to avoid enumeration.
- Never issue a global BFF bypass token for repository operations.
- Use a local-only loopback bridge for HTTP OIDC in Compose; production requires a trusted public HTTPS issuer.
