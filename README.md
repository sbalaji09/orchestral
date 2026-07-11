# Fleet Control Plane

A Maritime-hosted agent that operates your other Maritime agents. It runs a **reconciliation loop** over your fleet — senses each agent's state, classifies health, self-heals what's broken, flags cost leaks, and reports — then goes back to sleep. It is the reference implementation of Maritime's own "drive the CLI from an AI agent" pitch, built as a real control plane.

The mental model is a Kubernetes controller, not a script: it continuously drives *actual fleet state* toward *desired state* and reconciles drift. The one distinction that separates this from a toy: **`sleeping` is healthy** (it saves money and is the whole point of serverless agents), `error` is an incident, and `always_on` + idle is a cost leak. The policy must treat those three differently.

---

## 0. Ground truth — verify before you build

This README was written against the Maritime docs as of July 2026. The platform moves fast. **Before implementing any command, introspect the live contract** rather than trusting syntax from this file:

```bash
maritime guide --json     # full machine-readable manifest of every command + flag
maritime templates        # no auth required
```

Specifically **confirm these three against `maritime guide --json` or https://maritime.sh/docs**, because they're the parts most likely to have drifted or that this README is least certain about:

1. **Spend/cost data.** There may be no dedicated `maritime spend` command. If there isn't, derive cost from tier (see §5). Check `maritime status`/`maritime info --json` for any spend/compute fields first.
2. **Trigger creation syntax.** `maritime triggers <agent>` *lists* triggers; confirm how to *create* a cron trigger that POSTs to this controller's `/reconcile`. See https://maritime.sh/docs and the CLI reference.
3. **Key scope.** Lifecycle ops (`restart`, `sleep`, `scale`) require the `manage` scope. The default key scope is `provision,deploy,secrets`, which is **not enough**. Mint with `--scopes manage`.

If a command in this README fails, re-check `maritime guide --json` before working around it. Do not invent commands.

### 0.1 Smoke test FIRST (the load-bearing assumption)

The whole design assumes a running Maritime agent's container has **outbound network access to the Maritime API**, so it can drive the *other* agents. This is strongly implied by Maritime's "drive the CLI from an AI agent" positioning but is not explicitly documented. **Verify it in the first five minutes, before building anything else.**

Deploy the most trivial possible container: on boot, run `maritime list --json` with `MARITIME_TOKEN` injected, and print the result. Then:

```bash
maritime logs <smoke-test-agent>
```

- If you see the fleet come back → the assumption holds; build the rest.
- If it returns empty / auth error / network error → you've found the blocker at minute five. Note it as a "confusing part" for the Maritime submission and switch to the fallback in §9.1.

---

## 1. Architecture

Single containerized service, deployed as a public Maritime web agent. One reconciliation pass is:

```
sense → classify → decide → act → report
```

- **sense** — `maritime list --json` for the whole fleet; `maritime status`, `maritime logs --level error --json`, `maritime history --json` for anything not obviously healthy.
- **classify** — deterministic health + cost classification per agent (§5). Pure function, no LLM.
- **decide** — map each classification to an action under guardrails (§5). Pure function.
- **act** — execute via the Maritime CLI wrapper. Bounded, logged, reversible.
- **report** — structured summary always; an LLM turns the structured diff into a human-readable incident report *only if* `ANTHROPIC_API_KEY` is set. Dispatched to the dashboard, and to email via the agent's Maritime identity.

**The LLM never decides remediation. It only writes prose about decisions already made.** This is deliberate and worth saying out loud in the demo — the ops logic is deterministic code, not vibes.

---

## 2. Repo layout

```
fleet-control-plane/
├── README.md            # this file
├── Dockerfile           # node base; installs maritime-cli; exposes $PORT
├── package.json
├── desired-state.json   # what SHOULD be running (managed agents + expected tiers)
└── src/
    ├── index.js         # HTTP server: /, /health, /state, /reconcile
    ├── maritime.js      # thin wrapper: spawn maritime CLI, parse --json, map exit codes
    ├── policy.js        # classify(agent) -> health; decide(health) -> action. PURE, no I/O
    ├── reconcile.js     # the sense→act loop; orchestrates maritime.js + policy.js
    ├── report.js        # structured summary + optional LLM narration + email dispatch
    └── dashboard.js     # renders the fleet table / incident log HTML for GET /
```

---

## 3. Interfaces

HTTP server on `$PORT` (Maritime injects `PORT`; default 8080):

