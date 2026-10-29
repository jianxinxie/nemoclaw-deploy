import os from 'node:os';
import path from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import fs from 'fs-extra';
import { z } from 'zod';
import { resolveFromBase } from '../utils/fs.js';
import { readYamlFile } from '../utils/yaml.js';
import { assertNoLegacySkillConfig } from '../utils/config-migration.js';
import { resolveDashboardRemoteAccess } from './dashboard.js';
import {
  conflictStrategySchema,
  isPluginHostPathSource,
  validateAgentModel,
  validateAgentName,
  validateChannelServerUrl,
  validateDependencyCommand,
  validateDependencyWorkingDir,
  validateEnvDirectory,
  validateEnvName,
  validateEnvTargetFile,
  validateEnvValue,
  validateIgnorePattern,
  validatePluginId,
  validatePluginSource,
  validateSandboxCopyDestination,
  validateSandboxName,
  validateTrustedPrivateHost
} from '../utils/validators.js';

export type ConflictStrategy = 'ask' | 'skip' | 'backup' | 'overwrite' | 'fail';

export interface PluginItemConfig {
  id: string;
  channelId?: string;
  source?: string;
  sourceKind: 'path' | 'spec' | 'none';
  /** Pass --force to acknowledge the source review gate and reinstall existing plugins. */
  force: boolean;
  /** Acknowledge install provenance without forcing repeat deployments to reinstall. */
  trustSource: boolean;
  acceptCapabilities: boolean;
  acknowledgeInstallPolicyWarning: boolean;
}

export interface SandboxUploadConfig {
  source: string;
  destination: string;
  overwrite: boolean;
}

export interface DeployContext {
  sandboxName: string;
  agentName: string;
  workspace: string;
  model?: string;

  agentContent: {
    enabled: boolean;
    hostDir?: string;
    conflictStrategy: ConflictStrategy;
    ignore: string[];
  };

  sandbox: {
    uploads: {
      enabled: boolean;
      items: SandboxUploadConfig[];
    };
    commands: {
      enabled: boolean;
      workingDir: string;
      items: string[];
      continueOnError: boolean;
    };
  };

  channelRegistration: {
    enabled: boolean;
    agentLabel: string;
    continueOnError: boolean;
  };

  plugins: {
    enabled: boolean;
    items: PluginItemConfig[];
  };

  openclawConfig: {
    enabled: boolean;
    file?: string;
  };

  channelServer: {
    enabled: boolean;
    advbotAccountId: string;
    url: string;
    gatewayToken?: string;
    gatewayUrl?: string;
  };

  networkPolicy: {
    enabled: boolean;
    dir?: string;
    trustedPrivateHosts: string[];
  };

