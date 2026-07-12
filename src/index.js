const http = require('http');
const reconcile = require('./reconcile');
const dashboard = require('./dashboard');
const chat = require('./chat');

const PORT = process.env.PORT || 8080;
const BACKSTOP_INTERVAL_MS = 5 * 60 * 1000;

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

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

  // Maritime's native chat channel POSTs here with {message, source}. It
  // expects the reply as the raw response body text (wrapped as {response}
  // by the CLI), not a JSON envelope — so this returns plain text.
  if (req.method === 'POST' && url.pathname === '/chat') {
    let message;
    try {
      const body = await readBody(req);
      message = JSON.parse(body).message;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Could not parse chat message.');
      return;
    }
    if (!message || typeof message !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing "message" field.');
      return;
    }
    try {
      const reply = await chat.handleChatMessage(message);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(reply);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Chat handler error: ${err.message}`);
    }
    return;
  }

  // Direct "Start" button on the dashboard — a UI shortcut onto the exact
  // same reconcile.startAgent() the chat tool calls, not a new mutation path.
  if (req.method === 'POST' && url.pathname.startsWith('/agents/') && url.pathname.endsWith('/start')) {
    const agentName = decodeURIComponent(url.pathname.slice('/agents/'.length, -'/start'.length));
    try {
      const senseState = await reconcile.senseAndClassify();
      const target = senseState.results.find((r) => r.agent.name === agentName);
      if (!target) {
        sendJson(res, 404, { ok: false, error: `"${agentName}" is not a managed agent.` });
        return;
      }
      const { mode } = reconcile.getConfig();
      const result = await reconcile.startAgent(target.agent, mode);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
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
