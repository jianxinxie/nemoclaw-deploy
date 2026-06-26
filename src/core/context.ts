import path from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import { z } from 'zod';
import { resolveFromBase } from '../utils/fs.js';
import { readYamlFile } from '../utils/yaml.js';
import {
  conflictStrategySchema,
  validateAgentName,
  validateChannelServerUrl,
  validateGatewayUrl,
  validateSandboxName
} from '../utils/validators.js';

export type ConflictStrategy = 'ask' | 'skip' | 'backup' | 'overwrite' | 'fail';

export interface DeployContext {
  sandboxName: string;
  agentName: string;
  workspace: string;

  agentContent: {
    enabled: boolean;
    hostDir?: string;
    conflictStrategy: ConflictStrategy;
  };

  skill: {
    enabled: boolean;
    hostDir?: string;
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

  options: {
    restart: boolean;
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
        conflictStrategy: conflictStrategySchema.optional()
      })
      .optional(),
    skill: z
      .object({
        enabled: z.boolean().optional(),
        hostDir: z.string().optional()
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
    options: z
      .object({
        restart: z.boolean().optional()
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

  return {
    sandboxName,
    agentName,
    workspace: workspace.trim() || defaultWorkspace,
    agentContent: {
      enabled: agentContentEnabled,
      hostDir: agentContentHostDir,
      conflictStrategy: agentContentConflictStrategy
    },
    skill: {
      enabled: skillEnabled,
      hostDir: skillHostDir
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
    options: {
      restart: config.options?.restart ?? true,
      nonInteractive: Boolean(options.nonInteractive),
      dryRun: Boolean(options.dryRun)
    }
  };
}

async function loadDeployConfig(configPath: string): Promise<DeployConfigInput> {
  const raw = await readYamlFile(configPath);
  const result = deployConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`deploy config 格式无效: ${result.error.message}`);
  }
  return result.data;
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
