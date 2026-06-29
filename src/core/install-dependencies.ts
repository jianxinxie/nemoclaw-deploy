import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

export interface InstallDependenciesResult {
  status: 'skipped' | 'installed' | 'partial';
  count: number;
}

export async function installDependencies(
  ctx: DeployContext
): Promise<InstallDependenciesResult> {
  if (!ctx.dependencies.enabled) return { status: 'skipped', count: 0 };
  if (ctx.dependencies.commands.length === 0) {
    throw new Error('dependencies.commands 至少需要一个命令');
  }

  let installed = 0;
  logger.info(`将在 ${ctx.dependencies.workingDir} 下执行 ${ctx.dependencies.commands.length} 条依赖命令。`);

  for (const command of ctx.dependencies.commands) {
    logger.info(`依赖命令: ${command}`);
    try {
      await runCommand(
        'nemoclaw',
        [
          ctx.sandboxName,
          'exec',
          '--',
          'env',
          `DEPENDENCIES_WORKDIR=${ctx.dependencies.workingDir}`,
          'sh',
          '-lc',
          `cd "$DEPENDENCIES_WORKDIR" && ${command}`
        ],
        {
          dryRun: ctx.options.dryRun,
          description: `在 workspace 中执行依赖安装命令: ${command}`
        }
      );
      installed += 1;
    } catch (error) {
      if (!ctx.dependencies.continueOnError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`依赖命令失败，已按 continueOnError=true 继续：${detail}`);
    }
  }

  return {
    status: installed === ctx.dependencies.commands.length ? 'installed' : 'partial',
    count: installed
  };
}
