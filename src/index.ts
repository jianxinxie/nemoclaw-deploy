import { createRequire } from 'node:module';
import { Command } from 'commander';
import { deployCommand } from './commands/deploy.js';
import { doctorCommand } from './commands/doctor.js';
import { initConfigCommand } from './commands/init-config.js';
import { bootstrapCommand } from './commands/bootstrap.js';
import { upCommand } from './commands/up.js';
import { logger } from './utils/logger.js';
import { assertMinimumVersion, MIN_NODE_VERSION } from './utils/versions.js';

const packageMetadata = createRequire(import.meta.url)('../package.json') as { version: string };
const program = new Command();

program
  .name('nemoclaw-deploy')
  .description('Install/onboard NemoClaw and safely deploy one or more OpenClaw agents.')
  .version(packageMetadata.version)
  .option('--config <file>', '指定统一 onboard.yaml')
  .option('--non-interactive', '禁用所有交互，配置缺失时直接失败')
  .option('--dry-run', '只打印完整计划，不执行命令')
  .action((options: { config?: string; nonInteractive?: boolean; dryRun?: boolean }) =>
    runAction(() => upCommand(options))
  );

program
  .command('bootstrap')
  .description('Install NemoClaw when needed and ensure onboarding has produced a usable sandbox.')
  .option('--config <file>', '指定 onboard.yaml')
  .option('--non-interactive', '禁用交互，配置缺失时直接失败')
  .option('--dry-run', '只打印计划，不执行安装或 onboard')
  .action((options: { config?: string; nonInteractive?: boolean; dryRun?: boolean }, command: Command) =>
    runAction(() => bootstrapCommand(withGlobalOptions(options, command)).then(() => undefined))
  );

program
  .command('up')
  .description('Run bootstrap/onboard and then deploy all configured OpenClaw agents.')
  .option('--config <file>', '指定统一 onboard.yaml')
  .option('--non-interactive', '禁用所有交互，配置缺失时直接失败')
  .option('--dry-run', '只打印完整计划，不执行命令')
  .action(
    (
      options: { config?: string; nonInteractive?: boolean; dryRun?: boolean },
      command: Command
    ) => runAction(() => upCommand(withGlobalOptions(options, command)))
  );

program
  .command('deploy')
  .description('Deploy one or more OpenClaw agents into an existing NemoClaw sandbox.')
  .option('--config <file>', '指定统一 onboard.yaml，仅执行 deploy 分区')
  .option('--non-interactive', '禁用交互，缺少必要字段时直接失败')
  .option('--dry-run', '只打印计划，不执行命令')
  .action((options: { config?: string; nonInteractive?: boolean; dryRun?: boolean }, command: Command) =>
    runAction(() => deployCommand(withGlobalOptions(options, command)).then(() => undefined))
  );

program
  .command('doctor')
  .description('Check local NemoClaw prerequisites.')
  .option('--sandbox <name>', '额外检查指定 sandbox 状态')
  .action((options: { sandbox?: string }) => runAction(() => doctorCommand(options)));

program
  .command('init-config')
  .description('Output the unified onboard.yaml template.')
  .option('--output <file>', '写入统一 onboard.yaml 模板文件')
  .action((options: { output?: string }) => runAction(() => initConfigCommand(options)));

await program.parseAsync(process.argv);

function withGlobalOptions<T extends Record<string, unknown>>(options: T, command: Command): T {
  return {
    ...command.parent?.opts<Record<string, unknown>>(),
    ...options
  } as T;
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    assertMinimumVersion(process.versions.node, MIN_NODE_VERSION, 'Node.js');
    await action();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
