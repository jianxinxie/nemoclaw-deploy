import path from 'node:path';
import { isIP } from 'node:net';
import fs from 'fs-extra';
import { z } from 'zod';
import { createIgnoreMatcher } from './ignore.js';

export function validateTrustedPrivateHost(input: string): string {
  const host = input.trim().toLowerCase().replace(/\.$/, '').replace(/^\[([^\]]+)\]$/, '$1');
  if (!host || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) ||
      host.includes('..') || host === 'localhost' || host.endsWith('.localhost') ||
      /^127\./.test(host) || host === '::1') {
    throw new Error(`networkPolicy.trustedPrivateHosts 必须是精确主机名或私网 IP，不能包含 URL、端口、通配符或 loopback: ${input}`);
  }
  return host;
}

export const sandboxNameSchema = z.string().regex(/^[a-zA-Z0-9._-]+$/, {
  message: 'sandboxName 只能包含字母、数字、点、下划线和短横线'
});

export const onboardSandboxNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/, {
  message: 'onboard sandbox 名称必须为 1-63 位，以小写字母开头，只能包含小写字母、数字和内部短横线'
});

export const agentNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, {
  message: 'agentName 必须以小写字母开头，只能包含小写字母、数字、下划线和短横线，最长 32 位'
});

export const conflictStrategySchema = z.enum(['ask', 'skip', 'backup', 'overwrite', 'fail']);

export const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: 'env 变量名必须以字母或下划线开头，只能包含字母、数字和下划线'
});

export const pluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, {
  message: 'plugin id 必须以字母或数字开头，只能包含字母、数字、点、下划线和短横线，最长 64 位'
});

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

export function validateOnboardSandboxName(value: string): string {
  return onboardSandboxNameSchema.parse(value.trim());
}

export function validateAgentName(value: string): string {
  return agentNameSchema.parse(value);
}

export function validateWorkspace(value: string): string {
  const workspace = value.trim();
  if (!workspace.startsWith('/') || /[\0\r\n\\]/.test(workspace)) {
    throw new Error('workspace 必须是 sandbox 中不含控制字符的绝对路径');
  }
  const normalized = path.posix.normalize(workspace).replace(/\/+$/, '');
  if (!normalized) throw new Error('workspace 不能是 sandbox 根目录');
  return normalized;
}

export function validateEnvName(value: string): string {
  return envNameSchema.parse(value.trim());
}

export function validatePluginId(value: string): string {
  return pluginIdSchema.parse(value.trim());
}

export function validatePluginSource(value: string): string {
  const source = value.trim();
  if (!source) {
    throw new Error('plugins.items[].source 不能为空字符串');
  }
  if (source.includes('\0') || /\s/.test(source)) {
    throw new Error(`plugins.items[].source 不能包含空白字符: ${source}`);
  }
  if (source.startsWith('-')) {
    throw new Error(`plugins.items[].source 不能以 - 开头: ${source}`);
  }
  return source;
}

export function validateAgentModel(value: string): string {
  const model = value.trim();
  if (!model) throw new Error('deploy.agents[].model 不能为空字符串');
  if (model.includes('\0') || /[\r\n]/.test(model)) {
    throw new Error('deploy.agents[].model 不能包含空字符或换行');
  }
  return model;
}

export function validateIgnorePattern(value: string): string {
  const pattern = value.trim();
  if (!pattern) {
    throw new Error('agentContent.ignore 不能包含空模式');
  }
  if (pattern.includes('\0')) {
    throw new Error(`agentContent.ignore 模式不能包含空字符: ${pattern}`);
  }
  if (pattern.startsWith('/')) {
    throw new Error(`agentContent.ignore 模式必须是相对 hostDir 的路径，不能以 / 开头: ${pattern}`);
  }
  if (pattern === '..' || pattern.startsWith('../') || pattern.includes('/../')) {
    throw new Error(`agentContent.ignore 模式不能包含 ..: ${pattern}`);
  }
  return pattern;
}

