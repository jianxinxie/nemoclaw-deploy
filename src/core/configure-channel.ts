import os from 'node:os';
import path from 'node:path';
import { input, password } from '@inquirer/prompts';
import fs from 'fs-extra';
import type { DeployContext } from './context.js';
import { remoteTempBase } from './upload-agent-content.js';
import { logger } from '../utils/logger.js';
import { maskSecret } from '../utils/mask.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';
import {
  dashboardUrlToGatewayUrl,
  validateChannelServerUrl,
  validateGatewayUrl
} from '../utils/validators.js';

export interface ConfigureChannelResult {
  status: 'skipped' | 'configured';
  restarted: boolean;
  reason?: 'disabled' | 'existing';
}

const pluginConfigEnsured = new WeakSet<DeployContext>();

export async function configureChannel(ctx: DeployContext): Promise<ConfigureChannelResult> {
  if (!ctx.channel.enabled) return { status: 'skipped', restarted: false, reason: 'disabled' };

  ctx.channel.channelServerUrl = validateChannelServerUrl(ctx.channel.channelServerUrl);
  await ensureAdvbotPluginConfig(ctx);
  await assertAdvbotChannelSupported(ctx);

  const existingChannel = await getExistingAdvbotChannel(ctx);
  if (existingChannel.matches) {
    ctx.channel.gatewayUrl = existingChannel.gatewayUrl;
    ctx.channel.gatewayToken = ctx.channel.gatewayToken || '******';
    logger.info(
      `channels.advbot.accounts.${ctx.channel.accountId} 已存在且配置可用，跳过 channel 配置。`
    );
    return { status: 'skipped', restarted: false, reason: 'existing' };
  }

  await ensureGatewayToken(ctx);
  await ensureGatewayUrl(ctx);

  const gatewayToken = requireValue(ctx.channel.gatewayToken, 'gatewayToken');
  const gatewayUrl = validateGatewayUrl(requireValue(ctx.channel.gatewayUrl, 'gatewayUrl'));
  ctx.channel.gatewayUrl = gatewayUrl;

  const advbotConfig = {
    enabled: true,
    accounts: {
      [ctx.channel.accountId]: {
        enabled: true,
        accountId: ctx.channel.accountId,
        channelServerUrl: ctx.channel.channelServerUrl,
        gatewayToken,
        gatewayUrl
      }
    }
  };

  const args = [
    ctx.sandboxName,
    'config',
    'set',
    '--key',
    'channels.advbot',
    '--value',
    JSON.stringify(advbotConfig)
  ];

  const restartWithConfigSet = ctx.options.restart && !ctx.networkPolicy.enabled;
  let restarted = false;

  if (restartWithConfigSet) {
    args.push('--restart');
  }

  try {
    await runCommand('nemoclaw', args, {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      description: '写入 channels.advbot 配置，包含 channel server、gateway URL 和脱敏 token'
    });
    restarted = restartWithConfigSet;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`config set 失败，改用 patch 脚本方式。${detail}`);
    await patchAdvbotChannel(ctx);
  }

  logger.info(`Gateway Token: ${maskSecret(gatewayToken)}`);
  return { status: 'configured', restarted };
}

export async function ensureAdvbotPluginConfig(ctx: DeployContext): Promise<void> {
  if (!ctx.channel.enabled) return;
  if (pluginConfigEnsured.has(ctx)) return;

  await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'exec', '--', 'node', '-e', nodeEvalScript(PATCH_ADVBOT_PLUGIN_CONFIG_SCRIPT)],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: '确保 OpenClaw 已启用 advbot plugin，并加入 plugins.allow',
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- node -e <patch-advbot-plugin-config>`
    }
  );
  pluginConfigEnsured.add(ctx);
}

async function assertAdvbotChannelSupported(ctx: DeployContext): Promise<void> {
  if (ctx.options.dryRun) return;

  try {
    const result = await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'exec', '--', 'openclaw', 'channels', 'list', '--all'],
      {
        timeoutMs: 30_000,
        description: '确认当前 OpenClaw 支持 advbot channel'
      }
    );

    if (!/\badvbot\b/i.test(result.stdout)) {
      throw new Error(buildUnsupportedAdvbotMessage(ctx.sandboxName));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/unknown channel id:\s*advbot/i.test(detail)) {
      throw new Error(buildInvalidAdvbotConfigMessage(ctx.sandboxName, detail));
    }

    if (detail.includes('当前 OpenClaw 不支持 advbot channel')) {
      throw error;
    }

    throw new Error(
      [
        '无法确认当前 OpenClaw 是否支持 advbot channel。',
        '为避免写入无效 channels.advbot 配置，已停止部署。',
        detail
      ].join('\n')
    );
  }
}

interface ExistingAdvbotChannel {
  matches: boolean;
  gatewayUrl?: string;
}

async function getExistingAdvbotChannel(ctx: DeployContext): Promise<ExistingAdvbotChannel> {
  const result = await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `ACCOUNT_ID=${ctx.channel.accountId}`,
      `CHANNEL_SERVER_URL=${ctx.channel.channelServerUrl}`,
      `GATEWAY_TOKEN=${ctx.channel.gatewayToken ?? ''}`,
      `GATEWAY_URL=${ctx.channel.gatewayUrl ?? ''}`,
      'node',
      '-e',
      nodeEvalScript(CHECK_ADVBOT_CHANNEL_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      timeoutMs: 30_000,
      description: '检查 channels.advbot 是否已经存在，存在且可用则跳过重复配置',
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env ACCOUNT_ID=${ctx.channel.accountId} CHANNEL_SERVER_URL=${ctx.channel.channelServerUrl} node -e <check-advbot-channel>`
    }
  );

  try {
    const parsed = JSON.parse(result.stdout) as ExistingAdvbotChannel;
    if (parsed.gatewayUrl) {
      parsed.gatewayUrl = validateGatewayUrl(parsed.gatewayUrl);
    }
    return parsed;
  } catch {
    logger.warn(`无法解析现有 channel 配置检查结果，将继续重新配置 channel: ${result.stdout}`);
    return { matches: false };
  }
}

