import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import fs from 'fs-extra';
import { confirm } from '@inquirer/prompts';
import {
  collectOnboardContext,
  type BootstrapCliOptions,
  type OnboardContext,
  type TriState
} from '../core/onboard-context.js';
import { logger } from '../utils/logger.js';
import { runCommand, withCommandEnvironment } from '../utils/run.js';
import { dashboardEnvironment, dashboardBindLabel } from '../core/dashboard.js';
import { assertMinimumVersion, isInstalledVersionLower, normalizeVersion, MIN_NEMOCLAW_VERSION } from '../utils/versions.js';
import { assertSandboxRunning } from '../core/runtime.js';
export { isInstalledVersionLower } from '../utils/versions.js';

const INSTALL_URL = 'https://www.nvidia.com/nemoclaw.sh';
const INSTALL_DOWNLOAD_ARGS = ['-fsSL', '--retry', '3', '--retry-all-errors',
  '--retry-delay', '2', '--retry-max-time', '120', '--connect-timeout', '15', '--max-time', '120'];

export interface BootstrapResult {
  completed: boolean;
  sandboxName: string;
}

export async function bootstrapCommand(options: BootstrapCliOptions): Promise<BootstrapResult> {
  const initialNemoclaw = await resolveNemoclawExecutable();
  if (initialNemoclaw) {
    logger.success(`已检测到 NemoClaw: ${initialNemoclaw}`);
  } else {
    logger.warn('未检测到 NemoClaw；如继续执行，将先通过 NVIDIA 官方安装器安装。');
  }

  const ctx = await collectOnboardContext({
    ...options,
    config: await resolveDefaultOnboardConfig(options.config)
  });

  return withCommandEnvironment(dashboardEnvironment(ctx.onboard.services.dashboardRemoteAccess),
    () => executeBootstrap(ctx, initialNemoclaw));
}

