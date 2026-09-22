export const terminalRun = state => ['completed', 'failed', 'interrupted'].includes(state?.status);
export function mergeRunState(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.runId === incoming.runId) {
    if (Number(current.generation || 0) !== Number(incoming.generation || 0)) return Number(incoming.generation || 0) > Number(current.generation || 0) ? incoming : current;
    return Number(incoming.version || 0) >= Number(current.version || 0) ? incoming : current;
  }
  return String(incoming.startedAt || '') >= String(current.startedAt || '') ? incoming : current;
}
export function committedSections(resources = []) {
  const names = { character: 'characters', 'character-memory': 'characters', world: 'world', timeline: 'timeline', outline: 'outline', style: 'style', asset: 'assets' };
  return [...new Set(resources.map(item => names[String(item.resourceRef || '').split(':')[0]]).filter(Boolean))];
}
