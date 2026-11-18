"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { BrowserTime } from "./BrowserTime";

const PAGE_SIZE = 50;

export interface AuditEvent {
  id: string;
  action: string;
  targetId: string;
  actorUsername: string | null;
  createdAt: string;
}

export function AuditPanel({
  initialEvents,
  locale,
}: {
  initialEvents: AuditEvent[];
  locale: string;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(
    initialEvents.length === PAGE_SIZE,
  );
  const loadingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { messages } = useI18n();
  const m = messages.admin;

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    try {
      const response = await clientApi<{ events: AuditEvent[] }>(
        `/api/v1/admin/audit?limit=${PAGE_SIZE}&offset=${events.length}`,
      );
      setEvents((current) => {
        const known = new Set(current.map((event) => event.id));
        const next = response.events.filter((event) => !known.has(event.id));
        return [...current, ...next];
      });
      setHasMore(response.events.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [events.length, hasMore]);

  useEffect(() => {
    const target = sentinelRef.current;
    const root = scrollRef.current;
    if (!target || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { root, rootMargin: "120px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loading]);

  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{m.recentAudit}</h2>
        <span className="count">{events.length}</span>
      </div>
      <div className="timeline audit-scroll" ref={scrollRef}>
        {events.map((event) => (
          <div className="timeline-item" key={event.id}>
            <span className="timeline-dot" />
            <div>
              <strong>{event.action}</strong>
              <p>
                {event.actorUsername ?? messages.common.system} ·{" "}
                <code className="small-code">{event.targetId}</code>
              </p>
            </div>
            <BrowserTime value={event.createdAt} locale={locale} />
          </div>
        ))}
        {loading ? (
          <p className="audit-load-status">{m.auditLoading}</p>
        ) : null}
        {!hasMore && events.length >= PAGE_SIZE ? (
          <p className="audit-load-status">{m.auditEnd}</p>
        ) : null}
        <div className="audit-load-sentinel" ref={sentinelRef} />
      </div>
    </section>
  );
}
