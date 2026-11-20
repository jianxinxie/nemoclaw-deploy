import pc from 'picocolors';
import { AsyncLocalStorage } from 'node:async_hooks';

const warnings = new AsyncLocalStorage<string[]>();

export function withWarningCollection<T>(collection: string[], action: () => T): T {
  return warnings.run(collection, action);
}

export const logger = {
  info(message: string): void {
    console.log(message);
  },

  success(message: string): void {
    console.log(pc.green(message));
  },

  warn(message: string): void {
    warnings.getStore()?.push(message);
    console.warn(pc.yellow(message));
  },

  error(message: string): void {
    console.error(pc.red(message));
  },

  step(message: string): void {
    console.log(pc.cyan(message));
  }
};
