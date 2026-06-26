import path from 'node:path';
import fs from 'fs-extra';
import { templatePath } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

export interface InitConfigOptions {
  output?: string;
}

export async function initConfigCommand(options: InitConfigOptions): Promise<void> {
  const template = await fs.readFile(templatePath('deploy.yaml'), 'utf8');

  if (!options.output) {
    process.stdout.write(template);
    return;
  }

  const outputPath = path.resolve(options.output);
  await fs.outputFile(outputPath, template, 'utf8');
  logger.success(`已写入 ${outputPath}`);
}
