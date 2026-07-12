const reconcile = require('./reconcile');
const report = require('./report');

const REMEDIATE_TOOL_NAME = 'remediate_agent';
const START_TOOL_NAME = 'start_agent';

function summarizeAgent({ agent, health }) {
  const price = report.TIER_PRICE_CENTS[agent.tier];
  const parts = [`${agent.name}: status=${agent.status}, tier=${agent.tier}, health=${health}`];
  if (price != null) parts.push(`est_cost=$${(price / 100).toFixed(2)}/mo`);
  if (agent.desiredTier && agent.desiredTier !== agent.tier) parts.push(`desired_tier=${agent.desiredTier}`);
  if (agent.logs?.length) {
    const messages = agent.logs.slice(0, 3).map((l) => l.message).join(' | ');
    parts.push(`recent_error_logs=[${messages}]`);
  }
  if (agent.history?.[0]) {
    parts.push(`last_deploy_status=${agent.history[0].status}`);
  }
  return parts.join('; ');
}

function buildSystemPrompt(senseState, mode) {
  const fleetLines = senseState.results.map(summarizeAgent).join('\n');
  const missingLines = senseState.missing.map((d) => `${d.name}: MISSING from fleet (expected tier ${d.expected_tier})`).join('\n');
  const totalCostCents = senseState.results.reduce((sum, r) => sum + (report.TIER_PRICE_CENTS[r.agent.tier] || 0), 0);

  return `You are the conversational interface for a Maritime fleet control plane. You answer questions about the fleet and can request remediation for a specific agent.

Current fleet state (freshly sensed, may differ from what the user last saw):
${fleetLines || '(no managed agents)'}
${missingLines ? `\nMissing agents:\n${missingLines}` : ''}

Estimated total spend: $${(totalCostCents / 100).toFixed(2)}/mo (derived from tier pricing — no dedicated Maritime spend API exists).

Controller mode: ${mode} ${mode !== 'enforce' ? '(dry run — remediation requests are evaluated but not executed)' : '(remediation requests may actually execute)'}.

Rules:
- Answer informational questions directly and factually using only the fleet state above. Don't invent data.
- If the user asks you to fix, restart, heal, or remediate a specific agent that has a problem, call ${REMEDIATE_TOOL_NAME} with that agent's exact name. A sleeping agent is healthy, not broken — don't call this for a sleeping agent, use ${START_TOOL_NAME} instead if the user wants it running.
- If the user asks you to start, wake up, or turn on a specific agent that is currently sleeping or stopped, call ${START_TOOL_NAME} with that agent's exact name.
- Both tools only propose an action — a separate deterministic policy layer decides whether it's actually allowed or executed (dry-run mode, restart caps, and other guardrails all apply regardless of what you request). Do not claim an action succeeded — the tool result will tell you what actually happened, and you should report that faithfully in your next reply.
- Never claim you can restart, scale, start, or delete anything directly — you can only request it via a tool.
- If asked to act on the fleet-control-plane agent itself, or on an agent not listed above, explain that it's out of scope rather than calling a tool.`;
}

function buildTools(senseState) {
  const agentNames = senseState.results.map((r) => r.agent.name);
  if (!agentNames.length) return [];
  return [
    {
      type: 'function',
      function: {
        name: REMEDIATE_TOOL_NAME,
        description: 'Request remediation for one managed agent that has a problem (errored, crashed, stopped unexpectedly). A deterministic policy layer decides the actual action (or none) and whether it executes.',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string', enum: agentNames, description: 'Exact name of the agent to remediate.' },
          },
          required: ['agentName'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: START_TOOL_NAME,
        description: 'Request starting a sleeping or stopped agent that the user wants running right now. Only makes sense for agents that are currently sleeping or stopped.',
        parameters: {
          type: 'object',
          properties: {
            agentName: { type: 'string', enum: agentNames, description: 'Exact name of the agent to start.' },
          },
          required: ['agentName'],
        },
      },
    },
  ];
}

function describeOutcome(result) {
  const { name, health, decision, actionResult } = result;
  if (actionResult.executed) {
    return `${name} was classified ${health} and ${decision.action} was executed.`;
  }
  if (decision.action === 'NONE') {
    return `${name} is healthy (${health}) — no remediation was needed.`;
  }
  if (decision.action === 'ESCALATE') {
    return `${name} is ${health}, but it already hit the restart cap in the current window — escalating instead of restarting again.`;
  }
  if (actionResult.skippedReason) {
    return `${name} was classified ${health}, decision was ${decision.action}, but it was NOT executed: ${actionResult.skippedReason}.`;
  }
  if (actionResult.error) {
    return `${name} was classified ${health}, decision was ${decision.action}, but execution failed: ${actionResult.error}.`;
  }
  return `${name} was classified ${health}; decision was ${decision.action} (not executed).`;
}

function describeStartOutcome(name, result) {
  if (result.executed) {
    return `${name} was sleeping/stopped — start was executed, it should be active shortly.`;
  }
  if (result.skippedReason === 'RECONCILE_MODE is not enforce') {
    return `${name} is sleeping/stopped and would be started, but RECONCILE_MODE is report — this is a dry run, nothing was executed.`;
  }
  if (result.skippedReason) {
    return `Didn't start ${name}: it's ${result.skippedReason.replace('already ', '')} already.`;
  }
  if (result.error) {
    return `Tried to start ${name}, but it failed: ${result.error}.`;
  }
  return `${name}: start was not executed.`;
}

async function callLLM(messages, tools) {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('No LLM credentials configured (OPENAI_API_KEY/OPENAI_BASE_URL missing).');
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, tools: tools.length ? tools : undefined, max_tokens: 400 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM call failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function handleChatMessage(userMessage) {
  const senseState = await reconcile.senseAndClassify();
  const { mode, thresholds, restartWindowMinutes } = reconcile.getConfig();

  const tools = buildTools(senseState);
  const messages = [
    { role: 'system', content: buildSystemPrompt(senseState, mode) },
    { role: 'user', content: userMessage },
  ];

  const first = await callLLM(messages, tools);
  const choice = first.choices?.[0];
  const toolCalls = choice?.message?.tool_calls;

  if (!toolCalls?.length) {
    return choice?.message?.content?.trim() || "I don't have a response for that.";
  }

  // Both tools take only an agent name, so handle the first call in this
  // turn; extra calls are ignored rather than executing multiple actions
  // from one ambiguous request.
  const call = toolCalls[0];
  let agentName;
  try {
    agentName = JSON.parse(call.function.arguments).agentName;
  } catch {
    return "I tried to request that but couldn't parse which agent you meant.";
  }

  const target = senseState.results.find((r) => r.agent.name === agentName);
  if (!target) {
    return `I can't act on "${agentName}" — it's not a managed agent I have visibility into.`;
  }

  if (call.function.name === START_TOOL_NAME) {
    const result = await reconcile.startAgent(target.agent, mode);
    return describeStartOutcome(agentName, result);
  }

  const result = await reconcile.evaluateAndAct(target.agent, thresholds, restartWindowMinutes, mode);
  return describeOutcome(result);
}

module.exports = { handleChatMessage };
