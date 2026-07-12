const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, decide, HEALTH, ACTION } = require('../src/policy');

test('classify: unmanaged agent is DRIFT_UNMANAGED regardless of status', () => {
  const agent = { name: 'rogue', status: 'active', tier: 'smart', managed: false, desiredTier: null };
  assert.equal(classify(agent, [], []), HEALTH.DRIFT_UNMANAGED);
});

test('classify: sleeping is always OK_SLEEPING, even with error logs', () => {
  const agent = { name: 'a', status: 'sleeping', tier: 'smart', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [{ level: 'error' }], []), HEALTH.OK_SLEEPING);
});

test('classify: active with no errors and matching tier is OK', () => {
  const agent = { name: 'a', status: 'active', tier: 'smart', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [], []), HEALTH.OK);
});

test('classify: status error is INCIDENT', () => {
  const agent = { name: 'a', status: 'error', tier: 'smart', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [], []), HEALTH.INCIDENT);
});

test('classify: error-level logs elevate an active agent to INCIDENT', () => {
  const agent = { name: 'a', status: 'active', tier: 'smart', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [{ level: 'error', message: 'boom' }], []), HEALTH.INCIDENT);
});

test('classify: failed last deploy is INCIDENT even if status looks active', () => {
  const agent = { name: 'a', status: 'active', tier: 'smart', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [], [{ status: 'failed' }]), HEALTH.INCIDENT);
});

test('classify: tier mismatch is DRIFT_TIER', () => {
  const agent = { name: 'a', status: 'active', tier: 'extended', managed: true, desiredTier: 'smart' };
  assert.equal(classify(agent, [], []), HEALTH.DRIFT_TIER);
});

test('classify: always_on idle past threshold is COST_LEAK', () => {
  const agent = {
    name: 'a', status: 'active', tier: 'always_on', managed: true, desiredTier: 'always_on',
    lastActiveAt: new Date(Date.now() - 120 * 60000).toISOString(),
  };
  assert.equal(classify(agent, [], [], { idleMinutesThreshold: 60 }), HEALTH.COST_LEAK);
});

test('classify: always_on idle under threshold is OK', () => {
  const agent = {
    name: 'a', status: 'active', tier: 'always_on', managed: true, desiredTier: 'always_on',
    lastActiveAt: new Date(Date.now() - 5 * 60000).toISOString(),
  };
  assert.equal(classify(agent, [], [], { idleMinutesThreshold: 60 }), HEALTH.OK);
});

test('decide: OK/OK_SLEEPING never produce an action', () => {
  assert.deepEqual(decide(HEALTH.OK, 0, { mode: 'enforce' }), { action: ACTION.NONE });
  assert.deepEqual(decide(HEALTH.OK_SLEEPING, 0, { mode: 'enforce' }), { action: ACTION.NONE });
});

test('decide: report mode always alerts, never mutates', () => {
  assert.deepEqual(decide(HEALTH.INCIDENT, 0, { mode: 'report' }), { action: ACTION.ALERT });
  assert.deepEqual(decide(HEALTH.COST_LEAK, 0, { mode: 'report' }), { action: ACTION.ALERT });
  assert.deepEqual(decide(HEALTH.DRIFT_TIER, 0, { mode: 'report' }), { action: ACTION.ALERT });
});

test('decide: enforce mode restarts an incident under the cap', () => {
  assert.deepEqual(
    decide(HEALTH.INCIDENT, 1, { mode: 'enforce', maxRestartsPerWindow: 3 }),
    { action: ACTION.RESTART },
  );
});

test('decide: enforce mode escalates once the restart cap is hit', () => {
  assert.deepEqual(
    decide(HEALTH.INCIDENT, 3, { mode: 'enforce', maxRestartsPerWindow: 3 }),
    { action: ACTION.ESCALATE },
  );
});

test('decide: DRIFT_UNMANAGED never auto-deletes, always alerts', () => {
  assert.deepEqual(decide(HEALTH.DRIFT_UNMANAGED, 0, { mode: 'enforce' }), { action: ACTION.ALERT });
});
