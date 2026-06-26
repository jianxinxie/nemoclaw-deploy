import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { collectSkillDirs } from '../utils/validators.js';

export interface InstallSkillResult {
  status: 'skipped' | 'installed';
  count: number;
}

export async function installSkill(ctx: DeployContext): Promise<InstallSkillResult> {
  if (!ctx.skill.enabled) return { status: 'skipped', count: 0 };
  if (!ctx.skill.hostDir) {
    throw new Error('skill.hostDir 是必填字段');
  }

  const skillDirs = await collectSkillDirs(ctx.skill.hostDir);
  logger.info(`发现 ${skillDirs.length} 个 skill，将逐个安装到 sandbox ${ctx.sandboxName}。`);

  for (const skillDir of skillDirs) {
    logger.info(`安装 skill: ${skillDir}`);
    await runCommand('nemoclaw', [ctx.sandboxName, 'skill', 'install', skillDir], {
      dryRun: ctx.options.dryRun,
      description: `安装 skill ${skillDir}`
    });
  }

  return { status: 'installed', count: skillDirs.length };
}
