import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(packageDir, "dist");
const packageJson = JSON.parse(
  await readFile(path.join(packageDir, "package.json"), "utf8"),
);
const externalDependencies = Object.keys(packageJson.dependencies ?? {})
  .filter((name) => !name.startsWith("@lore-portal/"));

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await build({
  entryPoints: [path.join(packageDir, "src/index.ts")],
  outfile: path.join(distDir, "index.js"),
  bundle: true,
  external: externalDependencies,
  format: "esm",
  logLevel: "info",
  platform: "node",
  target: "node24",
});
await Promise.all([
  cp(
    path.join(packageDir, "src/db/migrations"),
    path.join(distDir, "migrations"),
    { recursive: true },
  ),
  cp(
    path.join(packageDir, "assets/loreignore"),
    path.join(distDir, "assets/loreignore"),
    { recursive: true },
  ),
  cp(path.join(packageDir, "proto"), path.join(distDir, "proto"), {
    recursive: true,
  }),
]);
