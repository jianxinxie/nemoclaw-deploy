import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import fs from 'fs-extra';
import type { DeployContext, PluginItemConfig } from './context.js';
import { remoteTempBase } from './upload-agent-content.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';
import { withTrailingSlash } from '../utils/fs.js';
import { validateHostFileOrDirectory } from '../utils/validators.js';

export async function validatePluginSources(ctx: DeployContext): Promise<void> {
  if (!ctx.plugins.enabled) return;
  for (const item of ctx.plugins.items) {
    if (item.sourceKind === 'path' && item.source) {
      await validateHostFileOrDirectory(item.source);
    }
  }
}

export interface InstallPluginsResult {
  status: 'skipped' | 'configured';
  installed: number;
  enabled: number;
  config?: PluginConfigPlan;
}

export interface PluginConfigPlan {
  ids: string[];
  aliases: Record<string, string>;
}

export async function installPlugins(ctx: DeployContext): Promise<InstallPluginsResult> {
  if (!ctx.plugins.enabled) return { status: 'skipped', installed: 0, enabled: 0 };
  if (ctx.plugins.items.length === 0) {
    throw new Error('plugins.items 至少需要一个插件');
  }

  let discovered = await listDiscoveredPlugins(ctx);
  let installedCount = 0;

  for (const item of ctx.plugins.items) {
    const discoveredPlugin = resolveDiscoveredPlugin(item, discovered);
    const alreadyInstalled = Boolean(discoveredPlugin);

    if (alreadyInstalled && !item.force) {
      logger.info(`插件 ${formatPluginLabel(item, discoveredPlugin)} 已安装，跳过安装步骤。`);
      continue;
    }

    if (!item.source) {
      if (alreadyInstalled) {
        logger.warn(`插件 ${formatPluginLabel(item, discoveredPlugin)} 设置了 force 但没有 source，跳过重装。`);
        continue;
      }
      throw new Error(
        [
          `插件 ${item.id} 尚未安装，且 plugins.items 中没有提供 source。`,
          '请提供本机路径（./ 或 / 开头）、npm spec、clawhub:package 或 marketplace 名称。',
          `也可以先手动安装：nemoclaw ${ctx.sandboxName} exec -- openclaw plugins install <source>`
        ].join('\n')
      );
    }

    await installPlugin(ctx, item);
    installedCount += 1;
    discovered = await listDiscoveredPlugins(ctx);
  }

  discovered = await listDiscoveredPlugins(ctx);
  const resolvedItems = resolvePluginItems(ctx, discovered);
  const config = buildPluginConfigPlan(resolvedItems);

  return {
    status: 'configured',
    installed: installedCount,
    enabled: config.ids.length,
    config
  };
}

interface DiscoveredPlugin {
  id: string;
  name?: string;
  enabled: boolean;
  channelIds: string[];
}

interface ResolvedPluginItem {
  item: PluginItemConfig;
  pluginId: string;
  plugin?: DiscoveredPlugin;
}

async function listDiscoveredPlugins(ctx: DeployContext): Promise<Map<string, DiscoveredPlugin>> {
  if (ctx.options.dryRun) return new Map();

  const result = await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'exec', '--', 'openclaw', 'plugins', 'list', '--json'],
    {
      timeoutMs: 120_000,
      logCommand: false,
      description: '读取 sandbox 中已发现的 OpenClaw 插件列表'
    }
  );

  return parsePluginList(result.stdout);
}

