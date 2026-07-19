import type { recurringRules } from "../db/schema.js";

type RecurringRule = typeof recurringRules.$inferSelect;

// "Local" time throughout (single-instance, single-timezone deployment —
// see recurring_rules.startMinuteOfDay in ../db/schema.ts) — deliberately
// uses local-time Date getters/setters (getDay, setHours, ...), never the
// UTC ones, so "today" and "midnight" agree with the rule's own timezone
// assumption. The server's process timezone is pinned to UTC (TZ=UTC,
// asserted at boot in src/index.ts), so in practice "local" here always
// means UTC — kept as local-time calls rather than switched to
// getUTCDay/setUTCHours so this code doesn't silently start meaning
// something different if that pin is ever loosened to a real per-rule
// timezone.

// bit 0 = Monday .. bit 6 = Sunday (see recurring_rules.daysOfWeek).
export function isDayActive(daysOfWeek: number, day: Date): boolean {
  const jsDay = day.getDay(); // 0 = Sunday .. 6 = Saturday, local time
  const bitIndex = (jsDay + 6) % 7; // 0 = Monday .. 6 = Sunday
  return (daysOfWeek & (1 << bitIndex)) !== 0;
}

export function startOfLocalDay(day: Date): Date {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  return start;
}

// The [start, end) window this rule occupies on the given calendar day,
// regardless of whether that day is actually one of the rule's active days
// — callers check isDayActive first.
export function occurrenceWindowForDay(rule: RecurringRule, day: Date): { start: Date; end: Date } {
  const start = startOfLocalDay(day);
  start.setMinutes(rule.startMinuteOfDay);
  const end = new Date(start.getTime() + rule.durationMinutes * 60_000);
  return { start, end };
}

// YYYY-MM-DD in server-local time — matches recurring_rule_skips.occurrenceDate.
export function occurrenceDateKey(day: Date): string {
  const start = startOfLocalDay(day);
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const date = String(start.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}
