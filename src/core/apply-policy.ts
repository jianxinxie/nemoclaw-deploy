import fs from 'fs-extra';
import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { collectNetworkPolicyFiles } from '../utils/validators.js';
import { readYamlFile } from '../utils/yaml.js';

export interface ApplyPolicyResult {
  status: 'skipped' | 'applied';
  count: number;
}

export async function validateNetworkPolicies(ctx: DeployContext): Promise<string[]> {
  if (!ctx.networkPolicy.enabled) return [];
  if (!ctx.networkPolicy.dir) {
    throw new Error('networkPolicy.dir 是必填字段');
  }

  const files = await collectNetworkPolicyFiles(ctx.networkPolicy.dir);
  const hosts = new Set<string>();
  for (const file of files) {
    const policy = await readYamlFile(file) as { network_policies?: Record<string, { endpoints?: Array<{ host?: string }> }> };
    if (!policy?.network_policies || typeof policy.network_policies !== 'object') {
      throw new Error(`policy 缺少 network_policies: ${file}`);
    }
    for (const entry of Object.values(policy.network_policies)) {
      for (const endpoint of entry?.endpoints ?? []) {
        if (typeof endpoint.host !== 'string') continue;
        const host = endpoint.host.toLowerCase().replace(/\.$/, '');
        if (/^127\./.test(host) || host === '::1' || host === 'localhost') {
          throw new Error(`NemoClaw v0.0.134 不接受自定义 policy 的 loopback endpoint (${host}): ${file}。主机服务请使用可达的 host.openshell.internal。`);
        }
        hosts.add(host);
      }
    }
  }
  for (const host of ctx.networkPolicy.trustedPrivateHosts) {
    if (!hosts.has(host)) throw new Error(`可信私网主机 ${host} 未匹配 policy 中的 endpoint，请修正 trustedPrivateHosts`);
  }
  return files;
}

export async function applyPolicy(ctx: DeployContext): Promise<ApplyPolicyResult> {
  if (!ctx.networkPolicy.enabled) return { status: 'skipped', count: 0 };
  const files = await validateNetworkPolicies(ctx);
  const source = ctx.networkPolicy.dir!;
  const isDirectory = (await fs.stat(source)).isDirectory();
  logger.info(`应用 ${files.length} 个 network policy 文件。`);
  for (const file of files) logger.info(`  Policy File: ${file}`);
  const result = await runCommand('nemoclaw', [
    ctx.sandboxName, 'policy', 'add', isDirectory ? '--from-dir' : '--from-file', source,
    ...ctx.networkPolicy.trustedPrivateHosts.flatMap((host) => ['--trusted-private-host', host]), '--yes'
  ], { dryRun: ctx.options.dryRun, description: '使用 NemoClaw 正式 policy add 命令应用策略及显式私网信任' });
  if (!ctx.options.dryRun) {
    if (result.stdout.trim()) logger.info(result.stdout.trim());
    if (result.stderr.trim()) logger.warn(result.stderr.trim());
    logger.success(`Sandbox ${ctx.sandboxName} 的 ${files.length} 个 network policy 文件已应用。`);
  }
  return { status: 'applied', count: files.length };
}
