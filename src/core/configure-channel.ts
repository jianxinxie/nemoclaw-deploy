import { input, password } from '@inquirer/prompts';
import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { maskSecret } from '../utils/mask.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';
import {
  dashboardUrlToGatewayUrl,
  validateChannelServerUrl,
  validateGatewayUrl
} from '../utils/validators.js';

export interface PrepareChannelServerResult {
  status: 'skipped' | 'configured';
  restarted: boolean;
  reason?: 'disabled' | 'existing';
  config?: Record<string, unknown>;
}

export async function prepareChannelServer(ctx: DeployContext): Promise<PrepareChannelServerResult> {
  if (!ctx.channelServer.enabled) return { status: 'skipped', restarted: false, reason: 'disabled' };

  ctx.channelServer.url = validateChannelServerUrl(ctx.channelServer.url);

  // Always resolve the live gateway values, even on repeat deployments. The
  // overlay may contain stale connection fields which this plan must override.
  await ensureGatewayToken(ctx);
  await ensureGatewayUrl(ctx);

  const gatewayToken = requireValue(ctx.channelServer.gatewayToken, 'gatewayToken');
  ctx.channelServer.gatewayUrl = validateGatewayUrl(requireValue(ctx.channelServer.gatewayUrl, 'gatewayUrl'));
  const config = buildAdvbotConfig(ctx, gatewayToken);
  const existingChannel = await getExistingAdvbotChannel(ctx);
  if (existingChannel.matches) {
    logger.info(
      `channels.advbot.accounts.${ctx.channelServer.advbotAccountId} 已存在且与当前 gateway 一致，将在合并时保留动态连接字段。`
    );
    return { status: 'skipped', restarted: false, reason: 'existing', config };
  }

  logger.info(`Gateway Token: ${maskSecret(gatewayToken)}`);
  return { status: 'configured', restarted: false, config };
}

function buildAdvbotConfig(
  ctx: DeployContext,
  gatewayToken?: string
): Record<string, unknown> {
  const account: Record<string, unknown> = {
    enabled: true,
    accountId: ctx.channelServer.advbotAccountId,
    channelServerUrl: ctx.channelServer.url,
    gatewayUrl: requireValue(ctx.channelServer.gatewayUrl, 'gatewayUrl')
  };
  if (gatewayToken) account.gatewayToken = gatewayToken;

  return {
    enabled: true,
    accounts: {
      [ctx.channelServer.advbotAccountId]: account
    }
  };
}

export async function verifyAdvbotChannelSupported(ctx: DeployContext): Promise<void> {
  if (!ctx.channelServer.enabled) return;
  if (ctx.options.dryRun) return;

  try {
    const result = await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'exec', '--', 'openclaw', 'channels', 'list', '--all', '--json'],
      {
        timeoutMs: 30_000,
        description: '确认当前 OpenClaw 支持 advbot channel'
      }
    );

    // Plugin discovery logs may mention advbot even if it failed to load.
    const start = result.stdout.indexOf('{');
    const end = result.stdout.lastIndexOf('}');
    const parsed = JSON.parse(result.stdout.slice(start, end + 1)) as {
      chat?: { advbot?: string[] | { accounts?: unknown; installed?: boolean; origin?: string } };
    };
    const channel = parsed.chat?.advbot;
    // OpenClaw 2026.9.2 returns { accounts, installed, origin }; older releases
    // returned an array of account ids directly under chat.<channel>.
    const accounts = Array.isArray(channel) ? channel : channel?.accounts;
    const installed = Array.isArray(channel) || channel?.installed === true;
    if (!installed || !Array.isArray(accounts) || !accounts.includes(ctx.channelServer.advbotAccountId)) {
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
}

