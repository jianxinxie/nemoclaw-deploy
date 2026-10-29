import { AsyncLocalStorage } from 'node:async_hooks';
import { execa } from 'execa';
import { logger } from './logger.js';
import { maskSensitiveText } from './mask.js';

export interface RunCommandOptions {
  dryRun?: boolean;
  sensitive?: boolean;
  /** Preserve machine-readable output in memory; logs and errors remain masked. */
  rawOutput?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  logCommand?: boolean;
  description?: string;
  displayCommand?: string;
  background?: boolean;
  /**
   * 丢弃子进程输出，只等待进程退出。
   * 用于会派生长驻子进程的命令（例如 nemoclaw gateway restart），
   * 否则子进程继承的输出管道不关闭，等待会一直挂住。
   */
  ignoreOutput?: boolean;
  /**
   * 将终端直接交给子进程。用于 NemoClaw installer/onboard 的官方交互向导。
   * 交互模式不捕获或重放子进程输出。
   */
  interactive?: boolean;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const commandEnvironment = new AsyncLocalStorage<Record<string, string>>();

/** Keep host command settings scoped to one operation, including cleanup. */
export function withCommandEnvironment<T>(env: Record<string, string>, action: () => T): T {
  return commandEnvironment.run({ ...commandEnvironment.getStore(), ...env }, action);
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  const env = { ...commandEnvironment.getStore(), ...options.env };
  const secrets = collectSecrets(args, env);
  const display = maskSensitiveText(options.displayCommand ?? formatCommand(command, args, secrets), secrets);

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
          ...env
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
      stdin: options.interactive ? 'inherit' : 'ignore',
      stdout: options.interactive ? 'inherit' : options.ignoreOutput ? 'ignore' : 'pipe',
      stderr: options.interactive ? 'inherit' : options.ignoreOutput ? 'ignore' : 'pipe',
      env: {
        ...process.env,
        NO_COLOR: '1',
        TERM: 'xterm-256color',
        ...env
      }
    });

    const stdout = maskSensitiveText(typeof result.stdout === 'string' ? result.stdout : '', secrets);
    const stderr = maskSensitiveText(typeof result.stderr === 'string' ? result.stderr : '', secrets);
    const exitCode = result.exitCode;
    const timedOut = (result as { timedOut?: boolean }).timedOut ?? false;

    if (timedOut) {
      throw new Error(`命令超时: ${display}`);
    }

    if (exitCode !== 0) {
      throw new Error(
        [
          `命令执行失败: ${display}`,
          `exitCode: ${exitCode ?? 'unknown'}${result.signal ? ` (signal: ${result.signal})` : ''}`,
          stderr ? `stderr: ${stderr}` : '',
          stdout ? `stdout: ${stdout}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    return {
      stdout: options.rawOutput && typeof result.stdout === 'string' ? result.stdout : stdout,
      stderr: options.rawOutput && typeof result.stderr === 'string' ? result.stderr : stderr,
      exitCode
    };
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
    const envAssignment = arg.match(/^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*)=(.+)$/i);
    if (envAssignment?.[2]) {
      secrets.add(envAssignment[2]);
    }

    for (const jsonSecret of arg.matchAll(/"(?:gatewayToken|secret)"\s*:\s*"([^"]+)"/gi)) {
      if (jsonSecret[1]) {
        secrets.add(jsonSecret[1]);
      }
    }
  }

  for (const [key, value] of Object.entries(env ?? {})) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i.test(key) && value) {
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
