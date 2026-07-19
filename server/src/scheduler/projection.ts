import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { recordings, recurringRules, recurringRuleSkips } from "../db/schema.js";
import { PROJECTION_HORIZON_DAYS } from "../config.js";
import { isDayActive, occurrenceDateKey, occurrenceWindowForDay, startOfLocalDay } from "./occurrence.js";

type RecurringRule = typeof recurringRules.$inferSelect;

export type ProjectedOccurrence = {
  recurringRuleId: number;
  providerId: number;
  channelId: string;
  startTime: Date;
  endTime: Date;
};

// GET /recordings?includeProjected=true — computed-but-not-yet-materialized
// future occurrences of a recurring rule (PLAN.md "Recurring occurrence
// materialization": "GET /recordings?recurring_rule_id={id} can include
// these projected future occurrences on request"). Distinct from the
// scheduler tick's single-day "is today due" check (./tick.ts) — this walks
// forward day-by-day out to PROJECTION_HORIZON_DAYS, applying the same
// day-active / skip-exception / end-date / max-occurrences rules tick.ts
// uses, so a projected occurrence is exactly what tick.ts would eventually
// materialize (barring a hard-reject at fire time, which can't be known
// this far ahead — projections are optimistic).
export function projectOccurrences(rule: RecurringRule, now: Date = new Date()): ProjectedOccurrence[] {
  if (rule.cancelledAt) {
    return [];
  }

  const skippedDates = new Set(
    db
      .select({ occurrenceDate: recurringRuleSkips.occurrenceDate })
      .from(recurringRuleSkips)
      .where(eq(recurringRuleSkips.ruleId, rule.id))
      .all()
      .map((s) => s.occurrenceDate),
  );

  // Every already-materialized row counts against max_occurrences
  // regardless of status (PLAN.md), and is excluded below so it isn't
  // double-reported alongside the real row GET /recordings already returns.
  let runningCount = 0;
  const materializedStarts = new Set<number>();
  for (const row of db
    .select({ startTime: recordings.startTime })
    .from(recordings)
    .where(eq(recordings.recurringRuleId, rule.id))
    .all()) {
    runningCount++;
    materializedStarts.add(row.startTime.getTime());
  }

  const results: ProjectedOccurrence[] = [];
  const day = startOfLocalDay(now);

  for (let i = 0; i <= PROJECTION_HORIZON_DAYS; i++) {
    if (i > 0) {
      day.setDate(day.getDate() + 1);
    }

    if (rule.maxOccurrences !== null && runningCount >= rule.maxOccurrences) {
      break;
    }
    if (!isDayActive(rule.daysOfWeek, day)) {
      continue;
    }

    const { start, end } = occurrenceWindowForDay(rule, day);

    if (rule.endDate && start > rule.endDate) {
      break;
    }
    // Not "future" if its window has already started — already handled by
    // materialization (or about to be, on the next tick) rather than
    // something to project.
    if (start <= now) {
      continue;
    }
    if (skippedDates.has(occurrenceDateKey(day))) {
      continue;
    }
    if (materializedStarts.has(start.getTime())) {
      continue;
    }

    results.push({ recurringRuleId: rule.id, providerId: rule.providerId, channelId: rule.channelId, startTime: start, endTime: end });
    runningCount++;
  }

  return results;
}
