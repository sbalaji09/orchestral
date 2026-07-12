// Pure functions only: no I/O, no CLI calls, no reads of process.env.
// reconcile.js is responsible for gathering data and thresholds and passing
// them in.

const HEALTH = {
  OK: 'OK',
  OK_SLEEPING: 'OK_SLEEPING',
  INCIDENT: 'INCIDENT',
  COST_LEAK: 'COST_LEAK',
  DRIFT_UNMANAGED: 'DRIFT_UNMANAGED',
  DRIFT_MISSING: 'DRIFT_MISSING',
  DRIFT_TIER: 'DRIFT_TIER',
};

const ACTION = {
  NONE: 'NONE',
  ALERT: 'ALERT',
  RESTART: 'RESTART',
  ESCALATE: 'ESCALATE',
  SCALE_TO_SMART: 'SCALE_TO_SMART',
  SCALE_TO_DESIRED: 'SCALE_TO_DESIRED',
};

function idleMinutesSince(lastActiveAt) {
  if (!lastActiveAt) return null;
  const last = new Date(lastActiveAt).getTime();
  if (Number.isNaN(last)) return null;
  return (Date.now() - last) / 60000;
}

// The CLI's response shape for a history entry isn't documented in
// `maritime guide --json` (only commands/flags are), so check a few
// plausible field names rather than assuming one.
function historyEntryFailed(entry) {
  if (!entry) return false;
  const status = String(entry.status || entry.deployStatus || entry.result || '').toLowerCase();
  if (['failed', 'error', 'errored'].includes(status)) return true;
  if (entry.success === false) return true;
  if (entry.ok === false) return true;
  return false;
}

/**
 * agent: an enriched fleet record — the raw `maritime list` entry plus
 *   `managed` (bool) and `desiredTier` (string|null), attached by reconcile.js
 *   from desired-state.json.
 * logs: recent error-level log entries for this agent (or []).
 * history: recent deploy-history entries for this agent, newest first (or []).
 * thresholds: { idleMinutesThreshold }
 */
function classify(agent, logs = [], history = [], thresholds = {}) {
  const { idleMinutesThreshold = 60 } = thresholds;

  if (!agent.managed) {
    return HEALTH.DRIFT_UNMANAGED;
  }

  if (agent.status === 'sleeping') {
    return HEALTH.OK_SLEEPING;
  }

  const hasErrorLogs = Array.isArray(logs) && logs.length > 0;
  const lastDeployFailed = Array.isArray(history) && history.length > 0 && historyEntryFailed(history[0]);

  // 'stopped' isn't sleeping (which is a deliberate, healthy, cost-saving
  // state) and isn't running either — an unexpectedly stopped managed agent
  // is exactly the case restart is meant to fix.
  if (agent.status === 'error' || agent.status === 'crashed' || agent.status === 'stopped' || hasErrorLogs || lastDeployFailed) {
    return HEALTH.INCIDENT;
  }

  if (agent.desiredTier && agent.tier !== agent.desiredTier) {
    return HEALTH.DRIFT_TIER;
  }

  if (agent.status === 'active' && agent.tier === 'always_on') {
    const idleMinutes = idleMinutesSince(agent.lastActiveAt);
    if (idleMinutes !== null && idleMinutes > idleMinutesThreshold) {
      return HEALTH.COST_LEAK;
    }
  }

  return HEALTH.OK;
}

/**
 * health: one of HEALTH.*
 * restartCount: number of controller-issued restarts for this agent within
 *   the restart window (tracked by reconcile.js, not here).
 * thresholds: { mode: 'report'|'enforce', maxRestartsPerWindow, costLeakAction: 'scale'|'alert' }
 */
function decide(health, restartCount = 0, thresholds = {}) {
  const { mode = 'report', maxRestartsPerWindow = 3, costLeakAction = 'alert' } = thresholds;
  const enforcing = mode === 'enforce';

  switch (health) {
    case HEALTH.OK:
    case HEALTH.OK_SLEEPING:
      return { action: ACTION.NONE };

    case HEALTH.INCIDENT:
      if (!enforcing) return { action: ACTION.ALERT };
      return restartCount < maxRestartsPerWindow
        ? { action: ACTION.RESTART }
        : { action: ACTION.ESCALATE };

    case HEALTH.COST_LEAK:
      if (!enforcing) return { action: ACTION.ALERT };
      return costLeakAction === 'scale' ? { action: ACTION.SCALE_TO_SMART } : { action: ACTION.ALERT };

    case HEALTH.DRIFT_UNMANAGED:
      // Never auto-delete — always a human alert.
      return { action: ACTION.ALERT };

    case HEALTH.DRIFT_MISSING:
      // Recreate-from-blueprint is a stretch goal; alert until then.
      return { action: ACTION.ALERT };

    case HEALTH.DRIFT_TIER:
      if (!enforcing) return { action: ACTION.ALERT };
      return { action: ACTION.SCALE_TO_DESIRED };

    default:
      return { action: ACTION.ALERT };
  }
}

module.exports = { HEALTH, ACTION, classify, decide, idleMinutesSince };
