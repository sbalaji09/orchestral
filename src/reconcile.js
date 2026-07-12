const fs = require('fs');
const path = require('path');
const maritime = require('./maritime');
const policy = require('./policy');
const report = require('./report');

const DESIRED_STATE_PATH = path.join(__dirname, '..', 'desired-state.json');

// Controller-issued restart timestamps, per agent — the crash-loop guard.
// In-memory only; resets on redeploy, which is acceptable for a dry-run-first
// controller (§11 lists persisting this to disk as a stretch goal).
const restartLog = new Map();

let lastState = null;

function loadDesiredState() {
  const raw = fs.readFileSync(DESIRED_STATE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    managed_agents: Array.isArray(parsed.managed_agents) ? parsed.managed_agents : [],
    ignore: Array.isArray(parsed.ignore) ? parsed.ignore : [],
  };
}

function recordRestart(agentName) {
  const list = restartLog.get(agentName) || [];
  list.push(Date.now());
  restartLog.set(agentName, list);
}

function getRestartCount(agentName, windowMinutes) {
  const list = restartLog.get(agentName) || [];
  const cutoff = Date.now() - windowMinutes * 60000;
  const recent = list.filter((t) => t > cutoff);
  restartLog.set(agentName, recent);
  return recent.length;
}

// Gathers real fleet state + desired-state comparison. No decisions here —
// that's policy.js's job.
async function sense(desiredState) {
  const selfName = process.env.SELF_AGENT_NAME || 'fleet-control-plane';
  const ignoreSet = new Set([...(desiredState.ignore || []), selfName]);
  const desiredByName = new Map(desiredState.managed_agents.map((a) => [a.name, a]));

  const fleet = await maritime.list();
  const enriched = [];

  for (const agent of fleet) {
    if (ignoreSet.has(agent.name)) continue;

    const desiredEntry = desiredByName.get(agent.name);
    let agentLogs = [];
    let agentHistory = [];

    // Only pull extra data for agents that aren't obviously healthy already
    // (sleeping is always healthy and needs no further evidence).
    if (agent.status !== 'sleeping') {
      const [logsResult, historyResult] = await Promise.allSettled([
        maritime.logs(agent.name, { level: 'error', lines: 5 }),
        maritime.history(agent.name, { limit: 1 }),
      ]);
      agentLogs = logsResult.status === 'fulfilled' && Array.isArray(logsResult.value) ? logsResult.value : [];
      agentHistory = historyResult.status === 'fulfilled' && Array.isArray(historyResult.value) ? historyResult.value : [];

      // Deploy-time error logs from a build attempt that was since superseded
      // by a successful deploy shouldn't count as an ongoing incident.
      const lastDeployCompletedAt = agentHistory[0]?.completedAt ? new Date(agentHistory[0].completedAt).getTime() : null;
      if (lastDeployCompletedAt) {
        agentLogs = agentLogs.filter((entry) => {
          const t = new Date(entry.timestamp).getTime();
          return Number.isNaN(t) || t > lastDeployCompletedAt;
        });
      }
    }

    enriched.push({
      ...agent,
      managed: !!desiredEntry,
      desiredTier: desiredEntry ? desiredEntry.expected_tier : null,
      logs: agentLogs,
      history: agentHistory,
    });
  }

  const fleetNames = new Set(fleet.map((a) => a.name));
  const missing = desiredState.managed_agents.filter((d) => !fleetNames.has(d.name));

  return { enriched, missing };
}

// Executes exactly one decided action against the real CLI — but only ever
// mutates anything when RECONCILE_MODE=enforce. This check is independent of
// what decide() returned, as defense in depth per README's guardrails.
async function act(agent, decision, mode) {
  if (decision.action === 'NONE' || decision.action === 'ALERT' || decision.action === 'ESCALATE') {
    return { executed: false, action: decision.action };
  }

  if (mode !== 'enforce') {
    return { executed: false, action: decision.action, skippedReason: 'RECONCILE_MODE is not enforce' };
  }

  try {
    if (decision.action === 'RESTART') {
      await maritime.restart(agent.name);
      recordRestart(agent.name);
      return { executed: true, action: 'RESTART' };
    }
    if (decision.action === 'SCALE_TO_SMART') {
      await maritime.scale(agent.name, 'smart');
      return { executed: true, action: 'SCALE_TO_SMART', tier: 'smart' };
    }
    if (decision.action === 'SCALE_TO_DESIRED') {
      await maritime.scale(agent.name, agent.desiredTier);
      return { executed: true, action: 'SCALE_TO_DESIRED', tier: agent.desiredTier };
    }
  } catch (err) {
    return { executed: false, action: decision.action, error: err.message };
  }

  return { executed: false, action: decision.action };
}

