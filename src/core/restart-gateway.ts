import { setTimeout as sleep } from 'node:timers/promises';
import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { assertSandboxRunning } from './runtime.js';

export type RestartGatewayResult = 'skipped' | 'restarted';

export async function restartGateway(
  ctx: DeployContext,
  description = '重启 OpenClaw 网关（nemoclaw gateway restart），等待 gateway 回到可用状态'
): Promise<RestartGatewayResult> {
  await runCommand('nemoclaw', [ctx.sandboxName, 'gateway', 'restart', '--quiet'], {
    dryRun: ctx.options.dryRun,
    timeoutMs: 600_000,
    ignoreOutput: true,
    description
  });

  await assertSandboxHealthy(ctx);
  logger.info('OpenClaw 网关已重启，sandbox 状态正常。');
  return 'restarted';
}

async function assertSandboxHealthy(ctx: DeployContext): Promise<void> {
  if (ctx.options.dryRun) return;

  const attempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await runCommand('nemoclaw', [ctx.sandboxName, 'status', '--json'], {
        timeoutMs: 60_000,
        logCommand: false,
        description: '确认网关重启后 sandbox 状态可读取'
      });
      assertSandboxRunning(status.stdout);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        logger.warn(`网关重启后状态检查失败（第 ${attempt} 次），5 秒后重试。`);
        await sleep(5_000);
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`网关重启后 sandbox 状态检查失败：${detail}`);
}