async function executeBootstrap(ctx: OnboardContext, initialNemoclaw?: string): Promise<BootstrapResult> {
  const installedVersion = initialNemoclaw && !ctx.options.dryRun ? await readInstalledNemoclawVersion(initialNemoclaw) : undefined;
  const updateAvailable = isInstalledVersionLower(installedVersion, ctx.install.version);
  const brokenInstallation = Boolean(initialNemoclaw && !ctx.options.dryRun && !installedVersion);
  if (brokenInstallation) logger.warn('已找到 NemoClaw 命令，但无法读取版本；将按安装策略尝试修复。');
  if (updateAvailable) {
    logger.warn(`当前 NemoClaw 版本为 ${installedVersion}，低于配置版本 ${normalizeVersion(ctx.install.version)}。`);
  }

  let versionUpdateApproved = updateAvailable;
  if (
    updateAvailable &&
    ctx.install.enabled &&
    ctx.install.mode === 'if-missing' &&
    !ctx.options.dryRun
  ) {
    if (ctx.options.nonInteractive) {
      logger.info('非交互模式检测到旧版 NemoClaw，将自动更新到配置版本。');
    } else {
      versionUpdateApproved = await confirm({
        message: `当前 NemoClaw ${installedVersion} 低于 ${normalizeVersion(ctx.install.version)}，是否更新？`,
        default: false
      });
      if (!versionUpdateApproved) {
        logger.warn('已跳过 NemoClaw 版本更新，继续后续 onboard/deploy 操作。');
      }
    }
  }

  printPlan(ctx, initialNemoclaw, installedVersion, updateAvailable, versionUpdateApproved, brokenInstallation);

  if (ctx.options.dryRun) {
    logger.warn('dry-run 模式：仅展示 bootstrap 计划，不安装 NemoClaw，也不执行 onboard。');
    return { completed: true, sandboxName: ctx.onboard.sandbox.name };
  }

  if (!ctx.options.nonInteractive) {
    const shouldContinue = await confirm({ message: '确认执行以上 bootstrap 计划？', default: true });
    if (!shouldContinue) {
      logger.warn('Bootstrap 已取消。');
      return { completed: false, sandboxName: ctx.onboard.sandbox.name };
    }
  }

  let nemoclaw = initialNemoclaw;
  const shouldInstall =
    ctx.install.enabled &&
    (ctx.install.mode === 'reinstall' || !nemoclaw || brokenInstallation || (updateAvailable && versionUpdateApproved));

  if (shouldInstall) {
    // 官方安装器会立即进入首次 onboard，必须在产生安装副作用前验证非交互配置。
    assertNonInteractiveOnboardConfig(ctx);
    logger.step('安装 NemoClaw；官方安装器会在首次安装后自动进入 onboard...');
    await installNemoclaw(ctx);
    // A stale executable earlier on PATH must not shadow the freshly installed CLI.
    nemoclaw = await resolveNemoclawExecutable(ctx.install.version) ?? await resolveNemoclawExecutable();
    const afterInstallVersion = nemoclaw ? await readInstalledNemoclawVersion(nemoclaw) : undefined;
    if (!afterInstallVersion) {
      throw new Error('NemoClaw 安装结束后无法读取版本，请检查安装日志和 PATH。');
    }
    const stillOutdated = isInstalledVersionLower(afterInstallVersion, ctx.install.version);
    if (stillOutdated) {
      throw new Error(
        `NemoClaw 安装结束后版本仍过低：当前 ${afterInstallVersion ?? 'unknown'}，期望至少为 ${normalizeVersion(ctx.install.version)}`
      );
    }
  }

  if (!nemoclaw) {
    if (!ctx.install.enabled) {
      throw new Error('未找到 nemoclaw，且 onboard config 已禁用自动安装');
    }
    throw new Error('NemoClaw 安装命令已结束，但仍未能在 PATH 或 ~/.local/bin 中找到 nemoclaw');
  }
  assertMinimumVersion((await runCommand(nemoclaw, ['--version'], { logCommand: false })).stdout, MIN_NEMOCLAW_VERSION, 'NemoClaw');
  exposeNemoclawOnPath(nemoclaw);

  if (ctx.onboard.mode === 'ensure' && (await isSandboxReady(nemoclaw, ctx.onboard.sandbox.name))) {
    logger.success(`Sandbox 已可用，跳过 onboard: ${ctx.onboard.sandbox.name}`);
    if (ctx.onboard.services.dashboardRemoteAccess) {
      logger.warn('ensure 不会改变已有 sandbox 的远程访问配置；若创建时未开启，请备份后显式使用 onboard.mode: recreate 重建。');
    }
    printSummary(ctx, nemoclaw, 'existing');
    return { completed: true, sandboxName: ctx.onboard.sandbox.name };
  }

  // A ready sandbox after installation does not prove that an explicitly
  // requested recreation (e.g. remote-bind opt-in) has taken place.
  if (shouldInstall && ctx.onboard.mode !== 'recreate' && (await isSandboxReady(nemoclaw, ctx.onboard.sandbox.name))) {
    logger.success(`首次安装和 onboard 已完成: ${ctx.onboard.sandbox.name}`);
    printSummary(ctx, nemoclaw, 'created');
    return { completed: true, sandboxName: ctx.onboard.sandbox.name };
  }

  assertNonInteractiveOnboardConfig(ctx);
  logger.step(`执行 NemoClaw onboard（${ctx.onboard.mode}）...`);
  await runCommand(nemoclaw, buildOnboardArgs(ctx), {
    interactive: !ctx.options.nonInteractive,
    sensitive: true,
    env: buildOnboardEnv(ctx),
    description: `创建、恢复或重建 sandbox ${ctx.onboard.sandbox.name}`
  });

  if (!(await isSandboxReady(nemoclaw, ctx.onboard.sandbox.name))) {
    throw new Error(
      `onboard 命令已结束，但 sandbox ${ctx.onboard.sandbox.name} 仍不可用。可尝试执行 nemoclaw onboard --resume。`
    );
  }

  printSummary(ctx, nemoclaw, ctx.onboard.mode === 'resume' ? 'resumed' : 'created');
  return { completed: true, sandboxName: ctx.onboard.sandbox.name };
}