// Explicit "start" for a sleeping/stopped agent — distinct from act() because
// policy.decide() never proposes waking a sleeping agent automatically
// (sleeping is deliberately healthy). This is a direct, user-requested
// override, not an automatic remediation, but it still goes through the same
// enforce-mode gate as every other mutation, and `agent` only ever comes from
// sense()'s already-self-filtered list, so it can't target the controller.
async function startAgent(agent, mode) {
  if (agent.status !== 'sleeping' && agent.status !== 'stopped') {
    return { executed: false, action: 'START', skippedReason: `already ${agent.status}` };
  }

  if (mode !== 'enforce') {
    return { executed: false, action: 'START', skippedReason: 'RECONCILE_MODE is not enforce' };
  }

  try {
    await maritime.start(agent.name);
    return { executed: true, action: 'START' };
  } catch (err) {
    return { executed: false, action: 'START', error: err.message };
  }
}

function getConfig() {
  const mode = process.env.RECONCILE_MODE || 'report';
  return {
    mode,
    thresholds: {
      mode,
      idleMinutesThreshold: Number(process.env.IDLE_MINUTES_THRESHOLD || 60),
      maxRestartsPerWindow: Number(process.env.MAX_RESTARTS_PER_WINDOW || 3),
      costLeakAction: 'alert',
    },
    restartWindowMinutes: Number(process.env.RESTART_WINDOW_MINUTES || 30),
  };
}

// classify -> decide -> act for one agent. This is THE mutation path — used
// by both the automatic reconcile loop and the chat handler, so a chat-
// requested "restart X" is decided and executed identically to an automatic
// pass, with the same guardrails (dry-run unless enforce, restart cap,
// never-self since `agent` only ever comes from sense()'s already-filtered
// list).
async function evaluateAndAct(agent, thresholds, restartWindowMinutes, mode) {
  const health = policy.classify(agent, agent.logs, agent.history, thresholds);
  const restartCount = getRestartCount(agent.name, restartWindowMinutes);
  const decision = policy.decide(health, restartCount, thresholds);
  const actionResult = await act(agent, decision, mode);
  return {
    name: agent.name,
    status: agent.status,
    tier: agent.tier,
    desiredTier: agent.desiredTier,
    lastActiveAt: agent.lastActiveAt,
    health,
    decision,
    actionResult,
  };
}

// Sense + classify only, no decide/act — a side-effect-free fleet snapshot
// for read-only callers (the chat handler's "what's wrong" questions).
async function senseAndClassify() {
  const { thresholds } = getConfig();
  const desiredState = loadDesiredState();
  const { enriched, missing } = await sense(desiredState);
  const results = enriched.map((agent) => ({
    agent,
    health: policy.classify(agent, agent.logs, agent.history, thresholds),
  }));
  return { results, missing };
}

async function reconcilePass() {
  const { mode, thresholds, restartWindowMinutes } = getConfig();

  const desiredState = loadDesiredState();
  const { enriched, missing } = await sense(desiredState);

  const results = [];

  for (const agent of enriched) {
    results.push(await evaluateAndAct(agent, thresholds, restartWindowMinutes, mode));
  }

  for (const d of missing) {
    results.push({
      name: d.name,
      status: 'missing',
      tier: null,
      desiredTier: d.expected_tier,
      lastActiveAt: null,
      health: policy.HEALTH.DRIFT_MISSING,
      decision: { action: policy.ACTION.ALERT },
      actionResult: { executed: false, action: policy.ACTION.ALERT },
    });
  }

  const summary = report.buildSummary(results, mode);
  const narration = await report.narrate(summary);

  lastState = {
    ok: true,
    timestamp: new Date().toISOString(),
    mode,
    results,
    summary,
    narration,
  };

  return lastState;
}

async function reconcilePassSafe() {
  try {
    return await reconcilePass();
  } catch (err) {
    lastState = {
      ok: false,
      timestamp: new Date().toISOString(),
      mode: process.env.RECONCILE_MODE || 'report',
      error: err.message,
      results: lastState?.results || [],
      summary: lastState?.summary || null,
    };
    return lastState;
  }
}

function getLastState() {
  return lastState;
}

module.exports = {
  reconcilePass,
  reconcilePassSafe,
  getLastState,
  senseAndClassify,
  evaluateAndAct,
  startAgent,
  getConfig,
};
