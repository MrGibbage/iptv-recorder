// PLAN.md "Recurring occurrence materialization" — how far ahead of an
// occurrence's start time the scheduler creates its `recordings` row.
// Consumed once the scheduler tick loop is built.
export const MATERIALIZATION_HORIZON_MINUTES = 10;
