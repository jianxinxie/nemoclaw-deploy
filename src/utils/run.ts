import { execa } from 'execa';
import { logger } from './logger.js';
import { maskSensitiveText } from './mask.js';

export interface RunCommandOptions {
  dryRun?: boolean;
  sensitive?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  logCommand?: boolean;
  description?: string;
  displayCommand?: string;
  background?: boolean;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const secrets = collectSecrets(args, options.env);
  const display = options.displayCommand ?? formatCommand(command, args, secrets);

  if (options.dryRun) {
    logger.info(`[dry-run] ${display}`);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  try {
    if (options.logCommand !== false) {
      if (options.description) {
        logger.info(`用途: ${options.description}`);
      }
      logger.info(`执行命令: ${display}`);
    }

    if (options.background) {
      const subprocess = execa(command, args, {
        detached: true,
        cleanup: false,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        env: {
          ...process.env,
          NO_COLOR: '1',
          TERM: 'xterm-256color',
          ...options.env
        }
      }) as unknown as { unref?: () => void };

      subprocess.unref?.();
      logger.info('命令已在后台启动，不等待完成。');
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const result = await execa(command, args, {
      reject: false,
      timeout: options.timeoutMs,
      forceKillAfterDelay: options.timeoutMs ? 2_000 : false,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        TERM: 'xterm-256color',
        ...options.env
      }
    });

    const stdout = maskSensitiveText(result.stdout, secrets);
    const stderr = maskSensitiveText(result.stderr, secrets);
    const exitCode = result.exitCode ?? 0;
    const timedOut = (result as { timedOut?: boolean }).timedOut ?? false;

    if (timedOut) {
      throw new Error(`命令超时: ${display}`);
    }

    if (exitCode !== 0) {
      throw new Error(
        [
          `命令执行失败: ${display}`,
          `exitCode: ${exitCode}`,
          stderr ? `stderr: ${stderr}` : '',
          stdout ? `stdout: ${stdout}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    return { stdout, stderr, exitCode };
  } catch (error) {
    if (error instanceof Error) {
      if ((error as { timedOut?: boolean }).timedOut) {
        throw new Error(`命令超时: ${display}`);
      }
      const message = maskSensitiveText(error.message, secrets);
      if (message.startsWith('命令执行失败:') || message.startsWith('命令超时:')) {
        throw new Error(message);
      }
      throw new Error(maskSensitiveText(`命令执行失败: ${display}\n${message}`, secrets));
    }
    throw error;
  }
}

function collectSecrets(args: string[], env?: Record<string, string>): string[] {
  const secrets = new Set<string>();

  for (const arg of args) {
    const envAssignment = arg.match(/^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=(.+)$/i);
    if (envAssignment?.[2]) {
      secrets.add(envAssignment[2]);
    }

    const jsonToken = arg.match(/"gatewayToken"\s*:\s*"([^"]+)"/i);
    if (jsonToken?.[1]) {
      secrets.add(jsonToken[1]);
    }
  }

  for (const [key, value] of Object.entries(env ?? {})) {
    if (/TOKEN|SECRET|PASSWORD/i.test(key) && value) {
      secrets.add(value);
    }
  }

  return [...secrets];
}

function formatCommand(command: string, args: string[], secrets: string[]): string {
  const parts = [command, ...args].map((part) => quoteShellArg(maskSensitiveText(part, secrets)));
  return parts.join(' ');
}

function quoteShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
