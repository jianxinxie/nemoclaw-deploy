export function isWarningLine(line: string): boolean {
  return /^(?:npm\s+)?warn(?:ing)?\b|^\[[^\]]*\bwarn(?:ing)?\b[^\]]*\]|^警告[：:]|^⚠|^\(node:\d+\) (?:Experimental)?Warning:/i.test(line.trim());
}

export function commandValue(stdout: string): string {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !isWarningLine(line)).at(-1) ?? '';
}

/** Read a complete JSON document surrounded by CLI diagnostics. */
export function parseJsonOutput<T = unknown>(stdout: string, label = 'JSON'): T {
  const text = stdout.trim();
  try { return JSON.parse(text) as T; } catch { /* Search line-aligned documents. */ }
  for (const match of text.matchAll(/(?:^|\n)[ \t]*([\[{])/g)) {
    const start = match.index! + match[0].length - 1;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) break;
        if (stack.length === 0) {
          try { return JSON.parse(text.slice(start, index + 1)) as T; } catch { break; }
        }
      }
    }
  }
  throw new Error(`无法解析 ${label} 输出`);
}
