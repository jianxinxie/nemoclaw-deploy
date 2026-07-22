import path from 'node:path';
import fs from 'fs-extra';
import type { DeployContext, SandboxUploadConfig } from './context.js';
import { remoteTempBase } from './upload-agent-content.js';
import { withTrailingSlash } from '../utils/fs.js';
import { runCommand } from '../utils/run.js';
import { nodeEvalScript } from '../utils/script.js';
import { validateHostFileOrDirectory } from '../utils/validators.js';

export interface CopyFilesResult {
  status: 'skipped' | 'uploaded';
  count: number;
}

export async function uploadSandboxFiles(ctx: DeployContext): Promise<CopyFilesResult> {
  if (!ctx.sandbox.uploads.enabled) return { status: 'skipped', count: 0 };
  if (ctx.sandbox.uploads.items.length === 0) {
    throw new Error('sandbox.uploads.enabled=true 时，sandbox.uploads.items 至少需要一项');
  }

  for (const [index, item] of ctx.sandbox.uploads.items.entries()) {
    item.source = await validateHostFileOrDirectory(item.source);
    const stat = await fs.stat(item.source);
    if (stat.isDirectory()) {
      await copyOneDirectory(ctx, item, index);
    } else {
      await copyOneFile(ctx, item);
    }
  }

  return { status: 'uploaded', count: ctx.sandbox.uploads.items.length };
}

async function copyOneFile(ctx: DeployContext, item: SandboxUploadConfig): Promise<void> {
  const destinationKind = await remotePathKind(ctx, item.destination);
  if (!item.overwrite && destinationKind !== 'missing') {
    throw new Error(
      `sandbox 目标文件已存在，且 overwrite=false: ${item.destination}`
    );
  }

  if (item.overwrite && destinationKind === 'directory') {
    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'rm', '-rf', item.destination], {
      dryRun: ctx.options.dryRun,
      description: `目标是目录，覆盖前移除 sandbox 路径: ${item.destination}`
    });
  }

  const parentDir = path.posix.dirname(item.destination);
  if (parentDir !== '/') {
    await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', parentDir], {
      dryRun: ctx.options.dryRun,
      description: `创建 sandbox 目标目录 ${parentDir}`
    });
  }

  await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'upload', item.source, item.destination],
    {
      dryRun: ctx.options.dryRun,
      description: `复制主机文件到 sandbox: ${item.source} -> ${item.destination}`
    }
  );

  await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'test', '-f', item.destination], {
    dryRun: ctx.options.dryRun,
    timeoutMs: 30_000,
    description: `确认 sandbox 文件已写入: ${item.destination}`
  });
}

