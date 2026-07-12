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

// Turns the structured summary into a short human-readable incident note.
// Uses Maritime's own injected OpenAI-compatible LLM proxy (OPENAI_API_KEY /
// OPENAI_BASE_URL, present on every Maritime agent) rather than requiring a
// separate ANTHROPIC_API_KEY. Purely descriptive — this runs after decide()
// has already produced every action; it narrates decisions, it never makes
// them. Returns null on any failure or if nothing notable happened, so
// /reconcile always has the structured summary to fall back on.
async function narrate(summary) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseUrl) return null;

  const noteworthy = summary.incidents.length || summary.costLeaks.length || summary.actionsTaken.length;
  if (!noteworthy) return null;

  const prompt = `You are writing a one-paragraph incident note for an ops dashboard. Mode: ${summary.mode}. ` +
    `${summary.incidents.length} incident(s), ${summary.costLeaks.length} cost leak(s), ${summary.actionsTaken.length} action(s) taken. ` +
    `Incidents: ${JSON.stringify(summary.incidents.map((r) => ({ name: r.name, status: r.status, action: r.decision.action })))}. ` +
    `Actions taken: ${JSON.stringify(summary.actionsTaken.map((r) => ({ name: r.name, action: r.decision.action })))}. ` +
    `Be factual and terse — state what was observed and what was done, nothing speculative. Two sentences max.`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You summarize fleet-ops reconciliation results factually and tersely. Never invent data not given to you.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// Sends the digest via the agent's Maritime email identity. Deferred by the
// build order — inert until REPORT_EMAIL is set and this is implemented.
async function dispatch(summary, narration) {
  if (!process.env.REPORT_EMAIL) return { sent: false };
  return { sent: false };
}

module.exports = { TIER_PRICE_CENTS, buildSummary, narrate, dispatch };
