import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import type { DeployContext } from './context.js';
import type { PrepareChannelServerResult } from './configure-channel.js';
import type { InstallPluginsResult, PluginConfigPlan } from './install-plugins.js';
import { remoteTempBase } from './upload-agent-content.js';
import { runCommand } from '../utils/run.js';

export interface ApplyOpenClawConfigResult {
  status: 'unchanged' | 'applied';
  backupPath?: string;
}

export interface ApplyOpenClawConfigOptions {
  contexts: DeployContext[];
  plugins: InstallPluginsResult;
  channelServer: PrepareChannelServerResult;
}

export async function validateOpenClawPartialFile(file: string): Promise<string> {
  const resolved = path.resolve(file);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`openclawConfig.file 不是有效文件: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(
      `openclawConfig.file 不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertValidPartialConfig(parsed);
  return resolved;
}

export async function applyOpenClawConfig(
  options: ApplyOpenClawConfigOptions
): Promise<ApplyOpenClawConfigResult> {
  const ctx = options.contexts[0];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-openclaw-'));
  const applyScript = path.join(tempDir, 'apply-openclaw-config.mjs');
  const rollbackScript = path.join(tempDir, 'rollback-openclaw-config.mjs');
  const remoteDir = `${remoteTempBase(ctx)}/openclaw-config`;
  const remoteApplyScript = `${remoteDir}/apply-openclaw-config.mjs`;
  const remoteRollbackScript = `${remoteDir}/rollback-openclaw-config.mjs`;
  const remotePartial = `${remoteDir}/openclaw.partial.json`;
  const backupPath = `${remoteDir}/openclaw.json.before-deploy`;

  const partialFile = ctx.openclawConfig.enabled
    ? await validateOpenClawPartialFile(requireValue(ctx.openclawConfig.file, 'openclawConfig.file'))
    : undefined;
  const managedPlan = buildManagedPlan(ctx, options.plugins.config, options.channelServer);
  const agentModels = Object.fromEntries(
    options.contexts
      .filter((agent) => Boolean(agent.model))
      .map((agent) => [agent.agentName, agent.model as string])
  );

  try {
    await fs.writeFile(applyScript, APPLY_OPENCLAW_CONFIG_SCRIPT, 'utf8');
    await fs.writeFile(rollbackScript, ROLLBACK_OPENCLAW_CONFIG_SCRIPT, 'utf8');

    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteDir], {
      dryRun: ctx.options.dryRun,
      description: '创建 sandbox 临时目录，用于统一提交 OpenClaw 配置'
    });
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'upload', applyScript, remoteApplyScript],
      {
        dryRun: ctx.options.dryRun,
        description: '上传 OpenClaw 配置事务脚本'
      }
    );
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'upload', rollbackScript, remoteRollbackScript],
      {
        dryRun: ctx.options.dryRun,
        description: '上传 OpenClaw 配置回滚脚本'
      }
    );
    if (partialFile) {
      await runCommand(
        'nemoclaw',
        [ctx.sandboxName, 'upload', partialFile, remotePartial],
        {
          dryRun: ctx.options.dryRun,
          sensitive: true,
          description: '上传用户提供的 openclaw partial JSON'
        }
      );
    }

    const result = await runCommand(
      'nemoclaw',
      [
        ctx.sandboxName,
        'exec',
        '--',
        'env',
        `PARTIAL_FILE=${partialFile ? remotePartial : ''}`,
        `BACKUP_FILE=${backupPath}`,
        `MANAGED_PLAN_JSON=${JSON.stringify(managedPlan)}`,
        `AGENT_MODELS_JSON=${JSON.stringify(agentModels)}`,
        'node',
        remoteApplyScript
      ],
      {
        dryRun: ctx.options.dryRun,
        sensitive: true,
        timeoutMs: 30_000,
        description: '一次性合并并原子写入 /sandbox/.openclaw/openclaw.json',
        displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env PARTIAL_FILE=${partialFile ? remotePartial : ''} BACKUP_FILE=${backupPath} MANAGED_PLAN_JSON=****** AGENT_MODELS_JSON=****** node ${remoteApplyScript}`
      }
    );

    const changed = parseChanged(result.stdout, ctx.options.dryRun);
    try {
      await runCommand(
        'nemoclaw',
        [ctx.sandboxName, 'exec', '--', 'openclaw', 'config', 'validate'],
        {
          dryRun: ctx.options.dryRun,
          timeoutMs: 30_000,
          description: '验证统一写入后的 OpenClaw 配置'
        }
      );
    } catch (error) {
      if (changed) {
        await rollbackOpenClawConfig(ctx, remoteRollbackScript, backupPath);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenClaw 配置验证失败${changed ? '，已恢复写入前配置' : ''}：\n${detail}`);
    }

    return changed
      ? { status: 'applied', backupPath }
      : { status: 'unchanged' };
  } finally {
    await fs.remove(tempDir);
  }
}

function buildManagedPlan(
  ctx: DeployContext,
  pluginPlan: PluginConfigPlan | undefined,
  channelServer: PrepareChannelServerResult
): Record<string, unknown> {
  const plugins: PluginConfigPlan = pluginPlan
    ? {
        ids: [...pluginPlan.ids],
        aliases: { ...pluginPlan.aliases }
      }
    : { ids: [], aliases: {} };

  if (ctx.channelServer.enabled && !plugins.ids.includes('advbot')) {
    plugins.ids.push('advbot');
  }

  return {
    plugins,
    advbot: ctx.channelServer.enabled && channelServer.config
      ? { id: 'advbot', config: channelServer.config }
      : null
  };
}

