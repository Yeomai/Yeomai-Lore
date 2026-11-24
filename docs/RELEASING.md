# Releasing

The application and bundled Lore versions are declared in
`apps/web/version.json`:

```json
{
  "version": "1.1.7",
  "loreVersion": "0.14.0",
  "internalBuild": 18,
  "builtAt": "2026-11-18 13:09"
}
```

This file is the version source of truth. The sync command updates:

- all workspace `package.json` versions and MIT license fields
- `.env`, `.env.example`, and `infra/runtime.env`
- Dockerfile `PORTAL_VERSION` and `LORE_VERSION` defaults
- the Docker Compose image tag
- local Lore installation defaults
- fallback versions in the Web and API applications
- Lore version references in the public documentation

## Set a release version

```bash
pnpm version:set 1.1.7
```

When upgrading the bundled official Lore version, provide it as the second
argument:

```bash
pnpm version:set 1.2.0 0.15.0
```

Update `LORESERVER_DIGEST` in `infra/app.Dockerfile` to the digest of the new
official Lore image before building.

## Synchronize and verify

```bash
pnpm version:sync
pnpm version:check
```

`version:check` fails when package manifests, runtime environment files,
Docker configuration, or documentation drift from `apps/web/version.json`.
The Web `prebuild` command increments `internalBuild` and synchronizes the same
files before building.

## Container output

The production image copies `NOTICE` to
`/usr/local/share/yeomai-lore/NOTICE`. On every container start, the entrypoint
prints the application version, bundled Epic Games Lore version, and the full
third-party license and trademark notice.