| Method + path   | Purpose |
|-----------------|---------|
| `GET /`         | Live dashboard: fleet table (name, status, tier, health, last action), spend summary, recent incident/action log. Auto-refreshes. |
| `GET /health`   | Liveness probe. `200 {ok:true}`. |
| `GET /state`    | Current fleet snapshot as JSON (last sensed state + classifications). |
| `POST /reconcile` | Run exactly one reconciliation pass. Returns the structured summary as JSON. **This is the endpoint the cron trigger calls.** |

Also run an internal interval timer as a backstop that calls the same reconcile function, in case the cron trigger isn't wired. Cron trigger is primary; interval is belt-and-suspenders.

---

## 4. Configuration (env / secrets)

Set via `maritime env set` / `-e` at create time. Secrets are encrypted by default.

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `MARITIME_TOKEN` | **yes** | — | `mk_…` key, scope `manage`. How the controller drives the fleet. |
| `RECONCILE_MODE` | no | `report` | `report` = observe + alert only (dry run). `enforce` = actually restart/sleep/scale. **Default to dry run.** |
| `ANTHROPIC_API_KEY` | no | — | If set, LLM writes incident narration. If absent, structured summary only. |
| `REPORT_EMAIL` | no | — | Where digests go, via the agent's Maritime email identity. |
| `IDLE_MINUTES_THRESHOLD` | no | `60` | An `always_on` agent idle longer than this is a cost leak. |
| `MAX_RESTARTS_PER_WINDOW` | no | `3` | Crash-loop guard. More than this in the window → stop restarting, escalate. |
| `RESTART_WINDOW_MINUTES` | no | `30` | Window for the restart counter. |
| `SELF_AGENT_NAME` | no | `fleet-control-plane` | The controller must **never act on itself.** Exclude this from all remediation. |

---

## 5. Core logic spec (`policy.js`)

### Health classification — `classify(agent, logs, history) -> health`

| Condition | Health | Rationale |
|-----------|--------|-----------|
| status `active`, no error logs | `OK` | Running fine. |
| status `sleeping` | `OK_SLEEPING` | **Healthy.** Saving money. Never wake it. |
| status `error`, or crashed, or last deploy in `history` failed | `INCIDENT` | Needs remediation. |
| status `active` + tier `always_on` + idle > `IDLE_MINUTES_THRESHOLD` | `COST_LEAK` | Burning $10/mo doing nothing. |
| in fleet, not in `desired-state.json` | `DRIFT_UNMANAGED` | Unexpected agent. |
| in `desired-state.json`, missing from fleet | `DRIFT_MISSING` | Expected agent gone. |
| tier ≠ desired tier | `DRIFT_TIER` | Config drift. |

### Decision — `decide(health, restartCount) -> action`

| Health | Action (enforce mode) | Action (report mode) |
|--------|-----------------------|----------------------|
| `OK`, `OK_SLEEPING` | none | none |
| `INCIDENT` | `maritime restart` if `restartCount < MAX_RESTARTS_PER_WINDOW`, else `ESCALATE` | alert |
| `COST_LEAK` | `maritime scale <agent> smart` (or alert — make configurable) | alert |
| `DRIFT_UNMANAGED` | alert only — **never auto-delete** | alert |
| `DRIFT_MISSING` | recreate from blueprint / `maritime.json` (stretch) — else alert | alert |
| `DRIFT_TIER` | `maritime scale` to desired tier | alert |

### Guardrails (non-negotiable — these are the "not a toy" part)

- **Dry run by default.** Nothing is mutated unless `RECONCILE_MODE=enforce`.
- **Never auto-delete anything.** The blast radius of a wrong delete is unrecoverable. Restart/sleep/scale only; everything else escalates to a human.
- **Bounded restarts.** Respect `MAX_RESTARTS_PER_WINDOW` so a crash-looping agent doesn't get thrashed.
- **Never act on self.** Exclude `SELF_AGENT_NAME`.
- **Every action logged** with before/after state, surfaced in `/state` and the dashboard.

### Cost estimate

If no spend API exists (verify per §0), estimate monthly spend as the sum over agents of tier price — `smart $1`, `extended $5`, `always_on $10` (confirm current prices in docs). Report total + top spenders + flagged leaks. State clearly in the UI that it's an estimate if derived from tier.

---

## 6. `desired-state.json` shape

```json
{
  "managed_agents": [
    { "name": "support-bot",   "expected_tier": "smart" },
    { "name": "data-pipeline", "expected_tier": "extended" }
  ],
  "ignore": ["fleet-control-plane"]
}
```

