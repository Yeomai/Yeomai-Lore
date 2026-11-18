"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/client";

export function UserMenu({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { messages } = useI18n();

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div
      ref={menuRef}
      className={`user-menu${open ? " is-open" : ""}`}
    >
      <button
        className="user-menu-trigger"
        type="button"
        aria-label={displayName}
        aria-expanded={open}
        title={displayName}
        onClick={() => setOpen((current) => !current)}
      >
        <img src="/user.png" alt="" aria-hidden="true" />
      </button>
      <div className="user-menu-panel">
        <div className="user-menu-identity">
          <strong>{displayName}</strong>
          <small>{email}</small>
        </div>
        <form action="/logout" method="post">
          <button className="user-menu-sign-out" type="submit">
            {messages.common.signOut}
          </button>
        </form>
        <a
          className="user-menu-feedback user-menu-version"
          href="https://my.feishu.cn/wiki/UR1Pw2wJyilbg3krQFjceJZEnyi"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpen(false)}
        >
          {messages.common.versionUpdate}
        </a>
        <a
          className="user-menu-feedback"
          href="https://my.feishu.cn/share/base/form/shrcnulvh4U72KoRYzSOPftlo7f"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpen(false)}
        >
          {messages.common.feedback}
        </a>
      </div>
    </div>
  );
}
