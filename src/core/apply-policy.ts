import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { collectNetworkPolicyFiles } from '../utils/validators.js';

export interface ApplyPolicyResult {
  status: 'skipped' | 'applied';
  count: number;
}

export async function applyPolicy(ctx: DeployContext): Promise<ApplyPolicyResult> {
  if (!ctx.networkPolicy.enabled) return { status: 'skipped', count: 0 };
  if (!ctx.networkPolicy.dir) {
    throw new Error('networkPolicy.dir 是必填字段');
  }

  const files = await collectNetworkPolicyFiles(ctx.networkPolicy.dir);
  logger.info(`发现 ${files.length} 个 network policy 文件，将逐个应用。`);

  for (const file of files) {
    logger.info(`应用 network policy: ${file}`);
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'policy-add', '--from-file', file, '--yes'],
      {
        dryRun: ctx.options.dryRun,
        description: `应用 network policy 文件 ${file}`
      }
    );
  }

  return { status: 'applied', count: files.length };
}
