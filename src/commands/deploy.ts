import { confirm } from '@inquirer/prompts';
import type { DeployContext } from '../core/context.js';
import { collectDeployContext, type DeployCliOptions } from '../core/context.js';
import { precheck } from '../core/precheck.js';
import { createAgent } from '../core/create-agent.js';
import { uploadAgentContent } from '../core/upload-agent-content.js';
import { installSkill } from '../core/install-skill.js';
import { installPlugins } from '../core/install-plugins.js';
import { configureChannel } from '../core/configure-channel.js';
import { configureTools } from '../core/configure-tools.js';
import { restartGateway, type RestartGatewayResult } from '../core/restart-gateway.js';
import { applyPolicy } from '../core/apply-policy.js';
import { configureEnv } from '../core/configure-env.js';
import { installDependencies } from '../core/install-dependencies.js';
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
  plugins: {
    status: 'skipped' | 'configured';
    installed: number;
    enabled: number;
  };
  tools: {
    status: 'skipped' | 'configured';
    profile?: string;
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
  env: {
    status: 'skipped' | 'configured';
    targetFile?: string;
    count: number;
  };
  dependencies: {
    status: 'skipped' | 'installed' | 'partial';
    count: number;
  };
  gatewayRestart: RestartGatewayResult;
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
      message: '确认执行以上部署计划？',
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
    plugins: { status: 'skipped', installed: 0, enabled: 0 },
    tools: { status: 'skipped' },
    channel: { status: 'skipped', restarted: false, reason: 'disabled' },
    networkPolicy: { status: 'skipped', count: 0 },
    env: { status: 'skipped', count: 0 },
    dependencies: { status: 'skipped', count: 0 },
    gatewayRestart: 'skipped'
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

    logger.step('安装 OpenClaw 插件...');
    logger.info('安装缺失的插件，然后在 openclaw.json 中启用并加入 plugins.allow。');
    remoteTempMayExist ||= ctx.plugins.enabled && ctx.plugins.items.some((item) => item.sourceKind === 'path');
    summary.plugins = await installPlugins(ctx);

    logger.step('配置 OpenClaw tools...');
    logger.info('设置 tools.profile（默认 coding），并深合并额外 tools 配置，保留已有 toolSearch/web 等设置。');
    summary.tools = await configureTools(ctx);

    logger.step('配置 advbot channel...');
    logger.info('先检查 advbot channel 是否已存在；未配置时再补齐 gateway token 和 gateway URL。');
    remoteTempMayExist ||= ctx.channel.enabled;
    summary.channel = await configureChannel(ctx);

    logger.step('应用 network policies...');
    logger.info('扫描 network policy 目录下的 .yaml/.yml 文件，并逐个执行 policy-add。');
    summary.networkPolicy = await applyPolicy(ctx);

    logger.step('配置 workspace env...');
    logger.info('把配置中的 workspace env 变量合并写入 workspace env 文件，不写入 sandbox 全局环境。');
    remoteTempMayExist ||= ctx.env.enabled;
    summary.env = await configureEnv(ctx);

    logger.step('安装 workspace 依赖...');
    logger.info('在 agent workspace 中执行依赖安装命令，依赖是否可联网由当前 network policy 决定。');
    summary.dependencies = await installDependencies(ctx);

    logger.step('执行基础验证...');
    logger.info('确认 agent 可在列表中看到，sandbox status 可读取，并检查 channel/policy 的关键结果。');
    await verifyDeployment(ctx, { policyApplied: summary.networkPolicy.status === 'applied' });

    await cleanupRemoteTemp(ctx);
    remoteTempCleaned = true;

    if (ctx.options.restartGateway) {
      logger.step('重启 OpenClaw 网关...');
      logger.info('部署改动已完成；现在重启 OpenClaw gateway，使插件、channel 和 tools 配置生效。');
      summary.gatewayRestart = await restartGateway(
        ctx,
        '重启 OpenClaw 网关，使插件、channel 和 tools 配置生效'
      );
    } else if (
      summary.plugins.status === 'configured' ||
      summary.tools.status === 'configured' ||
      summary.channel.status === 'configured'
    ) {
      logger.warn(
        `OpenClaw 配置已更新，但网关尚未重启，重启前可能不会生效。可执行 nemoclaw ${ctx.sandboxName} gateway restart，或在配置中设置 options.restartGateway: true。`
      );
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
  logger.step('部署计划');
  printBlock('目标', [
    ['Sandbox', ctx.sandboxName],
    ['Agent', ctx.agentName],
    ['Workspace', ctx.workspace]
  ]);
  printBlock('内容', [
    ['Agent Content', enabledLabel(ctx.agentContent.enabled)],
    ['Agent Content Dir', ctx.agentContent.hostDir ?? '-'],
    ['Conflict Strategy', ctx.agentContent.enabled ? ctx.agentContent.conflictStrategy : '-'],
    ['Ignore', formatList(ctx.agentContent.ignore)],
    ['Skills', ctx.skill.enabled ? `enabled (${ctx.skill.hostDir ?? '-'})` : 'disabled']
  ]);
  printBlock('OpenClaw 配置', [
    ['Plugins', ctx.plugins.enabled ? `enabled (${ctx.plugins.items.length})` : 'disabled'],
    ['Plugin Items', formatPluginItems(ctx)],
    ['Tools', ctx.tools.enabled ? `enabled (profile ${ctx.tools.profile})` : 'disabled'],
    ['Tools Extra Config', formatList(Object.keys(ctx.tools.config).sort())],
    ['Channel', ctx.channel.enabled ? `${ctx.channel.type}/${ctx.channel.accountId}` : 'disabled'],
    ['Channel Server URL', ctx.channel.channelServerUrl || '-'],
    ['Gateway URL', ctx.channel.enabled ? (ctx.channel.gatewayUrl ?? 'auto from dashboard-url') : '-'],
    ['Gateway Token', formatGatewayToken(ctx)]
  ]);
  printBlock('运行项', [
    ['Network Policy', ctx.networkPolicy.enabled ? `enabled (${ctx.networkPolicy.dir ?? '-'})` : 'disabled'],
    ['Env', ctx.env.enabled ? `enabled (${ctx.env.targetFile})` : 'disabled'],
    ['Env Variables', formatEnvVariables(ctx)],
    ['Dependencies', enabledLabel(ctx.dependencies.enabled)],
    ['Dependencies Workdir', ctx.dependencies.enabled ? ctx.dependencies.workingDir : '-'],
    ['Dependencies Commands', ctx.dependencies.commands.join(' && ') || '-'],
    ['Continue On Error', String(ctx.dependencies.continueOnError)]
  ]);
  printBlock('网关', [
    ['Restart At End', formatGatewayRestartPlan(ctx)],
    ['Restart Command', `nemoclaw ${ctx.sandboxName} gateway restart`]
  ]);
  logger.info('');
}

function formatPluginItems(ctx: DeployContext): string {
  if (!ctx.plugins.enabled || ctx.plugins.items.length === 0) return '-';
  return ctx.plugins.items
    .map((item) => {
      const source = item.source ?? 'already installed';
      const markers = [item.force ? 'force' : '', item.channel ? 'channel config' : '']
        .filter(Boolean)
        .join(', ');
      return `${item.id} <- ${source}${markers ? ` (${markers})` : ''}`;
    })
    .join(', ');
}

function printSummary(ctx: DeployContext, summary: DeploySummary): void {
  logger.info('');
  logger.success('部署完成');
  printBlock('目标', [
    ['Sandbox', ctx.sandboxName],
    ['Agent', ctx.agentName],
    ['Workspace', ctx.workspace]
  ]);
  printBlock('结果', [
    ['Agent Content', summary.agentContent],
    ['Skills', `${summary.skill.status}${summary.skill.status === 'installed' ? ` (${summary.skill.count})` : ''}`],
    [
      'Plugins',
      `${summary.plugins.status}${
        summary.plugins.status === 'configured'
          ? ` (installed ${summary.plugins.installed}, enabled ${summary.plugins.enabled})`
          : ''
      }`
    ],
    [
      'Tools',
      `${summary.tools.status}${summary.tools.status === 'configured' ? ` (profile ${summary.tools.profile})` : ''}`
    ],
    ['Channel', formatChannelSummary(ctx, summary)],
    [
      'Network Policy',
      `${summary.networkPolicy.status}${
        summary.networkPolicy.status === 'applied' ? ` (${summary.networkPolicy.count})` : ''
      }`
    ],
    [
      'Env',
      `${summary.env.status}${
        summary.env.status === 'configured' ? ` (${summary.env.count} keys -> ${summary.env.targetFile})` : ''
      }`
    ],
    [
      'Dependencies',
      `${summary.dependencies.status}${
        summary.dependencies.status !== 'skipped' ? ` (${summary.dependencies.count})` : ''
      }`
    ],
    ['Gateway Restart', summary.gatewayRestart]
  ]);
  if (ctx.channel.enabled) {
    printBlock('Channel', [
      ['Channel Server URL', ctx.channel.channelServerUrl],
      ['Gateway URL', ctx.channel.gatewayUrl ?? '-'],
      ['Gateway Token', maskSecret(ctx.channel.gatewayToken)]
    ]);
  }
  printBlock('验证', [['Doctor', `nemoclaw-deploy doctor --sandbox ${ctx.sandboxName}`]]);
}

function printBlock(title: string, rows: Array<[string, string]>): void {
  logger.info('');
  logger.step(title);
  const width = Math.max(...rows.map(([label]) => label.length), 0) + 2;
  for (const [label, value] of rows) {
    logger.info(`  ${label.padEnd(width)}${value || '-'}`);
  }
}

function enabledLabel(value: boolean): string {
  return value ? 'enabled' : 'disabled';
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '-';
}

function formatGatewayToken(ctx: DeployContext): string {
  if (!ctx.channel.enabled) return '-';
  return ctx.channel.gatewayToken ? maskSecret(ctx.channel.gatewayToken) : 'auto from gateway-token';
}

function formatEnvVariables(ctx: DeployContext): string {
  if (!ctx.env.enabled) return '-';
  return formatList(
    ['WORKSPACE', 'VIRTUAL_ENV', 'PYTHON', ...Object.keys(ctx.env.variables)]
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort()
  );
}

function formatGatewayRestartPlan(ctx: DeployContext): string {
  if (ctx.options.restartGateway) return 'enabled';
  return 'disabled';
}

function formatChannelSummary(ctx: DeployContext, summary: DeploySummary): string {
  if (summary.channel.status === 'configured') return `${ctx.channel.type}/${ctx.channel.accountId} configured`;
  if (summary.channel.reason === 'existing') return 'skipped (existing)';
  return summary.channel.status;
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
