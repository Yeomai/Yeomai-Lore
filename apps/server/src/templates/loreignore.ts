import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IGNORE_TEMPLATE_IDS = ["unreal", "unity", "nextjs"] as const;
export type IgnoreTemplateId = (typeof IGNORE_TEMPLATE_IDS)[number];

const assetUrls: Record<IgnoreTemplateId, URL> = {
  unreal: templateAsset("unreal.loreignore"),
  unity: templateAsset("unity.loreignore"),
  nextjs: templateAsset("nextjs.loreignore"),
};

export function readIgnoreTemplate(
  template: IgnoreTemplateId,
): Promise<string> {
  return readFile(assetUrls[template], "utf8");
}

function templateAsset(name: string): URL {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "assets/loreignore", name),
    path.resolve(here, "../../assets/loreignore", name),
  ];
  return pathToFileURL(candidates.find(existsSync) ?? candidates[0]!);
}
