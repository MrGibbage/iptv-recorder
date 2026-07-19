// PLAN.md "Recurring occurrence materialization" — how far ahead of an
// occurrence's start time the scheduler creates its `recordings` row.
export const MATERIALIZATION_HORIZON_MINUTES = 10;

// PLAN.md "Scheduler engine" — ticks every ~30-60s; 30s is the responsive
// end of that range, cheap at this scale (a handful of active rules).
export const SCHEDULER_TICK_INTERVAL_MS = 30_000;
