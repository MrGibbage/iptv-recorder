import { SCHEDULER_TICK_INTERVAL_MS } from "../config.js";
import { runSchedulerTick } from "./tick.js";

let intervalHandle: NodeJS.Timeout | undefined;

// PLAN.md "Scheduler engine — an in-process background loop (not OS cron)".
export function startScheduler(): void {
  if (intervalHandle) {
    return;
  }
  runSchedulerTick(); // don't wait a full interval for the first materialization
  intervalHandle = setInterval(runSchedulerTick, SCHEDULER_TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
