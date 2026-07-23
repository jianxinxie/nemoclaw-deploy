import type { DeployContext } from './context.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { validateChannelServerUrl } from '../utils/validators.js';

export type RegisterAgentResult = 'skipped' | 'registered' | 'failed-continued';

export async function precheckAgentRegistration(contexts: DeployContext[]): Promise<void> {
  const enabled = contexts.filter((ctx) => ctx.channelRegistration.enabled);
  if (enabled.length === 0) return;

  for (const ctx of enabled) {
    if (!ctx.channelServer.enabled || !ctx.channelServer.url) {
      throw new Error(
        `agent ${ctx.agentName} 启用了 channel registration，但没有可用的 channelServerUrl`
      );
    }
  }

  try {
    await runCommand('curl', ['--version'], {
      dryRun: enabled[0].options.dryRun,
      timeoutMs: 10_000,
      description: '确认 curl 可用于向 channel server 注册 agent'
    });
  } catch (error) {
    if (enabled.some((ctx) => !ctx.channelRegistration.continueOnError)) throw error;
    logger.warn(`curl 预检查失败，已按 channelRegistration.continueOnError=true 继续：${errorMessage(error)}`);
  }
}

export async function registerAgent(ctx: DeployContext): Promise<RegisterAgentResult> {
  if (!ctx.channelRegistration.enabled) return 'skipped';
  try {
    if (!ctx.channelServer.enabled || !ctx.channelServer.url) {
      throw new Error(
        `agent ${ctx.agentName} 启用了 channel registration，但没有可用的 channelServerUrl`
      );
    }

    const url = agentRegistrationUrl(ctx.channelServer.url);
    const body = JSON.stringify({
      agent_id: ctx.agentName,
      agent_label: ctx.channelRegistration.agentLabel
    });

    await runCommand(
      'curl',
      [
        '--fail',
        '--silent',
        '--show-error',
        '--request',
        'POST',
        url,
        '--header',
        'accept: application/json',
        '--header',
        'Content-Type: application/json',
        '--data',
        body
      ],
      {
        dryRun: ctx.options.dryRun,
        timeoutMs: 30_000,
        description: `向 channel server 注册 agent ${ctx.agentName}`
      }
    );

    return 'registered';
  } catch (error) {
    if (!ctx.channelRegistration.continueOnError) throw error;
    logger.warn(
      `agent ${ctx.agentName} 注册失败，已按 channelRegistration.continueOnError=true 继续：${errorMessage(error)}`
    );
    return 'failed-continued';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function agentRegistrationUrl(channelServerUrl: string): string {
  const url = new URL(validateChannelServerUrl(channelServerUrl));
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/v1/openclaw/agents`;
  url.search = '';
  url.hash = '';
  return url.toString();
}
