import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { confirm } from '@inquirer/prompts';
import {
  collectOnboardContext,
  type BootstrapCliOptions,
  type OnboardContext,
  type TriState
} from '../core/onboard-context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

const INSTALL_COMMAND = 'curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash';

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

  const installedVersion = initialNemoclaw ? await readInstalledNemoclawVersion(initialNemoclaw) : undefined;
  const updateAvailable = isInstalledVersionLower(installedVersion, ctx.install.version);
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

  printPlan(ctx, initialNemoclaw, installedVersion, updateAvailable, versionUpdateApproved);

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
    (ctx.install.mode === 'reinstall' || !nemoclaw || (updateAvailable && versionUpdateApproved));

  if (shouldInstall) {
    // 官方安装器会立即进入首次 onboard，必须在产生安装副作用前验证非交互配置。
    assertNonInteractiveOnboardConfig(ctx);
    logger.step('安装 NemoClaw；官方安装器会在首次安装后自动进入 onboard...');
    await runCommand('bash', ['-o', 'pipefail', '-c', INSTALL_COMMAND], {
      interactive: true,
      sensitive: true,
      env: buildOnboardEnv(ctx),
      description: '通过 NVIDIA 官方安装器安装 NemoClaw，并承接首次 onboard',
      displayCommand: installDisplayCommand(ctx)
    });
    nemoclaw = await resolveNemoclawExecutable();
    const afterInstallVersion = nemoclaw ? await readInstalledNemoclawVersion(nemoclaw) : undefined;
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
  exposeNemoclawOnPath(nemoclaw);

  if (ctx.onboard.mode === 'ensure' && (await isSandboxReady(nemoclaw, ctx.onboard.sandbox.name))) {
    logger.success(`Sandbox 已可用，跳过 onboard: ${ctx.onboard.sandbox.name}`);
    printSummary(ctx, nemoclaw, 'existing');
    return { completed: true, sandboxName: ctx.onboard.sandbox.name };
  }

  // 首次安装器可能已经自动完成 onboard；所有显式模式在新安装后也先以实际状态为准，避免重复创建。
  if (shouldInstall && (await isSandboxReady(nemoclaw, ctx.onboard.sandbox.name))) {
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

function printPlan(
  ctx: OnboardContext,
  detectedNemoclaw: string | undefined,
  installedVersion: string | undefined,
  updateAvailable: boolean,
  versionUpdateApproved: boolean
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
      installReason(ctx, detectedNemoclaw, updateAvailable, versionUpdateApproved)
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
  const envParts = [`NEMOCLAW_INSTALL_TAG=${ctx.install.version}`];
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
  return `curl -fsSL https://www.nvidia.com/nemoclaw.sh | ${envParts.join(' ')} bash`;
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
    ['Onboard', status]
  ]);
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
    NEMOCLAW_INSTALL_TAG: ctx.install.version,
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
    await runCommand(executable, [sandboxName, 'status', '--json'], {
      timeoutMs: 30_000,
      logCommand: false
    });
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

export function isInstalledVersionLower(
  installedVersion: string | undefined,
  targetVersion: string
): boolean {
  if (!installedVersion) return false;
  const installed = parseSemanticVersion(installedVersion);
  const target = parseSemanticVersion(targetVersion);
  if (!installed || !target) return false;
  return compareSemanticVersions(installed, target) < 0;
}

function normalizeVersion(version: string): string | undefined {
  const trimmed = version.trim();
  const match = trimmed.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  return match ? `v${match[1]}` : undefined;
}

interface SemanticVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const normalized = normalizeVersion(value);
  if (!normalized) return undefined;
  const match = normalized.match(
    /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  };
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function resolveNemoclawExecutable(): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry) candidates.add(path.join(entry, 'nemoclaw'));
  }
  candidates.add(path.join(os.homedir(), '.local', 'bin', 'nemoclaw'));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
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
  if (!entries.includes(directory)) process.env.PATH = [directory, ...entries].join(path.delimiter);
}