Anything in the fleet but not listed → `DRIFT_UNMANAGED` (alert). Anything listed but absent → `DRIFT_MISSING`.

---

## 7. Dockerfile requirements

- Node 18+ base.
- `RUN npm install -g maritime-cli` so the container can shell out to `maritime`.
- Copy source, `npm install`, `EXPOSE` and bind the server to `process.env.PORT || 8080`.
- The container authenticates purely via the injected `MARITIME_TOKEN` env var — **no interactive login.**

---

## 8. Build & deploy runbook

```bash
# 1. Mint a scoped key (lifecycle ops need `manage`)
maritime keys create --name fleet-cp --scopes manage --json
export MARITIME_TOKEN=mk_xxxxxxxxxxxx

# 2. Push this repo to GitHub (must contain the Dockerfile)

# 3. Deploy as a public web agent
maritime create fleet-control-plane \
  --repo https://github.com/<you>/fleet-control-plane \
  --public --port 8080 \
  -e MARITIME_TOKEN=$MARITIME_TOKEN \
  -e RECONCILE_MODE=report

# 4. Wire a cron trigger that POSTs to /reconcile every N minutes.
#    CONFIRM exact syntax via `maritime guide --json` / docs (see §0).

# 5. Verify
maritime status fleet-control-plane
maritime open fleet-control-plane        # opens the public dashboard
```

Start in `report` mode, confirm classifications look right on the dashboard, *then* flip `RECONCILE_MODE=enforce` with `maritime env set fleet-control-plane RECONCILE_MODE=enforce --reload`.

---

## 9. 60-second demo script

1. Show the dashboard on the public `*.maritime.sh` URL — fleet all green. (Proves it's hosted on Maritime.)
2. Break an agent live: `maritime stop demo-victim` (or deploy one that crashes on boot).
3. Trigger a pass: `curl -X POST https://<controller-url>/reconcile` (or wait for cron).
4. Dashboard flips the agent to **INCIDENT**, controller restarts it, incident log shows the action, agent returns to green.
5. Point at an `always_on` idle agent flagged as a **cost leak** with an estimated $/mo. End.

The whole story in one line for the video: *"An agent, running on Maritime, that keeps the rest of my Maritime fleet healthy and cheap — self-healing, cost-aware, dry-run-safe."*

### 9.1 Fallback demo (only if the §0.1 smoke test fails)

If the container can't reach the Maritime API: run the reconciliation loop from your laptop against the fleet, and deploy just the **dashboard** on Maritime as the public web agent, reading from a small state file the loop writes. Less elegant, but you still get "hosted on Maritime" + the self-healing story. Only fall back if the smoke test actually fails.

---

## 10. Acceptance criteria

- [ ] Deploys via `maritime create --repo --public` and serves a dashboard on its public URL.
- [ ] `POST /reconcile` senses the real fleet via `maritime list --json` and returns a structured summary.
- [ ] Correctly classifies `sleeping` as healthy and does **not** wake sleeping agents.
- [ ] Detects an errored agent and restarts it in `enforce` mode; only alerts in `report` mode.
- [ ] Flags an idle `always_on` agent as a cost leak with an estimated cost.
- [ ] Never acts on itself; never deletes anything; respects the restart cap.
- [ ] Every action appears in the incident/action log.
- [ ] Runs on cron via a Maritime trigger, with the interval timer as backstop.

---

## 11. Stretch (only if time remains)

- Recreate `DRIFT_MISSING` agents from a Maritime **blueprint** (`maritime blueprint deploy`).
- Webhook push triggers on state change instead of pure polling.
- Telegram/Discord trigger for real-time incident alerts using Maritime's built-in trigger types.
- Persist incident history to the agent's workspace disk so it survives sleep/wake.

---

## Build order (for the agent scaffolding this)

1. **§0.1 smoke test** — trivial container that runs `maritime list --json` on boot. Deploy, confirm egress works. Do not proceed until this passes (or fall back per §9.1).
2. `maritime.js` — CLI wrapper (spawn, parse `--json`, map exit codes).
3. `policy.js` — pure `classify` + `decide`. Unit-testable with no I/O.
4. `reconcile.js` — wire sense→classify→decide→act, in `report` mode.
5. `index.js` + `dashboard.js` — HTTP server and the fleet table UI.
6. Deploy public, verify the happy path (break-and-heal in `enforce` mode).
7. Only then: `report.js` LLM narration, cron trigger, and any §11 stretch items.