async function rollbackOpenClawConfig(
  ctx: DeployContext,
  rollbackScript: string,
  backupPath: string
): Promise<void> {
  await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `BACKUP_FILE=${backupPath}`,
      'node',
      rollbackScript
    ],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: '恢复 OpenClaw 配置事务写入前的备份'
    }
  );
}

function parseChanged(stdout: string, dryRun: boolean): boolean {
  if (dryRun) return true;
  try {
    return (JSON.parse(stdout) as { changed?: unknown }).changed === true;
  } catch {
    throw new Error(`无法解析 OpenClaw 配置事务结果: ${stdout}`);
  }
}

function assertValidPartialConfig(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error('openclawConfig.file 顶层必须是 JSON 对象');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'agents')) {
    throw new Error(
      'openclawConfig.file 不允许包含 agents；agent 创建和 workspace 交给 OpenClaw，model 请配置在 deploy.agents[].model'
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} 是必填字段`);
  return value;
}

const APPLY_OPENCLAW_CONFIG_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';

const configPath = '/sandbox/.openclaw/openclaw.json';
const partialFile = process.env.PARTIAL_FILE || '';
const backupFile = process.env.BACKUP_FILE;
const managed = JSON.parse(process.env.MANAGED_PLAN_JSON || '{}');
const agentModels = JSON.parse(process.env.AGENT_MODELS_JSON || '{}');

if (!backupFile) throw new Error('BACKUP_FILE is required');
if (!fs.existsSync(configPath)) throw new Error('OpenClaw config does not exist: ' + configPath);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else {
      out[key] = mergePatch(out[key], value);
    }
  }
  return out;
}

function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return clone(source);
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

const originalText = fs.readFileSync(configPath, 'utf8');
const original = JSON.parse(originalText);
let next = clone(original);

if (partialFile) {
  const partial = JSON.parse(fs.readFileSync(partialFile, 'utf8'));
  if (!isPlainObject(partial)) throw new Error('openclaw partial config must be an object');
  if (Object.prototype.hasOwnProperty.call(partial, 'agents')) {
    throw new Error('openclaw partial config must not contain agents');
  }
  next = mergePatch(next, partial);
}

const pluginPlan = managed.plugins || { ids: [], aliases: {}, channels: {} };
if ((pluginPlan.ids || []).length > 0 || Object.keys(pluginPlan.aliases || {}).length > 0) {
  if (!isPlainObject(next.plugins)) next.plugins = {};
  if (!isPlainObject(next.plugins.entries)) next.plugins.entries = {};

  for (const [aliasId, pluginId] of Object.entries(pluginPlan.aliases || {})) {
    if (!aliasId || !pluginId || aliasId === pluginId) continue;
    const aliasEntry = next.plugins.entries[aliasId];
    if (!aliasEntry) continue;
    const existingEntry = next.plugins.entries[pluginId];
    next.plugins.entries[pluginId] = deepMerge(aliasEntry, existingEntry || {});
    delete next.plugins.entries[aliasId];
  }

  for (const id of pluginPlan.ids || []) {
    const entry = isPlainObject(next.plugins.entries[id]) ? next.plugins.entries[id] : {};
    next.plugins.entries[id] = {
      ...entry,
      enabled: true,
      config: isPlainObject(entry.config) ? entry.config : {}
    };
  }
}

if (managed.advbot) {
  if (!isPlainObject(next.channels)) next.channels = {};
  next.channels[managed.advbot.id] = deepMerge(
    next.channels[managed.advbot.id],
    managed.advbot.config
  );
}

const modelEntries = Object.entries(agentModels);
if (modelEntries.length > 0) {
  const list = Array.isArray(next.agents)
    ? next.agents
    : isPlainObject(next.agents) && Array.isArray(next.agents.list)
      ? next.agents.list
      : null;
  if (!list) throw new Error('OpenClaw config does not contain agents.list');

  for (const [agentId, model] of modelEntries) {
    const agent = list.find((item) =>
      isPlainObject(item) && (item.id === agentId || item.name === agentId || item.agentName === agentId)
    );
    if (!agent) throw new Error('OpenClaw config does not contain agent: ' + agentId);
    agent.model = model;
  }
}

const nextText = JSON.stringify(next, null, 2) + '\\n';
const changed = JSON.stringify(original) !== JSON.stringify(next);
if (changed) {
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  fs.copyFileSync(configPath, backupFile);
  const mode = fs.statSync(configPath).mode & 0o777;
  const tempPath = configPath + '.nemoclaw-deploy.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tempPath, nextText, { mode });
    fs.renameSync(tempPath, configPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

process.stdout.write(JSON.stringify({ changed }));
`;

const ROLLBACK_OPENCLAW_CONFIG_SCRIPT = `
import fs from 'node:fs';

const configPath = '/sandbox/.openclaw/openclaw.json';
const backupFile = process.env.BACKUP_FILE;
if (!backupFile) throw new Error('BACKUP_FILE is required');
if (!fs.existsSync(backupFile)) throw new Error('OpenClaw config backup does not exist: ' + backupFile);

const mode = fs.statSync(configPath).mode & 0o777;
const tempPath = configPath + '.nemoclaw-deploy.rollback.' + process.pid + '.tmp';
try {
  fs.copyFileSync(backupFile, tempPath);
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, configPath);
} finally {
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
}
`;
