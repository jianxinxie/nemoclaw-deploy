import { validateSandboxName } from '../utils/validators.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { assertMinimumVersion, MIN_NODE_VERSION, MIN_NEMOCLAW_VERSION } from '../utils/versions.js';
import { assertSandboxRunning, checkOpenClawRuntime } from '../core/runtime.js';

export interface DoctorOptions {
  sandbox?: string;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  let ok = true;

  logger.info('Doctor checks:');

  try {
    assertMinimumVersion(process.versions.node, MIN_NODE_VERSION, 'Node.js');
    logger.success(`Node.js: ok (${process.version})`);
  } catch (error) {
    ok = false;
    logger.error(error instanceof Error ? error.message : String(error));
  }

  try {
    const result = await runCommand('nemoclaw', ['--version'], {
      timeoutMs: 10_000,
      description: '检查本机 nemoclaw CLI 是否可执行'
    });
    const version = assertMinimumVersion(result.stdout, MIN_NEMOCLAW_VERSION, 'NemoClaw');
    logger.success(`nemoclaw: ok (${version})`);
  } catch (error) {
    ok = false;
    logger.error(`nemoclaw: failed`);
    logger.error(error instanceof Error ? error.message : String(error));
  }

  if (options.sandbox) {
    const sandboxName = validateSandboxName(options.sandbox);
    try {
      const status = await runCommand('nemoclaw', [sandboxName, 'status', '--json'], {
        timeoutMs: 30_000,
        description: `读取 sandbox ${sandboxName} 状态`
      });
      assertSandboxRunning(status.stdout);
      const runtime = await checkOpenClawRuntime(sandboxName);
      logger.success(`sandbox Node.js: ok (${runtime.nodeVersion})`);
      logger.success(`OpenClaw: ok (${runtime.openClawVersion})`);
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