async function getExistingAdvbotChannel(ctx: DeployContext): Promise<ExistingAdvbotChannel> {
  const result = await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `ACCOUNT_ID=${ctx.channelServer.advbotAccountId}`,
      `CHANNEL_SERVER_URL=${ctx.channelServer.url}`,
      `GATEWAY_TOKEN=${ctx.channelServer.gatewayToken ?? ''}`,
      `GATEWAY_URL=${ctx.channelServer.gatewayUrl ?? ''}`,
      'node',
      '-e',
      nodeEvalScript(CHECK_ADVBOT_CHANNEL_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      timeoutMs: 30_000,
      description: '检查 channels.advbot 是否已经存在，存在且可用则跳过重复配置',
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env ACCOUNT_ID=${ctx.channelServer.advbotAccountId} CHANNEL_SERVER_URL=${ctx.channelServer.url} node -e <check-advbot-channel>`
    }
  );

  try {
    const parsed = JSON.parse(result.stdout) as ExistingAdvbotChannel;
    if (typeof parsed.matches !== 'boolean') throw new Error('missing matches');
    return parsed;
  } catch {
    logger.warn('无法解析现有 channel 配置检查结果，将继续重新配置 channel。');
    return { matches: false };
  }
}

async function ensureGatewayToken(ctx: DeployContext): Promise<void> {
  if (ctx.channelServer.gatewayToken) return;

  try {
    const result = await runCommand('nemoclaw', [ctx.sandboxName, 'gateway-token', '--quiet'], {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      rawOutput: true,
      description: '自动获取 gateway token，用于 advbot 连接 gateway'
    });
    const token = result.stdout.trim();
    if (!token) throw new Error('gateway-token 输出为空');
    ctx.channelServer.gatewayToken = token;
    return;
  } catch (error) {
    if (ctx.options.nonInteractive) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`自动获取 gatewayToken 失败: ${detail}`);
    }
  }

  ctx.channelServer.gatewayToken = await password({
    message: '请输入 gatewayToken：',
    mask: '*',
    validate: (value) => (value.trim() ? true : 'gatewayToken 是必填字段')
  });
}

async function ensureGatewayUrl(ctx: DeployContext): Promise<void> {
  if (ctx.channelServer.gatewayUrl) {
    ctx.channelServer.gatewayUrl = validateGatewayUrl(ctx.channelServer.gatewayUrl);
    return;
  }

  try {
    const result = await runCommand('nemoclaw', [ctx.sandboxName, 'dashboard-url', '--quiet'], {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      rawOutput: true,
      description: '获取 dashboard URL，并推导不含 token fragment 的 gateway URL'
    });
    const dashboardUrl = result.stdout.trim();
    if (!dashboardUrl) throw new Error('dashboard-url 输出为空');
    ctx.channelServer.gatewayUrl = dashboardUrlToGatewayUrl(dashboardUrl);
    return;
  } catch (error) {
    if (ctx.options.nonInteractive) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`自动获取 gatewayUrl 失败: ${detail}`);
    }
  }

  ctx.channelServer.gatewayUrl = await input({
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

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 是必填字段`);
  return value;
}

function buildUnsupportedAdvbotMessage(sandboxName: string): string {
  return [
    '当前 OpenClaw 不支持 advbot channel，已停止配置 channels.advbot。',
    '请先确认 advbot channel/plugin 已安装并能在下面命令中看到：',
    `nemoclaw ${sandboxName} exec -- openclaw channels list --all --json`,
    '如果这个 OpenClaw 版本没有 advbot channel，请在 onboard.yaml 中设置 deploy.shared.channelServer.enabled: false。'
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
    '如果 advbot channel 在当前 OpenClaw 中不可用，请移除 channels.advbot 后重试，或在 onboard.yaml 中设置 deploy.shared.channelServer.enabled: false。',
    '',
    detail
  ].join('\n');
}

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
    account.enabled === true &&
    account.accountId === accountId &&
    channelServerUrl === desiredChannelServerUrl &&
    Boolean(gatewayToken) &&
    /^wss?:\\/\\//.test(gatewayUrl) &&
    gatewayUrl === desiredGatewayUrl &&
    gatewayToken === desiredGatewayToken;

  finish({
    matches: Boolean(matches)
  });
} catch {
  finish({ matches: false });
}
`;
