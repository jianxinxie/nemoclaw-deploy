import { confirm } from '@inquirer/prompts';
import type { DeployContext, DeployPlan } from '../core/context.js';
import { collectDeployPlan, type DeployCliOptions } from '../core/context.js';
import { precheck } from '../core/precheck.js';
import { createAgent } from '../core/create-agent.js';
import { uploadAgentContent } from '../core/upload-agent-content.js';
import { uploadSandboxFiles } from '../core/copy-files.js';
import { collectWorkspaceSkills, type WorkspaceSkill } from '../core/workspace-skills.js';
import { installPlugins, verifyPluginsEnabled, validatePluginSources } from '../core/install-plugins.js';
import { prepareChannelServer } from '../core/configure-channel.js';
import {
  applyOpenClawConfig,
  validateOpenClawPartialFile,
  verifyOpenClawConfig
} from '../core/apply-openclaw-config.js';
import { restartGateway, type RestartGatewayResult } from '../core/restart-gateway.js';
import { applyPolicy, validateNetworkPolicies } from '../core/apply-policy.js';
import { configureEnv } from '../core/configure-env.js';
import { executeSandboxCommands } from '../core/install-dependencies.js';
import {
  agentRegistrationUrl,
  precheckAgentRegistration,
  registerAgent,
  type RegisterAgentResult
} from '../core/register-agent.js';
import { verifyDeployment } from '../core/verify.js';
import { logger } from '../utils/logger.js';
import { maskSecret } from '../utils/mask.js';
import { runCommand, withCommandEnvironment } from '../utils/run.js';
import { dashboardEnvironment, dashboardBindLabel } from '../core/dashboard.js';
import {
  validateAgentContentDir,
  validateHostFileOrDirectory
} from '../utils/validators.js';

interface AgentDeploySummary {
  name: string;
  workspace: string;
  model?: string;
  agentContent: 'skipped' | 'applied';
  fileCopies: { status: 'skipped' | 'uploaded'; count: number };
  skills: WorkspaceSkill[];
  env: { status: 'skipped' | 'configured'; targetFile?: string; count: number };
  dependencies: { status: 'skipped' | 'executed' | 'partial'; count: number };
  channelRegistration: RegisterAgentResult;
}

interface DeploySummary {
  agents: AgentDeploySummary[];
  plugins: { status: 'skipped' | 'configured'; installed: number; enabled: number };
  openclawConfig: { status: 'unchanged' | 'applied' };
  channelServer: {
    status: 'skipped' | 'configured';
    restarted: boolean;
    reason?: 'disabled' | 'existing';
  };
  networkPolicy: { status: 'skipped' | 'applied'; count: number };
  gatewayRestart: RestartGatewayResult;
}

export async function deployCommand(options: DeployCliOptions, preparedPlan?: DeployPlan): Promise<boolean> {
  const plan = preparedPlan ?? await collectDeployPlan(options);
  return withCommandEnvironment(dashboardEnvironment(plan.dashboardRemoteAccess),
    () => executeDeploy(options, plan));
}