async function ensureGatewayToken(ctx: DeployContext): Promise<void> {
  if (ctx.channel.gatewayToken) return;

  try {
    const result = await runCommand('nemoclaw', [ctx.sandboxName, 'gateway-token', '--quiet'], {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      description: '自动获取 gateway token，用于 advbot 连接 gateway'
    });
    const token = result.stdout.trim();
    if (!token) throw new Error('gateway-token 输出为空');
    ctx.channel.gatewayToken = token;
    return;
  } catch (error) {
    if (ctx.options.nonInteractive) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`自动获取 gatewayToken 失败: ${detail}`);
    }
  }

  ctx.channel.gatewayToken = await password({
    message: '请输入 gatewayToken：',
    mask: '*',
    validate: (value) => (value.trim() ? true : 'gatewayToken 是必填字段')
  });
}

async function ensureGatewayUrl(ctx: DeployContext): Promise<void> {
  if (ctx.channel.gatewayUrl) {
    ctx.channel.gatewayUrl = validateGatewayUrl(ctx.channel.gatewayUrl);
    return;
  }

  try {
    const result = await runCommand('nemoclaw', [ctx.sandboxName, 'dashboard-url', '--quiet'], {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      description: '获取 dashboard URL，并推导不含 token fragment 的 gateway URL'
    });
    const dashboardUrl = result.stdout.trim();
    if (!dashboardUrl) throw new Error('dashboard-url 输出为空');
    ctx.channel.gatewayUrl = dashboardUrlToGatewayUrl(dashboardUrl);
    return;
  } catch (error) {
    if (ctx.options.nonInteractive) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`自动获取 gatewayUrl 失败: ${detail}`);
    }
  }

  ctx.channel.gatewayUrl = await input({
    message: '请输入 gatewayUrl：',
    validate: (value) => {
      try {
        validateGatewayUrl(value);
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : 'gatewayUrl 无效';
      }
    }
  });
}

async function patchAdvbotChannel(ctx: DeployContext): Promise<void> {
  const gatewayToken = requireValue(ctx.channel.gatewayToken, 'gatewayToken');
  const gatewayUrl = requireValue(ctx.channel.gatewayUrl, 'gatewayUrl');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-'));
  const scriptPath = path.join(tempDir, 'patch-advbot-channel.mjs');
  const remoteBase = remoteTempBase(ctx);

  try {
    await fs.writeFile(scriptPath, PATCH_ADVBOT_CHANNEL_SCRIPT, 'utf8');
    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteBase], {
      dryRun: ctx.options.dryRun,
      description: '创建 sandbox 临时目录，用于上传 advbot 配置 patch 脚本'
    });
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'upload', scriptPath, `${remoteBase}/patch-advbot-channel.mjs`],
      {
        dryRun: ctx.options.dryRun,
        description: '上传 advbot 配置 patch 脚本到 sandbox'
      }
    );
    await runCommand(
      'nemoclaw',
      [
        ctx.sandboxName,
        'exec',
        '--',
        'env',
        `ACCOUNT_ID=${ctx.channel.accountId}`,
        `CHANNEL_SERVER_URL=${ctx.channel.channelServerUrl}`,
        `GATEWAY_TOKEN=${gatewayToken}`,
        `GATEWAY_URL=${gatewayUrl}`,
        'node',
        `${remoteBase}/patch-advbot-channel.mjs`
      ],
      {
        dryRun: ctx.options.dryRun,
        sensitive: true,
        description: '执行 patch 脚本，安全更新 /sandbox/.openclaw/openclaw.json'
      }
    );
  } finally {
    await fs.remove(tempDir);
  }
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 是必填字段`);
  return value;
}

function buildUnsupportedAdvbotMessage(sandboxName: string): string {
  return [
    '当前 OpenClaw 不支持 advbot channel，已停止配置 channels.advbot。',
    '请先确认 advbot channel/plugin 已安装并能在下面命令中看到：',
    `nemoclaw ${sandboxName} exec -- openclaw channels list --all`,
    '如果这个 OpenClaw 版本没有 advbot channel，请在 deploy.yaml 中设置 channel.enabled: false。'
  ].join('\n');
}

function buildInvalidAdvbotConfigMessage(sandboxName: string, detail: string): string {
  return [
    '当前 sandbox 的 OpenClaw 配置已经无效：channels.advbot 是未知 channel id。',
    '工具已停止，避免继续写入无效配置。',
    '',
    '可先按 OpenClaw 提示修复：',
    `nemoclaw ${sandboxName} exec -- openclaw doctor --fix --non-interactive`,
    '',
    '如果 advbot channel 在当前 OpenClaw 中不可用，请移除 channels.advbot 后重试，或在 deploy.yaml 中设置 channel.enabled: false。',
    '',
    detail
  ].join('\n');
}

const PATCH_ADVBOT_CHANNEL_SCRIPT = `
import fs from 'node:fs';