async function resolveDefaultOnboardConfig(configPath: string | undefined): Promise<string | undefined> {
  if (configPath) return configPath;
  return (await fs.pathExists(path.resolve('onboard.yaml'))) ? 'onboard.yaml' : undefined;
}

async function installNemoclaw(ctx: OnboardContext): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-installer-'));
  const installer = path.join(directory, 'install.sh');
  const env = buildOnboardEnv(ctx);
  try {
    try {
      const localInstaller = process.env.NEMOCLAW_INSTALLER_FILE;
      if (localInstaller) {
        const source = path.resolve(localInstaller);
        if (!(await fs.stat(source)).isFile()) throw new Error('NEMOCLAW_INSTALLER_FILE 必须是普通文件');
        await fs.copyFile(source, installer);
      } else {
        // Download retries must finish before Bash sees any script content.
        await runCommand('curl', [...INSTALL_DOWNLOAD_ARGS, INSTALL_URL, '-o', installer], {
          env,
          sensitive: true,
          description: '完整下载 NVIDIA 官方安装器（仅重试下载）'
        });
      }
      const content = await fs.readFile(installer);
      if (!content.length) throw new Error('安装器为空');
      const expectedHash = process.env.NEMOCLAW_INSTALLER_SHA256;
      if (expectedHash && (!/^[0-9a-f]{64}$/i.test(expectedHash) ||
          createHash('sha256').update(content).digest('hex') !== expectedHash.toLowerCase())) {
        throw new Error('NVIDIA 安装器 SHA256 校验失败');
      }
      await runCommand('bash', ['-n', installer], { logCommand: false });
    } catch (error) {
      throw new Error(`NVIDIA 官方安装器准备或校验失败，未执行安装脚本。请检查本地文件，或 www.nvidia.com 的网络连接和 HTTPS_PROXY。\n${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await runCommand('bash', [installer], {
        interactive: true,
        sensitive: true,
        env,
        description: '通过 NVIDIA 官方安装器安装 NemoClaw，并承接首次 onboard'
      });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nNemoClaw 官方安装器未完成；若上方出现 curl/SSL 错误，请检查 github.com、raw.githubusercontent.com、release-assets.githubusercontent.com 的网络连接和 HTTPS_PROXY。修复网络后重新运行安装入口；不会自动重跑可能已修改主机或 sandbox 的安装步骤。`);
    }
  } finally {
    await fs.remove(directory);
  }
}

