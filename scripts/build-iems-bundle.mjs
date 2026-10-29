import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../dist/utils/run.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const root = path.join(repo, 'iems');
const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
const archiveName = 'iems-install-' + metadata.version + '.zip';
const excluded = new Set(['.nemoclaw-deploy', 'node_modules', '.git', '.cache', '__pycache__', '.DS_Store']);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const staging = await fs.mkdtemp(path.join(repo, '.tmp-iems-bundle-'));
const excludedPackageFiles = new Set();

async function walk(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || (!relative && entry.name === 'SHA256SUMS')) continue;
    const name = path.posix.join(relative, entry.name);
    if (excludedPackageFiles.has(name)) continue;
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('安装包不接受符号链接或特殊文件: ' + name);
  }
  return files.sort();
}

async function replaceFile(source, target, mode = 0o600) {
  const temp = target + '.new-' + randomUUID();
  try {
    await fs.copyFile(source, temp);
    await fs.chmod(temp, mode);
    await fs.rename(temp, target);
  } finally { await fs.rm(temp, { force: true }); }
}

try {
  for (const file of ['onboard.yaml', 'openclaw.json', 'ienergy-query']) {
    const stat = await fs.stat(path.join(root, file));
    if (!stat.isFile() || !stat.size) throw new Error('IEMS 必需文件缺失或为空: ' + file);
  }
  const template = await fs.readFile(path.join(repo, 'templates/install-and-up.sh'), 'utf8');
  if (!/^BUNDLE_PLATFORM=any$/m.test(template)) throw new Error('安装模板缺少平台标记');
  const installer = template.replace(/^BUNDLE_PLATFORM=any$/m, 'BUNDLE_PLATFORM=linux-x64')
    .replace(/^MIN_DEPLOY_CLI_VERSION=".*"$/m, 'MIN_DEPLOY_CLI_VERSION="' + metadata.version + '"')
    .replace(/^PACKAGE_VERSION=.*$/m, 'PACKAGE_VERSION="${PACKAGE_VERSION:-' + metadata.version + '}"');
  await fs.writeFile(path.join(root, 'install.sh'), installer);
  await fs.chmod(path.join(root, 'install.sh'), 0o755);
  const packageRoot = path.join(staging, 'package');
  await fs.mkdir(packageRoot);
  for (const file of metadata.files) {
    await fs.cp(path.join(repo, file), path.join(packageRoot, file), { recursive: true });
  }
  const lock = JSON.parse(await fs.readFile(path.join(repo, 'package-lock.json'), 'utf8'));
  const lockedRoot = lock.packages?.[''];
  if (lockedRoot?.version !== metadata.version ||
      JSON.stringify(lockedRoot.dependencies) !== JSON.stringify(metadata.dependencies)) {
    throw new Error('package-lock.json 与 package.json 不一致，请先运行 npm install 更新锁文件');
  }
  const bundleMetadata = { ...metadata, files: [...metadata.files, 'npm-shrinkwrap.json'],
    bundleDependencies: Object.keys(metadata.dependencies) };
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(bundleMetadata, null, 2) + '\n');
  // Only the internal IEMS tarball gets a shrinkwrap; keep the repository lock unchanged.
  await fs.writeFile(path.join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock, null, 2) + '\n');
  console.log('准备锁定的生产依赖，供目标主机随包安装...');
  const dependencyArgs = ['ci', '--prefix', packageRoot, '--omit=dev', '--ignore-scripts',
    '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=2', '--fetch-timeout=60000',
    '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000'];
  if (process.env.NPM_OFFLINE === '1') dependencyArgs.push('--offline');
  await runCommand('npm', dependencyArgs, { logCommand: false });
  const packed = await runCommand('npm', ['pack', packageRoot, '--ignore-scripts', '--pack-destination', staging, '--json'], { logCommand: false });
  const info = JSON.parse(packed.stdout)[0];
  if (!info.files.some(file => file.path === 'npm-shrinkwrap.json')) throw new Error('npm 包缺少生产依赖锁');
  if (!info.files.some(file => file.path.startsWith('node_modules/'))) throw new Error('npm 包缺少随包生产依赖');
  if (info.files.some(file => file.path.startsWith('iems/'))) throw new Error('npm 包意外包含 IEMS 私有部署内容');
  const packages = path.join(root, 'packages');
  await fs.mkdir(packages, { recursive: true });
  const packagePath = path.join(packages, info.filename);
  await replaceFile(path.join(staging, info.filename), packagePath, 0o644);
  // Keep older local packages available without shipping them in this release.
  for (const name of await fs.readdir(packages)) {
    if (name.endsWith('.tgz') && name !== info.filename) excludedPackageFiles.add('packages/' + name);
  }
  await fs.writeFile(path.join(packages, 'SHA256SUMS'), hash(await fs.readFile(packagePath)) + '  ' + info.filename + '\n');
  const sums = [];
  for (const file of await walk(root)) {
    sums.push(hash(await fs.readFile(path.join(root, file))) + '  ./' + file);
  }
  await fs.writeFile(path.join(root, 'SHA256SUMS'), sums.join('\n') + '\n');
  const stagedArchive = path.join(staging, archiveName);
  await runCommand('zip', ['-q', '-r', '-X', stagedArchive, 'iems', '-x',
    ...Array.from(excluded, name => '*/' + name + '/*'), '*/.DS_Store',
    ...Array.from(excludedPackageFiles, name => 'iems/' + name)], { logCommand: false });
  const extracted = path.join(staging, 'check');
  await fs.mkdir(extracted);
  await runCommand('unzip', ['-q', stagedArchive, '-d', extracted], { logCommand: false });
  const unpacked = path.join(extracted, 'iems');
  const entries = (await fs.readFile(path.join(unpacked, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const entry of entries) {
    const expected = entry.slice(0, 64);
    const file = entry.slice(66);
    if (hash(await fs.readFile(path.join(unpacked, file))) !== expected) throw new Error('压缩包校验失败: ' + file);
  }
  for (const name of excluded) {
    try { await fs.access(path.join(unpacked, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('压缩包包含运行时缓存: ' + name);
  }
  const destination = path.join(repo, archiveName);
  await replaceFile(stagedArchive, destination);
  const checksum = path.join(staging, archiveName + '.sha256');
  await fs.writeFile(checksum, hash(await fs.readFile(destination)) + '  ' + archiveName + '\n');
  await replaceFile(checksum, destination + '.sha256');
  console.log('已生成 ' + archiveName + '，解压校验 ' + entries.length + ' 个文件；运行时缓存已排除。');
} finally { await fs.rm(staging, { recursive: true, force: true }); }