async function executeDeploy(options: DeployCliOptions, plan: DeployPlan): Promise<boolean> {
  printPlan(plan);

  if (options.dryRun) {
    logger.warn('dry-run 模式：仅展示部署计划，不执行真实命令。');
    return true;
  }

  if (!options.nonInteractive) {
    const shouldContinue = await confirm({ message: '确认执行以上部署计划？', default: true });
    if (!shouldContinue) {
      logger.warn('部署已取消。');
      return false;
    }
  }

  const workspaceSkills = await validateDeployResources(plan);

  const shared = plan.agents[0];
  const summary: DeploySummary = {
    agents: plan.agents.map((ctx, index) => ({
      name: ctx.agentName,
      workspace: ctx.workspace,
      model: ctx.model,
      agentContent: 'skipped',
      fileCopies: { status: 'skipped', count: 0 },
      skills: workspaceSkills[index],
      env: { status: 'skipped', count: 0 },
      dependencies: { status: 'skipped', count: 0 },
      channelRegistration: 'skipped'
    })),
    plugins: { status: 'skipped', installed: 0, enabled: 0 },
    openclawConfig: { status: 'unchanged' },
    channelServer: { status: 'skipped', restarted: false, reason: 'disabled' },
    networkPolicy: { status: 'skipped', count: 0 },
    gatewayRestart: 'skipped'
  };
  let cleanupCompleted = false;
  let remoteTempUsed = false;

  try {
    logger.step('执行 sandbox 预检查...');
    await precheck(shared);

    // Plugins and channel setup may require these endpoints. Apply policies
    // before any agent changes so an earlier deploy failure cannot skip them.
    logger.step('应用 sandbox 共享 network policies（agent、插件和 channel 配置之前）...');
    summary.networkPolicy = await applyPolicy(shared);

    await precheckAgentRegistration(plan.agents);

    logger.step(`创建或确认 ${plan.agents.length} 个 agent...`);
    for (const [index, ctx] of plan.agents.entries()) {
      await createAgent(ctx);
      summary.agents[index].workspace = ctx.workspace;
    }
    assertResolvedWorkspaces(plan.agents);

    logger.step('处理各 agent 初始化内容...');
    remoteTempUsed = true;
    for (const [index, ctx] of plan.agents.entries()) {
      logger.info(`处理 agent ${ctx.agentName} 的 workspace 初始化内容。`);
      summary.agents[index].agentContent = await uploadAgentContent(ctx);
    }

    logger.step('执行各 agent 的 sandbox 文件/目录上传...');
    for (const [index, ctx] of plan.agents.entries()) {
      summary.agents[index].fileCopies = await uploadSandboxFiles(ctx);
    }

    logger.step('安装 sandbox 共享 OpenClaw 插件...');
    summary.plugins = await installPlugins(shared);

    logger.step('准备 ChannelServer 与 advbot 动态连接配置...');
    summary.channelServer = await prepareChannelServer(shared);
    copyResolvedChannelServer(plan.agents, shared);

    logger.step('统一合并并提交 OpenClaw 配置...');
    summary.openclawConfig = await applyOpenClawConfig({
      contexts: plan.agents,
      plugins: summary.plugins,
      channelServer: summary.channelServer
    });
    await verifyPluginsEnabled(shared);

    logger.step('配置各 agent env...');
    for (const [index, ctx] of plan.agents.entries()) {
      summary.agents[index].env = await configureEnv(ctx);
    }

    logger.step('执行各 agent 的 sandbox commands...');
    for (const [index, ctx] of plan.agents.entries()) {
      summary.agents[index].dependencies = await executeSandboxCommands(ctx);
    }

    if (shared.options.restartGateway) {
      logger.step('重启 OpenClaw 网关...');
      summary.gatewayRestart = await restartGateway(
        shared,
        '全部 agent 和 sandbox 共享配置已完成，统一重启一次 OpenClaw gateway'
      );
    } else if (
      summary.plugins.status === 'configured' ||
      summary.channelServer.status === 'configured' ||
      summary.openclawConfig.status === 'applied'
    ) {
      logger.warn(
        `OpenClaw 配置已更新，但网关尚未重启。可执行 nemoclaw ${shared.sandboxName} gateway restart。`
      );
    }

    logger.step('验证最终 OpenClaw 配置、agent、sandbox 和 workspace skills...');
    await verifyOpenClawConfig(shared);
    await verifyPluginsEnabled(shared);
    for (const [index, ctx] of plan.agents.entries()) {
      await verifyDeployment(ctx, {
        policyApplied: summary.networkPolicy.status === 'applied',
        skills: summary.agents[index].skills
      });
    }

    logger.step('向 channel server 注册已启用的 agents...');
    for (const [index, ctx] of plan.agents.entries()) {
      summary.agents[index].channelRegistration = await registerAgent(ctx);
    }

    await cleanupAllRemoteTemp(plan.agents);
    cleanupCompleted = true;
    printSummary(plan, summary);
    return true;
  } finally {
    if (remoteTempUsed && !cleanupCompleted) {
      logger.info('部署未完成，开始清理 sandbox 临时目录。');
      await cleanupAllRemoteTemp(plan.agents);
    }
  }
}