function printPlan(
  ctx: OnboardContext,
  detectedNemoclaw: string | undefined,
  installedVersion: string | undefined,
  updateAvailable: boolean,
  versionUpdateApproved: boolean,
  brokenInstallation = false
): void {
  logger.info('');
  logger.step('Bootstrap / Onboard 计划');
  printRows([
    ['NemoClaw', detectedNemoclaw ? `detected (${detectedNemoclaw})` : 'missing'],
    ['Current Version', installedVersion ?? '-'],
    ['Install', ctx.install.enabled ? ctx.install.mode : 'disabled'],
    ['Install Version', ctx.install.version],
    [
      'Install Reason',
      brokenInstallation ? 'unreadable installed version; repair required' : installReason(ctx, detectedNemoclaw, updateAvailable, versionUpdateApproved)
    ],
    ['Installer', installDisplayCommand(ctx)],
    ['Sandbox', ctx.onboard.sandbox.name],
    ['Runtime', ctx.onboard.sandbox.runtime],
    ['Dockerfile Dir', ctx.onboard.sandbox.dockerfileDir ?? 'official default'],
    ['Dockerfile', ctx.onboard.sandbox.dockerfilePath ?? 'official default'],
    ['Mode', ctx.onboard.mode],
    ['Provider', ctx.onboard.inference.provider ?? '由官方向导选择'],
    ['Model', ctx.onboard.inference.model ?? '由官方向导选择'],
    ['Endpoint URL', ctx.onboard.inference.endpointUrl ?? envHint('NEMOCLAW_ENDPOINT_URL')],
    ['Preferred API', ctx.onboard.inference.preferredApi ?? '-'],
    ['API Key', credentialDisplay(ctx)],
    ['Host GPU', ctx.onboard.gpu.host],
    ['Sandbox GPU', ctx.onboard.gpu.sandbox],
    ['OpenShell Gateway Port', formatOptional(ctx.onboard.services.openShellGatewayPort)],
    ['Dashboard Port', formatOptional(ctx.onboard.services.dashboardPort)],
    ['Dashboard Bind', dashboardBindLabel(ctx.onboard.services.dashboardRemoteAccess)],
    ['Control UI Port', formatOptional(ctx.onboard.services.controlUiPort)],
    ['Policy', `${ctx.onboard.policy.tier}/${ctx.onboard.policy.mode}`],
    ['Policy Presets', formatPolicyPresets(ctx)],
    ['Web Search', ctx.onboard.openclaw.webSearchProvider],
    ['Tool Disclosure', ctx.onboard.openclaw.toolDisclosure],
    ['Interaction', ctx.options.nonInteractive ? 'non-interactive' : 'official interactive wizard'],
    ['Credentials', '模型 API key 仅从 onboard.yaml inference.apiKey 读取']
  ]);
  logger.info('');
}

function installReason(
  ctx: OnboardContext,
  detectedNemoclaw: string | undefined,
  updateAvailable: boolean,
  versionUpdateApproved: boolean
): string {
  if (!ctx.install.enabled) return 'disabled';
  if (!detectedNemoclaw) return 'missing';
  if (ctx.install.mode === 'reinstall') return 'reinstall requested';
  if (updateAvailable) {
    if (ctx.options.dryRun) return 'installed version is older; update confirmation required';
    if (!versionUpdateApproved) return 'installed version is older; update declined';
    return ctx.options.nonInteractive
      ? 'installed version is older; update automatically'
      : 'installed version is older; update approved';
  }
  return 'skip install';
}

function installDisplayCommand(ctx: OnboardContext): string {
  const envParts = [
    `NEMOCLAW_INSTALL_TAG=${ctx.install.version}`,
    `NEMOCLAW_INSTALL_REF=${ctx.install.version}`,
    `NEMOCLAW_DASHBOARD_BIND=${ctx.onboard.services.dashboardRemoteAccess ? '0.0.0.0' : "''"}`
  ];
  if (ctx.onboard.inference.endpointUrl) {
    envParts.push(`NEMOCLAW_ENDPOINT_URL=${ctx.onboard.inference.endpointUrl}`);
  }
  if (ctx.onboard.inference.preferredApi) {
    envParts.push(`NEMOCLAW_PREFERRED_API=${ctx.onboard.inference.preferredApi}`);
  }
  if (ctx.onboard.services.openShellGatewayPort) {
    envParts.push(`NEMOCLAW_GATEWAY_PORT=${ctx.onboard.services.openShellGatewayPort}`);
  }
  if (ctx.onboard.services.dashboardPort) {
    envParts.push(`NEMOCLAW_DASHBOARD_PORT=${ctx.onboard.services.dashboardPort}`);
  }
  if (ctx.onboard.sandbox.dockerfilePath) {
    envParts.push(`NEMOCLAW_FROM_DOCKERFILE=${ctx.onboard.sandbox.dockerfilePath}`);
  }
  if (process.env.NEMOCLAW_INSTALLER_FILE) {
    return `${envParts.join(' ')} bash <NEMOCLAW_INSTALLER_FILE> (local copy, validated before execution)`;
  }
  return `curl ${INSTALL_DOWNLOAD_ARGS.join(' ')} ${INSTALL_URL} -o <installer.sh> && ${envParts.join(' ')} bash <installer.sh>`;
}

