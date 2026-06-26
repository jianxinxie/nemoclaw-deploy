import { confirm } from '@inquirer/prompts';
import type { DeployContext } from '../core/context.js';
import { collectDeployContext, type DeployCliOptions } from '../core/context.js';
import { precheck } from '../core/precheck.js';
import { createAgent } from '../core/create-agent.js';
import { uploadAgentContent } from '../core/upload-agent-content.js';
import { installSkill } from '../core/install-skill.js';
import { configureChannel } from '../core/configure-channel.js';
import { applyPolicy } from '../core/apply-policy.js';
import { verifyDeployment } from '../core/verify.js';
import { logger } from '../utils/logger.js';
import { maskSecret } from '../utils/mask.js';
import { runCommand } from '../utils/run.js';
import { validateAgentContentDir } from '../utils/validators.js';

interface DeploySummary {
  agentContent: 'skipped' | 'applied';
  skill: {
    status: 'skipped' | 'installed';
    count: number;
  };
  channel: {
    status: 'skipped' | 'configured';
    restarted: boolean;
    reason?: 'disabled' | 'existing';
  };
  networkPolicy: {
    status: 'skipped' | 'applied';
    count: number;
  };
}

export async function deployCommand(options: DeployCliOptions): Promise<void> {
  const ctx = await collectDeployContext(options);
  printPlan(ctx);

  if (ctx.options.dryRun) {
    logger.warn('dry-run 模式：仅展示部署计划，不执行真实命令。');
    return;
  }

  if (!ctx.options.nonInteractive) {
    const shouldContinue = await confirm({
      message: '是否继续？',
      default: true
    });
    if (!shouldContinue) {
      logger.warn('部署已取消。');
      return;
    }
  }

  await validateRuntimeResources(ctx);

  const summary: DeploySummary = {
    agentContent: 'skipped',
    skill: { status: 'skipped', count: 0 },
    channel: { status: 'skipped', restarted: false, reason: 'disabled' },
    networkPolicy: { status: 'skipped', count: 0 }
  };
  let remoteTempCleaned = false;
  let remoteTempMayExist = false;

  try {
    logger.step('执行预检查...');
    logger.info('确认 nemoclaw 命令可用，并检查 sandbox 状态是否可读取。');
    await precheck(ctx);

    logger.step('创建或确认 agent...');
    logger.info('尝试创建 agent；如果 agent 已存在，会确认列表后继续。');
    await createAgent(ctx);

    logger.step('处理 agent 初始化内容...');
    logger.info('先上传到 sandbox 临时目录，再按冲突策略合并到 workspace，避免直接覆盖已有文件。');
    remoteTempMayExist ||= ctx.agentContent.enabled;
    summary.agentContent = await uploadAgentContent(ctx);

    logger.step('安装 skills...');
    logger.info('扫描 skills 主机目录下包含 SKILL.md 的所有 skill，并逐个执行 nemoclaw skill install。');
    summary.skill = await installSkill(ctx);

    logger.step('配置 advbot channel...');
    logger.info('先检查 advbot channel 是否已存在；未配置时再补齐 gateway token 和 gateway URL。');
    remoteTempMayExist ||= ctx.channel.enabled;
    summary.channel = await configureChannel(ctx);

    logger.step('应用 network policies...');
    logger.info('扫描 network policy 目录下的 .yaml/.yml 文件，并逐个执行 policy-add。');
    summary.networkPolicy = await applyPolicy(ctx);

    const needsRecover =
      ctx.options.restart &&
      (summary.networkPolicy.status === 'applied' ||
        (summary.channel.status === 'configured' && !summary.channel.restarted));

    logger.step('执行基础验证...');
    logger.info('确认 agent 可在列表中看到，sandbox status 可读取，并检查 channel/policy 的关键结果。');
    await verifyDeployment(ctx, { policyApplied: summary.networkPolicy.status === 'applied' });

    await cleanupRemoteTemp(ctx);
    remoteTempCleaned = true;

    if (needsRecover) {
      logger.step('触发 recover...');
      logger.info('基础部署已完成；现在后台触发 sandbox recover，不等待 recover 完成。');
      await runCommand('nemoclaw', [ctx.sandboxName, 'recover'], {
        background: true,
        description: '后台重启/恢复 sandbox，使新配置和 network policy 生效'
      });
    }

    printSummary(ctx, summary);
  } finally {
    if (remoteTempMayExist && !remoteTempCleaned) {
      logger.info('部署未完成，开始清理 sandbox 临时目录。');
      await cleanupRemoteTemp(ctx);
    }
  }
}

