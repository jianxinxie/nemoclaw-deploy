import fs from 'fs-extra';
import { parse } from 'yaml';

export async function readYamlFile(filePath: string): Promise<unknown> {
  const content = await fs.readFile(filePath, 'utf8');
  return parse(content);
}
