import os from 'node:os';
import path from 'node:path';
import { select } from '@inquirer/prompts';
import fs from 'fs-extra';
import type { ConflictStrategy, DeployContext } from './context.js';
import { createIgnoreMatcher } from '../utils/ignore.js';
import { logger } from '../utils/logger.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';
import { validateAgentContentDir } from '../utils/validators.js';
import { withTrailingSlash } from '../utils/fs.js';

export async function uploadAgentContent(ctx: DeployContext): Promise<'skipped' | 'applied'> {
  if (!ctx.agentContent.enabled) return 'skipped';
  if (!ctx.agentContent.hostDir) {
    throw new Error('agentContent.hostDir 是必填字段');
  }

  const hostDir = await validateAgentContentDir(ctx.agentContent.hostDir);
  const hostDirName = path.basename(hostDir);
  const remoteBase = remoteTempBase(ctx);
  const remoteSourceDir = `${remoteBase}/agent-content`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-'));
  const mergeScriptPath = path.join(tempDir, 'merge-agent-content.mjs');

  try {
    const uploadDir = await stageAgentContent(hostDir, ctx.agentContent.ignore, tempDir);

    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteBase], {
      dryRun: ctx.options.dryRun,
      description: '创建 sandbox 临时目录，用于暂存 agent 初始化内容'
    });

    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'upload', withTrailingSlash(uploadDir), `${remoteSourceDir}/`],
      {
        dryRun: ctx.options.dryRun,
        description: '上传 agent 初始化内容到 sandbox 临时目录，不直接覆盖 workspace'
      }
    );

    let strategy = ctx.agentContent.conflictStrategy;
    if (strategy === 'ask') {
      const conflicts = await detectRemoteConflicts(ctx, remoteSourceDir, hostDirName);
      strategy = await resolveAskStrategy(conflicts);
    }

    await fs.writeFile(mergeScriptPath, MERGE_AGENT_CONTENT_SCRIPT, 'utf8');
    await runCommand(
      'nemoclaw',
      [ctx.sandboxName, 'upload', mergeScriptPath, `${remoteBase}/merge-agent-content.mjs`],
      {
        dryRun: ctx.options.dryRun,
        description: '上传 agent-content 合并脚本到 sandbox'
      }
    );

    await runCommand(
      'nemoclaw',
      [
        ctx.sandboxName,
        'exec',
        '--',
        'env',
        `WORKSPACE=${ctx.workspace}`,
        `SOURCE_DIR=${remoteSourceDir}`,
        `SOURCE_BASENAME=${hostDirName}`,
        `CONFLICT_STRATEGY=${strategy}`,
        'node',
        `${remoteBase}/merge-agent-content.mjs`
      ],
      {
        dryRun: ctx.options.dryRun,
        description: `按 ${strategy} 策略把临时目录内容合并到 workspace`
      }
    );

    return 'applied';
  } finally {
    await fs.remove(tempDir);
  }
}

export function remoteTempBase(ctx: DeployContext): string {
  return `/tmp/nemoclaw-deploy/${ctx.agentName}`;
}

export async function stageAgentContent(
  hostDir: string,
  ignorePatterns: string[],
  tempDir: string
): Promise<string> {
  if (ignorePatterns.length === 0) return hostDir;

  const matcher = createIgnoreMatcher(ignorePatterns);
  const stagingDir = path.join(tempDir, 'staging', path.basename(hostDir));
  let ignoredCount = 0;

  await fs.copy(hostDir, stagingDir, {
    filter: (src) => {
      const rel = path.relative(hostDir, src);
      if (!rel) return true;
      const isDirectory = fs.lstatSync(src).isDirectory();
      if (matcher.ignores(rel, isDirectory)) {
        ignoredCount += 1;
        return false;
      }
      return true;
    }
  });

  const remaining = await fs.readdir(stagingDir).catch(() => [] as string[]);
  if (remaining.length === 0) {
    throw new Error(`agentContent.hostDir 下所有内容都被 ignore 规则忽略: ${hostDir}`);
  }

  logger.info(
    `已应用 ${ignorePatterns.length} 条 ignore 规则，忽略 ${ignoredCount} 个条目，被忽略内容不会上传。`
  );
  return stagingDir;
}

