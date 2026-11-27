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

## Build the image from GitHub

The `Build Docker image` workflow is manual-only. After it is present on the
default branch, open **Actions → Build Docker image → Run workflow**. Leave the
tag input empty to use the version in `apps/web/version.json`, or enter a tag
such as `test-1` explicitly.

The workflow reuses `infra/app.Dockerfile` and publishes a `linux/amd64` image
to GitHub Container Registry:

```text
ghcr.io/<github-owner>/yeomai-lore-web:<tag>
```

For this repository, the default branch publishes
`ghcr.io/yeomai/yeomai-lore-web:1.1.7`. The built-in `GITHUB_TOKEN` handles
authentication; no registry secret needs to be added. If the workflow receives
a package-permission error, check **Settings → Actions → General → Workflow
permissions** and allow read and write access.

New GHCR packages are private by default. To allow anonymous `docker pull`,
open the package under the account or organization's **Packages** page, then
choose **Package settings → Change visibility → Public**. Private deployments
can keep the package private and authenticate with a personal access token
that has `read:packages`.

```bash
docker pull ghcr.io/yeomai/yeomai-lore-web:1.1.7
```
