import { validateSandboxName } from '../utils/validators.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';

export interface DoctorOptions {
  sandbox?: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  let ok = true;

  logger.info('Doctor checks:');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) {
    logger.success(`Node.js: ok (${process.version})`);
  } else {
    ok = false;
    logger.error(`Node.js: failed (${process.version}), requires >=20`);
  }

  try {
    const result = await runCommand('nemoclaw', ['--version'], {
      timeoutMs: 10_000,
      description: '检查本机 nemoclaw CLI 是否可执行'
    });
    logger.success(`nemoclaw: ok (${result.stdout.trim() || 'version command succeeded'})`);
  } catch (error) {
    ok = false;
    logger.error(`nemoclaw: failed`);
    logger.error(error instanceof Error ? error.message : String(error));
  }

  if (options.sandbox) {
    const sandboxName = validateSandboxName(options.sandbox);
    try {
      await runCommand('nemoclaw', [sandboxName, 'status', '--json'], {
        timeoutMs: 30_000,
        description: `读取 sandbox ${sandboxName} 状态`
      });
      logger.success(`sandbox ${sandboxName}: ok`);
    } catch (error) {
      ok = false;
      logger.error(`sandbox ${sandboxName}: failed`);
      logger.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (!ok) {
    process.exitCode = 1;
  }
}
