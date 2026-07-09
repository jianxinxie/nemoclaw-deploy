import os from 'node:os';
import path from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';
import { resolveFromBase } from '../utils/fs.js';
import { readYamlFile } from '../utils/yaml.js';
import {
  conflictStrategySchema,
  isPluginHostPathSource,
  validateAgentName,
  validateChannelServerUrl,
  validateDependencyCommand,
  validateDependencyWorkingDir,
  validateEnvName,
  validateEnvTargetFile,
  validateEnvValue,
  validateGatewayUrl,
  validateIgnorePattern,
  validatePluginId,
  validatePluginSource,
  validateSandboxName,
  validateToolsProfile
} from '../utils/validators.js';

export type ConflictStrategy = 'ask' | 'skip' | 'backup' | 'overwrite' | 'fail';

export interface PluginItemConfig {
  id: string;
  channelId?: string;
  source?: string;
  sourceKind: 'path' | 'spec' | 'none';
  force: boolean;
  channel?: Record<string, unknown>;
}

export interface DeployContext {
  sandboxName: string;
  agentName: string;
  workspace: string;

  agentContent: {
    enabled: boolean;
    hostDir?: string;
    conflictStrategy: ConflictStrategy;
    ignore: string[];
  };

  skill: {
    enabled: boolean;
    hostDir?: string;
  };

  plugins: {
    enabled: boolean;
    items: PluginItemConfig[];
  };

  tools: {
    enabled: boolean;
    profile: string;
    config: Record<string, unknown>;
  };

  channel: {
    enabled: boolean;
    type: 'advbot';
    accountId: string;
    channelServerUrl: string;
    gatewayToken?: string;
    gatewayUrl?: string;
  };

  networkPolicy: {
    enabled: boolean;
    dir?: string;
  };

  env: {
    enabled: boolean;
    targetFile: string;
    variables: Record<string, string>;
  };

  dependencies: {
    enabled: boolean;
    workingDir: string;
    commands: string[];
    continueOnError: boolean;
  };

  options: {
    restartGateway: boolean;
    nonInteractive: boolean;
    dryRun: boolean;
  };
}