  env: {
    enabled: boolean;
    directory: string;
    targetFile: string;
    variables: Record<string, string>;
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

export interface DeployPlan {
  schemaVersion: 3;
  sandboxName: string;
  dashboardRemoteAccess: boolean;
  agents: DeployContext[];
}

const agentContentSchema = z.object({
  enabled: z.boolean().optional(),
  hostDir: z.string().optional(),
  conflictStrategy: conflictStrategySchema.optional(),
  ignore: z.array(z.string()).optional()
}).strict().optional();

const sandboxUploadsSchema = z.object({
  enabled: z.boolean().optional(),
  items: z.array(z.object({
    source: z.string(),
    destination: z.string(),
    overwrite: z.boolean().optional()
  }).strict()).optional()
}).strict().optional();

const sandboxCommandsSchema = z.object({
  enabled: z.boolean().optional(),
  workingDir: z.string().optional(),
  items: z.array(z.string()).optional(),
  continueOnError: z.boolean().optional()
}).strict().optional();

const channelRegistrationSchema = z.object({
  enabled: z.boolean().optional(),
  agentLabel: z.string().optional(),
  continueOnError: z.boolean().optional()
}).strict().optional();

const envSchema = z.object({
  enabled: z.boolean().optional(),
  directory: z.string().optional(),
  targetFile: z.string().optional(),
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
}).strict().optional();

const pluginsSchema = z.object({
  enabled: z.boolean().optional(),
  items: z.array(z.object({
    id: z.string(),
    channelId: z.string().optional(),
    source: z.string().optional().nullable(),
    force: z.boolean().optional(),
    trustSource: z.boolean().optional(),
    acceptCapabilities: z.boolean().optional(),
    acknowledgeInstallPolicyWarning: z.boolean().optional()
  }).strict()).optional()
}).strict().optional();

const openclawConfigSchema = z.object({
  enabled: z.boolean().optional(),
  file: z.string().optional()
}).strict().optional();

const channelServerSchema = z.object({
  enabled: z.boolean().optional(),
  advbotAccountId: z.string().optional(),
  url: z.string().optional()
}).strict().optional();

const networkPolicySchema = z.object({
  enabled: z.boolean().optional(),
  dir: z.string().optional(),
  trustedPrivateHosts: z.array(z.string()).optional()
}).strict().optional();

const deployOptionsSchema = z.object({
  restartGateway: z.boolean().optional()
}).strict().optional();

const sharedDeploySchema = z.object({
  plugins: pluginsSchema,
  openclawConfig: openclawConfigSchema,
  channelServer: channelServerSchema,
  networkPolicy: networkPolicySchema,
  options: deployOptionsSchema
}).strict().optional();

const agentDeploySchema = z.object({
  name: z.string(),
  workspace: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  agentContent: agentContentSchema,
  sandbox: z.object({
    uploads: sandboxUploadsSchema,
    commands: sandboxCommandsSchema
  }).strict().optional(),
  channelRegistration: channelRegistrationSchema,
  env: envSchema
}).strict();

const unifiedDeployConfigSchema = z.object({
  schemaVersion: z.literal(3),
  install: z.unknown().optional(),
  onboard: z.object({
    sandbox: z.object({ name: z.string() }).passthrough(),
    services: z.object({ dashboardRemoteAccess: z.boolean().optional() }).passthrough().optional(),
    environment: z.record(z.string(), z.unknown()).optional()
  }).passthrough(),
  deploy: z.object({
    shared: sharedDeploySchema,
    agents: z.array(agentDeploySchema).min(1)
  }).strict()
}).strict();

const normalizedAgentConfigSchema = z.object({
  sandboxName: z.string().optional(),
  agentName: z.string().optional(),
  workspace: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  agentContent: agentContentSchema,
  sandbox: z.object({
    uploads: sandboxUploadsSchema,
    commands: sandboxCommandsSchema
  }).strict().optional(),
  channelRegistration: channelRegistrationSchema,
  plugins: pluginsSchema,
  openclawConfig: openclawConfigSchema,
  channelServer: channelServerSchema,
  networkPolicy: networkPolicySchema,
  env: envSchema,
  options: deployOptionsSchema
});

type DeployConfigInput = z.infer<typeof normalizedAgentConfigSchema>;

interface NormalizedDeployConfig {
  schemaVersion: 3;
  dashboardRemoteAccess: boolean;
  configs: DeployConfigInput[];
}

export async function collectDeployContext(options: DeployCliOptions): Promise<DeployContext> {
  const plan = await collectDeployPlan(options);
  if (plan.agents.length !== 1) {
    throw new Error('当前配置包含多个 agent，请使用 collectDeployPlan 处理');
  }
  return plan.agents[0];
}

export async function collectDeployPlan(options: DeployCliOptions): Promise<DeployPlan> {
  const configPath = path.resolve(options.config ?? 'onboard.yaml');
  if (!(await fs.pathExists(configPath))) {
    throw new Error(`统一配置文件不存在: ${configPath}`);
  }
  const configBaseDir = path.dirname(configPath);
  const normalized = await loadDeployConfigs(configPath);

  const agents: DeployContext[] = [];
  for (const config of normalized.configs) {
    agents.push(await collectOneDeployContext(options, config, configBaseDir));
  }

  const sandboxNames = new Set(agents.map((agent) => agent.sandboxName));
  if (sandboxNames.size !== 1) {
    throw new Error('deploy.agents 中所有 agent 必须属于同一个 sandbox');
  }

  const agentNames = new Set<string>();
  const workspaces = new Set<string>();
  for (const agent of agents) {
    if (agentNames.has(agent.agentName)) {
      throw new Error(`deploy.agents 中 agent 名称重复: ${agent.agentName}`);
    }
    if (workspaces.has(agent.workspace)) {
      throw new Error(`deploy.agents 中 workspace 重复: ${agent.workspace}`);
    }
    agentNames.add(agent.agentName);
    workspaces.add(agent.workspace);
  }

  return {
    schemaVersion: normalized.schemaVersion,
    sandboxName: agents[0].sandboxName,
    dashboardRemoteAccess: normalized.dashboardRemoteAccess,
    agents
  };
}

async function collectOneDeployContext(
  options: DeployCliOptions,
  config: DeployConfigInput,
  configBaseDir: string
): Promise<DeployContext> {
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

  const defaultWorkspace = `/sandbox/.openclaw/workspace/${agentName}`;
  const configuredWorkspace = normalizeOptionalString(config.workspace);
  const workspace =
    configuredWorkspace ??
    defaultWorkspace;

  const configuredModel = normalizeOptionalString(config.model ?? undefined);
  const model = configuredModel ? validateAgentModel(configuredModel) : undefined;

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

  const fileCopiesEnabled = await readOptionalBoolean({
    current: config.sandbox?.uploads?.enabled,
    interactive,
    promptMessage: '是否上传主机文件或目录到 sandbox？',
    defaultValue: false
  });

  const fileCopyItems = fileCopiesEnabled
    ? await readFileCopyItems({
        current: config.sandbox?.uploads?.items,
        configBaseDir,
        interactive
      })
    : [];

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

  const openclawConfigEnabled = await readOptionalBoolean({
    current: config.openclawConfig?.enabled,
    interactive,
    promptMessage: '是否合并 openclaw partial 配置？',
    defaultValue: false
  });

  const openclawConfigFile = openclawConfigEnabled
    ? await readOptionalPath({
        current: config.openclawConfig?.file,
        configBaseDir,
        interactive,
        label: 'openclawConfig.file',
        promptMessage: '请输入 openclaw partial JSON 文件路径：'
      })
    : undefined;

  const channelServerEnabled = await readOptionalBoolean({
    current: config.channelServer?.enabled,
    interactive,
    promptMessage: '是否启用 ChannelServer 集成？',
    defaultValue: true
  });

  const channelServerUrl = channelServerEnabled
    ? validateChannelServerUrl(
        await readRequiredString({
          current: config.channelServer?.url,
          label: 'channelServer.url',
          promptMessage: '请输入 ChannelServer URL：',
          interactive,
          validate: validateChannelServerUrl
        })
      )
    : '';

  const channelRegistrationEnabled = await readOptionalBoolean({
    current: config.channelRegistration?.enabled,
    interactive,
    promptMessage: `是否向 channel server 注册 agent ${agentName}？`,
    defaultValue: false
  });
  if (channelRegistrationEnabled && !channelServerEnabled) {
    throw new Error(
      `agent ${agentName} 设置了 channelRegistration.enabled=true，但 deploy.shared.channelServer.enabled=false`
    );
  }
  const channelRegistrationContinueOnError =
    config.channelRegistration?.continueOnError ?? true;
  const channelRegistrationAgentLabel =
    normalizeOptionalString(config.channelRegistration?.agentLabel) ?? sandboxName;

  const networkPolicyEnabled = await readOptionalBoolean({
    current: config.networkPolicy?.enabled,
    interactive,
    promptMessage: '是否应用 network policy？',
    defaultValue: true
  });

  const networkPolicyDir = networkPolicyEnabled
    ? await readOptionalPath({
        current: config.networkPolicy?.dir,
        configBaseDir,
        interactive,
        label: 'networkPolicy.dir',
        promptMessage: '请输入 network policy 目录路径：'
      })
    : undefined;

  const envEnabled = await readOptionalBoolean({
    current: config.env?.enabled,
    interactive,
    promptMessage: '是否配置 agent env 文件？',
    defaultValue: false
  });

  const envDirectory = validateEnvDirectory(
    envEnabled ? config.env?.directory : undefined,
    workspace.trim() || defaultWorkspace
  );

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
    current: config.sandbox?.commands?.enabled,
    interactive,
    promptMessage: '是否在 sandbox 中执行 agent 命令？',
    defaultValue: false
  });

