import os from 'node:os';
import path from 'node:path';
import { password } from '@inquirer/prompts';
import fs from 'fs-extra';
import type { DeployContext, EnvSecretConfig } from './context.js';
import { remoteTempBase } from './upload-agent-content.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { validateEnvValue } from '../utils/validators.js';

export interface ConfigureEnvResult {
  status: 'skipped' | 'configured';
  targetFile?: string;
  count: number;
}

export async function configureEnv(ctx: DeployContext): Promise<ConfigureEnvResult> {
  if (!ctx.env.enabled) return { status: 'skipped', count: 0 };

  const variables = await resolveEnvVariables(ctx);
  const entries = Object.keys(variables).sort();
  if (entries.length === 0) {
    throw new Error('env 已启用，但没有配置 variables 或 secrets');
  }

  const remoteBase = remoteTempBase(ctx);
  const remoteDataFile = `${remoteBase}/env-data.json`;
  const remoteScriptFile = `${remoteBase}/merge-env.mjs`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-env-'));
  const dataPath = path.join(tempDir, 'env-data.json');
  const scriptPath = path.join(tempDir, 'merge-env.mjs');

  try {
    await fs.writeJson(dataPath, { variables });
    await fs.chmod(dataPath, 0o600).catch(() => undefined);
    await fs.writeFile(scriptPath, MERGE_ENV_SCRIPT, 'utf8');

    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteBase], {
      dryRun: ctx.options.dryRun,
      description: '创建 sandbox 临时目录，用于暂存 env 合并脚本和数据'
    });

    await runCommand('nemoclaw', [ctx.sandboxName, 'upload', dataPath, remoteDataFile], {
      dryRun: ctx.options.dryRun,
      sensitive: true,
      description: '上传 env 数据到 sandbox 临时目录，日志不打印变量值'
    });

    await runCommand('nemoclaw', [ctx.sandboxName, 'upload', scriptPath, remoteScriptFile], {
      dryRun: ctx.options.dryRun,
      description: '上传 env 合并脚本到 sandbox'
    });

    await runCommand(
      'nemoclaw',
      [
        ctx.sandboxName,
        'exec',
        '--',
        'env',
        `WORKSPACE=${ctx.workspace}`,
        `TARGET_FILE=${ctx.env.targetFile}`,
        `ENV_DATA_FILE=${remoteDataFile}`,
        'node',
        remoteScriptFile
      ],
      {
        dryRun: ctx.options.dryRun,
        sensitive: true,
        description: `合并 env 变量到 workspace/${ctx.env.targetFile}`
      }
    );

    logger.info(`已写入 ${entries.length} 个 env key: ${entries.join(', ')}`);
    return { status: 'configured', targetFile: ctx.env.targetFile, count: entries.length };
  } finally {
    await fs.remove(tempDir);
  }
}

async function resolveEnvVariables(ctx: DeployContext): Promise<Record<string, string>> {
  const variables: Record<string, string> = { ...ctx.env.variables };

  for (const secret of ctx.env.secrets) {
    const value = await resolveSecretValue(secret, ctx.options.nonInteractive);
    variables[secret.name] = validateEnvValue(secret.name, value);
  }

  return variables;
}

async function resolveSecretValue(secret: EnvSecretConfig, nonInteractive: boolean): Promise<string> {
  if (secret.fromEnv) {
    const value = process.env[secret.fromEnv];
    if (value !== undefined && value !== '') return value;
    if (nonInteractive) {
      throw new Error(`env secret ${secret.name} 需要本机环境变量 ${secret.fromEnv}`);
    }
    logger.warn(`本机环境变量 ${secret.fromEnv} 为空，将改为交互输入 ${secret.name}。`);
  } else if (nonInteractive) {
    throw new Error(`env secret ${secret.name} 在非交互模式下必须配置 fromEnv`);
  }

  const value = await password({
    message: `请输入 ${secret.name}：`,
    mask: '*',
    validate: (candidate) => (candidate ? true : `${secret.name} 不能为空`)
  });
  return value;
}

const MERGE_ENV_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';

const workspace = process.env.WORKSPACE;
const targetFile = process.env.TARGET_FILE || '.env';
const dataFile = process.env.ENV_DATA_FILE;

if (!workspace) throw new Error('WORKSPACE is required');
if (!dataFile) throw new Error('ENV_DATA_FILE is required');
if (path.isAbsolute(targetFile)) throw new Error('TARGET_FILE must be relative');

const normalizedTarget = path.posix.normalize(targetFile.replace(/\\\\/g, '/'));
if (!normalizedTarget || normalizedTarget === '.' || normalizedTarget === '..' || normalizedTarget.startsWith('../')) {
  throw new Error('TARGET_FILE must stay inside WORKSPACE');
}

const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const variables = data.variables || {};
const targetPath = path.join(workspace, normalizedTarget);

function assertEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('Invalid env name: ' + name);
  }
}

function formatEnvValue(value) {
  const text = String(value);
  if (/[\\0\\n\\r]/.test(text)) {
    throw new Error('Env values cannot contain null bytes or newlines');
  }
  if (text === '') return '""';
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(text)) return text;
  return '"' + text.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
}

for (const [name, value] of Object.entries(variables)) {
  assertEnvName(name);
  variables[name] = formatEnvValue(value);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });

const existing = fs.existsSync(targetPath)
  ? fs.readFileSync(targetPath, 'utf8').split(/\\r?\\n/)
  : [];
const seen = new Set();
const output = [];

for (const line of existing) {
  const match = line.match(/^(\\s*(?:export\\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\\s*=).*$/);
  if (match && Object.prototype.hasOwnProperty.call(variables, match[2])) {
    output.push(match[1] + match[2] + match[3] + variables[match[2]]);
    seen.add(match[2]);
  } else {
    output.push(line);
  }
}

const missing = Object.keys(variables).filter((name) => !seen.has(name)).sort();
if (output.length > 0 && output[output.length - 1] !== '') {
  output.push('');
}
for (const name of missing) {
  output.push(name + '=' + variables[name]);
}

fs.writeFileSync(targetPath, output.join('\\n').replace(/\\n*$/, '\\n'), { mode: 0o600 });
fs.chmodSync(targetPath, 0o600);
`;
