import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { NEMOCLAW_VERSION, MIN_NEMOCLAW_VERSION } from '../dist/utils/versions.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repo, 'bin/nemoclaw-deploy.js');

async function fixture(t, installedVersion = 'nemoclaw v0.0.134') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-bootstrap-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  // The executable resolver also searches ~/.local/bin. Keep both that fallback
  // and PATH isolated so failed-version tests cannot invoke a real host CLI.
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.symlink('/bin/bash', path.join(bin, 'bash'));
  await fs.copyFile(path.join(repo, 'test/fixtures/nemoclaw.cjs'), path.join(bin, 'nemoclaw'));
  await fs.chmod(path.join(bin, 'nemoclaw'), 0o755);
  await fs.writeFile(path.join(root, 'nemoclaw-version'), installedVersion);
  await fs.copyFile(path.join(repo, 'test/fixtures/curl-installer.cjs'), path.join(bin, 'curl'));
  await fs.chmod(path.join(bin, 'curl'), 0o755);
  const config = { schemaVersion: 3, install: {}, onboard: { sandbox: { name: 'demo' },
    inference: { provider: 'custom', endpointUrl: 'https://api.example.com/v1', apiKey: 'fixture-api-key' },
    options: { acceptThirdPartySoftware: true } }, deploy: {} };
  const configPath = path.join(root, 'onboard.yaml');
  const write = () => fs.writeFile(configPath, stringify(config));
  await write();
  const run = (args = [], env = {}, command = 'bootstrap') => spawnSync(process.execPath,
    [cli, command, '--config', configPath, '--non-interactive', ...args],
    { encoding: 'utf8', timeout: 20_000, env: { ...process.env, HOME: home, PATH: bin,
      NEMOCLAW_DASHBOARD_BIND: '', TEST_ROOT: root,
      TEST_INSTALLER_SCRIPT: path.join(repo, 'test/fixtures/nemoclaw-installer.cjs'), ...env } });
  const installed = async () => JSON.parse(await fs.readFile(path.join(root, 'installer.json'), 'utf8'));
  return { root, config, write, run, installed };
}

test('bootstrap upgrades to v0.0.139 and overrides an inherited installer ref with the YAML target', async (t) => {
  const f = await fixture(t);
  const result = f.run([], { NEMOCLAW_INSTALL_REF: 'v0.0.55' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(await f.installed(), { NEMOCLAW_INSTALL_TAG: NEMOCLAW_VERSION,
    NEMOCLAW_INSTALL_REF: NEMOCLAW_VERSION, NEMOCLAW_SANDBOX_NAME: 'demo', NEMOCLAW_NON_INTERACTIVE: '1' });
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-api-key/);
});

test('an explicit v0.0.134 pin remains supported without reinstalling', async (t) => {
  const f = await fixture(t);
  f.config.install.version = MIN_NEMOCLAW_VERSION;
  await f.write();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(f.installed(), { code: 'ENOENT' });
});

test('an installed newer CLI is reused without downgrading', async (t) => {
  const f = await fixture(t, 'nemoclaw v0.0.140');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(f.installed(), { code: 'ENOENT' });
});

test('bootstrap rejects an old or unreadable version after the installer exits successfully', async (t) => {
  for (const [version, message] of [['nemoclaw v0.0.134', /版本仍过低/], ['unrecognized', /无法读取版本/]]) {
    await t.test(version, async (t) => {
      const f = await fixture(t);
      const result = f.run([], { TEST_INSTALL_VERSION: version });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, message);
      assert.doesNotMatch(result.stdout, /Bootstrap 完成/);
    });
  }
});

