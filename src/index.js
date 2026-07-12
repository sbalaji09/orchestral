const http = require('http');
const fs = require('fs');
const reconcile = require('./reconcile');
const dashboard = require('./dashboard');

const PORT = process.env.PORT || 8080;
const BACKSTOP_INTERVAL_MS = 5 * 60 * 1000;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (process.env.DEBUG_LOG_REQUESTS === '1') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const line = `${new Date().toISOString()} ${req.method} ${url.pathname} headers=${JSON.stringify(req.headers)} body=${Buffer.concat(chunks).toString('utf8')}\n`;
      try { fs.appendFileSync('/tmp/debug-requests.log', line); } catch {}
    });
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    const state = reconcile.getLastState();
    sendJson(res, state ? 200 : 202, state || { ok: false, message: 'No reconciliation pass has run yet.' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/reconcile') {
    const state = await reconcile.reconcilePassSafe();
    sendJson(res, state.ok ? 200 : 500, state);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = dashboard.renderDashboard(reconcile.getLastState());
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`fleet-control-plane listening on :${PORT}, mode=${process.env.RECONCILE_MODE || 'report'}`);

  // Run once at boot so /state and the dashboard aren't empty on first load.
  reconcile.reconcilePassSafe().catch((err) => console.error('initial reconcile failed:', err.message));

  // Cron trigger is primary; this interval is belt-and-suspenders per README §3.
  setInterval(() => {
    reconcile.reconcilePassSafe().catch((err) => console.error('backstop reconcile failed:', err.message));
  }, BACKSTOP_INTERVAL_MS);
});