async function copyOneDirectory(
  ctx: DeployContext,
  item: SandboxUploadConfig,
  index: number
): Promise<void> {
  const remoteSourceDir = `${remoteTempBase(ctx)}/sandbox-uploads/${index}-${process.pid}/source`;
  const sourceBasename = path.basename(item.source);

  await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'mkdir', '-p', remoteSourceDir], {
    dryRun: ctx.options.dryRun,
    description: `创建 sandbox 临时目录，用于暂存主机目录 ${item.source}`
  });
  await runCommand(
    'nemoclaw',
    [ctx.sandboxName, 'upload', withTrailingSlash(item.source), `${remoteSourceDir}/`],
    {
      dryRun: ctx.options.dryRun,
      description: `上传主机目录到 sandbox 临时目录: ${item.source}`
    }
  );
  await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `SOURCE_DIR=${remoteSourceDir}`,
      `SOURCE_BASENAME=${sourceBasename}`,
      `DESTINATION=${item.destination}`,
      `OVERWRITE=${String(item.overwrite)}`,
      'node',
      '-e',
      nodeEvalScript(MERGE_DIRECTORY_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 120_000,
      description: `${item.overwrite ? '合并并覆盖冲突项' : '无冲突合并'}主机目录到 sandbox: ${item.source} -> ${item.destination}`,
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env SOURCE_DIR=${remoteSourceDir} SOURCE_BASENAME=${sourceBasename} DESTINATION=${item.destination} OVERWRITE=${String(item.overwrite)} node -e <merge-directory>`
    }
  );
  await runCommand('nemoclaw', [ctx.sandboxName, 'exec', '--', 'test', '-d', item.destination], {
    dryRun: ctx.options.dryRun,
    timeoutMs: 30_000,
    description: `确认 sandbox 目录已写入: ${item.destination}`
  });
}

type RemotePathKind = 'missing' | 'file' | 'directory' | 'other';

async function remotePathKind(
  ctx: DeployContext,
  destination: string
): Promise<RemotePathKind> {
  const result = await runCommand(
    'nemoclaw',
    [
      ctx.sandboxName,
      'exec',
      '--',
      'env',
      `DESTINATION=${destination}`,
      'node',
      '-e',
      nodeEvalScript(CHECK_PATH_KIND_SCRIPT)
    ],
    {
      dryRun: ctx.options.dryRun,
      timeoutMs: 30_000,
      description: `检查 sandbox 目标路径类型: ${destination}`,
      displayCommand: `nemoclaw ${ctx.sandboxName} exec -- env DESTINATION=${destination} node -e <check-path-kind>`
    }
  );
  const kind = result.stdout.trim();
  if (kind === 'file' || kind === 'directory' || kind === 'other') return kind;
  return 'missing';
}

const CHECK_PATH_KIND_SCRIPT = `
const fs = require('node:fs');
const destination = process.env.DESTINATION;
if (!destination) throw new Error('DESTINATION is required');
if (!fs.existsSync(destination)) process.stdout.write('missing');
else if (fs.statSync(destination).isFile()) process.stdout.write('file');
else if (fs.statSync(destination).isDirectory()) process.stdout.write('directory');
else process.stdout.write('other');
`;

const MERGE_DIRECTORY_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');

const sourceDir = process.env.SOURCE_DIR;
const sourceBasename = process.env.SOURCE_BASENAME;
const destination = process.env.DESTINATION;
const overwrite = process.env.OVERWRITE === 'true';

if (!sourceDir) throw new Error('SOURCE_DIR is required');
if (!destination) throw new Error('DESTINATION is required');
if (!fs.existsSync(sourceDir)) throw new Error('SOURCE_DIR does not exist: ' + sourceDir);

function resolveSourceRoot(dir) {
  if (!sourceBasename) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1) return dir;
  const only = entries[0];
  return only.isDirectory() && only.name === sourceBasename
    ? path.join(dir, only.name)
    : dir;
}

function kind(value) {
  if (!fs.existsSync(value)) return 'missing';
  const stat = fs.statSync(value);
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

function findConflicts(src, dst, relative = '') {
  const conflicts = [];
  const sourceKind = kind(src);
  const targetKind = kind(dst);
  if (sourceKind === 'directory') {
    if (targetKind !== 'missing' && targetKind !== 'directory') {
      conflicts.push(relative || '.');
      return conflicts;
    }
    for (const entry of fs.readdirSync(src)) {
      conflicts.push(...findConflicts(
        path.join(src, entry),
        path.join(dst, entry),
        path.join(relative, entry)
      ));
    }
    return conflicts;
  }
  if (targetKind !== 'missing') conflicts.push(relative || '.');
  return conflicts;
}

function copyEntry(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (fs.existsSync(dst) && !fs.statSync(dst).isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(dst, { recursive: true, mode: stat.mode & 0o777 });
    }
    for (const entry of fs.readdirSync(src)) {
      copyEntry(path.join(src, entry), path.join(dst, entry));
    }
    return;
  }

  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, stat.mode & 0o777);
}

const sourceRoot = resolveSourceRoot(sourceDir);
if (!overwrite) {
  const conflicts = findConflicts(sourceRoot, destination);
  if (conflicts.length > 0) {
    throw new Error('Directory copy conflicts: ' + conflicts.join(', '));
  }
}
copyEntry(sourceRoot, destination);
`;