function parsePluginList(stdout: string): Map<string, DiscoveredPlugin> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`无法解析 openclaw plugins list --json 输出: ${stdout.slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new Error(`无法解析 openclaw plugins list --json 输出: ${stdout.slice(0, 200)}`);
  }

  const plugins = (parsed as { plugins?: unknown }).plugins;
  const out = new Map<string, DiscoveredPlugin>();
  if (!Array.isArray(plugins)) return out;

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue;
    const rawPlugin = plugin as {
      id?: unknown;
      name?: unknown;
      enabled?: unknown;
      channelIds?: unknown;
    };
    const id = rawPlugin.id;
    if (typeof id !== 'string' || !id) continue;
    const channelIds = Array.isArray(rawPlugin.channelIds)
      ? rawPlugin.channelIds.filter((channelId): channelId is string => typeof channelId === 'string')
      : [];
    out.set(id, {
      id,
      name: typeof rawPlugin.name === 'string' ? rawPlugin.name : undefined,
      enabled: rawPlugin.enabled === true,
      channelIds
    });
  }

  return out;
}

function resolvePluginItems(
  ctx: DeployContext,
  discovered: Map<string, DiscoveredPlugin>
): ResolvedPluginItem[] {
  return ctx.plugins.items.map((item) => {
    const plugin = resolveDiscoveredPlugin(item, discovered);
    return {
      item,
      plugin,
      pluginId: plugin?.id ?? item.id
    };
  });
}

function resolveDiscoveredPlugin(
  item: PluginItemConfig,
  discovered: Map<string, DiscoveredPlugin>
): DiscoveredPlugin | undefined {
  const exact = discovered.get(item.id);
  if (exact) return exact;

  const packageName = packageNameFromPluginSource(item.source);
  if (packageName) {
    const byName = findDiscoveredPlugin(discovered, (plugin) => plugin.name === packageName);
    if (byName) return byName;
  }

  if (item.channelId) {
    const byExplicitChannel = findDiscoveredPlugin(discovered, (plugin) =>
      plugin.channelIds.includes(item.channelId as string)
    );
    if (byExplicitChannel) return byExplicitChannel;
  }

  return findDiscoveredPlugin(discovered, (plugin) => plugin.channelIds.includes(item.id));
}

function findDiscoveredPlugin(
  discovered: Map<string, DiscoveredPlugin>,
  predicate: (plugin: DiscoveredPlugin) => boolean
): DiscoveredPlugin | undefined {
  return [...discovered.values()].find(predicate);
}

function packageNameFromPluginSource(source?: string): string | undefined {
  const raw = source?.trim();
  if (!raw) return undefined;
  const spec = raw.replace(/^(?:clawhub|npm):/, '');
  if (spec === '.' || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    return undefined;
  }
  if (spec.startsWith('~/')) return undefined;

  if (spec.startsWith('@')) {
    return spec.match(/^(@[^/]+\/[^@/]+)(?:@.+)?$/)?.[1];
  }

  return spec.match(/^([^@:/]+)(?:@.+)?$/)?.[1];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatPluginLabel(item: PluginItemConfig, plugin?: DiscoveredPlugin): string {
  if (!plugin || plugin.id === item.id) return item.id;
  return `${item.id} -> ${plugin.id}`;
}

async function installPlugin(ctx: DeployContext, item: PluginItemConfig): Promise<void> {
  let installSource = item.source ?? '';
  if (item.sourceKind === 'path') {
    installSource = await uploadPluginSource(ctx, item);
  }

  const args = [ctx.sandboxName, 'exec', '--', 'openclaw', 'plugins', 'install', installSource];
  if (item.force || item.trustSource) args.push('--force');
  if (item.acceptCapabilities) args.push('--accept-capabilities');
  if (item.acknowledgeInstallPolicyWarning) args.push('--acknowledge-install-policy-warning');

  logger.info(`安装插件 ${item.id}，来源: ${item.source}`);
  const options = {
    dryRun: ctx.options.dryRun,
    timeoutMs: 300_000,
    description: `在 sandbox 中安装 OpenClaw 插件 ${item.id}`
  };
  try {
    await runCommand('nemoclaw', args, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!item.acceptCapabilities && /--accept-capabilities\b/.test(detail)) {
      throw new Error(`${detail}\n审查插件 ${item.id} 声明的能力后，可在对应插件项设置 acceptCapabilities: true。`);
    }
    if (!item.acknowledgeInstallPolicyWarning && /--acknowledge-install-policy-warning\b/.test(detail)) {
      throw new Error(`${detail}\n审查安装策略警告后，可在插件 ${item.id} 上设置 acknowledgeInstallPolicyWarning: true；block 和策略执行失败仍会停止。`);
    }
    // Only offer trust confirmation for OpenClaw's explicit source-review gate.
    // Network errors and other install failures must retain their original cause.
    if (item.force || item.trustSource || !/Install cancel(?:led|ed);?\s*rerun with --force after reviewing the source/i.test(detail)) {
      throw error;
    }

    if (ctx.options.nonInteractive) {
      throw new Error([
        detail,
        '',
        `OpenClaw 要求显式确认插件 ${item.id} 的安装来源: ${item.source}`,
        `确认已审查并信任该来源后，在 deploy.shared.plugins.items 中为 id: ${item.id} 设置 force: true，再重新部署。`,
        '若只需确认首次安装来源，可改用 trustSource: true；重复部署仍跳过已安装插件。',
        'force: true 会传入 --force，也会对已安装的该插件执行重装。'
      ].join('\n'));
    }

    logger.warn(detail);
    const trusted = await confirm({
      message: `确认已审查并信任插件 ${item.id} 的来源 ${item.source}，使用 --force 重试安装？`,
      default: false
    });
    if (!trusted) {
      throw new Error(`未确认插件 ${item.id} 的安装来源，部署已停止。\n${detail}`);
    }

    await runCommand('nemoclaw', [...args, '--force'], options);
  }
}

async function uploadPluginSource(ctx: DeployContext, item: PluginItemConfig): Promise<string> {
  const hostPath = item.source ?? '';
  const stat = await fs.stat(hostPath).catch(() => null);
  if (!stat) {
    throw new Error(`plugins.items 中 ${item.id} 的 source 路径不存在: ${hostPath}`);
  }

  const remoteDir = `${remoteTempBase(ctx)}/plugins/${item.id}`;
  await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteDir], {
    dryRun: ctx.options.dryRun,
    description: `创建 sandbox 临时目录，用于暂存插件 ${item.id} 的安装文件`
  });

  const basename = path.basename(hostPath);
  const remotePath = `${remoteDir}/${basename}`;

  if (!stat.isDirectory()) {
    await runCommand('nemoclaw', [ctx.sandboxName, 'upload', hostPath, remotePath], {
      dryRun: ctx.options.dryRun,
      description: `上传插件 ${item.id} 的安装文件到 sandbox 临时目录`
    });
    return remotePath;
  }

  await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'upload', withTrailingSlash(hostPath), `${remotePath}/`],
    {
      dryRun: ctx.options.dryRun,
      description: `上传插件 ${item.id} 的本机目录到 sandbox 临时目录`
    }
  );
  return resolveRemotePluginRoot(ctx, remotePath, basename);
}

async function resolveRemotePluginRoot(
  ctx: DeployContext,
  remotePath: string,
  basename: string
): Promise<string> {
  if (ctx.options.dryRun) return remotePath;

  const result = await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `PLUGIN_DIR=${remotePath}`,
      `PLUGIN_BASENAME=${basename}`,
      'node',
      '-e',
      nodeEvalScript(RESOLVE_PLUGIN_ROOT_SCRIPT)
    ],
    {
      timeoutMs: 30_000,
      description: '确认插件目录在 sandbox 中的实际路径',
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env PLUGIN_DIR=${remotePath} node -e <resolve-plugin-root>`
    }
  );

  const resolved = result.stdout.trim();
  if (!resolved.startsWith('/')) {
    throw new Error(`无法确认插件目录的 sandbox 路径: ${result.stdout}`);
  }
  return resolved;
}

