# Git Repository Import

The current single-node implementation imports a Git repository into a new Lore
repository through a shared background queue.

## Supported Sources

- Public `http://`, `https://`, and `git://` clone URLs.
- Private HTTP(S) repositories using an access token only.
- Provider detection supports `github.com` and self-hosted Gitea. When a token
  is supplied, the provider API validates it and resolves the Git username.
- Local paths, SSH URLs, private-key uploads, and password-only authentication
  are not supported.
- Embedded URL passwords are rejected.

```dotenv
LORE_IMPORT_WORK_DIR=./data/local/imports
LORE_IMPORT_MAX_SOURCE_BYTES=0
LORE_IMPORT_GIT_USERNAME=oauth2
GIT_PATH=git
```

`LORE_IMPORT_MAX_SOURCE_BYTES=0` disables the source-size cap. The import form
does not ask for a username. Git HTTP Basic uses the username resolved by the
provider API; `LORE_IMPORT_GIT_USERNAME` remains the provider-compatible
fallback.

## Import Behavior

- The source is mirrored before importing, so refs and objects come from one
  consistent snapshot.
- The first commit materializes one complete workspace snapshot. Later commits
  use `git diff-tree` to update only added, modified, deleted, type-changed, and
  renamed paths, then stage only those paths through a Lore targets file.
- Empty commits and metadata-only commits do not rescan the complete workspace.
- Octopus merges still use a full-tree checkpoint between synthetic merge
  revisions because each intermediate merge must establish an exact tree.
- The Git default branch name becomes the new Lore repository default branch.
- All local branches participate in the import.
- Normal merges preserve both Lore parents.
- Author, committer, email, timestamps, Git SHAs, and commit messages are
  recorded as Lore metadata.
- Git commits whose tree is unchanged from their first parent, including empty
  root commits, are imported as metadata-only Lore revisions. The original SHA,
  author, timestamps, message, and branch position are retained, and an
  `empty-commit` warning is recorded.
- A merge whose final tree is identical to its first parent's tree has no
  material changes to commit. It is imported as a single-parent metadata-only
  revision and records a `merge-topology` warning.
- The portal returns Git committer time for imported revisions even though Lore
  0.13.0's filesystem commit path stamps its own revision time.
- Lightweight and annotated tags are optional. When “Import Git tags” is
  selected, they are stored in portal SQLite and shown on the repository Tags
  tab.
- Git renames use Lore's native move operation when possible; an explicit
  warning is recorded if the move cannot be preserved.
- Git LFS pointers are imported as ordinary files.
- Git submodules are skipped with a warning. Non-UTF-8 paths currently fail the
  job with the underlying Git/Lore error rather than risking a lossy rename.
- Symlinks become regular files containing their target path.
- Octopus merges become a chain of synthetic two-parent merges so every original
  parent remains reachable; an explicit warning is recorded.

These preservation tradeoffs make this an initial best-effort importer rather
than the final exact-history importer.

Wiki pages, issues, pull requests, releases, and milestones are intentionally
not imported in this version.

## Jobs

Every signed-in user can create imports. A regular user's target repository is
always created in that user's personal namespace. Administrators may target
their personal namespace or an organization they can manage.

All users share one global queue ordered by the server-side request arrival
time. Exactly one import runs at a time, with additional jobs remaining queued
in SQLite. Each regular user can have at most one queued or running import at a
time and must wait for it to finish before submitting another. Administrators
have no queue-count limit. Regular users can inspect, cancel, or clean only
their own jobs. Administrators can inspect and manage all jobs.

Import credentials are refreshed before their configured lifetime elapses so
large repositories can run longer than the normal repository-token TTL.

Jobs are not resumable. Cancellation, failure, or an API restart marks the job
failed or cancelled and removes the incomplete Lore repository. Job records,
warnings, and logs remain available from the repository import page.

Completed, failed, and cancelled records can be removed with **Clean record**.
Cleaning a failed/cancelled record first retries removal of any incomplete
repository, then deletes the task row, warnings, temporary directory, and log.
Cleaning a successful record keeps the imported repository and only removes the
job metadata and logs. Revision Git timestamps are retained in a separate
repository-level table.

Git access tokens are held only in the API process memory. They are never written
to SQLite or logs. If the API restarts before a private import starts, that
queued job fails and must be submitted again with its credentials.

The importer waits for Lore health before starting or recovering queued work so
the API/JWKS and Lore startup order remains valid.
