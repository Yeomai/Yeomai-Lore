interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

interface CacheState {
  values: Map<string, CacheEntry>;
  inflight: Map<string, Promise<unknown>>;
}

const globalCache = globalThis as typeof globalThis & {
  __lorePortalServerCache?: CacheState;
};

const state =
  globalCache.__lorePortalServerCache ??
  (globalCache.__lorePortalServerCache = {
    values: new Map(),
    inflight: new Map(),
  });

export async function cachedValue<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  options: { force?: boolean } = {},
): Promise<T> {
  if (options.force) {
    state.values.delete(key);
    const pending = state.inflight.get(key);
    if (pending) {
      await pending.catch(() => undefined);
    }
  }
  const now = Date.now();
  const cached = state.values.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }
  if (cached) state.values.delete(key);

  const existing = state.inflight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = load()
    .then((value) => {
      state.values.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      pruneCache();
      return value;
    })
    .finally(() => {
      state.inflight.delete(key);
    });
  state.inflight.set(key, pending);
  return pending;
}

export function shouldRefreshServerCache(headers: {
  get(name: string): string | null;
}): boolean {
  if (headers.get("rsc") === "1") return false;
  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  const pragma = headers.get("pragma")?.toLowerCase() ?? "";
  return (
    cacheControl.includes("no-cache") ||
    cacheControl.includes("max-age=0") ||
    pragma.includes("no-cache")
  );
}

function pruneCache(): void {
  if (state.values.size <= 1_000) return;
  const removeCount = state.values.size - 800;
  let removed = 0;
  for (const key of state.values.keys()) {
    state.values.delete(key);
    if (++removed >= removeCount) break;
  }
}