  const dependencyCommands = dependenciesEnabled
    ? await readDependencyCommands({
        current: config.sandbox?.commands?.items,
        interactive
      })
    : [];

  const dependencyWorkingDir = validateDependencyWorkingDir(
    dependenciesEnabled ? config.sandbox?.commands?.workingDir : undefined,
    workspace.trim() || defaultWorkspace
  );

  return {
    sandboxName,
    agentName,
    workspace: workspace.trim() || defaultWorkspace,
    model,
    agentContent: {
      enabled: agentContentEnabled,
      hostDir: agentContentHostDir,
      conflictStrategy: agentContentConflictStrategy,
      ignore: agentContentIgnore
    },
    sandbox: {
      uploads: {
        enabled: fileCopiesEnabled,
        items: fileCopyItems
      },
      commands: {
        enabled: dependenciesEnabled,
        workingDir: dependencyWorkingDir,
        items: dependencyCommands,
        continueOnError: config.sandbox?.commands?.continueOnError ?? false
      }
    },
    channelRegistration: {
      enabled: channelRegistrationEnabled,
      agentLabel: channelRegistrationAgentLabel,
      continueOnError: channelRegistrationContinueOnError
    },
    plugins: {
      enabled: pluginsEnabled,
      items: pluginItems
    },
    openclawConfig: {
      enabled: openclawConfigEnabled,
      file: openclawConfigFile
    },
    channelServer: {
      enabled: channelServerEnabled,
      advbotAccountId: config.channelServer?.advbotAccountId?.trim() || 'default',
      url: channelServerUrl
    },
    networkPolicy: {
      enabled: networkPolicyEnabled,
      dir: networkPolicyDir,
      trustedPrivateHosts: [...new Set((config.networkPolicy?.trustedPrivateHosts ?? []).map(validateTrustedPrivateHost))]
    },
    env: {
      enabled: envEnabled,
      directory: envDirectory,
      targetFile: envTargetFile,
      variables: envVariables
    },
    options: {
      restartGateway: config.options?.restartGateway ?? true,
      nonInteractive: Boolean(options.nonInteractive),
      dryRun: Boolean(options.dryRun)
    }
  };
}