test('bootstrap retains installer failure and does not report success', async (t) => {
  const f = await fixture(t);
  const result = f.run([], { TEST_INSTALL_FAILURE: '1' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /exitCode: 23/);
  assert.match(result.stderr, /release-assets\.githubusercontent\.com/);
  assert.doesNotMatch(result.stdout, /Bootstrap 完成/);
  const downloads = (await fs.readFile(path.join(f.root, 'downloads.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(downloads.length, 1, 'do not rerun the installer after a partial installation');
  const args = JSON.parse(downloads[0]);
  await assert.rejects(fs.access(path.dirname(args[args.indexOf('-o') + 1])), { code: 'ENOENT' });
});

test('a failed or partial installer download is never executed and is cleaned up', async (t) => {
  const f = await fixture(t);
  const result = f.run([], { TEST_DOWNLOAD_FAILURE: '1' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /未执行安装脚本/);
  assert.match(result.stderr, /exitCode: 35/);
  assert.match(result.stderr, /SSL_ERROR_SYSCALL/);
  await assert.rejects(f.installed(), { code: 'ENOENT' });
  const args = JSON.parse((await fs.readFile(path.join(f.root, 'downloads.jsonl'), 'utf8')).trim());
  assert(args.includes('--retry-all-errors'));
  assert.equal(args[args.indexOf('--retry') + 1], '3');
  await assert.rejects(fs.access(path.dirname(args[args.indexOf('-o') + 1])), { code: 'ENOENT' });
});

test('bootstrap dry-run shows the v0.0.139 pin without executing the installer or CLI', async (t) => {
  const f = await fixture(t);
  const result = f.run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NEMOCLAW_INSTALL_REF=v0\.0\.139/);
  await assert.rejects(f.installed(), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' });
});

test('conflicting GPU flags are rejected before running the installer or CLI', async (t) => {
  for (const [host, sandbox] of [['enabled', 'disabled'], ['disabled', 'enabled']]) {
    const f = await fixture(t);
    f.config.onboard.gpu = { host, sandbox };
    await f.write();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /GPU 参数/);
    await assert.rejects(f.installed(), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' });
  }
});

test('init-config generates the current supported installation target', () => {
  const result = spawnSync(process.execPath, [cli, 'init-config'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parse(result.stdout).install.version, NEMOCLAW_VERSION);
  assert.equal(parse(result.stdout).onboard.services.dashboardRemoteAccess, false);
});

test('installer and subsequent host checks receive the enabled dashboard bind', async t => {
  const f = await fixture(t);
  f.config.onboard.services = { dashboardRemoteAccess: true };
  await f.write();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'installer-dashboard-bind.json'), 'utf8')), '0.0.0.0');
  const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(calls.length > 0);
  assert(calls.every(call => call.dashboardBind === '0.0.0.0'));
  assert.match(result.stdout, /NEMOCLAW_DASHBOARD_BIND=0\.0\.0\.0 nemoclaw demo connect/);
});

test('explicit onboard modes pass the bind and preserve the selected lifecycle flags', async t => {
  for (const mode of ['ensure', 'resume', 'fresh', 'recreate']) {
    await t.test(mode, async t => {
      const f = await fixture(t, `nemoclaw ${NEMOCLAW_VERSION}`);
      f.config.onboard.mode = mode;
      f.config.onboard.services = { dashboardRemoteAccess: true, dashboardPort: 19000 };
      await f.write();
      const result = f.run([], { TEST_REQUIRE_ONBOARD: '1' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const onboard = calls.find(call => call.args[0] === 'onboard');
      assert(onboard);
      assert.equal(onboard.dashboardBind, '0.0.0.0');
      assert.equal(onboard.args.includes('--recreate-sandbox'), mode === 'recreate');
      assert.equal(onboard.args.includes('--resume'), mode === 'resume');
      assert(calls.every(call => call.dashboardBind === '0.0.0.0'));
    });
  }
});

test('explicit false clears legacy and inherited remote-bind opt-ins for installation', async t => {
  const f = await fixture(t);
  f.config.onboard.services = { dashboardRemoteAccess: false };
  f.config.onboard.environment = { NEMOCLAW_DASHBOARD_BIND: '0.0.0.0' };
  await f.write();
  const result = f.run([], { NEMOCLAW_DASHBOARD_BIND: '0.0.0.0' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'installer-dashboard-bind.json'), 'utf8')), '');
  const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(calls.every(call => call.dashboardBind === ''));
});

test('an upgrade never skips an explicitly requested sandbox recreation', async t => {
  const f = await fixture(t);
  f.config.onboard.mode = 'recreate';
  f.config.onboard.services = { dashboardRemoteAccess: true };
  await f.write();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await f.installed();
  const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const onboard = calls.filter(call => call.args[0] === 'onboard');
  assert.equal(onboard.length, 1);
  assert(onboard[0].args.includes('--recreate-sandbox'));
  assert.equal(onboard[0].dashboardBind, '0.0.0.0');
});

test('invalid dashboard settings fail before installation or external commands', async t => {
  for (const onboard of [{ services: { dashboardRemoteAccess: 'true' } },
    { environment: { NEMOCLAW_DASHBOARD_BIND: '127.0.0.1' } }]) {
    const f = await fixture(t);
    Object.assign(f.config.onboard, onboard);
    await f.write();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /dashboardRemoteAccess|NEMOCLAW_DASHBOARD_BIND/);
    await assert.rejects(f.installed(), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' });
  }
});

test('enabled dashboard dry-run has no effects; ensure never automatically recreates a ready sandbox', async t => {
  const f = await fixture(t, `nemoclaw ${NEMOCLAW_VERSION}`);
  f.config.onboard.services = { dashboardRemoteAccess: true };
  await f.write();
  const preview = f.run(['--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /NEMOCLAW_DASHBOARD_BIND=0\.0\.0\.0/);
  await assert.rejects(fs.access(path.join(f.root, 'calls.jsonl')), { code: 'ENOENT' });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /ensure 不会改变已有 sandbox/);
  const calls = (await fs.readFile(path.join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(!calls.some(args => args[0] === 'onboard'));
});

test('an unreadable existing NemoClaw installation is repaired when installation is enabled', async t => {
  const f = await fixture(t, 'unrecognized');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /repair required/);
  await f.installed();
});

test('a local NVIDIA installer is copied, verified and executed without network downloads', async t => {
  const f = await fixture(t);
  const installer = path.join(f.root, 'local installer.sh');
  const content = 'node "$TEST_INSTALLER_SCRIPT"\n';
  await fs.writeFile(installer, content);
  const result = f.run([], { NEMOCLAW_INSTALLER_FILE: installer,
    NEMOCLAW_INSTALLER_SHA256: createHash('sha256').update(content).digest('hex') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await f.installed();
  await assert.rejects(fs.access(path.join(f.root, 'downloads.jsonl')), { code: 'ENOENT' });
});

test('empty, invalid or checksum-mismatched installers are rejected before execution', async t => {
  for (const [content, env, message] of [['', {}, /安装器为空/], ['if then', {}, /exitCode: 2/],
    ['node "$TEST_INSTALLER_SCRIPT"\n', { NEMOCLAW_INSTALLER_SHA256: '0'.repeat(64) }, /SHA256 校验失败/]]) {
    const f = await fixture(t);
    const result = f.run([], { TEST_DOWNLOAD_CONTENT: content, ...env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /未执行安装脚本/);
    await assert.rejects(f.installed(), { code: 'ENOENT' });
  }
});

test('up selects the freshly installed CLI over a stale executable earlier on PATH', async t => {
  const f = await fixture(t);
  f.config.onboard.services = { dashboardRemoteAccess: true };
  const home = path.join(f.root, 'home');
  const localBin = path.join(home, '.local/bin');
  await fs.mkdir(localBin, { recursive: true });
  await fs.writeFile(path.join(f.root, 'bin/nemoclaw'), '#!/bin/sh\nif [ "$1" = --version ]; then echo "nemoclaw v0.0.134"; exit 0; fi\necho "stale CLI called" >&2\nexit 79\n');
  await fs.writeFile(path.join(f.root, 'openclaw.json'), '{}');
  f.config.deploy = { shared: { plugins: { enabled: false }, openclawConfig: { enabled: false },
    channelServer: { enabled: false }, networkPolicy: { enabled: false }, options: { restartGateway: false } },
    agents: [{ name: 'alpha', workspace: path.join(f.root, 'workspace'), agentContent: { enabled: false },
      env: { enabled: false }, sandbox: { uploads: { enabled: false }, commands: { enabled: false } },
      channelRegistration: { enabled: false } }] };
  await f.write();
  const result = f.run([], { HOME: home, PATH: `${path.join(f.root, 'bin')}:${localBin}`,
    TEST_INSTALL_NEW_CLI: path.join(repo, 'test/fixtures/nemoclaw.cjs') }, 'up');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /stale CLI called/);
  assert.match(result.stdout, /部署完成/);
  const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(calls.some(call => call.args[1] === 'agents'));
  assert(calls.every(call => call.dashboardBind === '0.0.0.0'));
});