function printSummary(
  ctx: OnboardContext,
  executable: string,
  status: 'existing' | 'created' | 'resumed'
): void {
  logger.info('');
  logger.success('Bootstrap 完成');
  printRows([
    ['NemoClaw', executable],
    ['Sandbox', ctx.onboard.sandbox.name],
    ['Runtime', ctx.onboard.sandbox.runtime],
    ['Dockerfile', ctx.onboard.sandbox.dockerfilePath ?? 'official default'],
    ['Onboard', status],
    ['Dashboard Bind', dashboardBindLabel(ctx.onboard.services.dashboardRemoteAccess)],
    ['Connect', `NEMOCLAW_DASHBOARD_BIND=${ctx.onboard.services.dashboardRemoteAccess ? '0.0.0.0' : "''"} nemoclaw ${ctx.onboard.sandbox.name} connect`]
  ]);
  if (ctx.onboard.services.dashboardRemoteAccess) {
    logger.info('远程浏览器使用主机实际 IP/域名和 dashboard 端口；dashboard-url 默认仍可输出 127.0.0.1，0.0.0.0 是监听地址。');
  }
}

function printRows(rows: Array<[string, string]>): void {
  const width = Math.max(...rows.map(([label]) => label.length), 0) + 2;
  for (const [label, value] of rows) logger.info(`  ${label.padEnd(width)}${value}`);
}

function buildOnboardArgs(ctx: OnboardContext): string[] {
  const args = ['onboard'];
  if (ctx.onboard.mode === 'resume') {
    args.push('--resume');
  } else {
    if (ctx.onboard.mode === 'fresh' || ctx.onboard.mode === 'recreate') args.push('--fresh');
    args.push('--name', ctx.onboard.sandbox.name, '--agent', ctx.onboard.sandbox.runtime);
    if (ctx.onboard.mode === 'recreate') args.push('--recreate-sandbox');
  }
  if (ctx.onboard.sandbox.dockerfilePath) {
    args.push('--from', ctx.onboard.sandbox.dockerfilePath);
  }

  addTriStateFlag(args, ctx.onboard.gpu.host, '--gpu', '--no-gpu');
  addTriStateFlag(args, ctx.onboard.gpu.sandbox, '--sandbox-gpu', '--no-sandbox-gpu');
  if (ctx.onboard.gpu.device) args.push('--sandbox-gpu-device', ctx.onboard.gpu.device);
  args.push('--tool-disclosure', ctx.onboard.openclaw.toolDisclosure);
  if (ctx.onboard.services.controlUiPort) {
    args.push('--control-ui-port', String(ctx.onboard.services.controlUiPort));
  }
  if (ctx.onboard.options.yes) args.push('--yes');
  if (ctx.onboard.options.noOllamaAutostart) args.push('--no-ollama-autostart');
  if (ctx.options.nonInteractive) args.push('--non-interactive');
  if (ctx.onboard.options.acceptThirdPartySoftware) {
    args.push('--yes-i-accept-third-party-software');
  }
  return args;
}

function addTriStateFlag(args: string[], value: TriState, enabled: string, disabled: string): void {
  if (value === 'enabled') args.push(enabled);
  if (value === 'disabled') args.push(disabled);
}