function buildPluginConfigPlan(resolvedItems: ResolvedPluginItem[]): PluginConfigPlan {
  const pluginIds = unique(resolvedItems.map((item) => item.pluginId));
  const aliases = Object.fromEntries(
    resolvedItems
      .filter((item) => item.item.id !== item.pluginId)
      .map((item) => [item.item.id, item.pluginId])
  );

  return { ids: pluginIds, aliases };
}

export async function verifyPluginsEnabled(ctx: DeployContext): Promise<void> {
  if (!ctx.plugins.enabled) return;
  if (ctx.options.dryRun) return;

  const discovered = await listDiscoveredPlugins(ctx);
  const missing: string[] = [];
  const disabled: string[] = [];

  for (const item of ctx.plugins.items) {
    const plugin = resolveDiscoveredPlugin(item, discovered);
    if (!plugin) missing.push(item.id);
    else if (!plugin.enabled) disabled.push(formatPluginLabel(item, plugin));
  }

  if (missing.length > 0 || disabled.length > 0) {
    throw new Error(
      [
        '插件配置验证失败：',
        missing.length > 0 ? `未发现插件: ${missing.join(', ')}` : '',
        disabled.length > 0 ? `插件未启用: ${disabled.join(', ')}` : '',
        '如果插件包的真实 id 与 channel id 不同，请在 onboard.yaml 的 deploy.shared.plugins 中用真实 plugin id，并设置 channelId。',
        `可执行 nemoclaw ${ctx.sandboxName} exec -- openclaw plugins doctor 查看插件加载问题。`
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
}

const RESOLVE_PLUGIN_ROOT_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.PLUGIN_DIR;
const basename = process.env.PLUGIN_BASENAME;
if (!dir) throw new Error('PLUGIN_DIR is required');
if (!fs.existsSync(dir)) throw new Error('PLUGIN_DIR does not exist: ' + dir);

let root = dir;
if (basename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory() && entries[0].name === basename) {
    root = path.join(dir, entries[0].name);
  }
}

process.stdout.write(root);
`;
