export interface AgentConfigPatch {
  id: string;
  patch: Record<string, unknown>;
}

/** Self-contained so the sandbox uses the same validation as host preflight. */
export function parseAgentConfigPatches(input: unknown): AgentConfigPatch[] {
  const plain = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!plain(input)) throw new Error('openclawConfig.file 的 agents 必须是对象');
  if (Object.keys(input).some(key => key !== 'entries' && key !== 'list')) {
    throw new Error('agent partial 仅支持 agents.entries 或 agents.list；默认配置和 agent 生命周期由 OpenClaw 管理');
  }
  if (Object.hasOwn(input, 'entries') && Object.hasOwn(input, 'list')) {
    throw new Error('agent partial 不能同时包含 agents.entries 和 agents.list');
  }
  let entries: Array<[unknown, unknown]> = [];
  if (Object.hasOwn(input, 'entries')) {
    if (!plain(input.entries)) throw new Error('agents.entries 必须是以 agent ID 为键的对象，不能删除 agent');
    entries = Object.entries(input.entries);
  } else if (Object.hasOwn(input, 'list')) {
    if (!Array.isArray(input.list)) throw new Error('agents.list 必须是数组，不能删除 agent');
    entries = input.list.map(entry => [plain(entry) ? entry.id : undefined, entry]);
  }
  const seen = new Set<string>();
  return entries.map(([id, entry]) => {
    if (typeof id !== 'string' || !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(id) ||
        ['__proto__', 'prototype', 'constructor'].includes(id.toLowerCase())) {
      throw new Error('agent partial 必须提供有效的 agent ID；旧格式 agents.list 的每项需要 id');
    }
    if (seen.has(id.toLowerCase())) throw new Error(`agent partial 中 agent ID 重复: ${id}`);
    seen.add(id.toLowerCase());
    if (!plain(entry)) throw new Error(`agent ${id} 的 partial 必须是对象，不能删除 agent`);
    if (Object.hasOwn(entry, 'id') && entry.id !== id) throw new Error(`agent ${id} 的 id 与配置键不一致`);
    for (const field of ['workspace', 'agentDir']) {
      if (Object.hasOwn(entry, field) && (typeof entry[field] !== 'string' || !entry[field])) {
        throw new Error(`agent ${id} 的 ${field} 不能删除或设为空值`);
      }
    }
    const patch = { ...entry };
    delete patch.id;
    return { id, patch };
  });
}
