import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFile =
  process.env.PORTAL_VERSION_FILE ??
  path.join(root, "apps/web/version.json");
const command = process.argv[2] ?? "print";
const writeChanges = command !== "check";
const changedFiles = [];
const current = JSON.parse(readFileSync(versionFile, "utf8"));
const previous = { ...current };

validateVersionState(current);

if (command === "release") {
  const nextVersion = process.argv[3];
  const nextLoreVersion = process.argv[4];
  if (!nextVersion || !isSemver(nextVersion)) {
    throw new Error("Usage: version.mjs release <app-version> [lore-version]");
  }
  if (nextLoreVersion !== undefined && !isSemver(nextLoreVersion)) {
    throw new Error(`Invalid Lore version: ${nextLoreVersion}`);
  }
  current.version = nextVersion;
  if (nextLoreVersion !== undefined) {
    current.loreVersion = nextLoreVersion;
  }
  current.internalBuild = 1;
  current.builtAt = formatShanghaiTime(new Date());
  writeVersionFile();
} else if (command === "bump") {
  current.internalBuild += 1;
  current.builtAt = formatShanghaiTime(new Date());
  writeVersionFile();
} else if (!["check", "print", "sync"].includes(command)) {
  throw new Error(`Unknown version command: ${command}`);
}

syncVersionFiles(current, previous);

if (command === "check" && changedFiles.length > 0) {
  throw new Error(
    `Version files are out of sync:\n${changedFiles
      .map((file) => `- ${file}`)
      .join("\n")}\nRun: pnpm version:sync`,
  );
}

process.stdout.write(`${current.version}\n`);

function validateVersionState(value) {
  if (!isSemver(value.version)) {
    throw new Error(`Invalid application version: ${value.version}`);
  }
  if (!isSemver(value.loreVersion)) {
    throw new Error(`Invalid Lore version: ${value.loreVersion}`);
  }
  if (!Number.isInteger(value.internalBuild) || value.internalBuild < 1) {
    throw new Error("internalBuild must be a positive integer");
  }
  if (typeof value.builtAt !== "string" || value.builtAt.length === 0) {
    throw new Error("builtAt must be a non-empty string");
  }
}

function isSemver(value) {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  );
}

function writeVersionFile() {
  writeFileSync(versionFile, `${JSON.stringify(current, null, 2)}\n`);
}

function updateText(relativePath, transform, required = true) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    if (required) throw new Error(`Missing version-managed file: ${relativePath}`);
    return;
  }
  const before = readFileSync(absolutePath, "utf8");
  const after = transform(before);
  if (after === before) return;
  changedFiles.push(relativePath);
  if (writeChanges) writeFileSync(absolutePath, after);
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not update ${label}`);
  }
  return content.replace(pattern, replacement);
}

function syncEnvFile(relativePath, create) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath) && !create) return;
  const before = existsSync(absolutePath)
    ? readFileSync(absolutePath, "utf8")
    : "";
  let after = before;
  for (const [key, value] of [
    ["PORTAL_VERSION", current.version],
    ["LORE_VERSION", current.loreVersion],
  ]) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(after)) {
      after = after.replace(pattern, `${key}=${value}`);
    } else {
      after = `${after}${after && !after.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
    }
  }
  if (after === before) return;
  changedFiles.push(relativePath);
  if (writeChanges) writeFileSync(absolutePath, after);
}

function syncVersionFiles(value, oldValue) {
  for (const relativePath of [
    "package.json",
    "apps/server/package.json",
    "apps/web/package.json",
    "packages/shared/package.json",
    "packages/sqlite-db/package.json",
  ]) {
    updateText(relativePath, (content) => {
      const manifest = JSON.parse(content);
      manifest.version = value.version;
      manifest.license = "MIT";
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
  }

  syncEnvFile(".env.example", false);
  syncEnvFile("infra/runtime.env", false);
  syncEnvFile(".env", false);

  updateText("infra/app.Dockerfile", (content) => {
    let next = replaceRequired(
      content,
      /^ARG LORE_VERSION=.*$/gm,
      `ARG LORE_VERSION=${value.loreVersion}`,
      "Dockerfile LORE_VERSION",
    );
    next = replaceRequired(
      next,
      /^ARG PORTAL_VERSION=.*$/gm,
      `ARG PORTAL_VERSION=${value.version}`,
      "Dockerfile PORTAL_VERSION",
    );
    return next;
  }, false);

  updateText("compose.yaml", (content) =>
    replaceRequired(
      content,
      /^(\s*image:\s*)yeomai-lore-web:[^\s]+$/m,
      `$1yeomai-lore-web:${value.version}`,
      "Compose image tag",
    ),
    false,
  );

  for (const relativePath of ["scripts/run-docker.sh", "线上部署文档.md"]) {
    updateText(
      relativePath,
      (content) =>
        content
          .replace(
            /yeomai-lore-web:\d+\.\d+\.\d+/g,
            `yeomai-lore-web:${value.version}`,
          )
          .replace(
            /yeomai-lore-web-\d+\.\d+\.\d+-linux-amd64/g,
            `yeomai-lore-web-${value.version}-linux-amd64`,
          ),
      false,
    );
  }

  updateText("scripts/install-lore.sh", (content) =>
    replaceRequired(
      content,
      /VERSION="\$\{LORE_VERSION:-[^}]+\}"/,
      `VERSION="\${LORE_VERSION:-${value.loreVersion}}"`,
      "install-lore default version",
    ),
    false,
  );

  updateText("scripts/start-local.sh", (content) =>
    replaceRequired(
      content,
      /LORE_VERSION="\$\{LORE_VERSION:-[^}]+\}"/,
      `LORE_VERSION="\${LORE_VERSION:-${value.loreVersion}}"`,
      "local startup default version",
    ),
    false,
  );

  for (const relativePath of [
    "apps/server/src/routes/metadata.ts",
    "apps/web/src/app/layout.tsx",
  ]) {
    updateText(relativePath, (content) =>
      replaceRequired(
        content,
        /process\.env\.LORE_VERSION \?\? "[^"]+"/g,
        `process.env.LORE_VERSION ?? "${value.loreVersion}"`,
        `${relativePath} Lore fallback`,
      ),
      false,
    );
  }

  if (oldValue.loreVersion !== value.loreVersion) {
    for (const relativePath of [
      "README.md",
      "README.zh-CN.md",
      "docs/README.md",
      "docs/IMPLEMENTATION.md",
      "docs/RELEASING.md",
      "线上部署文档.md",
      "Lore与Git命令对比.md",
    ]) {
      updateText(
        relativePath,
        (content) =>
          content.replaceAll(oldValue.loreVersion, value.loreVersion),
        false,
      );
    }
  }

  if (oldValue.version !== value.version) {
    updateText(
      "docs/RELEASING.md",
      (content) => content.replaceAll(oldValue.version, value.version),
      false,
    );
  }
}

function formatShanghaiTime(date) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}