function buildOnboardEnv(ctx: OnboardContext): Record<string, string> {
  const env: Record<string, string> = {
    ...ctx.onboard.environment,
    ...dashboardEnvironment(ctx.onboard.services.dashboardRemoteAccess),
    NEMOCLAW_INSTALL_TAG: ctx.install.version,
    // The official installer gives INSTALL_REF precedence over INSTALL_TAG.
    // Override an inherited ref so the YAML target remains authoritative.
    NEMOCLAW_INSTALL_REF: ctx.install.version,
    NEMOCLAW_SANDBOX_NAME: ctx.onboard.sandbox.name,
    NEMOCLAW_AGENT: ctx.onboard.sandbox.runtime,
    NEMOCLAW_TOOL_DISCLOSURE: ctx.onboard.openclaw.toolDisclosure,
    NEMOCLAW_POLICY_TIER: ctx.onboard.policy.tier,
    NEMOCLAW_POLICY_MODE: ctx.onboard.policy.mode,
    NEMOCLAW_WEB_SEARCH_PROVIDER: ctx.onboard.openclaw.webSearchProvider,
    NEMOCLAW_SANDBOX_GPU: triStateEnv(ctx.onboard.gpu.sandbox)
  };

  setEnv(env, 'NEMOCLAW_PROVIDER', ctx.onboard.inference.provider);
  setEnv(env, 'NEMOCLAW_MODEL', ctx.onboard.inference.model);
  setEnv(env, 'NEMOCLAW_ENDPOINT_URL', ctx.onboard.inference.endpointUrl);
  setEnv(env, 'NEMOCLAW_PREFERRED_API', ctx.onboard.inference.preferredApi);
  injectInferenceCredential(env, ctx);
  setEnv(env, 'NEMOCLAW_POLICY_PRESETS', ctx.onboard.policy.presets.join(',') || undefined);
  setEnv(env, 'NEMOCLAW_SANDBOX_GPU_DEVICE', ctx.onboard.gpu.device);
  setEnv(env, 'NEMOCLAW_AGENT_TIMEOUT', ctx.onboard.openclaw.agentTimeout);
  setEnv(env, 'NEMOCLAW_GATEWAY_PORT', ctx.onboard.services.openShellGatewayPort);
  setEnv(env, 'NEMOCLAW_DASHBOARD_PORT', ctx.onboard.services.dashboardPort);
  setEnv(env, 'NEMOCLAW_VLLM_PORT', ctx.onboard.services.vllmPort);
  setEnv(env, 'NEMOCLAW_OLLAMA_PORT', ctx.onboard.services.ollamaPort);
  setEnv(env, 'NEMOCLAW_OLLAMA_PULL_TIMEOUT', ctx.onboard.timeouts.ollamaPull);
  setEnv(env, 'NEMOCLAW_LOCAL_INFERENCE_TIMEOUT', ctx.onboard.timeouts.localInference);
  setEnv(env, 'NEMOCLAW_SANDBOX_READY_TIMEOUT', ctx.onboard.timeouts.sandboxReady);
  setEnv(env, 'NEMOCLAW_FROM_DOCKERFILE', ctx.onboard.sandbox.dockerfilePath);

  if (ctx.options.nonInteractive) env.NEMOCLAW_NON_INTERACTIVE = '1';
  if (ctx.onboard.options.acceptThirdPartySoftware) {
    env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = '1';
  }
  if (ctx.onboard.options.yes) env.NEMOCLAW_YES = '1';
  if (ctx.onboard.options.noOllamaAutostart) env.NEMOCLAW_OLLAMA_NO_AUTOSTART = '1';
  return env;
}

function setEnv(
  env: Record<string, string>,
  name: string,
  value: string | number | undefined
): void {
  if (value !== undefined && value !== '') env[name] = String(value);
}

function triStateEnv(value: TriState): string {
  if (value === 'enabled') return '1';
  if (value === 'disabled') return '0';
  return 'auto';
}

function formatOptional(value: string | number | undefined): string {
  return value === undefined || value === '' ? '-' : String(value);
}

function formatPolicyPresets(ctx: OnboardContext): string {
  if (ctx.onboard.policy.mode === 'skip') return '-';
  if (ctx.onboard.policy.mode === 'suggested') return 'suggested by NemoClaw';
  return ctx.onboard.policy.presets.join(', ');
}

function envHint(name: string): string {
  return process.env[name] ? `from $${name}` : '-';
}

