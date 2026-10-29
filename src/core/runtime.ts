import { runCommand } from '../utils/run.js';
import {
  assertMinimumVersion,
  assertOpenClawNodeVersion,
  DEFAULT_NODE_VERSION,
  MIN_OPENCLAW_VERSION
} from '../utils/versions.js';

export function assertSandboxRunning(output: string): void {
  let status: { found?: boolean; phase?: string; gatewayState?: string; rpcIssue?: unknown; failureLayer?: unknown };
  try {
    status = JSON.parse(output);
  } catch {
    throw new Error('无法解析 sandbox status --json 返回的状态');
  }
  if (!status || status.found !== true || !['ready', 'running'].includes(status.phase?.toLowerCase() ?? '') ||
      status.gatewayState !== 'present' || status.rpcIssue || status.failureLayer) {
    throw new Error(`sandbox 尚未运行或状态异常（phase=${status?.phase ?? 'unknown'}）。请先恢复 sandbox 后再部署。`);
  }
}

export async function checkOpenClawRuntime(
  sandboxName: string,
  dryRun = false
): Promise<{ nodeVersion: string; openClawVersion: string }> {
  const node = await runCommand('nemoclaw', [sandboxName, 'exec', '--', 'node', '--version'], {
    dryRun,
    timeoutMs: 30_000,
    description: '独立检查 sandbox 内 Node.js 是否满足 OpenClaw 的版本范围'
  });
  let nodeVersion = '';
  if (!dryRun) {
    try {
      nodeVersion = assertOpenClawNodeVersion(node.stdout);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n请备份并通过官方 rebuild 流程更新 sandbox 镜像；自定义 Dockerfile 请使用 Node.js ${DEFAULT_NODE_VERSION} 等受支持版本。更新主机 Node.js 不会更新 sandbox 内 Node.js。`);
    }
  }
  const result = await runCommand('nemoclaw', [sandboxName, 'exec', '--', 'openclaw', '--version'], {
    dryRun,
    timeoutMs: 30_000,
    description: '检查 sandbox 中的 OpenClaw 版本；更新主机 CLI 不会自动更新已有 sandbox'
  });
  if (dryRun) return { nodeVersion: '', openClawVersion: '' };
  try {
    return {
      nodeVersion,
      openClawVersion: assertMinimumVersion(result.stdout, MIN_OPENCLAW_VERSION, 'sandbox OpenClaw')
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n请备份并使用 NemoClaw 的 sandbox rebuild 流程更新已有 sandbox。`);
  }
}
