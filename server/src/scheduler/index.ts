import { SCHEDULER_TICK_INTERVAL_MS } from "../config.js";
import { runSchedulerTick } from "./tick.js";
import { dispatchDueRecordings, stopAllWorkers } from "../worker/dispatch.js";

let intervalHandle: NodeJS.Timeout | undefined;

// Each tick both materializes due recurring occurrences and hands off any
// materialized occurrence whose start time has arrived to the recording
// worker (PLAN.md "Scheduler engine").
function tick(): void {
  runSchedulerTick();
  dispatchDueRecordings();
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