function printPlan(plan: DeployPlan): void {
  const shared = plan.agents[0];
  logger.info('');
  logger.step('部署计划');
  printBlock('目标', [
    ['Sandbox', plan.sandboxName],
    ['Agents', String(plan.agents.length)],
    ['Schema', `v${plan.schemaVersion}`]
  ]);

  for (const ctx of plan.agents) {
    printBlock(`Agent: ${ctx.agentName}`, [
      ['Workspace', ctx.workspace],
      ['Model', ctx.model ?? 'preserve OpenClaw value'],
      ['Agent Content', enabledLabel(ctx.agentContent.enabled)],
      ['Agent Content Dir', ctx.agentContent.hostDir ?? '-'],
      ['Conflict Strategy', ctx.agentContent.enabled ? ctx.agentContent.conflictStrategy : '-'],
      ['Ignore', formatList(ctx.agentContent.ignore)],
      ['Sandbox Uploads', formatFileCopies(ctx)],
      ['Skills', ctx.agentContent.enabled ? '随 agent content 上传到 workspace/skills，按 agent 验证' : '不上传'],
      [
        'Env',
        ctx.env.enabled
          ? `enabled (${formatEnvTarget(ctx)})`
          : 'disabled'
      ],
      ['Env Variables', formatEnvVariables(ctx)],
      ['Sandbox Commands', enabledLabel(ctx.sandbox.commands.enabled)],
      ['Commands Workdir', ctx.sandbox.commands.enabled ? ctx.sandbox.commands.workingDir : '-'],
      ['Commands', formatDependencyCommands(ctx.sandbox.commands.items)],
      [
        'Channel Registration',
        ctx.channelRegistration.enabled
          ? `enabled (${agentRegistrationUrl(ctx.channelServer.url)}, agentLabel=${ctx.channelRegistration.agentLabel}, continueOnError=${ctx.channelRegistration.continueOnError})`
          : 'disabled'
      ]
    ]);
  }

  printBlock('Sandbox 共享配置', [
    ['Dashboard Bind', dashboardBindLabel(plan.dashboardRemoteAccess)],
    ['Plugins', shared.plugins.enabled ? `enabled (${shared.plugins.items.length})` : 'disabled'],
    ['Plugin Items', formatPluginItems(shared)],
    [
      'OpenClaw Partial',
      shared.openclawConfig.enabled ? `enabled (${shared.openclawConfig.file ?? '-'})` : 'disabled'
    ],
    ['ChannelServer', shared.channelServer.enabled ? `enabled (advbot/${shared.channelServer.advbotAccountId})` : 'disabled'],
    ['ChannelServer URL', shared.channelServer.url || '-'],
    ['Gateway URL', shared.channelServer.enabled ? (shared.channelServer.gatewayUrl ?? 'auto from dashboard-url') : '-'],
    ['Gateway Token', formatGatewayToken(shared)],
    ['Network Policy', shared.networkPolicy.enabled ? `enabled (${shared.networkPolicy.dir ?? '-'})` : 'disabled'],
    ['Policy Apply Order', shared.networkPolicy.enabled ? 'sandbox 预检查后，agent、插件和 channel 配置前' : '-'],
    ['Trusted Private Hosts', formatList(shared.networkPolicy.trustedPrivateHosts)],
    ['Restart At End', shared.options.restartGateway ? 'enabled' : 'disabled']
  ]);
  logger.info('');
}