export async function loadDeployConfigs(configPath: string): Promise<NormalizedDeployConfig> {
  const raw = await readYamlFile(configPath);
  assertNoLegacySkillConfig(raw);
  const result = unifiedDeployConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`统一 onboard.yaml 的 deploy 配置格式无效: ${result.error.message}`);
  }

  const shared = result.data.deploy.shared ?? {};
  return {
    schemaVersion: 3,
    dashboardRemoteAccess: resolveDashboardRemoteAccess(result.data.onboard),
    configs: result.data.deploy.agents.map((agent) => ({
      sandboxName: result.data.onboard.sandbox.name,
      agentName: agent.name,
      workspace: agent.workspace,
      model: agent.model,
      agentContent: agent.agentContent,
      sandbox: agent.sandbox,
      channelRegistration: agent.channelRegistration,
      plugins: shared.plugins,
      openclawConfig: shared.openclawConfig,
      channelServer: shared.channelServer,
      networkPolicy: shared.networkPolicy,
      env: agent.env,
      options: shared.options
    }))
  };
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

async function readFileCopyItems(inputOptions: {
  current?: Array<{ source: string; destination: string; overwrite?: boolean }>;
  configBaseDir: string;
  interactive: boolean;
}): Promise<SandboxUploadConfig[]> {
  if (inputOptions.current !== undefined) {
    if (inputOptions.current.length === 0) {
      throw new Error('sandbox.uploads.enabled=true 时，sandbox.uploads.items 至少需要一项');
    }
    return inputOptions.current.map((item) => normalizeFileCopyItem(item, inputOptions.configBaseDir));
  }

  if (!inputOptions.interactive) {
    throw new Error('sandbox.uploads.enabled=true 时，sandbox.uploads.items 是必填字段');
  }

  const items: SandboxUploadConfig[] = [];
  let addAnother = true;
  while (addAnother) {
    const source = await input({
      message: '请输入要复制的主机文件或目录路径：',
      validate: (value) => (value.trim() ? true : '主机文件或目录路径不能为空')
    });
    const destination = await input({
      message: '请输入 sandbox 中的目标绝对路径：',
      validate: (value) => {
        try {
          validateSandboxCopyDestination(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : '目标路径无效';
        }
      }
    });
    const overwrite = await confirm({
      message: '目标文件已存在时是否覆盖？',
      default: true
    });
    items.push(
      normalizeFileCopyItem({ source, destination, overwrite }, inputOptions.configBaseDir)
    );
    addAnother = await confirm({ message: '是否继续添加 sandbox 上传项？', default: false });
  }

  return items;
}

function normalizeFileCopyItem(
  raw: { source: string; destination: string; overwrite?: boolean },
  configBaseDir: string
): SandboxUploadConfig {
  const source = raw.source.trim();
  if (!source) {
    throw new Error('sandbox.uploads.items[].source 是必填字段');
  }
  if (source.includes('\0') || /[\r\n]/.test(source)) {
    throw new Error('sandbox.uploads.items[].source 不能包含空字符或换行');
  }

  const expanded = source.startsWith('~/') ? path.join(os.homedir(), source.slice(2)) : source;
  return {
    source: resolveFromBase(configBaseDir, expanded),
    destination: validateSandboxCopyDestination(raw.destination),
    overwrite: raw.overwrite ?? true
  };
}

interface RawPluginItem {
  id: string;
  channelId?: string;
  source?: string | null;
  force?: boolean;
  trustSource?: boolean;
  acceptCapabilities?: boolean;
  acknowledgeInstallPolicyWarning?: boolean;
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
  const consent = {
    trustSource: raw.trustSource ?? false,
    acceptCapabilities: raw.acceptCapabilities ?? false,
    acknowledgeInstallPolicyWarning: raw.acknowledgeInstallPolicyWarning ?? false
  };
  const source = normalizeOptionalString(raw.source ?? undefined);
  if (!source) {
    return { id, channelId, sourceKind: 'none', force, ...consent };
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
      ...consent
    };
  }

  return { id, channelId, source: validated, sourceKind: 'spec', force, ...consent };
}

async function readDependencyCommands(inputOptions: {
  current?: string[];
  interactive: boolean;
}): Promise<string[]> {
  if (inputOptions.current !== undefined) {
    const commands = inputOptions.current.map(validateDependencyCommand);
    if (commands.length === 0) {
      throw new Error('sandbox.commands.items 至少需要一个命令');
    }
    return commands;
  }

  if (!inputOptions.interactive) {
    throw new Error('sandbox.commands.items 是必填字段');
  }

  const raw = await input({
    message: '请输入要在 sandbox 中执行的命令，例如 npm install：',
    validate: (value) => (value.trim() ? true : 'sandbox.commands.items 是必填字段')
  });

  return [validateDependencyCommand(raw)];
}
