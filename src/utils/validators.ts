import path from 'node:path';
import fs from 'fs-extra';
import { z } from 'zod';

export const sandboxNameSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/, {
  message: 'sandboxName 只能包含字母、数字、点、下划线和短横线'
});

export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, {
  message: 'agentName 必须以小写字母开头，只能包含小写字母、数字、下划线和短横线，最长 32 位'
});

export const conflictStrategySchema = z.enum(['ask', 'skip', 'backup', 'overwrite', 'fail']);

export function stripAngleBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function validateSandboxName(value: string): string {
  return sandboxNameSchema.parse(value);
}

export function validateAgentName(value: string): string {
  return agentNameSchema.parse(value);
}

export function validateChannelServerUrl(value: string): string {
  const cleaned = stripAngleBrackets(value);
  if (cleaned.includes('<') || cleaned.includes('>')) {
    throw new Error('channelServerUrl 不允许包含尖括号');
  }

  const url = new URL(cleaned);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('channelServerUrl 必须以 http:// 或 https:// 开头');
  }

  return url.toString().replace(/\/$/, '');
}

export function validateGatewayUrl(value: string): string {
  const cleaned = stripAngleBrackets(value);
  if (cleaned.includes('#token=')) {
    throw new Error('gatewayUrl 不能包含 #token= 片段');
  }

  const url = new URL(cleaned);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('gatewayUrl 必须以 ws:// 或 wss:// 开头');
  }

  return `${url.protocol}//${url.host}`;
}

export function dashboardUrlToGatewayUrl(input: string): string {
  const url = new URL(input.trim());

  if (url.protocol === 'http:') {
    return `ws://${url.host}`;
  }

  if (url.protocol === 'https:') {
    return `wss://${url.host}`;
  }

  throw new Error(`Unsupported dashboard URL protocol: ${url.protocol}`);
}

export async function validateAgentContentDir(hostDir: string): Promise<string> {
  const resolved = path.resolve(hostDir);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`agentContent.hostDir 不是有效目录: ${hostDir}`);
  }

  const entries = await fs.readdir(resolved);
  if (entries.length === 0) {
    throw new Error(`agentContent.hostDir 不能为空: ${hostDir}`);
  }

  return resolved;
}

export async function collectSkillDirs(hostDir: string): Promise<string[]> {
  const resolved = path.resolve(hostDir);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`skill.hostDir 不是有效目录: ${hostDir}`);
  }

  if (await fs.pathExists(path.join(resolved, 'SKILL.md'))) {
    return [resolved];
  }

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const skillDirs: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(resolved, entry.name);
    if (await fs.pathExists(path.join(skillDir, 'SKILL.md'))) {
      skillDirs.push(skillDir);
    }
  }

  if (skillDirs.length === 0) {
    throw new Error(`skill.hostDir 下没有找到包含 SKILL.md 的 skill 目录: ${hostDir}`);
  }

  return skillDirs.sort();
}

export async function collectNetworkPolicyFiles(inputPath: string): Promise<string[]> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved).catch(() => null);

  if (!stat) {
    throw new Error(`networkPolicy.dir 不是有效路径: ${inputPath}`);
  }

  if (stat.isFile()) {
    assertPolicyFileExtension(resolved);
    return [resolved];
  }

  if (!stat.isDirectory()) {
    throw new Error(`networkPolicy.dir 不是有效目录: ${inputPath}`);
  }

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(resolved, entry.name))
    .filter(isPolicyFile)
    .sort();

  if (files.length === 0) {
    throw new Error(`networkPolicy.dir 下没有找到 .yaml 或 .yml 文件: ${inputPath}`);
  }

  return files;
}

function isPolicyFile(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return ext === '.yaml' || ext === '.yml';
}

function assertPolicyFileExtension(file: string): void {
  if (!isPolicyFile(file)) {
    throw new Error('networkPolicy 文件必须是 .yaml 或 .yml 文件');
  }
}
