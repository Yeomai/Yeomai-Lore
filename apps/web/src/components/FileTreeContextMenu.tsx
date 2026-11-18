"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/client";

interface MenuState {
  x: number;
  y: number;
  path: string;
  kind: "file" | "directory";
}

export function FileTreeContextMenu({
  basePath,
  branch,
}: {
  basePath: string;
  branch: string;
}) {
  const { messages } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("tr[data-file-tree-path]")
          : null;
      if (!target) {
        setMenu(null);
        return;
      }
      event.preventDefault();
      const kind =
        target.dataset.fileTreeKind === "directory" ? "directory" : "file";
      const height = kind === "directory" ? 96 : 52;
      setMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - height)),
        path: target.dataset.fileTreePath ?? "",
        kind,
      });
    };
    const closeOutside = (event: PointerEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenu(null);
      }
    };
    const close = () => setMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };

    document.addEventListener("contextmenu", open);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  if (!menu || typeof document === "undefined") return null;

  const closeMenu = () => setMenu(null);
  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.kind === "file" ? (
        <a
          role="menuitem"
          href={`${basePath}/blob?${new URLSearchParams({
            branch,
            path: menu.path,
            inline: "false",
          })}`}
          download
          onClick={closeMenu}
        >
          {messages.repository.downloadFile}
        </a>
      ) : (
        <>
          <a
            role="menuitem"
            href={archiveHref(basePath, branch, menu.path, "zip")}
            download
            onClick={closeMenu}
          >
            {messages.repository.downloadDirectoryZip}
          </a>
          <a
            role="menuitem"
            href={archiveHref(basePath, branch, menu.path, "tar.gz")}
            download
            onClick={closeMenu}
          >
            {messages.repository.downloadDirectoryTarGz}
          </a>
        </>
      )}
    </div>,
    document.body,
  );
}

function archiveHref(
  basePath: string,
  branch: string,
  path: string,
  format: "zip" | "tar.gz",
): string {
  return `${basePath}/archive?${new URLSearchParams({
    branch,
    path,
    format,
  })}`;
}