const configPath = '/sandbox/.openclaw/openclaw.json';

const accountId = process.env.ACCOUNT_ID || 'default';
const channelServerUrl = process.env.CHANNEL_SERVER_URL;
const gatewayToken = process.env.GATEWAY_TOKEN;
const gatewayUrl = process.env.GATEWAY_URL;

if (!channelServerUrl) throw new Error('CHANNEL_SERVER_URL is required');
if (!gatewayToken) throw new Error('GATEWAY_TOKEN is required');
if (!gatewayUrl) throw new Error('GATEWAY_URL is required');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries.advbot = {
  ...config.plugins.entries.advbot,
  enabled: true,
  config:
    config.plugins.entries.advbot &&
    config.plugins.entries.advbot.config &&
    typeof config.plugins.entries.advbot.config === 'object' &&
    !Array.isArray(config.plugins.entries.advbot.config)
      ? config.plugins.entries.advbot.config
      : {}
};

if (!Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [];
}
if (!config.plugins.allow.includes('advbot')) {
  config.plugins.allow.push('advbot');
}

config.channels ??= {};
config.channels.advbot ??= {};
config.channels.advbot.enabled = true;
config.channels.advbot.accounts ??= {};

config.channels.advbot.accounts[accountId] = {
  enabled: true,
  accountId,
  channelServerUrl,
  gatewayToken,
  gatewayUrl
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
`;

const PATCH_ADVBOT_PLUGIN_CONFIG_SCRIPT = `
const fs = require('node:fs');

const configPath = '/sandbox/.openclaw/openclaw.json';
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};

config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries.advbot = {
  ...config.plugins.entries.advbot,
  enabled: true,
  config:
    config.plugins.entries.advbot &&
    config.plugins.entries.advbot.config &&
    typeof config.plugins.entries.advbot.config === 'object' &&
    !Array.isArray(config.plugins.entries.advbot.config)
      ? config.plugins.entries.advbot.config
      : {}
};

if (!Array.isArray(config.plugins.allow)) {
  config.plugins.allow = [];
}
if (!config.plugins.allow.includes('advbot')) {
  config.plugins.allow.push('advbot');
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
`;

const CHECK_ADVBOT_CHANNEL_SCRIPT = `
const fs = require('node:fs');

const configPath = '/sandbox/.openclaw/openclaw.json';
const accountId = process.env.ACCOUNT_ID || 'default';
const desiredChannelServerUrl = process.env.CHANNEL_SERVER_URL || '';
const desiredGatewayToken = process.env.GATEWAY_TOKEN || '';
const desiredGatewayUrl = process.env.GATEWAY_URL || '';

function finish(value) {
  process.stdout.write(JSON.stringify(value));
}

try {
  if (!fs.existsSync(configPath)) {
    finish({ matches: false });
    process.exit(0);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const plugins = config.plugins || {};
  const pluginEntry = plugins.entries && plugins.entries.advbot;
  const pluginAllowed = Array.isArray(plugins.allow) && plugins.allow.includes('advbot');
  const advbot = config.channels && config.channels.advbot;
  const account = advbot && advbot.accounts && advbot.accounts[accountId];

  if (!advbot || !account) {
    finish({ matches: false });
    process.exit(0);
  }

  const gatewayUrl = typeof account.gatewayUrl === 'string' ? account.gatewayUrl : '';
  const gatewayToken = typeof account.gatewayToken === 'string' ? account.gatewayToken : '';
  const channelServerUrl = typeof account.channelServerUrl === 'string' ? account.channelServerUrl : '';

  const matches =
    advbot.enabled === true &&
    pluginEntry &&
    pluginEntry.enabled === true &&
    pluginAllowed &&
    account.enabled === true &&
    channelServerUrl === desiredChannelServerUrl &&
    Boolean(gatewayToken) &&
    /^wss?:\\/\\//.test(gatewayUrl) &&
    (!desiredGatewayUrl || gatewayUrl === desiredGatewayUrl) &&
    (!desiredGatewayToken || gatewayToken === desiredGatewayToken);

  finish({
    matches,
    gatewayUrl: matches ? gatewayUrl : undefined
  });
} catch {
  finish({ matches: false });
}
`;
