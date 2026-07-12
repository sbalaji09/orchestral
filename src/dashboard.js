function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// { class, label } — label defaults to the health key itself.
const HEALTH_META = {
  OK: { cls: 'ok', label: 'OK' },
  OK_SLEEPING: { cls: 'sleep', label: 'SLEEPING' },
  INCIDENT: { cls: 'incident', label: 'INCIDENT' },
  COST_LEAK: { cls: 'warn', label: 'COST LEAK' },
  DRIFT_UNMANAGED: { cls: 'warn', label: 'UNMANAGED' },
  DRIFT_MISSING: { cls: 'incident', label: 'MISSING' },
  DRIFT_TIER: { cls: 'warn', label: 'TIER DRIFT' },
};

function fmtCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function healthPill(health) {
  const meta = HEALTH_META[health] || { cls: 'sleep', label: health };
  return `<span class="pill pill-${meta.cls}"><span class="dot"></span>${esc(meta.label)}</span>`;
}

function renderRow(r) {
  const action = r.actionResult?.executed
    ? `${r.decision.action} · executed`
    : r.decision.action === 'NONE'
      ? '—'
      : r.decision.action;
  return `<tr>
    <td class="name-cell">${esc(r.name)}</td>
    <td class="muted">${esc(r.status)}</td>
    <td class="muted">${esc(r.tier || '—')}${r.desiredTier && r.desiredTier !== r.tier ? ` <span class="want">want ${esc(r.desiredTier)}</span>` : ''}</td>
    <td>${healthPill(r.health)}</td>
    <td class="muted">${esc(action)}</td>
  </tr>`;
}

