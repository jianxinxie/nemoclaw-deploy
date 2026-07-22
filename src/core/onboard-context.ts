import path from 'node:path';
import { input } from '@inquirer/prompts';
import fs from 'fs-extra';
import { z } from 'zod';
import { readYamlFile } from '../utils/yaml.js';
import { resolveFromBase } from '../utils/fs.js';
import { validateOnboardSandboxName } from '../utils/validators.js';

export type OnboardMode = 'ensure' | 'resume' | 'fresh' | 'recreate';
export type TriState = 'auto' | 'enabled' | 'disabled';

export interface BootstrapCliOptions {
  config?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export interface OnboardContext {
  install: {
    enabled: boolean;
    mode: 'if-missing' | 'reinstall';
    version: string;
  };
  onboard: {
    mode: OnboardMode;
    sandbox: {
      name: string;
      runtime: string;
      dockerfileDir?: string;
      dockerfilePath?: string;
    };
    inference: {
      provider?: string;
      model?: string;
      endpointUrl?: string;
      preferredApi?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
      apiKey: {
        promptInInteractive: boolean;
        prompted: boolean;
        value?: string;
        fromEnv?: string;
        targetEnv?: string;
      };
    };
    gpu: {
      host: TriState;
      sandbox: TriState;
      device?: string;
    };
    policy: {
      tier: 'restricted' | 'balanced' | 'open';
      mode: 'suggested' | 'custom' | 'skip';
      presets: string[];
    };
    openclaw: {
      toolDisclosure: 'progressive' | 'direct';
      webSearchProvider: 'brave' | 'tavily' | 'none';
      agentTimeout?: number;
    };
    services: {
      openShellGatewayPort?: number;
      dashboardPort?: number;
      controlUiPort?: number;
      vllmPort?: number;
      ollamaPort?: number;
    };
    timeouts: {
      ollamaPull?: number;
      localInference?: number;
      sandboxReady?: number;
    };
    options: {
      acceptThirdPartySoftware: boolean;
      yes: boolean;
      noOllamaAutostart: boolean;
    };
    environment: Record<string, string>;
  };
  options: {
    nonInteractive: boolean;
    dryRun: boolean;
  };
}

const optionalPort = z.number().int().min(1024).max(65535).optional().nullable();
const optionalTimeout = z.number().positive().optional().nullable();
const optionalPreferredApi = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']).optional().nullable()
);

const onboardConfigSchema = z.object({
  schemaVersion: z.literal(3),
  install: z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(['if-missing', 'reinstall']).optional(),
      version: z.string().optional().nullable()
    })
    .optional(),
  onboard: z
    .object({
      mode: z.enum(['ensure', 'resume', 'fresh', 'recreate']).optional(),
      sandbox: z
        .object({
          name: z.string().optional(),
          runtime: z.string().optional(),
          dockerfileDir: z.string().optional().nullable()
        })
        .optional(),
      inference: z
        .object({
          provider: z.string().optional().nullable(),
          model: z.string().optional().nullable(),
          endpointUrl: z.string().optional().nullable(),
          preferredApi: optionalPreferredApi,
          apiKey: z
            .object({
              promptInInteractive: z.boolean().optional(),
              value: z.string().optional().nullable(),
              fromEnv: z.string().optional().nullable(),
              targetEnv: z.string().optional().nullable()
            })
            .optional()
        })
        .optional(),
      gpu: z
        .object({
          host: z.enum(['auto', 'enabled', 'disabled']).optional(),
          sandbox: z.enum(['auto', 'enabled', 'disabled']).optional(),
          device: z.string().optional().nullable()
        })
        .optional(),
      policy: z
        .object({
          tier: z.enum(['restricted', 'balanced', 'open']).optional(),
          mode: z.enum(['suggested', 'custom', 'skip']).optional(),
          presets: z.array(z.string()).optional()
        })
        .optional(),
      openclaw: z
        .object({
          toolDisclosure: z.enum(['progressive', 'direct']).optional(),
          webSearchProvider: z.enum(['brave', 'tavily', 'none']).optional(),
          agentTimeout: optionalTimeout
        })
        .optional(),
      services: z
        .object({
          openShellGatewayPort: optionalPort,
          gatewayPort: optionalPort,
          dashboardPort: optionalPort,
          controlUiPort: optionalPort,
          vllmPort: optionalPort,
          ollamaPort: optionalPort
        })
        .optional(),
      timeouts: z
        .object({
          ollamaPull: optionalTimeout,
          localInference: optionalTimeout,
          sandboxReady: optionalTimeout
        })
        .optional(),
      options: z
        .object({
          acceptThirdPartySoftware: z.boolean().optional(),
          yes: z.boolean().optional(),
          noOllamaAutostart: z.boolean().optional()
        })
        .optional(),
      environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
    })
    .optional(),
  deploy: z.object({}).passthrough()
});

