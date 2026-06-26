import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

export async function createAgent(ctx: DeployContext): Promise<void> {
  const initialListResult = await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'agents', 'list', '--json'],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: '创建前读取 agent 列表，已存在则跳过创建'
    }
  );

  if (agentListContains(initialListResult.stdout, ctx.agentName)) {
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
    return;
  } catch (createError) {
    const listResult = await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'agents', 'list', '--json'],
      {
        dryRun: ctx.options.dryRun,
        timeoutMs: 30_000,
        description: '创建失败后读取 agent 列表，判断 agent 是否已存在'
      }
    );

    if (agentListContains(listResult.stdout, ctx.agentName)) {
      logger.info(`agent 已存在，继续后续步骤: ${ctx.agentName}`);
      return;
    }

    const detail = createError instanceof Error ? createError.message : String(createError);
    throw new Error(`创建 agent 失败，且 agents list 中未找到 ${ctx.agentName}\n${detail}`);
  }
}

export function agentListContains(raw: string, agentName: string): boolean {
  try {
    return containsAgent(JSON.parse(raw), agentName);
  } catch {
    return raw.includes(`"${agentName}"`) || raw.split(/\s+/).includes(agentName);
  }
}

function containsAgent(value: unknown, agentName: string): boolean {
  if (typeof value === 'string') return value === agentName;
  if (Array.isArray(value)) return value.some((item) => containsAgent(item, agentName));
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  if (record.name === agentName || record.agentName === agentName || record.id === agentName) {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(record, agentName)) {
    return true;
  }

  return Object.values(record).some((item) => containsAgent(item, agentName));
}
