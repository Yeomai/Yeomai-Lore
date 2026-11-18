# Security Policy

## Supported versions

Security fixes are applied to the current main branch and the latest published
release. Older releases may not receive fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use the repository's **Security → Advisories → Report a vulnerability**
workflow on GitHub. Include:

- affected version or commit
- reproduction steps
- expected and observed behavior
- security impact
- any suggested mitigation

Do not include real credentials, private keys, production databases, customer
data, or screenshots containing personal information. Replace secrets and
identifiers with test values.

## Deployment hardening

- Use HTTPS and `lores://` for public deployments.
- Publish only the unified application port; keep internal service ports
  private.
- Back up `portal.sqlite`, Lore storage, the OIDC signing key, and runtime
  configuration before upgrades.
- Replace development certificates before exposing the service outside a
  trusted local network.
- Keep Node.js, pnpm, Lore, and container base images patched.