function printSummary(plan: DeployPlan, summary: DeploySummary): void {
  const shared = plan.agents[0];
  logger.info('');
  logger.success('部署完成');
  printBlock('目标', [
    ['Sandbox', plan.sandboxName],
    ['Agents', String(plan.agents.length)]
  ]);
  for (const agent of summary.agents) {
    printBlock(`Agent: ${agent.name}`, [
      ['Workspace', agent.workspace],
      ['Model', agent.model ?? 'preserved'],
      ['Agent Content', agent.agentContent],
      ['Sandbox Uploads', `${agent.fileCopies.status}${agent.fileCopies.count ? ` (${agent.fileCopies.count})` : ''}`],
      ['Skills', agent.skills.length ? `workspace verified (${agent.skills.length})` : 'none uploaded'],
      ['Env', formatEnvSummary(agent.env)],
      ['Sandbox Commands', formatDependenciesSummary(agent.dependencies)],
      ['Channel Registration', agent.channelRegistration]
    ]);
  }
  printBlock('Sandbox 共享结果', [
    ['Dashboard Bind', dashboardBindLabel(plan.dashboardRemoteAccess)],
    ['Plugins', `${summary.plugins.status}${summary.plugins.status === 'configured' ? ` (installed ${summary.plugins.installed}, enabled ${summary.plugins.enabled})` : ''}`],
    ['OpenClaw Config', summary.openclawConfig.status],
    ['ChannelServer', formatChannelServerSummary(shared, summary)],
    ['Network Policy', `${summary.networkPolicy.status}${summary.networkPolicy.count ? ` (${summary.networkPolicy.count})` : ''}`],
    ['Gateway Restart', summary.gatewayRestart]
  ]);
  if (shared.channelServer.enabled) {
    printBlock('ChannelServer', [
      ['URL', shared.channelServer.url],
      ['Gateway URL', shared.channelServer.gatewayUrl ?? '-'],
      ['Gateway Token', maskSecret(shared.channelServer.gatewayToken)]
    ]);
  }
  const dashboardEnv = `NEMOCLAW_DASHBOARD_BIND=${plan.dashboardRemoteAccess ? '0.0.0.0' : "''"}`;
  printBlock('验证', [
    ['Doctor', `${dashboardEnv} nemoclaw-deploy doctor --sandbox ${plan.sandboxName}`],
    ['Connect', `${dashboardEnv} nemoclaw ${plan.sandboxName} connect`]
  ]);
}

function formatPluginItems(ctx: DeployContext): string {
  if (!ctx.plugins.enabled || ctx.plugins.items.length === 0) return '-';
  return ctx.plugins.items
    .map((item) => `${item.id} <- ${item.source ?? 'already installed'}${item.force ? ' (force)' : ''}${item.trustSource ? ' (trust source)' : ''}${item.acceptCapabilities ? ' (accept capabilities)' : ''}${item.acknowledgeInstallPolicyWarning ? ' (acknowledge policy warnings)' : ''}`)
    .join(', ');
}

function printBlock(title: string, rows: Array<[string, string]>): void {
  logger.info('');
  logger.step(title);
  const width = Math.max(...rows.map(([label]) => label.length), 0) + 2;
  for (const [label, value] of rows) logger.info(`  ${label.padEnd(width)}${value || '-'}`);
}

function enabledLabel(value: boolean): string {
  return value ? 'enabled' : 'disabled';
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '-';
}

function formatDependencyCommands(commands: string[]): string {
  const text = commands.map((command) => command.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' && ');
  if (!text) return '-';
  if (text.length <= 240) return text;
  return `${text.slice(0, 237)}...`;
}

function formatFileCopies(ctx: DeployContext): string {
  if (!ctx.sandbox.uploads.enabled) return 'disabled';
  return ctx.sandbox.uploads.items
    .map(
      (item) =>
        `${item.source} -> ${item.destination}${item.overwrite ? ' (merge/overwrite)' : ' (fail on conflict)'}`
    )
    .join(', ');
}

function formatGatewayToken(ctx: DeployContext): string {
  if (!ctx.channelServer.enabled) return '-';
  return ctx.channelServer.gatewayToken
    ? maskSecret(ctx.channelServer.gatewayToken)
    : 'auto from gateway-token';
}

