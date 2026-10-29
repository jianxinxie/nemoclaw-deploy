import path from 'node:path';
import fs from 'fs-extra';
import { bootstrapCommand } from './bootstrap.js';
import { deployCommand, validateDeployResources } from './deploy.js';
import { collectDeployPlan } from '../core/context.js';

export interface UpOptions {
  config?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export async function upCommand(options: UpOptions): Promise<void> {
  const config = await resolveConfigPath(options.config);
  const plan = await collectDeployPlan({ ...options, config });
  // Catch missing uploads, malformed skills and invalid policy before installing
  // NemoClaw or creating a sandbox. Check again at deployment time for changes.
  await validateDeployResources(plan);

  const bootstrap = await bootstrapCommand({
    config,
    nonInteractive: options.nonInteractive,
    dryRun: options.dryRun
  });
  if (!bootstrap.completed) return;

  await deployCommand({
    config,
    nonInteractive: options.nonInteractive,
    dryRun: options.dryRun
  }, plan);
}

async function resolveConfigPath(
  explicitPath: string | undefined
): Promise<string> {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!(await fs.pathExists(resolved))) {
      throw new Error(`配置文件不存在: ${resolved}`);
    }
    return resolved;
  }

  const resolvedDefault = path.resolve('onboard.yaml');
  if (!(await fs.pathExists(resolvedDefault))) {
    throw new Error(`统一配置文件不存在: ${resolvedDefault}`);
  }
  return resolvedDefault;
}
