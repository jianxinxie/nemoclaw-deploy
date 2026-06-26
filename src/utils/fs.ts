import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), '../..');
}

export function templatePath(...segments: string[]): string {
  return path.join(packageRoot(), 'templates', ...segments);
}

export function resolveFromBase(baseDir: string, value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

export function withTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') + '/';
}