export interface DeployCliOptions {
  config?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

const deployConfigSchema = z
  .object({
    sandboxName: z.string().optional(),
    agentName: z.string().optional(),
    workspace: z.string().optional().nullable(),
    agentContent: z
      .object({
        enabled: z.boolean().optional(),
        hostDir: z.string().optional(),
        conflictStrategy: conflictStrategySchema.optional(),
        ignore: z.array(z.string()).optional()
      })
      .optional(),
    skill: z
      .object({
        enabled: z.boolean().optional(),
        hostDir: z.string().optional()
      })
      .optional(),
    plugins: z
      .object({
        enabled: z.boolean().optional(),
        items: z
          .array(
            z.object({
              id: z.string(),
              channelId: z.string().optional(),
              source: z.string().optional().nullable(),
              force: z.boolean().optional(),
              channel: z.record(z.string(), z.unknown()).optional()
            })
          )
          .optional()
      })
      .optional(),
    tools: z
      .object({
        enabled: z.boolean().optional(),
        profile: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional()
      })
      .optional(),
    channel: z
      .object({
        enabled: z.boolean().optional(),
        type: z.literal('advbot').optional(),
        accountId: z.string().optional(),
        channelServerUrl: z.string().optional(),
        gatewayToken: z.string().optional().nullable(),
        gatewayUrl: z.string().optional().nullable()
      })
      .optional(),
    networkPolicy: z
      .object({
        enabled: z.boolean().optional(),
        dir: z.string().optional(),
        file: z.string().optional()
      })
      .optional(),
    env: z
      .object({
        enabled: z.boolean().optional(),
        targetFile: z.string().optional(),
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      })
      .optional(),
    dependencies: z
      .object({
        enabled: z.boolean().optional(),
        workingDir: z.string().optional(),
        commands: z.array(z.string()).optional(),
        continueOnError: z.boolean().optional()
      })
      .optional(),
    options: z
      .object({
        restartGateway: z.boolean().optional()
      })
      .optional()
  })
  .passthrough();

type DeployConfigInput = z.infer<typeof deployConfigSchema>;

export async function collectDeployContext(options: DeployCliOptions): Promise<DeployContext> {
  const configPath = options.config ? path.resolve(options.config) : undefined;
  const configBaseDir = configPath ? path.dirname(configPath) : process.cwd();
  const config = configPath ? await loadDeployConfig(configPath) : {};
  const hasConfig = Boolean(configPath);
  const interactive = !options.nonInteractive;

  const sandboxName = validateSandboxName(
    await readRequiredString({
      current: config.sandboxName,
      label: 'sandboxName',
      promptMessage: '请输入 sandbox 名称：',
      interactive,
      validate: validateSandboxName
    })
  );

  const agentName = validateAgentName(
    await readRequiredString({
      current: config.agentName,
      label: 'agentName',
      promptMessage: '请输入 agent 名称：',
      interactive,
      validate: validateAgentName
    })
  );

  const defaultWorkspace = `/sandbox/.openclaw/workspace-${agentName}`;
  const configuredWorkspace = normalizeOptionalString(config.workspace);
  const workspace =
    configuredWorkspace ??
    (hasConfig || !interactive
      ? defaultWorkspace
      : await input({
          message: `请输入 workspace，默认 ${defaultWorkspace}：`,
          default: defaultWorkspace
        }));

  const agentContentEnabled = await readOptionalBoolean({
    current: config.agentContent?.enabled,
    interactive,
    promptMessage: '是否上传 agent 初始化内容？',
    defaultValue: true
  });

  const agentContentHostDir = agentContentEnabled
    ? await readOptionalPath({
        current: config.agentContent?.hostDir,
        configBaseDir,
        interactive,
        label: 'agentContent.hostDir',
        promptMessage: '请输入 agent-content 主机目录：'
      })
    : undefined;

  const agentContentConflictStrategy = agentContentEnabled
    ? await readConflictStrategy({
        current: config.agentContent?.conflictStrategy,
        interactive,
        defaultValue: interactive ? 'ask' : 'fail'
      })
    : config.agentContent?.conflictStrategy ?? (interactive ? 'ask' : 'fail');

  const agentContentIgnore = agentContentEnabled
    ? await readAgentContentIgnore({
        current: config.agentContent?.ignore,
        configured: config.agentContent !== undefined,
        interactive
      })
    : [];

  const skillEnabled = await readOptionalBoolean({
    current: config.skill?.enabled,
    interactive,
    promptMessage: '是否安装 skills？',
    defaultValue: true
  });

  const skillHostDir = skillEnabled
    ? await readOptionalPath({
        current: config.skill?.hostDir,
        configBaseDir,
        interactive,
        label: 'skill.hostDir',
        promptMessage: '请输入 skills 主机目录：'
      })
    : undefined;

  const pluginsEnabled = await readOptionalBoolean({
    current: config.plugins?.enabled,
    interactive,
    promptMessage: '是否安装并启用 OpenClaw 插件？',
    defaultValue: false
  });

  const pluginItems = pluginsEnabled
    ? await readPluginItems({
        current: config.plugins?.items,
        configBaseDir,
        interactive
      })
    : [];

  const toolsEnabled = await readOptionalBoolean({
    current: config.tools?.enabled,
    interactive,
    promptMessage: '是否配置 OpenClaw tools（默认设置 tools.profile=coding）？',
    defaultValue: true
  });

  const toolsProfile = toolsEnabled
    ? validateToolsProfile(
        await readStringWithDefault({
          current: config.tools?.profile,
          interactive,
          promptMessage: '请输入 tools.profile，默认 coding：',
          defaultValue: 'coding'
        })
      )
    : 'coding';

  const channelEnabled = await readOptionalBoolean({
    current: config.channel?.enabled,
    interactive,
    promptMessage: '是否配置 advbot channel？',
    defaultValue: true
  });

  const channelServerUrl = channelEnabled
    ? validateChannelServerUrl(
        await readRequiredString({
          current: config.channel?.channelServerUrl,
          label: 'channel.channelServerUrl',
          promptMessage: '请输入 channelServerUrl：',
          interactive,
          validate: validateChannelServerUrl
        })
      )
    : '';

  const gatewayToken = normalizeOptionalString(config.channel?.gatewayToken ?? undefined);
  const gatewayUrl = normalizeOptionalString(config.channel?.gatewayUrl ?? undefined);

  const networkPolicyEnabled = await readOptionalBoolean({
    current: config.networkPolicy?.enabled,
    interactive,
    promptMessage: '是否应用 network policy？',
    defaultValue: true
  });

  const networkPolicyDir = networkPolicyEnabled
    ? await readOptionalPath({
        current: config.networkPolicy?.dir ?? config.networkPolicy?.file,
        configBaseDir,
        interactive,
        label: 'networkPolicy.dir',
        promptMessage: '请输入 network policy 目录路径：'
      })
    : undefined;

  const envEnabled = await readOptionalBoolean({
    current: config.env?.enabled,
    interactive,
    promptMessage: '是否配置 workspace env 文件？',
    defaultValue: false
  });

  const envTargetFile = envEnabled
    ? validateEnvTargetFile(
        await readStringWithDefault({
          current: config.env?.targetFile,
          interactive,
          promptMessage: '请输入 env 文件路径，默认 .env：',
          defaultValue: '.env'
        })
      )
    : '.env';

  const envVariables = envEnabled
    ? {
        ...parseEnvVariables(config.env?.variables),
        ...(await readInteractiveEnvVariables({
          configured: config.env?.variables !== undefined,
          interactive
        }))
      }
    : {};

  const dependenciesEnabled = await readOptionalBoolean({
    current: config.dependencies?.enabled,
    interactive,
    promptMessage: '是否安装 workspace 依赖？',
    defaultValue: false
  });

  const dependencyCommands = dependenciesEnabled
    ? await readDependencyCommands({
        current: config.dependencies?.commands,
        interactive
      })
    : [];

  const dependencyWorkingDir = validateDependencyWorkingDir(
    dependenciesEnabled ? config.dependencies?.workingDir : undefined,
    workspace.trim() || defaultWorkspace
  );

  return {
    sandboxName,
    agentName,
    workspace: workspace.trim() || defaultWorkspace,
    agentContent: {
      enabled: agentContentEnabled,
      hostDir: agentContentHostDir,
      conflictStrategy: agentContentConflictStrategy,
      ignore: agentContentIgnore
    },
    skill: {
      enabled: skillEnabled,
      hostDir: skillHostDir
    },
    plugins: {
      enabled: pluginsEnabled,
      items: pluginItems
    },
    tools: {
      enabled: toolsEnabled,
      profile: toolsProfile,
      config: config.tools?.config ?? {}
    },
    channel: {
      enabled: channelEnabled,
      type: config.channel?.type ?? 'advbot',
      accountId: config.channel?.accountId?.trim() || 'default',
      channelServerUrl,
      gatewayToken,
      gatewayUrl: gatewayUrl ? validateGatewayUrl(gatewayUrl) : undefined
    },
    networkPolicy: {
      enabled: networkPolicyEnabled,
      dir: networkPolicyDir
    },
    env: {
      enabled: envEnabled,
      targetFile: envTargetFile,
      variables: envVariables
    },
    dependencies: {
      enabled: dependenciesEnabled,
      workingDir: dependencyWorkingDir,
      commands: dependencyCommands,
      continueOnError: config.dependencies?.continueOnError ?? false
    },
    options: {
      restartGateway: config.options?.restartGateway ?? false,
      nonInteractive: Boolean(options.nonInteractive),
      dryRun: Boolean(options.dryRun)
    }
  };
}

async function loadDeployConfig(configPath: string): Promise<DeployConfigInput> {
  const raw = await readYamlFile(configPath);
  assertRemovedConfigFields(raw);
  const result = deployConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`deploy config 格式无效: ${result.error.message}`);
  }
  return result.data;
}

