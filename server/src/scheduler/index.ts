import { SCHEDULER_TICK_INTERVAL_MS } from "../config.js";
import { runSchedulerTick } from "./tick.js";
import { dispatchDueRecordings, stopAllWorkers } from "../worker/dispatch.js";
import { runRetentionSweep } from "../retention/sweep.js";

let intervalHandle: NodeJS.Timeout | undefined;

// Each tick materializes due recurring occurrences, hands off any
// materialized occurrence whose start time has arrived to the recording
// worker (PLAN.md "Scheduler engine"), and sweeps expired recordings per the
// retention TTL. All three are cheap DB-query-driven checks at this scale,
// so one shared 30s cadence is enough — no need for retention to run on a
// separate, coarser interval.
function tick(): void {
  runSchedulerTick();
  dispatchDueRecordings();
  runRetentionSweep();
}

// PLAN.md "Scheduler engine — an in-process background loop (not OS cron)".
export function startScheduler(): void {
  if (intervalHandle) {
    return;
  }
  tick(); // don't wait a full interval for the first materialization/dispatch
  intervalHandle = setInterval(tick, SCHEDULER_TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
  stopAllWorkers();
}
