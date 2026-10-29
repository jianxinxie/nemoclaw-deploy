import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The internal IEMS bundle is supplied separately from the CLI repository.
const installerScripts = ['templates/install-and-up.sh'];
try {
  await fs.access(path.join(repo, 'iems/install.sh'));
  installerScripts.push('iems/install.sh');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function fixture(t, script, installed = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-install-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const nodeBin = path.join(root, 'node-bin');
  const nvm = path.join(root, 'nvm');
  await Promise.all([bin, nodeBin, nvm].map(dir => fs.mkdir(dir)));
  const fakeNode = version => `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '-v') { console.log('v${version}'); process.exit(0); }
if (args[0] !== '-e') process.exit(99);
Object.defineProperty(process.versions, 'node', { value: '${version}' });
process.argv = [process.execPath, ...args.slice(2)];
eval(args[1]);
`;
  await fs.writeFile(path.join(bin, 'node'), fakeNode('20.20.0'), { mode: 0o755 });
  await fs.writeFile(path.join(nodeBin, 'node'), fakeNode('22.23.0'), { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\ncase "$1" in -v|--version) echo 11.0.0; exit 0 ;; esac\nexit 99\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'nemoclaw-deploy'), `#!/bin/sh
if [ "$1" = --version ]; then echo 0.0.9; exit 0; fi
printf '%s\\n' "$*" >> "$TEST_ROOT/up-calls"
exit "\${TEST_UP_FAILURE:-0}"
`, { mode: 0o755 });
  await fs.copyFile(path.join(repo, 'test/fixtures/curl-installer.cjs'), path.join(bin, 'curl'));
  // This fixture needs the real Node runtime even while PATH points at an old one.
  const curl = await fs.readFile(path.join(bin, 'curl'), 'utf8');
  await fs.writeFile(path.join(bin, 'curl'), curl.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  await fs.chmod(path.join(bin, 'curl'), 0o755);
  await fs.writeFile(path.join(nvm, 'nvm.sh'), `
printf 'load %s\\n' "$*" >> "$TEST_ROOT/nvm-calls"
[ "\${1:-}" = --no-use ] || return 42
nvm() {
  printf '%s\\n' "$*" >> "$TEST_ROOT/nvm-calls"
  case "$1" in
    use)
      if [ -f "$TEST_ROOT/installed" ]; then
        # Simulate a broken default alias and an existing compatible Node 22.
        if [ "\${TEST_NVM_ONLY_NODE:-0}" = 1 ] && [ "\${*: -1}" != node ]; then return 3; fi
        export PATH="$TEST_NODE_BIN:$PATH"
        return 0
      fi
      return 3
      ;;
    install)
      if [ "\${TEST_NVM_INSTALL_FAILURE:-0}" = 1 ]; then
        printf "Version '%s' not found - try nvm ls-remote\\n" "$2" >&2
        return 3
      fi
      touch "$TEST_ROOT/installed"
      return 0
      ;;
    *) return 99 ;;
  esac
}


`);
  if (installed) await fs.writeFile(path.join(root, 'installed'), '');
  const config = path.join(root, 'onboard.yaml');
  await fs.writeFile(config, 'schemaVersion: 3\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root,
    TEST_NODE_BIN: nodeBin, NVM_DIR: nvm, NPM_PREFIX: path.join(root, 'prefix'), CONFIG: config,
    FORCE_CLI_INSTALL: '0', TEST_DOWNLOAD_FAILURE: '1' };
  for (const key of ['BASH_ENV', 'NODE_VERSION', 'REQUIRED_NODE_VERSION', 'TEST_NVM_INSTALL_FAILURE', 'TEST_UP_FAILURE']) delete env[key];
  const scriptPath = path.join(root, 'install.sh');
  await fs.copyFile(path.join(repo, script), scriptPath);
  // The fixtures exercise the common installer without shipping business binaries.
  if (script.startsWith('iems/')) await fs.writeFile(scriptPath, (await fs.readFile(scriptPath, 'utf8')).replace(/^BUNDLE_PLATFORM=linux-x64$/m, 'BUNDLE_PLATFORM=any'));
  const run = (args = [], overrides = {}) => spawnSync('bash', [scriptPath, ...args], {
    encoding: 'utf8', timeout: 15_000, env: { ...env, ...overrides }
  });
  const calls = () => fs.readFile(path.join(root, 'nvm-calls'), 'utf8').catch(() => '');
  const assertNoDownload = () => assert.rejects(fs.access(path.join(root, 'downloads.jsonl')), { code: 'ENOENT' });
  const prefix = path.join(root, 'prefix');
  const addBundle = async (content = 'fixture package') => {
    const packages = path.join(root, 'packages');
    await fs.mkdir(packages, { recursive: true });
    const filename = 'advantech-axa-nemoclaw-deploy-0.0.9.tgz';
    await fs.writeFile(path.join(packages, filename), content);
    const hash = createHash('sha256').update(content).digest('hex');
    await fs.writeFile(path.join(packages, 'SHA256SUMS'), hash + '  ' + filename + '\n');
    const npm = (await fs.readFile(path.join(repo, 'test/fixtures/npm-installer.cjs'), 'utf8'))
      .replace('#!/usr/bin/env node', `#!${process.execPath}`);
    await fs.writeFile(path.join(bin, 'npm'), npm, { mode: 0o755 });
    return hash;
  };
  const npmCalls = async () => (await fs.readFile(path.join(root, 'npm-calls.jsonl'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  return { root, bin, nodeBin, nvm, run, calls, assertNoDownload, scriptPath, prefix, addBundle, npmCalls, env };
}

test('an installation lock excludes concurrent execution before Node or npm preparation', async t => {
  const f = await fixture(t, 'templates/install-and-up.sh', false);
  await fs.mkdir(f.prefix);
  const holder = spawn('flock', [path.join(f.prefix, '.install.lock'), 'sh', '-c', 'echo ready; cat'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(holder.stdout, 'data');
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /另一个安装或部署进程/);
    assert.equal(await f.calls(), '');
    assert.deepEqual(await f.npmCalls(), []);
  } finally {
    const closed = once(holder, 'close');
    holder.stdin.end();
    await closed;
  }
});

test('prepare-only installs the bundled CLI and forwards dry-run to the deployment', async t => {
  const f = await fixture(t, 'templates/install-and-up.sh');
  await f.addBundle();
  const result = f.run(['--prepare-only']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await f.npmCalls()).length, 1);
  assert.match(await fs.readFile(path.join(f.root, 'up-calls'), 'utf8'), /--dry-run/);
});

test('interrupted npm installation removes staging and preserves the working CLI', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'templates/install-and-up.sh');
  await f.addBundle();
  assert.equal(f.run().status, 0);
  const selected = await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy'));
  const child = spawn('bash', [f.scriptPath], { detached: true,
    env: { ...f.env, FORCE_CLI_INSTALL: '1', TEST_NPM_WAIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    for await (const chunk of child.stdout) {
      if (chunk.toString().includes('npm-fixture-waiting')) break;
    }
    process.kill(-child.pid, 'SIGTERM');
    await closed;
    assert.equal(await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy')), selected);
    assert.equal((await fs.readdir(f.prefix)).filter(name => name.startsWith('.release.')).length, 1);
    assert.equal(f.run().status, 0);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
});

for (const script of installerScripts) {
  test(`${script}: reuses compatible Node on PATH without loading nvm`, async t => {
    const f = await fixture(t, script);
    const result = f.run([], { PATH: `${f.nodeBin}:${f.bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await f.calls(), '');
    await f.assertNoDownload();
  });

  test(`${script}: reuses installed nvm Node despite an old PATH and broken default alias`, async t => {
    const f = await fixture(t, script);
    const result = f.run([], { TEST_NVM_ONLY_NODE: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /v22\.23\.0/);
    assert.match(await f.calls(), /load --no-use/);
    assert.doesNotMatch(await f.calls(), /install /);
    await f.assertNoDownload();
  });

  test(`${script}: a retry after failed up reuses Node installed on the first run`, async t => {
    const f = await fixture(t, script, false);
    const first = f.run([], { TEST_UP_FAILURE: '23' });
    assert.equal(first.status, 23, first.stdout + first.stderr);
    const second = f.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal((await f.calls()).split('\n').filter(line => line.startsWith('install ')).join(), 'install 24');
    await f.assertNoDownload();
  });

  test(`${script}: explicit Node pin failures retain the error and explain mirror/network checks`, async t => {
    const f = await fixture(t, script, false);
    const result = f.run([], { NODE_VERSION: '24.22.1', TEST_NVM_INSTALL_FAILURE: '1',
      NVM_NODEJS_ORG_MIRROR: 'https://mirror.example.com/node' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Version '24\.22\.1' not found/);
    assert.match(result.stderr, /版本索引下载失败/);
    assert.match(result.stderr, /https:\/\/mirror\.example\.com\/node/);
    await assert.rejects(fs.access(path.join(f.root, 'up-calls')), { code: 'ENOENT' });
  });

  test(`${script}: dry-run can use local nvm Node but never installs a missing runtime`, async t => {
    const f = await fixture(t, script);
    const cached = f.run(['--dry-run']);
    assert.equal(cached.status, 0, cached.stdout + cached.stderr);
    await fs.rm(path.join(f.root, 'installed'));
    const missing = f.run(['--dry-run']);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /dry-run 需要预先安装 Node.js/);
    assert.doesNotMatch(await f.calls(), /install /);
    await f.assertNoDownload();
  });

  test(`${script}: partial nvm download is not executed and the temporary script is removed`, async t => {
    const f = await fixture(t, script, false);
    await fs.rm(path.join(f.nvm, 'nvm.sh'));
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /nvm 安装器下载失败/);
    assert.match(result.stderr, /SSL_ERROR_SYSCALL/);
    const args = JSON.parse((await fs.readFile(path.join(f.root, 'downloads.jsonl'), 'utf8')).trim());
    assert(args.includes('--retry-all-errors'));
    await assert.rejects(fs.access(args[args.indexOf('-o') + 1]), { code: 'ENOENT' });
    assert.equal(await f.calls(), '');
  });

  test(`${script}: help and invalid arguments do not prepare the environment`, async t => {
    const f = await fixture(t, script, false);
    await fs.rm(path.join(f.root, 'onboard.yaml'));
    assert.equal(f.run(['--help']).status, 0);
    const bad = f.run(['--non-interactiv']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /不支持的参数/);
    assert.equal(await f.calls(), '');
    await assert.rejects(fs.access(f.prefix), { code: 'ENOENT' });
  });

  test(`${script}: --config selects the checked and deployed file, including spaces`, async t => {
    const f = await fixture(t, script);
    const config = path.join(f.root, 'custom config.yaml');
    await fs.rename(path.join(f.root, 'onboard.yaml'), config);
    const result = f.run(['--config', config]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = await fs.readFile(path.join(f.root, 'up-calls'), 'utf8');
    assert.match(calls, /custom config.yaml/);
    assert.equal(calls.match(/--config/g).length, 1);
  });

  test(`${script}: corrupt bundled package fails before Node preparation or npm`, async t => {
    const f = await fixture(t, script, false);
    await f.addBundle();
    await fs.appendFile(path.join(f.root, 'packages/advantech-axa-nemoclaw-deploy-0.0.9.tgz'), 'corrupt');
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /SHA256 校验失败/);
    assert.equal(await f.calls(), '');
    assert.deepEqual(await f.npmCalls(), []);
    await assert.rejects(fs.access(f.prefix), { code: 'ENOENT' });
  });

  test(`${script}: bundled content takes precedence over an old same-version CLI and caches by hash`, async t => {
    const f = await fixture(t, script);
    const firstHash = await f.addBundle();
    const first = f.run([], { NPM_OFFLINE: '1' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    await fs.access(path.join(f.root, 'used-bundled-cli'));
    assert.equal(f.run().status, 0);
    assert.equal((await f.npmCalls()).length, 1);
    assert((await f.npmCalls())[0].includes('--offline'));
    const secondHash = await f.addBundle('updated same-version package');
    assert.notEqual(firstHash, secondHash);
    const updated = f.run();
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal((await f.npmCalls()).length, 2);
    for (const hash of [firstHash, secondHash]) await fs.access(path.join(f.prefix, 'releases', hash, 'bin/nemoclaw-deploy'));
    const cached = f.run(['--dry-run']);
    assert.equal(cached.status, 0, cached.stdout + cached.stderr);
    assert.equal((await f.npmCalls()).length, 2);
  });

  test(`${script}: failed npm installation preserves the selected CLI and removes staging`, async t => {
    const f = await fixture(t, script);
    await f.addBundle();
    assert.equal(f.run().status, 0);
    const selected = await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy'));
    const failed = f.run([], { FORCE_CLI_INSTALL: '1', TEST_NPM_INSTALL_FAILURE: '1' });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /exitCode: 23/);
    assert.equal(await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy')), selected);
    const releases = (await fs.readdir(f.prefix)).filter(name => name.startsWith('.release.'));
    assert.equal(releases.length, 1, 'only the previous successful release remains');
    assert.equal(f.run().status, 0);
  });

  test(`${script}: an unsupported staged CLI never replaces the working one`, async t => {
    const f = await fixture(t, script);
    await f.addBundle();
    assert.equal(f.run().status, 0);
    const selected = await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy'));
    const failed = f.run([], { FORCE_CLI_INSTALL: '1', TEST_NPM_CLI_VERSION: '0.0.8' });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /新 CLI 版本检查失败/);
    assert.equal(await fs.readlink(path.join(f.prefix, 'bin/nemoclaw-deploy')), selected);
  });
}