export function isPluginHostPathSource(source: string): boolean {
  return (
    source === '.' ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/') ||
    source.startsWith('~/')
  );
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

export function validateEnvTargetFile(value: string): string {
  const cleaned = value.trim() || '.env';
  if (cleaned.includes('\0')) {
    throw new Error('env.targetFile 不能包含空字符');
  }
  if (path.isAbsolute(cleaned)) {
    throw new Error('env.targetFile 必须是相对 env.directory 的路径');
  }

  const normalized = path.posix.normalize(cleaned.replace(/\\/g, '/'));
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error('env.targetFile 必须位于 env.directory 内');
  }
  if (normalized.endsWith('/')) {
    throw new Error('env.targetFile 必须是文件路径，不能是目录');
  }

  return normalized;
}

export function validateEnvDirectory(value: string | undefined, workspace: string): string {
  const raw = value?.trim();
  if (!raw) return workspace;
  if (raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new Error('env.directory 不能包含空字符或换行');
  }
  if (raw.startsWith('/')) return path.posix.normalize(raw);

  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('env.directory 相对路径必须位于 workspace 内');
  }
  return path.posix.join(workspace, normalized);
}

export function validateEnvValue(name: string, value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`env 变量 ${name} 不能包含空字符或换行`);
  }
  return value;
}

export function validateDependencyCommand(value: string): string {
  const command = value.trim();
  if (!command) {
    throw new Error('sandbox.commands.items 不能包含空命令');
  }
  if (command.includes('\0')) {
    throw new Error('sandbox.commands.items 不能包含空字符');
  }
  return command;
}

export function validateDependencyWorkingDir(value: string | undefined, workspace: string): string {
  const raw = value?.trim();
  if (!raw) return workspace;
  if (raw.includes('\0')) {
    throw new Error('sandbox.commands.workingDir 不能包含空字符');
  }
  if (raw.startsWith('/')) return path.posix.normalize(raw);

  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('sandbox.commands.workingDir 相对路径必须位于 workspace 内');
  }
  return path.posix.join(workspace, normalized);
}

export function validateSandboxCopyDestination(value: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error('sandbox.uploads.items[].destination 是必填字段');
  }
  if (raw.includes('\0') || /[\r\n]/.test(raw)) {
    throw new Error('sandbox.uploads.items[].destination 不能包含空字符或换行');
  }
  if (!raw.startsWith('/')) {
    throw new Error(`sandbox.uploads.items[].destination 必须是 sandbox 绝对路径: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '/') {
    throw new Error('sandbox.uploads.items[].destination 不能是 sandbox 根目录');
  }
  return normalized.replace(/\/+$/, '');
}

export async function validateHostFileOrDirectory(source: string): Promise<string> {
  const resolved = path.resolve(source);
  const stat = await fs.lstat(resolved).catch(() => null);
  if (!stat || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`sandbox.uploads.items[].source 不是有效的主机文件或目录: ${source}`);
  }
  await validateUploadTree(resolved, []);
  return resolved;
}

export async function validateAgentContentDir(hostDir: string, ignore: string[] = []): Promise<string> {
  const resolved = path.resolve(hostDir);
  const stat = await fs.lstat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`agentContent.hostDir 不是有效目录: ${hostDir}`);
  }

  if (await validateUploadTree(resolved, ignore) === 0) {
    throw new Error(`agentContent.hostDir 不能为空，应用 ignore 后必须至少有一个可上传文件: ${hostDir}`);
  }

  return resolved;
}

async function validateUploadTree(root: string, ignore: string[]): Promise<number> {
  const matcher = createIgnoreMatcher(ignore);
  async function visit(full: string, relative: string): Promise<number> {
    const stat = await fs.lstat(full);
    if (relative && matcher.ignores(relative, stat.isDirectory())) return 0;
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`上传路径必须是普通文件或目录，不能包含符号链接或特殊文件: ${full}`);
    }
    if (stat.isFile()) return 1;
    let files = 0;
    for (const name of await fs.readdir(full)) {
      files += await visit(path.join(full, name), relative ? `${relative}/${name}` : name);
    }
    return files;
  }
  return visit(root, '');
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
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
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
