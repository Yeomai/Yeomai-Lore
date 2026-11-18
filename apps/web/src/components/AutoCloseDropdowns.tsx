"use client";

import { useEffect } from "react";

export function AutoCloseDropdowns() {
  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      for (const dropdown of document.querySelectorAll<HTMLDetailsElement>(
        "details[data-dropdown][open]",
      )) {
        if (!dropdown.contains(event.target)) {
          dropdown.open = false;
        }
      }
    };
    const closeOnFocusOut = (event: FocusEvent) => {
      if (
        !(event.target instanceof Node) ||
        !(event.relatedTarget instanceof Node)
      ) {
        return;
      }
      for (const dropdown of document.querySelectorAll<HTMLDetailsElement>(
        "details[data-dropdown][open]",
      )) {
        if (
          dropdown.contains(event.target) &&
          !dropdown.contains(event.relatedTarget)
        ) {
          dropdown.open = false;
        }
      }
    };

    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("focusin", closeOutside, true);
    document.addEventListener("focusout", closeOnFocusOut, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("focusin", closeOutside, true);
      document.removeEventListener("focusout", closeOnFocusOut, true);
    };
  }, []);

  return null;
}
