// No dedicated spend API exists on Maritime (confirmed via `maritime guide
// --json`), so cost is estimated from tier pricing.
const TIER_PRICE_CENTS = {
  smart: 100,
  extended: 500,
  always_on: 1000,
};

function buildSummary(results, mode) {
  const counts = {};
  let estimatedMonthlyCostCents = 0;
  const spenders = [];
  const incidents = [];
  const costLeaks = [];
  const actionsTaken = [];

  for (const r of results) {
    counts[r.health] = (counts[r.health] || 0) + 1;

    const price = r.tier ? TIER_PRICE_CENTS[r.tier] : undefined;
    if (price != null) {
      estimatedMonthlyCostCents += price;
      spenders.push({ name: r.name, tier: r.tier, costCents: price });
    }

    if (r.health === 'INCIDENT') incidents.push(r);
    if (r.health === 'COST_LEAK') costLeaks.push(r);
    if (r.actionResult && r.actionResult.executed) actionsTaken.push(r);
  }

  spenders.sort((a, b) => b.costCents - a.costCents);

  return {
    mode,
    generatedAt: new Date().toISOString(),
    agentCount: results.length,
    counts,
    estimatedMonthlyCostCents,
    topSpenders: spenders.slice(0, 5),
    incidents,
    costLeaks,
    actionsTaken,
    costNote: 'Estimated from tier pricing (no dedicated spend API).',
  };
}

// Turns the structured summary into human-readable prose. Deferred by the
// build order — only activates once ANTHROPIC_API_KEY is set and this is
// implemented; until then it's a no-op so /reconcile always has a
// structured summary to fall back on.
async function narrate(summary) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return null;
}

// Sends the digest via the agent's Maritime email identity. Deferred by the
// build order — inert until REPORT_EMAIL is set and this is implemented.
async function dispatch(summary, narration) {
  if (!process.env.REPORT_EMAIL) return { sent: false };
  return { sent: false };
}

module.exports = { TIER_PRICE_CENTS, buildSummary, narrate, dispatch };