function assertRemovedConfigFields(raw: unknown): void {
  if (!isPlainRecord(raw)) return;

  if (isPlainRecord(raw.env) && Object.prototype.hasOwnProperty.call(raw.env, 'secrets')) {
    throw new Error('deploy config 字段 env.secrets 已移除，请删除该字段；secret 请通过运行环境或平台能力注入。');
  }

  if (isPlainRecord(raw.options) && Object.prototype.hasOwnProperty.call(raw.options, 'restart')) {
    throw new Error('deploy config 字段 options.restart 已移除，请改用 options.restartGateway。');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequiredString(inputOptions: {
  current?: string;
  label: string;
  promptMessage: string;
  interactive: boolean;
  validate: (value: string) => string;
}): Promise<string> {
  const current = normalizeOptionalString(inputOptions.current);
  if (current) return current;

  if (!inputOptions.interactive) {
    throw new Error(`${inputOptions.label} 是必填字段`);
  }

  return input({
    message: inputOptions.promptMessage,
    validate: (value) => {
      try {
        inputOptions.validate(value);
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : '输入无效';
      }
    }
  });
}

async function readOptionalBoolean(inputOptions: {
  current?: boolean;
  interactive: boolean;
  promptMessage: string;
  defaultValue: boolean;
}): Promise<boolean> {
  if (typeof inputOptions.current === 'boolean') return inputOptions.current;
  if (!inputOptions.interactive) return inputOptions.defaultValue;

  return confirm({
    message: inputOptions.promptMessage,
    default: inputOptions.defaultValue
  });
}

async function readOptionalPath(inputOptions: {
  current?: string;
  configBaseDir: string;
  interactive: boolean;
  label: string;
  promptMessage: string;
}): Promise<string> {
  const current = normalizeOptionalString(inputOptions.current);
  if (current) return resolveFromBase(inputOptions.configBaseDir, current);

  if (!inputOptions.interactive) {
    throw new Error(`${inputOptions.label} 是必填字段`);
  }

  const value = await input({
    message: inputOptions.promptMessage,
    validate: (candidate) => (candidate.trim() ? true : `${inputOptions.label} 是必填字段`)
  });

  return path.resolve(value);
}

async function readStringWithDefault(inputOptions: {
  current?: string;
  interactive: boolean;
  promptMessage: string;
  defaultValue: string;
}): Promise<string> {
  const current = normalizeOptionalString(inputOptions.current);
  if (current) return current;
  if (!inputOptions.interactive) return inputOptions.defaultValue;

  return input({
    message: inputOptions.promptMessage,
    default: inputOptions.defaultValue
  });
}

async function readConflictStrategy(inputOptions: {
  current?: ConflictStrategy;
  interactive: boolean;
  defaultValue: ConflictStrategy;
}): Promise<ConflictStrategy> {
  if (inputOptions.current) {
    if (!inputOptions.interactive && inputOptions.current === 'ask') return 'fail';
    return inputOptions.current;
  }
  if (!inputOptions.interactive) return inputOptions.defaultValue;

  return select<ConflictStrategy>({
    message: '如果 workspace 中已有同名文件，如何处理？',
    default: inputOptions.defaultValue,
    choices: [
      { name: 'ask', value: 'ask', description: '发现冲突时先在主程序里询问' },
      { name: 'skip', value: 'skip', description: '跳过已有文件' },
      { name: 'backup', value: 'backup', description: '备份已有文件后覆盖' },
      { name: 'overwrite', value: 'overwrite', description: '直接覆盖已有文件' },
      { name: 'fail', value: 'fail', description: '发现冲突即失败' }
    ]
  });
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseEnvVariables(
  variables?: Record<string, string | number | boolean>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(variables ?? {})) {
    const name = validateEnvName(rawName);
    out[name] = validateEnvValue(name, String(rawValue));
  }
  return out;
}

async function readInteractiveEnvVariables(inputOptions: {
  configured: boolean;
  interactive: boolean;
}): Promise<Record<string, string>> {
  if (inputOptions.configured || !inputOptions.interactive) return {};

  const raw = await input({
    message: '请输入普通 env 变量，格式 KEY=value，多个用逗号分隔，可留空：',
    default: ''
  });
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const out: Record<string, string> = {};
  for (const pair of trimmed.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) {
      throw new Error(`env 变量格式无效: ${pair.trim()}`);
    }
    const name = validateEnvName(pair.slice(0, index));
    out[name] = validateEnvValue(name, pair.slice(index + 1).trim());
  }
  return out;
}

async function readAgentContentIgnore(inputOptions: {
  current?: string[];
  configured: boolean;
  interactive: boolean;
}): Promise<string[]> {
  if (inputOptions.current !== undefined) {
    return inputOptions.current.map(validateIgnorePattern);
  }

  if (inputOptions.configured || !inputOptions.interactive) return [];

  const raw = await input({
    message: '请输入要忽略（不上传）的目录/文件模式，多个用逗号分隔，可留空，例如 .git,node_modules,*.log：',
    default: ''
  });
  const trimmed = raw.trim();
  if (!trimmed) return [];

  return trimmed.split(',').map(validateIgnorePattern);
}

interface RawPluginItem {
  id: string;
  channelId?: string;
  source?: string | null;
  force?: boolean;
  channel?: Record<string, unknown>;
}

async function readPluginItems(inputOptions: {
  current?: RawPluginItem[];
  configBaseDir: string;
  interactive: boolean;
}): Promise<PluginItemConfig[]> {
  if (inputOptions.current !== undefined) {
    return normalizePluginItems(inputOptions.current, inputOptions.configBaseDir);
  }

  if (!inputOptions.interactive) {
    throw new Error('plugins.items 是必填字段');
  }

  const raw = await input({
    message: '请输入插件列表，格式 id 或 id=source，多个用逗号分隔，例如 wecom=clawhub:@sunnoy/wecom：',
    validate: (value) => (value.trim() ? true : 'plugins.items 至少需要一个插件')
  });

  const rawItems = raw.split(',').map((pair) => {
    const trimmed = pair.trim();
    const index = trimmed.indexOf('=');
    if (index < 0) return { id: trimmed };
    return { id: trimmed.slice(0, index), source: trimmed.slice(index + 1) };
  });

  return normalizePluginItems(rawItems, inputOptions.configBaseDir);
}

function normalizePluginItems(rawItems: RawPluginItem[], configBaseDir: string): PluginItemConfig[] {
  if (rawItems.length === 0) {
    throw new Error('plugins.items 至少需要一个插件');
  }

  const seen = new Set<string>();
  return rawItems.map((raw) => {
    const item = parsePluginItem(raw, configBaseDir);
    if (seen.has(item.id)) {
      throw new Error(`plugins.items 中插件 id 重复: ${item.id}`);
    }
    seen.add(item.id);
    return item;
  });
}

function parsePluginItem(raw: RawPluginItem, configBaseDir: string): PluginItemConfig {
  const id = validatePluginId(raw.id);
  const channelId = raw.channelId ? validatePluginId(raw.channelId) : undefined;
  const force = Boolean(raw.force);
  const channel = raw.channel;
  const source = normalizeOptionalString(raw.source ?? undefined);
  if (!source) {
    return { id, channelId, sourceKind: 'none', force, channel };
  }

  const validated = validatePluginSource(source);
  if (isPluginHostPathSource(validated)) {
    const expanded = validated.startsWith('~/')
      ? path.join(os.homedir(), validated.slice(2))
      : validated;
    return {
      id,
      channelId,
      source: resolveFromBase(configBaseDir, expanded),
      sourceKind: 'path',
      force,
      channel
    };
  }

  return { id, channelId, source: validated, sourceKind: 'spec', force, channel };
}

async function readDependencyCommands(inputOptions: {
  current?: string[];
  interactive: boolean;
}): Promise<string[]> {
  if (inputOptions.current !== undefined) {
    const commands = inputOptions.current.map(validateDependencyCommand);
    if (commands.length === 0) {
      throw new Error('dependencies.commands 至少需要一个命令');
    }
    return commands;
  }

  if (!inputOptions.interactive) {
    throw new Error('dependencies.commands 是必填字段');
  }

  const raw = await input({
    message: '请输入依赖安装命令，例如 npm install：',
    validate: (value) => (value.trim() ? true : 'dependencies.commands 是必填字段')
  });

  return [validateDependencyCommand(raw)];
}
