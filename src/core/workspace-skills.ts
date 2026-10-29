import path from 'node:path';
import fs from 'fs-extra';
import { parse } from 'yaml';
import type { DeployContext } from './context.js';
import { createIgnoreMatcher } from '../utils/ignore.js';
import { runCommand } from '../utils/run.js';
import { logger } from '../utils/logger.js';

export interface WorkspaceSkill {
  name: string;
  relativePath: string;
}

/** Discover precisely the files that will be uploaded, including grouped skills. */
export async function collectWorkspaceSkills(hostDir: string, ignore: string[]): Promise<WorkspaceSkill[]> {
  const matcher = createIgnoreMatcher(ignore);
  const skills: WorkspaceSkill[] = [];
  const names = new Set<string>();
  async function visit(relativePath: string, depth: number): Promise<void> {
    if (matcher.ignores(relativePath, true)) return;
    const directory = path.join(hostDir, relativePath);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`workspace skill 路径必须是普通目录: ${directory}`);
    }
    const file = path.join(directory, 'SKILL.md');
    const relativeFile = `${relativePath}/SKILL.md`;
    const fileStat = await fs.lstat(file).catch(() => null);
    if (fileStat && !matcher.ignores(relativeFile, false)) {
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`技能说明必须是普通文件: ${file}`);
      const text = await fs.readFile(file, 'utf8');
      const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      let metadata: { name?: unknown; description?: unknown } | null;
      try {
        metadata = frontmatter ? parse(frontmatter[1]) : null;
      } catch {
        throw new Error(`skill YAML frontmatter 无效: ${file}。请检查 description 中的冒号是否已加引号。`);
      }
      if (!metadata || typeof metadata.name !== 'string' || !metadata.name.trim() ||
          typeof metadata.description !== 'string' || !metadata.description.trim()) {
        throw new Error(`skill 必须包含 YAML frontmatter 和非空 name/description: ${file}`);
      }
      const name = metadata.name.trim();
      if (names.has(name)) throw new Error(`同一 workspace 中的 skill 名称重复: ${name}`);
      names.add(name);
      skills.push({ name, relativePath: relativeFile });
      return;
    }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (depth >= 6 && !matcher.ignores(`${relativePath}/${entry.name}`, true)) {
          throw new Error(`skill 目录超过 OpenClaw 支持的 6 层分组深度: ${directory}`);
        }
        await visit(`${relativePath}/${entry.name}`, depth + 1);
      }
    }
  }
  await visit('skills', 0);
  return skills;
}

export async function verifyWorkspaceSkills(ctx: DeployContext, expected: WorkspaceSkill[]): Promise<void> {
  if (expected.length === 0 || ctx.options.dryRun) return;
  const result = await runCommand('nemoclaw', [
    ctx.sandboxName, 'exec', '--', 'openclaw', 'skills', 'list', '--agent', ctx.agentName, '--json'
  ], { timeoutMs: 60_000, description: `确认 ${ctx.agentName} 能发现上传的 workspace skills` });
  let report: { workspaceDir?: string; skills?: Array<{
    name: string; source?: string; eligible?: boolean; disabled?: boolean;
    blockedByAllowlist?: boolean; blockedByAgentFilter?: boolean;
  }> };
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`无法解析 agent ${ctx.agentName} 的 skills list --json 输出`);
  }
  for (const skill of expected) {
    const found = report?.skills?.find((entry) => entry.name === skill.name);
    const expectedPath = path.posix.join(ctx.workspace, skill.relativePath);
    // The public JSON intentionally omits individual filePath fields.
    if (report.workspaceDir !== ctx.workspace || !found || found.source !== 'openclaw-workspace') {
      throw new Error(`agent ${ctx.agentName} 未从自己的 workspace 发现 skill ${skill.name}（期望 ${expectedPath}）`);
    }
    if (found.eligible !== true || found.disabled || found.blockedByAllowlist || found.blockedByAgentFilter) {
      throw new Error(`agent ${ctx.agentName} 的 skill ${skill.name} 尚不可用，请检查技能依赖、环境变量及 allowlist`);
    }
  }
  logger.info(`agent ${ctx.agentName}: 已验证 ${expected.length} 个 workspace skills。`);
}
