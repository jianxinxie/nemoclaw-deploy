import path from 'node:path';

export interface IgnoreMatcher {
  ignores(relPath: string, isDirectory: boolean): boolean;
}

interface CompiledPattern {
  regex: RegExp;
  anchored: boolean;
  dirOnly: boolean;
}

/**
 * 简化版 .gitignore 语义：
 * - 不含 / 的模式匹配任意层级下的文件名或目录名，例如 node_modules、*.log
 * - 含 / 的模式相对 hostDir 根路径匹配，例如 docs/draft.md、data/**
 * - 末尾 / 表示只匹配目录，例如 secrets/
 * - * 不跨目录，** 跨目录，? 匹配单个字符；不支持 ! 取反
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const compiled = patterns.map(compilePattern);

  return {
    ignores(relPath: string, isDirectory: boolean): boolean {
      const normalized = relPath.split(path.sep).join('/');
      const basename = normalized.split('/').pop() ?? normalized;

      return compiled.some((pattern) => {
        if (pattern.dirOnly && !isDirectory) return false;
        return pattern.regex.test(pattern.anchored ? normalized : basename);
      });
    }
  };
}

function compilePattern(raw: string): CompiledPattern {
  let pattern = raw.trim();

  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.replace(/\/+$/, '');

  const anchored = pattern.includes('/');
  if (anchored) pattern = pattern.replace(/^\/+/, '');

  return { regex: globToRegExp(pattern), anchored, dirOnly };
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}