function credentialDisplay(ctx: OnboardContext): string {
  const targetEnv = resolveCredentialTargetEnv(ctx);
  if (ctx.onboard.inference.apiKey && targetEnv) {
    return `${targetEnv} <- onboard.yaml inference.apiKey`;
  }
  if (ctx.onboard.inference.apiKey) return 'configured in onboard.yaml inference.apiKey';
  return 'not configured in onboard.yaml';
}

function injectInferenceCredential(env: Record<string, string>, ctx: OnboardContext): void {
  const targetEnv = resolveCredentialTargetEnv(ctx);
  const apiKey = ctx.onboard.inference.apiKey;
  if (targetEnv && apiKey) env[targetEnv] = apiKey;
}

function resolveCredentialTargetEnv(ctx: OnboardContext): string | undefined {
  const provider = normalizeProviderKey(ctx.onboard.inference.provider);
  switch (provider) {
    case 'build':
    case 'cloud':
      return 'NVIDIA_INFERENCE_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'custom':
      return 'COMPATIBLE_API_KEY';
    case 'anthropiccompatible':
      return 'COMPATIBLE_ANTHROPIC_API_KEY';
    case 'hermes-provider':
    case 'hermesprovider':
    case 'nous':
    case 'nous-portal':
      return 'OPENAI_API_KEY';
    default:
      return undefined;
  }
}

function normalizeProviderKey(value?: string): string {
  return value?.trim().toLowerCase() ?? '';
}

function assertNonInteractiveOnboardConfig(ctx: OnboardContext): void {
  if (!ctx.options.nonInteractive) return;
  if (!ctx.onboard.options.acceptThirdPartySoftware) {
    throw new Error('非交互 onboard 必须设置 onboard.options.acceptThirdPartySoftware: true');
  }
  if (!ctx.onboard.inference.provider && ctx.onboard.mode !== 'resume') {
    throw new Error('非交互 onboard 必须设置 onboard.inference.provider');
  }
  const provider = normalizeProviderKey(ctx.onboard.inference.provider);
  if ((provider === 'custom' || provider === 'anthropiccompatible') && !ctx.onboard.inference.endpointUrl && !process.env.NEMOCLAW_ENDPOINT_URL) {
    throw new Error('非交互 compatible endpoint 必须设置 onboard.inference.endpointUrl 或导出 NEMOCLAW_ENDPOINT_URL');
  }
  const targetEnv = resolveCredentialTargetEnv(ctx);
  if (
    (provider === 'custom' || provider === 'anthropiccompatible') &&
    targetEnv &&
    !ctx.onboard.inference.apiKey
  ) {
    throw new Error(`非交互 compatible endpoint 必须设置 onboard.inference.apiKey`);
  }
}

async function isSandboxReady(executable: string, sandboxName: string): Promise<boolean> {
  try {
    const result = await runCommand(executable, [sandboxName, 'status', '--json'], {
      timeoutMs: 30_000,
      logCommand: false
    });
    assertSandboxRunning(result.stdout);
    return true;
  } catch {
    return false;
  }
}

async function readInstalledNemoclawVersion(executable: string): Promise<string | undefined> {
  try {
    const result = await runCommand(executable, ['--version'], {
      timeoutMs: 30_000,
      logCommand: false
    });
    const match = result.stdout.match(
      /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\b/
    );
    return match ? `v${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

async function resolveNemoclawExecutable(minimumVersion?: string): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry) candidates.add(path.join(entry, 'nemoclaw'));
  }
  candidates.add(path.join(os.homedir(), '.local', 'bin', 'nemoclaw'));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if (!(await fs.stat(candidate)).isFile()) continue;
      if (minimumVersion) {
        const version = await readInstalledNemoclawVersion(candidate);
        if (!version || isInstalledVersionLower(version, minimumVersion)) continue;
      }
      return candidate;
    } catch {
      // 继续检查下一个候选路径。
    }
  }
  return undefined;
}

function exposeNemoclawOnPath(executable: string): void {
  const directory = path.dirname(executable);
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [directory, ...entries.filter((entry) => entry !== directory)].join(path.delimiter);
}
