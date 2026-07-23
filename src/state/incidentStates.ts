/**
 * An observation disappearing from the health report is not evidence that anything was fixed — the
 * report generator may simply have stopped emitting the row. Incidents whose observation goes
 * absent land in `absent_unverified`: still open as far as the pipeline is concerned, excluded
 * from the operator's "needs attention" list, and eligible for the stale-incident sweep so Verify
 * can prove recovery (or find the problem is still live) before anything is called resolved.
 */
export const ABSENT_UNVERIFIED_STATE = 'absent_unverified';

/** States a Decide or Verify outcome put an incident in permanently. */
export const TERMINAL_INCIDENT_STATES = ['resolved', 'closed'] as const;

/** SQL literal list for `state NOT IN (...)` / `state IN (...)` predicates. */
export const TERMINAL_INCIDENT_STATES_SQL = TERMINAL_INCIDENT_STATES.map(
  (state) => `'${state}'`
).join(', ');

export function isTerminalIncidentState(state: string | null | undefined): boolean {
  return state === 'resolved' || state === 'closed';
}
