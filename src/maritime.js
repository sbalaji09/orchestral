const { spawn } = require('child_process');

const EXIT_CODES = {
  0: 'ok',
  1: 'error',
  2: 'auth',
  3: 'not_found',
  4: 'usage',
};

class MaritimeError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.name = 'MaritimeError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

// Spawns `maritime <args> --json`. Inherits process.env so MARITIME_TOKEN
// (injected by Maritime itself) reaches the CLI without ever touching it here.
function runMaritime(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('maritime', [...args, '--json']);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) => {
      reject(new MaritimeError('spawn_failed', `Failed to spawn maritime CLI: ${err.message}`, null));
    });

    proc.on('close', (exitCode) => {
      if (exitCode === 0) {
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch (err) {
          reject(new MaritimeError('parse_error', `Could not parse maritime stdout as JSON: ${err.message}`, exitCode));
        }
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stderr.trim());
      } catch {
        // stderr wasn't JSON; fall through to the raw text.
      }

      const code = parsed?.error?.code || EXIT_CODES[exitCode] || 'unknown';
      const message = parsed?.error?.message || stderr.trim() || `maritime exited with code ${exitCode}`;
      reject(new MaritimeError(code, message, exitCode));
    });
  });
}

function list() {
  return runMaritime(['list']);
}

function status(agentName) {
  return runMaritime(['status', agentName]);
}

function logs(agentName, { level, lines } = {}) {
  const args = ['logs', agentName];
  if (lines != null) args.push('-n', String(lines));
  if (level) args.push('--level', level);
  return runMaritime(args);
}

function history(agentName, { limit } = {}) {
  const args = ['history', agentName];
  if (limit != null) args.push('-n', String(limit));
  return runMaritime(args);
}

function restart(agentName) {
  return runMaritime(['restart', agentName]);
}

function start(agentName) {
  return runMaritime(['start', agentName]);
}

function scale(agentName, tier) {
  return runMaritime(['scale', agentName, tier]);
}

function sleep(agentName) {
  return runMaritime(['sleep', agentName]);
}

module.exports = {
  MaritimeError,
  EXIT_CODES,
  runMaritime,
  list,
  status,
  logs,
  history,
  restart,
  start,
  scale,
  sleep,
};
