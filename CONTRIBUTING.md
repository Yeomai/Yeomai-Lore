# Contributing

Thanks for contributing to Yeomai Lore.

## Development setup

Prerequisites:

- Node.js 22 or newer
- pnpm 11
- Git
- OpenSSL
- Git for Windows when developing on Windows

Install dependencies and start the native development environment:

```bash
corepack enable
pnpm install
pnpm dev:local
```

On Windows, run `start.bat` and `stop.bat` instead of invoking the shell
scripts directly.

## Cross-platform path compatibility

This project is intended to install and run on Windows, Linux, macOS, and in
Docker. Code and scripts must treat filesystem paths as platform-specific:

- Build filesystem paths with `node:path` or the native shell APIs; use POSIX
  paths only for URL and protocol path segments.
- Do not assume `/`, drive letters, home-directory locations, temporary
  directories, path case, or path separators.
- When invoking external tools, prefer a native working directory plus relative
  file names over passing absolute paths as command arguments. In particular,
  Windows drive-letter paths such as `C:\...` can be misread as remote host
  specifications by GNU-compatible tools.
- Add regression coverage for path handling when changing import, archive,
  backup, certificate, or file-processing code.

## Before submitting a change

Run the relevant checks from the repository root:

```bash
pnpm typecheck
pnpm test
pnpm test:gateway
pnpm --filter @lore-portal/web build
```

Keep changes focused and include tests for behavior changes. Update the English
and Chinese documentation when a user-facing setting, workflow, endpoint, or
deployment requirement changes.

Version numbers are managed by `apps/web/version.json`. Use
`pnpm version:set <version>` for a release and `pnpm version:check` before
submitting version-related changes. See [docs/RELEASING.md](docs/RELEASING.md).

## Security and private data

Do not commit:

- `.env` files
- databases or Lore repository storage
- TLS certificates, private keys, passwords, API tokens, or session data
- logs, screenshots, customer data, or internal deployment notes
- absolute local paths or personal account identifiers

Use generic examples such as `lore.example.com`, `admin@example.com`, and
`your-organization/your-repository`.

Report security issues through the process in [SECURITY.md](SECURITY.md), not
through a public issue.

## Licensing

By submitting a contribution, you agree that it may be distributed under the
project's MIT License. Files derived from third-party projects must retain their
original notices and comply with the upstream license.
