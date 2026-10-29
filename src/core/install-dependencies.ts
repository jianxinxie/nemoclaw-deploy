import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import type { DeployContext } from './context.js';
import { remoteTempBase } from './upload-agent-content.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

export interface InstallDependenciesResult {
  status: 'skipped' | 'executed' | 'partial';
  count: number;
}

export async function executeSandboxCommands(
  ctx: DeployContext
): Promise<InstallDependenciesResult> {
  if (!ctx.sandbox.commands.enabled) return { status: 'skipped', count: 0 };
  if (ctx.sandbox.commands.items.length === 0) {
    throw new Error('sandbox.commands.items 至少需要一个命令');
  }

  let installed = 0;
  logger.info(`将在 sandbox 的 ${ctx.sandbox.commands.workingDir} 下执行 ${ctx.sandbox.commands.items.length} 条命令。`);

  const remoteDir = `${remoteTempBase(ctx)}/sandbox-commands`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-commands-'));

  try {
    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteDir], {
      dryRun: ctx.options.dryRun,
      description: '创建 sandbox 临时目录，用于暂存命令脚本'
    });

    for (const [index, command] of ctx.sandbox.commands.items.entries()) {
      const ordinal = index + 1;
      const scriptName = `command-${String(ordinal).padStart(3, '0')}.sh`;
      const localScriptPath = path.join(tempDir, scriptName);
      const remoteScriptPath = `${remoteDir}/${scriptName}`;

      logger.info(`sandbox 命令 ${ordinal}/${ctx.sandbox.commands.items.length}: ${summarizeCommand(command)}`);
      await fs.writeFile(localScriptPath, buildDependencyScript(command), 'utf8');

      try {
        await runCommand('nemoclaw', [ctx.sandboxName, 'upload', localScriptPath, remoteScriptPath], {
          dryRun: ctx.options.dryRun,
          sensitive: true,
          description: `上传第 ${ordinal} 条命令脚本到 sandbox`
        });

        await runCommand(
          'nemoclaw',
          [
            ctx.sandboxName,
            'exec',
            '--',
            'env',
            `WORKSPACE=${ctx.workspace}`,
            `VIRTUAL_ENV=${ctx.workspace}/.venv`,
            `PYTHON=${ctx.workspace}/.venv/bin/python`,
            `COMMAND_WORKDIR=${ctx.sandbox.commands.workingDir}`,
            'sh',
            remoteScriptPath
          ],
          {
            dryRun: ctx.options.dryRun,
            sensitive: true,
            description: `在 sandbox 中执行第 ${ordinal} 条 agent 命令`,
            displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env WORKSPACE=${ctx.workspace} VIRTUAL_ENV=${ctx.workspace}/.venv PYTHON=${ctx.workspace}/.venv/bin/python COMMAND_WORKDIR=${ctx.sandbox.commands.workingDir} sh ${remoteScriptPath}`
          }
        );
        installed += 1;
      } catch (error) {
        if (!ctx.sandbox.commands.continueOnError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(`sandbox 命令失败，已按 continueOnError=true 继续：${detail}`);
      }
    }
  } finally {
    await fs.remove(tempDir);
  }

  return {
    status: installed === ctx.sandbox.commands.items.length ? 'executed' : 'partial',
    count: installed
  };
}

function buildDependencyScript(command: string): string {
  const normalizedCommand = command.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
  return [
    '#!/usr/bin/env sh',
    'set -e',
    'cd "$COMMAND_WORKDIR" || exit 1',
    'export PATH="$VIRTUAL_ENV/bin:$PATH"',
    normalizedCommand
  ].join('\n');
}

function summarizeCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 160) return oneLine;
  return `${oneLine.slice(0, 157)}...`;
}
