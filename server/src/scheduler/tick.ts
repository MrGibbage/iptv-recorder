import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings, recurringRules, recurringRuleSkips } from "../db/schema.js";
import { checkHardReject } from "../hardReject.js";
import { MATERIALIZATION_HORIZON_MINUTES } from "../config.js";
import { isDayActive, occurrenceDateKey, occurrenceWindowForDay } from "./occurrence.js";

type RecurringRule = typeof recurringRules.$inferSelect;

const HORIZON_MS = MATERIALIZATION_HORIZON_MINUTES * 60_000;

// One tick: for every non-cancelled rule, materialize today's occurrence if
// it's due. Only "today" is ever considered (see occurrence.ts) — there's no
// backfill for occurrences missed while the process was down, the same way
// a VCR that was unplugged doesn't retroactively record.
export function runSchedulerTick(now: Date = new Date()): void {
  const activeRules = db.select().from(recurringRules).where(isNull(recurringRules.cancelledAt)).all();

  for (const rule of activeRules) {
    materializeIfDue(rule, now);
  }
}

function materializeIfDue(rule: RecurringRule, now: Date): void {
  if (!isDayActive(rule.daysOfWeek, now)) {
    return;
  }

  const { start, end } = occurrenceWindowForDay(rule, now);

  if (rule.endDate && start > rule.endDate) {
    return;
  }

  // Already materialized (this tick or an earlier one)?
  const [existing] = db
    .select({ id: recordings.id })
    .from(recordings)
    .where(and(eq(recordings.recurringRuleId, rule.id), eq(recordings.startTime, start)))
    .all();
  if (existing) {
    return;
  }

  const isDue = now.getTime() >= start.getTime() - HORIZON_MS;
  if (!isDue) {
    return;
  }

  // Skip exception (EXDATE equivalent) — never materialized, doesn't count
  // against max_occurrences either.
  const [skip] = db
    .select({ id: recurringRuleSkips.id })
    .from(recurringRuleSkips)
    .where(
      and(eq(recurringRuleSkips.ruleId, rule.id), eq(recurringRuleSkips.occurrenceDate, occurrenceDateKey(now))),
    )
    .all();
  if (skip) {
    return;
  }

  if (rule.maxOccurrences !== null) {
    const [{ count }] = db
      .select({ count: sql<number>`count(*)` })
      .from(recordings)
      .where(eq(recordings.recurringRuleId, rule.id))
      .all();
    if (count >= rule.maxOccurrences) {
      return;
    }
  }

  // FK guarantees this exists; defensive only.
  const [provider] = db.select().from(providers).where(eq(providers.id, rule.providerId)).all();
  if (!provider) {
    return;
  }

  const rejection = checkHardReject(provider, start, end, rule.channelId);
  if (!rejection) {
    db.insert(recordings)
      .values({
        providerId: rule.providerId,
        channelId: rule.channelId,
        recurringRuleId: rule.id,
        startTime: start,
        endTime: end,
        status: "scheduled",
      })
      .run();
    return;
  }

  // Hard-reject still failing — retry next tick unless the occurrence's own
  // window has fully elapsed, in which case it's truly missed. Materialize
  // it as failed so it stays visible in history instead of silently
  // vanishing (see PLAN.md "Materialization conflict" decision, 2026-07-19).
  if (now.getTime() >= end.getTime()) {
    db.insert(recordings)
      .values({
        providerId: rule.providerId,
        channelId: rule.channelId,
        recurringRuleId: rule.id,
        startTime: start,
        endTime: end,
        status: "failed",
        failureReason: rejection,
      })
      .run();
  }
}
