import { Command } from 'commander';
import { deployCommand } from './commands/deploy.js';
import { doctorCommand } from './commands/doctor.js';
import { initConfigCommand } from './commands/init-config.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('nemoclaw-deploy')
  .description('Safely deploy OpenClaw agents into an existing NemoClaw sandbox.')
  .version('0.1.0')
  .action(() => runAction(() => deployCommand({})));

program
  .command('deploy')
  .description('Deploy an OpenClaw agent into an existing NemoClaw sandbox.')
  .option('--config <file>', '指定 deploy.yaml')
  .option('--non-interactive', '禁用交互，缺少必要字段时直接失败')
  .option('--dry-run', '只打印计划，不执行命令')
  .action((options: { config?: string; nonInteractive?: boolean; dryRun?: boolean }) =>
    runAction(() => deployCommand(options))
  );

program
  .command('doctor')
  .description('Check local NemoClaw prerequisites.')
  .option('--sandbox <name>', '额外检查指定 sandbox 状态')
  .action((options: { sandbox?: string }) => runAction(() => doctorCommand(options)));

program
  .command('init-config')
  .description('Output a deploy.yaml template.')
  .option('--output <file>', '写入 deploy.yaml 模板文件')
  .action((options: { output?: string }) => runAction(() => initConfigCommand(options)));

await program.parseAsync(process.argv);

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
