import type { DeployContext } from './context.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';

export interface ConfigureToolsResult {
  status: 'skipped' | 'configured';
  profile?: string;
}

export async function configureTools(ctx: DeployContext): Promise<ConfigureToolsResult> {
  if (!ctx.tools.enabled) return { status: 'skipped' };

  const extraJson = JSON.stringify(ctx.tools.config ?? {});

  await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `TOOLS_PROFILE=${ctx.tools.profile}`,
      `TOOLS_EXTRA_JSON=${extraJson}`,
      'node',
      '-e',
      nodeEvalScript(PATCH_TOOLS_CONFIG_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: `在 openclaw.json 中设置 tools.profile=${ctx.tools.profile}，保留已有 toolSearch/web 等配置`,
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env TOOLS_PROFILE=${ctx.tools.profile} TOOLS_EXTRA_JSON=<json> node -e <patch-tools-config>`
    }
  );

  return { status: 'configured', profile: ctx.tools.profile };
}

const PATCH_TOOLS_CONFIG_SCRIPT = `
const fs = require('node:fs');

const configPath = '/sandbox/.openclaw/openclaw.json';
const profile = process.env.TOOLS_PROFILE;
const extra = JSON.parse(process.env.TOOLS_EXTRA_JSON || '{}');
if (!profile) throw new Error('TOOLS_PROFILE is required');

const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

if (!isPlainObject(config.tools)) config.tools = {};
config.tools = deepMerge(config.tools, extra);
config.tools.profile = profile;

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
`;