export async function collectOnboardContext(options: BootstrapCliOptions): Promise<OnboardContext> {
  const configPath = options.config ? path.resolve(options.config) : undefined;
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  const raw = configPath ? await readYamlFile(configPath) : {};
  const parsed = onboardConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`onboard config 格式无效: ${parsed.error.message}`);

  const config = parsed.data;
  const interactive = !options.nonInteractive;
  let sandboxName = normalize(config.onboard?.sandbox?.name);
  if (!sandboxName) {
    if (!interactive) throw new Error('onboard.sandbox.name 是必填字段');
    sandboxName = await input({
      message: '请输入要创建或确认的 sandbox 名称：',
      default: 'my-assistant',
      validate: (value) => {
        try {
          validateOnboardSandboxName(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : 'sandbox 名称无效';
        }
      }
    });
  }
  sandboxName = validateOnboardSandboxName(sandboxName);

  const customDockerfile = await resolveCustomDockerfile(
    baseDir,
    normalize(config.onboard?.sandbox?.dockerfileDir)
  );
  const environment = normalizeEnvironment(config.onboard?.environment);
  const runtime = validateRuntime(normalize(config.onboard?.sandbox?.runtime) ?? 'openclaw');
  const policyMode = config.onboard?.policy?.mode ?? 'suggested';
  const policyPresets = (config.onboard?.policy?.presets ?? [])
    .map(validatePolicyPreset)
    .filter(Boolean);
  if (policyMode === 'custom' && policyPresets.length === 0) {
    throw new Error('onboard.policy.mode=custom 时 presets 至少需要一个值');
  }

  const sandboxGpu = config.onboard?.gpu?.sandbox ?? 'auto';
  const gpuDevice = validateOptionalSimpleValue('onboard.gpu.device', normalize(config.onboard?.gpu?.device));
  if (gpuDevice && sandboxGpu !== 'enabled') {
    throw new Error('onboard.gpu.device 需要同时设置 onboard.gpu.sandbox: enabled');
  }
  const openShellGatewayPort = validateOpenShellGatewayPort(
    nullable(config.onboard?.services?.openShellGatewayPort ?? config.onboard?.services?.gatewayPort)
  );
  const servicePorts = {
    openShellGatewayPort,
    dashboardPort: nullable(config.onboard?.services?.dashboardPort),
    controlUiPort: nullable(config.onboard?.services?.controlUiPort),
    vllmPort: nullable(config.onboard?.services?.vllmPort),
    ollamaPort: nullable(config.onboard?.services?.ollamaPort)
  };
  validateDistinctServicePorts(servicePorts);

  return {
    install: {
      enabled: config.install?.enabled ?? true,
      mode: config.install?.mode ?? 'if-missing',
      version: validateInstallVersion(normalize(config.install?.version) ?? 'v0.0.75')
    },
    onboard: {
      mode: config.onboard?.mode ?? 'ensure',
      sandbox: {
        name: sandboxName,
        runtime,
        dockerfileDir: customDockerfile?.directory,
        dockerfilePath: customDockerfile?.file
      },
      inference: {
        provider: normalize(config.onboard?.inference?.provider),
        model: normalize(config.onboard?.inference?.model),
        endpointUrl: validateOptionalHttpUrl(
          'onboard.inference.endpointUrl',
          normalize(config.onboard?.inference?.endpointUrl)
        ),
        preferredApi: config.onboard?.inference?.preferredApi ?? undefined,
        apiKey: {
          promptInInteractive: config.onboard?.inference?.apiKey?.promptInInteractive ?? false,
          prompted: false,
          value: validateOptionalSecretValue(
            'onboard.inference.apiKey.value',
            normalize(config.onboard?.inference?.apiKey?.value)
          ),
          fromEnv: validateOptionalEnvName(
            'onboard.inference.apiKey.fromEnv',
            normalize(config.onboard?.inference?.apiKey?.fromEnv)
          ),
          targetEnv: validateOptionalEnvName(
            'onboard.inference.apiKey.targetEnv',
            normalize(config.onboard?.inference?.apiKey?.targetEnv)
          )
        }
      },
      gpu: {
        host: config.onboard?.gpu?.host ?? 'auto',
        sandbox: sandboxGpu,
        device: gpuDevice
      },
      policy: {
        tier: config.onboard?.policy?.tier ?? 'balanced',
        mode: policyMode,
        presets: policyPresets
      },
      openclaw: {
        toolDisclosure: config.onboard?.openclaw?.toolDisclosure ?? 'progressive',
        webSearchProvider: config.onboard?.openclaw?.webSearchProvider ?? 'none',
        agentTimeout: nullable(config.onboard?.openclaw?.agentTimeout)
      },
      services: servicePorts,
      timeouts: {
        ollamaPull: nullable(config.onboard?.timeouts?.ollamaPull),
        localInference: nullable(config.onboard?.timeouts?.localInference),
        sandboxReady: nullable(config.onboard?.timeouts?.sandboxReady)
      },
      options: {
        acceptThirdPartySoftware: config.onboard?.options?.acceptThirdPartySoftware ?? false,
        yes: config.onboard?.options?.yes ?? false,
        noOllamaAutostart: config.onboard?.options?.noOllamaAutostart ?? false
      },
      environment
    },
    options: {
      nonInteractive: Boolean(options.nonInteractive),
      dryRun: Boolean(options.dryRun)
    }
  };
}

