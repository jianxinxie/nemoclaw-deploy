import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

export async function createAgent(ctx: DeployContext): Promise<void> {
  const initialListResult = await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'agents', 'list', '--json'],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 60_000,
      description: '创建前读取 agent 列表，已存在则跳过创建'
    }
  );

  if (syncExistingAgentContext(ctx, initialListResult.stdout)) {
    logger.info(`agent 已存在，跳过创建: ${ctx.agentName}`);
    return;
  }

  try {
    await runCommand(
      'nemoclaw',
      [
        ctx.sandboxName,
        'agents',
        'add',
        ctx.agentName,
        '--workspace',
        ctx.workspace,
        '--non-interactive',
        '--json'
      ],
      {
        dryRun: ctx.options.dryRun,
        timeoutMs: 120_000,
        description: '创建 OpenClaw agent，并指定 workspace'
      }
    );
    const createdListResult = await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'agents', 'list', '--json'],
      {
        dryRun: ctx.options.dryRun,
        timeoutMs: 60_000,
        description: '创建后读取 agent 列表，使用 OpenClaw 返回的实际 workspace'
      }
    );
    if (!syncExistingAgentContext(ctx, createdListResult.stdout)) {
      throw new Error(`agents add 已返回成功，但 agents list 中未找到 ${ctx.agentName}`);
    }
    return;
  } catch (createError) {
    const listResult = await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'agents', 'list', '--json'],
      {
        dryRun: ctx.options.dryRun,
        timeoutMs: 60_000,
        description: '创建失败后读取 agent 列表，判断 agent 是否已存在'
      }
    );

    if (syncExistingAgentContext(ctx, listResult.stdout)) {
      logger.info(`agent 已存在，继续后续步骤: ${ctx.agentName}`);
      return;
    }

    const detail = createError instanceof Error ? createError.message : String(createError);
    throw new Error(`创建 agent 失败，且 agents list 中未找到 ${ctx.agentName}\n${detail}`);
  }
}

export function agentListContains(raw: string, agentName: string): boolean {
  try {
    return Boolean(findAgentRecord(JSON.parse(raw), agentName));
  } catch {
    return raw.includes(`"${agentName}"`) || raw.split(/\s+/).includes(agentName);
  }
}

function syncExistingAgentContext(ctx: DeployContext, raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return agentListContains(raw, ctx.agentName);
  }

  const agent = findAgentRecord(parsed, ctx.agentName);
  if (!agent) return false;

  const liveWorkspace = readString(agent.workspace, agent.workspacePath, agent.workspaceDir);
  if (liveWorkspace && liveWorkspace !== ctx.workspace) {
    const configuredWorkspace = ctx.workspace;
    logger.warn(
      `agent ${ctx.agentName} 已存在，使用 OpenClaw 中的实际 workspace: ${liveWorkspace}（onboard.yaml 配置为 ${configuredWorkspace}）`
    );
    ctx.workspace = liveWorkspace;
    ctx.env.directory = rebaseWorkspacePath(
      ctx.env.directory,
      configuredWorkspace,
      liveWorkspace
    );
    ctx.sandbox.commands.workingDir = rebaseWorkspacePath(
      ctx.sandbox.commands.workingDir,
      configuredWorkspace,
      liveWorkspace
    );
  }
  return true;
}

function findAgentRecord(value: unknown, agentName: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAgentRecord(item, agentName);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  if (record.name === agentName || record.agentName === agentName || record.id === agentName) {
    return record;
  }

  if (Object.prototype.hasOwnProperty.call(record, agentName)) {
    const keyed = record[agentName];
    if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) {
      return keyed as Record<string, unknown>;
    }
  }

  for (const item of Object.values(record)) {
    const found = findAgentRecord(item, agentName);
    if (found) return found;
  }
  return undefined;
}

function readString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function rebaseWorkspacePath(value: string, from: string, to: string): string {
  if (value === from) return to;
  if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  return value;
}
