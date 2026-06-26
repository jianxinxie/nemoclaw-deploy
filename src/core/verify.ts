import type { DeployContext } from './context.js';
import { agentListContains } from './create-agent.js';
import { runCommand } from '../utils/run.js';

export interface VerifyOptions {
  policyApplied: boolean;
}

export async function verifyDeployment(ctx: DeployContext, options: VerifyOptions): Promise<void> {
  const agents = await runCommand('nemoclaw', [ctx.sandboxName, 'agents', 'list', '--json'], {
    dryRun: ctx.options.dryRun,
    timeoutMs: 30_000,
    description: '验证 agent 是否已经出现在 agents list 中'
  });
  if (!agentListContains(agents.stdout, ctx.agentName)) {
    throw new Error(`验证失败：agents list 中未找到 ${ctx.agentName}`);
  }

  await runCommand('nemoclaw', [ctx.sandboxName, 'status', '--json'], {
    dryRun: ctx.options.dryRun,
    description: '验证 sandbox 状态仍然可读取'
  });

  if (ctx.channel.enabled) {
    if (!ctx.channel.gatewayToken) throw new Error('验证失败：gatewayToken 未获取');
    if (!ctx.channel.gatewayUrl) throw new Error('验证失败：gatewayUrl 未获取');
    if (!ctx.channel.channelServerUrl) throw new Error('验证失败：channelServerUrl 未填写');
  }

  if (ctx.networkPolicy.enabled && !options.policyApplied) {
    throw new Error('验证失败：network policy 未成功应用');
  }
}
