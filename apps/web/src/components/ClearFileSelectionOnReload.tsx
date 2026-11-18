"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

let reloadCheckCompleted = false;

export function ClearFileSelectionOnReload() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (reloadCheckCompleted) return;
    reloadCheckCompleted = true;
    if (!searchParams.has("file")) return;
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (navigation?.type !== "reload") return;

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("file");
    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [pathname, router, searchParams]);

  return null;
}
