import type { AppConfig } from "./config.ts";

export async function isLoreReady(config: AppConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.loreHttpUrl}/health_check`, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}
