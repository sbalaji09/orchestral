function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const HEALTH_COLOR = {
  OK: '#1a7f37',
  OK_SLEEPING: '#57606a',
  INCIDENT: '#cf222e',
  COST_LEAK: '#9a6700',
  DRIFT_UNMANAGED: '#9a6700',
  DRIFT_MISSING: '#cf222e',
  DRIFT_TIER: '#9a6700',
};

function fmtCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function renderRow(r) {
  const color = HEALTH_COLOR[r.health] || '#57606a';
  const action = r.actionResult?.executed
    ? `${r.decision.action} (executed)`
    : r.decision.action === 'NONE'
      ? '—'
      : r.decision.action;
  return `<tr>
    <td>${esc(r.name)}</td>
    <td>${esc(r.status)}</td>
    <td>${esc(r.tier || '—')}${r.desiredTier && r.desiredTier !== r.tier ? ` <span class="muted">(want ${esc(r.desiredTier)})</span>` : ''}</td>
    <td><span class="pill" style="background:${color}">${esc(r.health)}</span></td>
    <td>${esc(action)}</td>
  </tr>`;
}

function renderDashboard(state) {
  if (!state) {
    return page('<p>No reconciliation pass has run yet. It runs automatically shortly after boot.</p>');
  }

  if (!state.ok) {
    return page(`<p class="error">Last reconcile pass failed: ${esc(state.error)}</p>
      <p class="muted">Last run: ${esc(state.timestamp)}</p>`);
  }

  const { results, summary, mode, timestamp } = state;

  const rows = results.length
    ? results.map(renderRow).join('\n')
    : '<tr><td colspan="5" class="muted">No agents to reconcile (empty fleet, or everything managed is ignored).</td></tr>';

  const incidentRows = results
    .filter((r) => r.health === 'INCIDENT' || r.health === 'DRIFT_MISSING' || (r.actionResult && r.actionResult.executed))
    .map((r) => `<li><strong>${esc(r.name)}</strong> — ${esc(r.health)} → ${esc(r.decision.action)}${r.actionResult?.error ? ` (error: ${esc(r.actionResult.error)})` : ''}</li>`)
    .join('\n');

  const spendersRows = summary.topSpenders
    .map((s) => `<li>${esc(s.name)} (${esc(s.tier)}) — ${fmtCents(s.costCents)}/mo</li>`)
    .join('\n');

  return page(`
    <div class="banner ${mode === 'enforce' ? 'enforce' : 'report'}">
      Mode: <strong>${esc(mode)}</strong>${mode !== 'enforce' ? ' — dry run, no remediation is executed' : ''}
    </div>
    <p class="muted">Last reconciled: ${esc(timestamp)} · ${results.length} agent(s) · est. spend ${fmtCents(summary.estimatedMonthlyCostCents)}/mo</p>

    <h2>Fleet</h2>
    <table>
      <thead><tr><th>Name</th><th>Status</th><th>Tier</th><th>Health</th><th>Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <h2>Incidents &amp; actions</h2>
    ${incidentRows ? `<ul>${incidentRows}</ul>` : '<p class="muted">None.</p>'}

    <h2>Spend</h2>
    <p>${fmtCents(summary.estimatedMonthlyCostCents)}/mo estimated (${esc(summary.costNote)})</p>
    ${spendersRows ? `<ul>${spendersRows}</ul>` : '<p class="muted">No spend data.</p>'}
  `);
}

function page(body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Fleet Control Plane</title>
<meta http-equiv="refresh" content="30">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2rem; font-size: 1.1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #d0d7de; font-size: 0.9rem; }
  .pill { color: white; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
  .muted { color: #57606a; font-size: 0.85rem; }
  .error { color: #cf222e; }
  .banner { padding: 0.5rem 1rem; border-radius: 6px; margin-top: 1rem; }
  .banner.report { background: #ddf4ff; }
  .banner.enforce { background: #fff1e5; }
</style>
</head>
<body>
  <h1>Fleet Control Plane</h1>
  <p class="muted">Self-healing, cost-aware reconciliation for your Maritime fleet.</p>
  ${body}
</body>
</html>`;
}

module.exports = { renderDashboard };