function printPlan(ctx: DeployContext): void {
  logger.info('');
  logger.info('部署计划：');
  logger.info('');
  logger.info(`Sandbox: ${ctx.sandboxName}`);
  logger.info(`Agent: ${ctx.agentName}`);
  logger.info(`Workspace: ${ctx.workspace}`);
  logger.info('');
  logger.info(`Agent Content: ${ctx.agentContent.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`Agent Content Dir: ${ctx.agentContent.hostDir ?? '-'}`);
  logger.info(`Conflict Strategy: ${ctx.agentContent.conflictStrategy}`);
  logger.info('');
  logger.info(`Skill: ${ctx.skill.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`Skills Dir: ${ctx.skill.hostDir ?? '-'}`);
  logger.info('');
  logger.info(
    `Channel: ${ctx.channel.enabled ? `${ctx.channel.type}/${ctx.channel.accountId}` : 'disabled'}`
  );
  logger.info(`Channel Server URL: ${ctx.channel.channelServerUrl || '-'}`);
  logger.info(`Gateway URL: ${ctx.channel.gatewayUrl ?? 'auto from dashboard-url'}`);
  logger.info(
    `Gateway Token: ${ctx.channel.gatewayToken ? maskSecret(ctx.channel.gatewayToken) : 'auto from gateway-token'}`
  );
  logger.info('');
  logger.info(`Network Policy: ${ctx.networkPolicy.enabled ? 'enabled' : 'disabled'}`);
  logger.info(`Policy Dir: ${ctx.networkPolicy.dir ?? '-'}`);
  logger.info('');
  logger.info(`Restart / Recover: ${ctx.options.restart ? 'enabled' : 'disabled'}`);
  logger.info('');
}

function printSummary(ctx: DeployContext, summary: DeploySummary): void {
  logger.info('');
  logger.success('部署完成：');
  logger.info('');
  logger.info(`Sandbox: ${ctx.sandboxName}`);
  logger.info(`Agent: ${ctx.agentName}`);
  logger.info(`Workspace: ${ctx.workspace}`);
  logger.info('');
  logger.info(`Agent Content: ${summary.agentContent}`);
  logger.info(
    `Skill: ${summary.skill.status}${
      summary.skill.status === 'installed' ? ` (${summary.skill.count})` : ''
    }`
  );
  logger.info(
    `Channel: ${
      summary.channel.status === 'configured'
        ? `${ctx.channel.type}/${ctx.channel.accountId} configured`
        : summary.channel.reason === 'existing'
          ? 'skipped (existing)'
        : summary.channel.status
    }`
  );
  if (ctx.channel.enabled) {
    logger.info(`Channel Server URL: ${ctx.channel.channelServerUrl}`);
    logger.info(`Gateway URL: ${ctx.channel.gatewayUrl}`);
    logger.info(`Gateway Token: ${maskSecret(ctx.channel.gatewayToken)}`);
  }
  logger.info(
    `Network Policy: ${summary.networkPolicy.status}${
      summary.networkPolicy.status === 'applied' ? ` (${summary.networkPolicy.count})` : ''
    }`
  );
  logger.info('');
  logger.info('验证命令：');
  logger.info(`nemoclaw-deploy doctor --sandbox ${ctx.sandboxName}`);
}

async function validateRuntimeResources(ctx: DeployContext): Promise<void> {
  if (ctx.agentContent.enabled && ctx.agentContent.hostDir) {
    ctx.agentContent.hostDir = await validateAgentContentDir(ctx.agentContent.hostDir);
  }

}

async function cleanupRemoteTemp(ctx: DeployContext): Promise<void> {
  try {
    await runCommand('nemoclaw', [
      ctx.sandboxName,
      'exec',
      '--',
      'rm',
      '-rf',
      `/tmp/nemoclaw-deploy/${ctx.agentName}`
    ], {
      timeoutMs: 10_000,
      description: '清理 sandbox 内 nemoclaw-deploy 临时目录'
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`临时文件清理未完成：${detail}`);
  }
}