function formatEnvVariables(ctx: DeployContext): string {
  if (!ctx.env.enabled) return '-';
  return formatList(
    ['WORKSPACE', 'VIRTUAL_ENV', 'PYTHON', ...Object.keys(ctx.env.variables)]
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort()
  );
}

function formatEnvTarget(ctx: DeployContext): string {
  const directory = ctx.env.directory.replace(/\/+$/, '');
  return `${directory || '/'}/${ctx.env.targetFile}`.replace(/^\/\//, '/');
}

function formatEnvSummary(result: AgentDeploySummary['env']): string {
  return result.status === 'configured'
    ? `${result.status} (${result.count} keys -> ${result.targetFile})`
    : result.status;
}

function formatDependenciesSummary(result: AgentDeploySummary['dependencies']): string {
  return result.status === 'skipped' ? result.status : `${result.status} (${result.count})`;
}

function formatChannelServerSummary(ctx: DeployContext, summary: DeploySummary): string {
  if (summary.channelServer.status === 'configured') {
    return `advbot/${ctx.channelServer.advbotAccountId} configured`;
  }
  if (summary.channelServer.reason === 'existing') return 'skipped (existing)';
  return summary.channelServer.status;
}

function copyResolvedChannelServer(contexts: DeployContext[], source: DeployContext): void {
  for (const ctx of contexts) {
    ctx.channelServer.gatewayToken = source.channelServer.gatewayToken;
    ctx.channelServer.gatewayUrl = source.channelServer.gatewayUrl;
  }
}

function assertResolvedWorkspaces(contexts: DeployContext[]): void {
  const owners = new Map<string, string>();
  for (const ctx of contexts) {
    const existing = owners.get(ctx.workspace);
    if (existing) {
      throw new Error(
        `OpenClaw 中的实际 workspace 冲突: agent ${existing} 和 ${ctx.agentName} 都使用 ${ctx.workspace}`
      );
    }
    owners.set(ctx.workspace, ctx.agentName);
  }
}

export async function validateDeployResources(plan: DeployPlan): Promise<WorkspaceSkill[][]> {
  await validatePluginSources(plan.agents[0]);
  const workspaceSkills = await Promise.all(plan.agents.map(validateRuntimeResources));
  await validateNetworkPolicies(plan.agents[0]);
  return workspaceSkills;
}

async function validateRuntimeResources(ctx: DeployContext): Promise<WorkspaceSkill[]> {
  if (ctx.agentContent.enabled && ctx.agentContent.hostDir) {
    ctx.agentContent.hostDir = await validateAgentContentDir(ctx.agentContent.hostDir);
  }
  if (ctx.sandbox.uploads.enabled) {
    for (const item of ctx.sandbox.uploads.items) {
      item.source = await validateHostFileOrDirectory(item.source);
    }
  }
  if (ctx.openclawConfig.enabled && ctx.openclawConfig.file) {
    ctx.openclawConfig.file = await validateOpenClawPartialFile(ctx.openclawConfig.file);
  }
  return ctx.agentContent.enabled && ctx.agentContent.hostDir
    ? collectWorkspaceSkills(ctx.agentContent.hostDir, ctx.agentContent.ignore)
    : [];
}

async function cleanupAllRemoteTemp(contexts: DeployContext[]): Promise<void> {
  for (const ctx of contexts) await cleanupRemoteTemp(ctx);
}

async function cleanupRemoteTemp(ctx: DeployContext): Promise<void> {
  try {
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'exec', '--', 'rm', '-rf', `/tmp/nemoclaw-deploy/${ctx.agentName}`],
      { timeoutMs: 10_000, description: `清理 agent ${ctx.agentName} 的 sandbox 临时目录` }
    );
  } catch (error) {
    logger.warn(`临时文件清理未完成：${error instanceof Error ? error.message : String(error)}`);
  }
}