async function detectRemoteConflicts(
  ctx: DeployContext,
  remoteSourceDir: string,
  hostDirName: string
): Promise<string[]> {
  const result = await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `WORKSPACE=${ctx.workspace}`,
      `SOURCE_DIR=${remoteSourceDir}`,
      `SOURCE_BASENAME=${hostDirName}`,
      'node',
      '-e',
      nodeEvalScript(DETECT_CONFLICTS_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      description: '检测 workspace 中是否已有同名 agent-content 文件',
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env WORKSPACE=${ctx.workspace} SOURCE_DIR=${remoteSourceDir} node -e <detect-agent-content-conflicts>`
    }
  );

  if (!result.stdout.trim()) return [];

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    throw new Error(`无法解析 agent-content 冲突检测结果: ${result.stdout}`);
  }
}

async function resolveAskStrategy(conflicts: string[]): Promise<Exclude<ConflictStrategy, 'ask'>> {
  if (conflicts.length === 0) return 'fail';

  logger.warn('检测到 workspace 中已有同名文件：');
  for (const file of conflicts) {
    logger.warn(`- ${file}`);
  }

  return select<Exclude<ConflictStrategy, 'ask'>>({
    message: '请选择最终冲突处理策略：',
    choices: [
      { name: 'skip', value: 'skip', description: '跳过已有文件' },
      { name: 'backup', value: 'backup', description: '备份已有文件后覆盖' },
      { name: 'overwrite', value: 'overwrite', description: '直接覆盖已有文件' },
      { name: 'fail', value: 'fail', description: '发现冲突即失败' }
    ]
  });
}

const DETECT_CONFLICTS_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');

const workspace = process.env.WORKSPACE;
const sourceDir = process.env.SOURCE_DIR;
const sourceBasename = process.env.SOURCE_BASENAME;
if (!workspace) throw new Error('WORKSPACE is required');
if (!sourceDir) throw new Error('SOURCE_DIR is required');

function resolveSourceRoot(dir) {
  if (!sourceBasename || !fs.existsSync(dir)) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1) return dir;

  const only = entries[0];
  if (only.isDirectory() && only.name === sourceBasename) {
    return path.join(dir, only.name);
  }

  return dir;
}

function findConflicts(src, dst, relative = '') {
  const source = fs.lstatSync(src);
  const target = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (source.isSymbolicLink()) throw new Error('Agent content contains a symbolic link: ' + src);
  if (!source.isDirectory()) return target ? [relative] : [];
  if (target && !target.isDirectory()) return [relative];
  return fs.readdirSync(src).flatMap((name) =>
    findConflicts(path.join(src, name), path.join(dst, name), path.join(relative, name))
  );
}

const sourceRoot = resolveSourceRoot(sourceDir);
const conflicts = findConflicts(sourceRoot, workspace);
process.stdout.write(JSON.stringify(conflicts));
`;

const MERGE_AGENT_CONTENT_SCRIPT = `
import fs from 'node:fs';
import path from 'node:path';

const workspace = process.env.WORKSPACE;
const sourceDir = process.env.SOURCE_DIR;
const sourceBasename = process.env.SOURCE_BASENAME;
const strategy = process.env.CONFLICT_STRATEGY || 'fail';
const allowed = new Set(['skip', 'backup', 'overwrite', 'fail']);

if (!workspace) throw new Error('WORKSPACE is required');
if (!sourceDir) throw new Error('SOURCE_DIR is required');
if (!allowed.has(strategy)) throw new Error('Unsupported CONFLICT_STRATEGY: ' + strategy);
if (!fs.existsSync(sourceDir)) throw new Error('SOURCE_DIR does not exist: ' + sourceDir);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function resolveSourceRoot(dir) {
  if (!sourceBasename) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1) return dir;

  const only = entries[0];
  if (only.isDirectory() && only.name === sourceBasename) {
    return path.join(dir, only.name);
  }

  return dir;
}

function findConflicts(src, dst) {
  const source = fs.lstatSync(src);
  const target = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (source.isSymbolicLink() || (!source.isDirectory() && !source.isFile())) {
    throw new Error('Agent content must contain ordinary files and directories: ' + src);
  }
  if (!source.isDirectory()) return target ? [dst] : [];
  if (target && !target.isDirectory()) return [dst];
  return fs.readdirSync(src).flatMap((name) => findConflicts(path.join(src, name), path.join(dst, name)));
}

function copyEntry(src, dst) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error('Agent content must contain ordinary files and directories: ' + src);
  }
  const target = fs.lstatSync(dst, { throwIfNoEntry: false });
  if (target && !(stat.isDirectory() && target.isDirectory())) {
    if (strategy === 'skip') return;
    if (strategy === 'fail') throw new Error('Target file already exists: ' + dst);
    if (strategy === 'backup') {
      fs.renameSync(dst, dst + '.bak.' + timestamp);
    } else if (strategy === 'overwrite') {
      fs.rmSync(dst, { recursive: true, force: true });
    }
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: stat.mode & 0o777 });
    for (const entry of fs.readdirSync(src)) {
      copyEntry(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, stat.mode & 0o777);
}

const sourceRoot = resolveSourceRoot(sourceDir);
const workspaceStat = fs.lstatSync(workspace, { throwIfNoEntry: false });
if (workspaceStat && !workspaceStat.isDirectory()) {
  throw new Error('WORKSPACE must be an ordinary directory: ' + workspace);
}
const conflicts = findConflicts(sourceRoot, workspace);
if (strategy === 'fail' && conflicts.length > 0) {
  throw new Error('Target file already exists: ' + conflicts.join(', '));
}
fs.mkdirSync(workspace, { recursive: true });
for (const entry of fs.readdirSync(sourceRoot)) {
  copyEntry(path.join(sourceRoot, entry), path.join(workspace, entry));
}
`;