function statCard(label, value, sub) {
  return `<div class="stat">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function renderDashboard(state) {
  if (!state) {
    return page(`
      <div class="card empty-state">
        <p>No reconciliation pass has run yet.</p>
        <p class="muted">One runs automatically shortly after boot — refresh in a few seconds.</p>
      </div>
    `, { mode: null, timestamp: null });
  }

  if (!state.ok) {
    return page(`
      <div class="card empty-state">
        <p class="error-text">Last reconcile pass failed: ${esc(state.error)}</p>
        <p class="muted">Last attempted: ${esc(state.timestamp)}</p>
      </div>
    `, { mode: state.mode, timestamp: state.timestamp });
  }

  const { results, summary, mode, timestamp, narration } = state;

  const rows = results.length
    ? results.map(renderRow).join('\n')
    : `<tr><td colspan="5" class="muted empty-cell">No agents to reconcile — empty fleet, or everything managed is ignored.</td></tr>`;

  const incidentItems = results
    .filter((r) => r.health === 'INCIDENT' || r.health === 'DRIFT_MISSING' || (r.actionResult && r.actionResult.executed))
    .map((r) => `<li>
        <span class="incident-name">${esc(r.name)}</span>
        <span class="muted">${esc(r.health)} → ${esc(r.decision.action)}</span>
        ${r.actionResult?.error ? `<span class="error-text">error: ${esc(r.actionResult.error)}</span>` : ''}
      </li>`)
    .join('\n');

  const spenderItems = summary.topSpenders
    .map((s) => `<li><span>${esc(s.name)}</span><span class="muted">${esc(s.tier)}</span><span class="spend-amount">${fmtCents(s.costCents)}/mo</span></li>`)
    .join('\n');

  const incidentCount = (summary.counts.INCIDENT || 0) + (summary.counts.DRIFT_MISSING || 0);

  const stats = [
    statCard('Agents managed', results.length),
    statCard('Est. monthly spend', fmtCents(summary.estimatedMonthlyCostCents), summary.costNote),
    statCard('Open incidents', incidentCount, incidentCount ? null : 'All clear'),
  ].join('\n');

  const body = `
    <section class="stat-row">${stats}</section>

    <section class="card chat-card">
      <div class="card-header">
        <h2>Ask the control plane</h2>
        <span class="muted">Goes through the same guarded executor as automatic reconciliation</span>
      </div>
      <div id="chat-log" class="chat-log"></div>
      <form id="chat-form" class="chat-form">
        <input id="chat-input" type="text" placeholder="e.g. what's wrong with the fleet? / restart lead-enricher" autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    </section>

    ${narration ? `<section class="card narration-card">
      <div class="card-header"><h2>Incident note</h2><span class="muted">AI-generated, describes decisions already made</span></div>
      <p class="narration-text">${esc(narration)}</p>
    </section>` : ''}

    <section class="card">
      <div class="card-header">
        <h2>Fleet</h2>
        <span class="muted">${results.length} agent${results.length === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Tier</th><th>Health</th><th>Action</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Incidents &amp; actions</h2>
      </div>
      ${incidentItems ? `<ul class="list">${incidentItems}</ul>` : '<p class="muted empty-cell">Nothing to report.</p>'}
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Top spenders</h2>
      </div>
      ${spenderItems ? `<ul class="list spend-list">${spenderItems}</ul>` : '<p class="muted empty-cell">No spend data.</p>'}
    </section>
  `;

  return page(body, { mode, timestamp, resultCount: results.length });
}

function page(body, ctx) {
  const mode = ctx?.mode;
  const modePillCls = mode === 'enforce' ? 'pill-warn' : 'pill-ok';
  const modeLabel = mode ? mode.toUpperCase() : '—';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet Control Plane</title>
<style>
  :root {
    --background: #ffffff;
    --foreground: #0a0a0a;
    --muted-foreground: #6b7280;
    --surface-1: #f7f7f8;
    --surface-2: #ffffff;
    --border: #e5e5e7;
    --border-subtle: #ececed;
    --brand: #f26622;
    --ok-fg: #166534; --ok-bg: #dcfce7;
    --sleep-fg: #52525b; --sleep-bg: #f4f4f5;
    --incident-fg: #b91c1c; --incident-bg: #fee2e2;
    --warn-fg: #92400e; --warn-bg: #fef3c7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: #0a0a0a;
      --foreground: #f5f5f5;
      --muted-foreground: #9a9a9f;
      --surface-1: #141415;
      --surface-2: #18181a;
      --border: #232325;
      --border-subtle: #232325;
      --ok-fg: #4ade80; --ok-bg: rgba(74,222,128,0.12);
      --sleep-fg: #a1a1aa; --sleep-bg: rgba(161,161,170,0.12);
      --incident-fg: #f87171; --incident-bg: rgba(248,113,113,0.14);
      --warn-fg: #fbbf24; --warn-bg: rgba(251,191,36,0.12);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--background);
    color: var(--foreground);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.9rem 1.5rem;
    background: color-mix(in srgb, var(--background) 70%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border-subtle);
  }
  .brand { display: flex; align-items: center; gap: 0.6rem; font-weight: 600; letter-spacing: -0.01em; }
  .brand-dot { width: 0.55rem; height: 0.55rem; border-radius: 999px; background: var(--brand); flex-shrink: 0; }
  header .meta { display: flex; align-items: center; gap: 0.75rem; font-size: 0.8rem; color: var(--muted-foreground); }
  main { max-width: 68rem; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
  .lede { color: var(--muted-foreground); font-size: 0.9rem; margin: 0 0 2rem; }
  h1 { font-size: 1.05rem; margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
  .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-bottom: 2rem; }
  .stat {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    padding: 1.25rem 1.4rem;
  }
  .stat-label { font-size: 0.78rem; color: var(--muted-foreground); margin-bottom: 0.5rem; }
  .stat-value { font-size: 1.9rem; font-weight: 600; letter-spacing: -0.02em; }
  .stat-sub { font-size: 0.75rem; color: var(--muted-foreground); margin-top: 0.35rem; }
  .narration-card { border-color: var(--brand); }
  .narration-text { margin: 0; font-size: 0.92rem; line-height: 1.5; }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    padding: 1.4rem;
    margin-bottom: 1.25rem;
  }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.9rem; }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 0.72rem; font-weight: 500; text-transform: uppercase;
    letter-spacing: 0.03em; color: var(--muted-foreground); padding: 0 0 0.6rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  td { padding: 0.7rem 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.88rem; }
  tr:last-child td { border-bottom: none; }
  .name-cell { font-weight: 500; }
  .muted { color: var(--muted-foreground); }
  .want { font-size: 0.75rem; color: var(--warn-fg); }
  .empty-cell { padding: 1.2rem 0; text-align: left; border-bottom: none; }
  .empty-state { text-align: center; padding: 3rem 1.5rem; }
  .error-text { color: var(--incident-fg); font-size: 0.85rem; }
  .pill {
    display: inline-flex; align-items: center; gap: 0.4rem;
    border-radius: 999px; padding: 0.22rem 0.65rem;
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em;
  }
  .pill .dot { width: 0.4rem; height: 0.4rem; border-radius: 999px; background: currentColor; }
  .pill-ok { color: var(--ok-fg); background: var(--ok-bg); }
  .pill-sleep { color: var(--sleep-fg); background: var(--sleep-bg); }
  .pill-incident { color: var(--incident-fg); background: var(--incident-bg); }
  .pill-warn { color: var(--warn-fg); background: var(--warn-bg); }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.65rem; }
  .list li { display: flex; align-items: center; gap: 0.75rem; font-size: 0.86rem; padding: 0.15rem 0; }
  .incident-name { font-weight: 500; }
  .spend-list li { justify-content: space-between; }
  .spend-amount { font-weight: 500; margin-left: auto; }
  .chat-card { border-color: var(--brand); }
  .chat-log { display: flex; flex-direction: column; gap: 0.6rem; margin-bottom: 0.9rem; max-height: 16rem; overflow-y: auto; }
  .chat-log:empty { display: none; }
  .chat-msg { padding: 0.55rem 0.8rem; border-radius: 0.6rem; font-size: 0.88rem; line-height: 1.45; max-width: 85%; white-space: pre-wrap; }
  .chat-msg.user { align-self: flex-end; background: var(--brand); color: #fff; }
  .chat-msg.assistant { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--border); }
  .chat-msg.pending { color: var(--muted-foreground); font-style: italic; }
  .chat-msg.error { background: var(--incident-bg); color: var(--incident-fg); border: none; }
  .chat-form { display: flex; gap: 0.6rem; }
  .chat-form input {
    flex: 1; padding: 0.55rem 0.8rem; border-radius: 0.6rem; border: 1px solid var(--border);
    background: var(--background); color: var(--foreground); font-size: 0.88rem; font-family: inherit;
  }
  .chat-form input:focus { outline: 2px solid var(--brand); outline-offset: -1px; }
  .chat-form button {
    padding: 0.55rem 1.1rem; border-radius: 0.6rem; border: none; background: var(--brand);
    color: #fff; font-size: 0.85rem; font-weight: 600; cursor: pointer;
  }
  .chat-form button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <header>
    <div class="brand"><span class="brand-dot"></span><h1>Fleet Control Plane</h1></div>
    <div class="meta">
      <span class="pill ${modePillCls}"><span class="dot"></span>${esc(modeLabel)}</span>
      ${ctx?.timestamp ? `<span>updated ${esc(new Date(ctx.timestamp).toLocaleTimeString())}</span>` : ''}
    </div>
  </header>
  <main>
    <p class="lede">Self-healing, cost-aware reconciliation for your Maritime fleet.${ctx?.mode && ctx.mode !== 'enforce' ? ' Dry run — no remediation is executed.' : ''}</p>
    ${body}
  </main>
  <script>
    (function () {
      var REFRESH_MS = 30000;
      var refreshTimer = setTimeout(function () { location.reload(); }, REFRESH_MS);
      function pauseAutoRefresh() { clearTimeout(refreshTimer); }

      var form = document.getElementById('chat-form');
      if (!form) return;
      var input = document.getElementById('chat-input');
      var log = document.getElementById('chat-log');
      var button = form.querySelector('button');

      // The public URL is served behind a path prefix (e.g. /a/<id>/) that
      // Maritime's gateway strips before forwarding to this container — our
      // server only ever sees "/chat". But a fetch('/chat') from the browser
      // resolves against the domain root, bypassing that prefix and missing
      // the gateway entirely. Resolve relative to the current page path instead.
      function apiUrl(relativePath) {
        var base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
        return base + relativePath;
      }

      function addMessage(role, text) {
        var el = document.createElement('div');
        el.className = 'chat-msg ' + role;
        el.textContent = text;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        return el;
      }

      var WAKE_RETRY_ATTEMPTS = 8;
      var WAKE_RETRY_DELAY_MS = 2500;

      function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

      // The controller itself runs on a sleep-when-idle tier, so the first
      // request after a period of inactivity can hit the gateway mid-wake
      // (503, "Agent is starting or asleep"). Retry through that instead of
      // surfacing it as a chat failure.
      function postChatWithRetry(message, pending, attemptsLeft) {
        return fetch(apiUrl('chat'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message, source: 'dashboard' }),
        }).then(function (res) {
          if (res.status === 503 && attemptsLeft > 0) {
            pending.textContent = 'waking up the control plane…';
            return sleep(WAKE_RETRY_DELAY_MS).then(function () {
              return postChatWithRetry(message, pending, attemptsLeft - 1);
            });
          }
          return res.text().then(function (text) { return { ok: res.ok, text: text }; });
        });
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        pauseAutoRefresh();
        var message = input.value.trim();
        if (!message) return;
        addMessage('user', message);
        input.value = '';
        input.disabled = true;
        button.disabled = true;
        var pending = addMessage('assistant pending', 'thinking…');

        postChatWithRetry(message, pending, WAKE_RETRY_ATTEMPTS)
          .then(function (result) {
            pending.textContent = result.text;
            pending.className = result.ok ? 'chat-msg assistant' : 'chat-msg assistant error';
          })
          .catch(function (err) {
            pending.textContent = 'Request failed: ' + err.message;
            pending.className = 'chat-msg assistant error';
          })
          .finally(function () {
            input.disabled = false;
            button.disabled = false;
            input.focus();
          });
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = { renderDashboard };
