import type { DeployContext } from './context.js';
import { ensureAdvbotPluginConfig } from './configure-channel.js';
import { runCommand } from '../utils/run.js';

export async function precheck(ctx: DeployContext): Promise<void> {
  await runCommand('nemoclaw', ['--version'], {
    dryRun: ctx.options.dryRun,
    timeoutMs: 10_000,
    description: '检查本机 nemoclaw CLI 是否可执行'
  });

  try {
    await runCommand('nemoclaw', [ctx.sandboxName, 'status', '--json'], {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: '读取 sandbox 状态，确认 sandbox 已创建并运行'
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        'sandbox 不可用，请先确认 sandbox 已创建并运行。',
        `可尝试执行：nemoclaw ${ctx.sandboxName} recover`,
        detail
      ].join('\n')
    );
  }

  if (ctx.channel.enabled) {
    await ensureAdvbotPluginConfig(ctx);
  }

  try {
    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'openclaw', 'config', 'validate'], {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: '验证 OpenClaw 配置是否有效，避免后续 agents/channel 命令因配置损坏失败'
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/unknown channel id:\s*advbot/i.test(detail)) {
      throw new Error(
        [
          'OpenClaw 配置无效：channels.advbot 是当前 OpenClaw 不认识的 channel id。',
          '部署已停止，避免继续执行后续命令。',
          '',
          '可先尝试修复：',
          `nemoclaw ${ctx.sandboxName} exec -- openclaw doctor --fix --non-interactive`,
          '',
          '如果当前 OpenClaw 版本不支持 advbot，请移除 channels.advbot，或在 deploy.yaml 中设置 channel.enabled: false。',
          '',
          detail
        ].join('\n')
      );
    }

    throw new Error(['OpenClaw 配置无效，请先修复后再部署。', detail].join('\n'));
  }
}
