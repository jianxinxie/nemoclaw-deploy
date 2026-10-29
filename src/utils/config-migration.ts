export function assertNoLegacySkillConfig(raw: unknown): void {
  const agents = (raw as { deploy?: { agents?: unknown[] } } | null)?.deploy?.agents;
  if (!Array.isArray(agents)) return;
  for (const [index, agent] of agents.entries()) {
    if (agent && typeof agent === 'object' && Object.hasOwn(agent, 'skill')) {
      throw new Error(`deploy.agents[${index}].skill 已移除。请将技能目录放到 agentContent.hostDir 下的 skills/<name>/SKILL.md，随 agent 内容一起上传，并删除独立 skill 配置。`);
    }
  }
}