function normalize(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function nullable(value?: number | null): number | undefined {
  return value ?? undefined;
}

async function resolveCustomDockerfile(
  baseDir: string,
  configuredDir?: string
): Promise<{ directory: string; file: string } | undefined> {
  if (!configuredDir) return undefined;
  if (/[\0\r\n]/.test(configuredDir)) {
    throw new Error('onboard.sandbox.dockerfileDir 不能包含空字符或换行');
  }

  const directory = resolveFromBase(baseDir, configuredDir);
  if (!(await fs.pathExists(directory))) {
    throw new Error(`onboard.sandbox.dockerfileDir 不存在: ${directory}`);
  }
  const directoryStat = await fs.stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error(`onboard.sandbox.dockerfileDir 必须是目录: ${directory}`);
  }

  const file = path.join(directory, 'Dockerfile');
  if (!(await fs.pathExists(file))) {
    throw new Error(`指定目录中找不到 Dockerfile: ${file}`);
  }
  const fileStat = await fs.stat(file);
  if (!fileStat.isFile()) {
    throw new Error(`Dockerfile 必须是普通文件: ${file}`);
  }

  return { directory, file };
}

function normalizeEnvironment(
  input?: Record<string, string | number | boolean>
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!/^NEMOCLAW_[A-Z0-9_]+$/.test(name)) {
      throw new Error(`onboard.environment 只允许 NEMOCLAW_* 变量: ${name}`);
    }
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name)) {
      throw new Error(`onboard.environment 不允许保存 secret 变量: ${name}`);
    }
    const text = String(value);
    if (/[\0\r\n]/.test(text)) {
      throw new Error(`onboard.environment 变量不能包含空字符或换行: ${name}`);
    }
    output[name] = text;
  }
  return output;
}

function validateRuntime(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('onboard.sandbox.runtime 只能包含小写字母、数字、点、下划线和短横线');
  }
  return value;
}

function validateInstallVersion(value: string): string {
  const version = value.trim();
  if (!version) throw new Error('install.version 不能为空');
  if (version.startsWith('-') || /[\0\r\n\s]/.test(version)) {
    throw new Error('install.version 不能以 - 开头，且不能包含空白或控制字符');
  }
  return version;
}

function validatePolicyPreset(value: string): string {
  const preset = value.trim();
  if (!preset) return '';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(preset)) {
    throw new Error(`onboard.policy.presets 中包含无效名称: ${preset}`);
  }
  return preset;
}

function validateOptionalSimpleValue(label: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} 不能以 - 开头或包含控制字符`);
  }
  return value;
}

function validateOptionalEnvName(label: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error(`${label} 必须是合法环境变量名，例如 COMPATIBLE_API_KEY`);
  }
  return value;
}

function validateOptionalSecretValue(label: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} 不能包含空字符或换行`);
  }
  return value;
}

function validateOptionalHttpUrl(label: string, value?: string): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 必须是合法 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} 必须以 http:// 或 https:// 开头`);
  }
  if (url.hash) {
    throw new Error(`${label} 不能包含 hash fragment`);
  }
  return value;
}

function validateOpenShellGatewayPort(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (value >= 18789 && value <= 18799) {
    throw new Error('onboard.services.openShellGatewayPort 不能使用 dashboard 自动分配范围 18789-18799');
  }
  if ([8000, 11434, 11435].includes(value)) {
    throw new Error('onboard.services.openShellGatewayPort 不能使用 NemoClaw 默认推理/代理端口 8000、11434、11435');
  }
  return value;
}

function validateDistinctServicePorts(ports: OnboardContext['onboard']['services']): void {
  const seen = new Map<number, string>();
  for (const [name, value] of Object.entries(ports)) {
    if (value === undefined) continue;
    const existing = seen.get(value);
    if (existing) {
      throw new Error(`onboard.services.${name} 不能和 onboard.services.${existing} 使用同一个端口 ${value}`);
    }
    seen.set(value, name);
  }
}
