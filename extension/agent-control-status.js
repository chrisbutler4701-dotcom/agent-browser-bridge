const ACTIVE_WINDOW_MS = 30_000;

export function describeAgentControl(last, now = Date.now()) {
  if (!last || typeof last.agentId !== 'string' || !last.agentId || !Number.isFinite(last.at)) return 'No agent has acted on this browser yet.';
  const ageMs = Math.max(0, now - last.at);
  if (ageMs <= ACTIVE_WINDOW_MS) {
    const seconds = Math.round(ageMs / 1000);
    return `${last.agentId} is acting now (last action ${seconds} second${seconds === 1 ? '' : 's'} ago).`;
  }
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  return `Last action by ${last.agentId}, ${minutes} minute${minutes === 1 ? '' : 's'} ago.`;
}
