"use client";

import { useEffect, useState } from "react";

type DateStyle = "full" | "long" | "medium" | "short";
type TimeStyle = "full" | "long" | "medium" | "short";

interface BrowserTimeProps {
  value: string | number | Date;
  locale: string;
  kind?: "date" | "datetime";
  dateStyle?: DateStyle;
  timeStyle?: TimeStyle;
  className?: string;
  role?: React.AriaRole;
  title?: string;
}

function asDate(value: BrowserTimeProps["value"]): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatTime(
  value: BrowserTimeProps["value"],
  locale: string,
  timeZone: string,
  kind: BrowserTimeProps["kind"],
  dateStyle: DateStyle,
  timeStyle: TimeStyle,
): string {
  const options: Intl.DateTimeFormatOptions =
    kind === "date"
      ? {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }
      : { timeZone, dateStyle, timeStyle };
  return new Intl.DateTimeFormat(locale, options).format(asDate(value));
}

export function BrowserTime({
  value,
  locale,
  kind = "datetime",
  dateStyle = "medium",
  timeStyle = "short",
  className,
  role,
  title,
}: BrowserTimeProps) {
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const date = asDate(value);

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }, []);

  const formatted = formatTime(
    value,
    locale,
    timeZone ?? "UTC",
    kind,
    dateStyle,
    timeStyle,
  );

  return (
    <time
      className={className}
      dateTime={date.toISOString()}
      role={role}
      suppressHydrationWarning
      title={title ?? `${date.toISOString()}${timeZone ? ` (${timeZone})` : ""}`}
    >
      {formatted}
    </time>
  );
}

export function BrowserTimeText({
  template,
  ...props
}: BrowserTimeProps & { template: string }) {
  const marker = "{date}";
  const index = template.indexOf(marker);
  if (index === -1) return <>{template}</>;
  return (
    <>
      {template.slice(0, index)}
      <BrowserTime {...props} />
      {template.slice(index + marker.length)}
    </>
  );
}
