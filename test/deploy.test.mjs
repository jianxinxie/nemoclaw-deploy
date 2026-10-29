import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { collectWorkspaceSkills } from '../dist/core/workspace-skills.js';
import { assertSandboxRunning } from '../dist/core/runtime.js';
import { assertMinimumVersion, assertOpenClawNodeVersion, DEFAULT_NODE_VERSION, NEMOCLAW_VERSION } from '../dist/utils/versions.js';
import { runCommand } from '../dist/utils/run.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repo, 'bin/nemoclaw-deploy.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-deploy-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'));
  const executable = path.join(root, 'bin/nemoclaw');
  await fs.copyFile(path.join(repo, 'test/fixtures/nemoclaw.cjs'), executable);
  await fs.chmod(executable, 0o755);
  await fs.writeFile(path.join(root, 'openclaw.json'), '{}');
  const agents = [];
  for (const name of ['alpha', 'beta']) {
    const content = path.join(root, 'content', name);
    await fs.mkdir(path.join(content, 'skills/demo'), { recursive: true });
    await fs.writeFile(path.join(content, 'SOUL.md'), `${name} original`);
    await fs.writeFile(path.join(content, 'skills/demo/SKILL.md'), `---\nname: demo\ndescription: Skill for ${name}\n---\n${name}\n`);
    agents.push({ name, workspace: path.join(root, 'workspaces', name),
      agentContent: { enabled: true, hostDir: content }, env: { enabled: false },
      sandbox: { uploads: { enabled: false }, commands: { enabled: false } },
      channelRegistration: { enabled: false } });
  }
  const policies = path.join(root, 'policies');
  await fs.mkdir(policies);
  for (const [name, host] of [['private', '192.168.0.165'], ['public', 'api.example.com']]) {
    await fs.writeFile(path.join(policies, `${name}.yaml`), stringify({ preset: { name }, network_policies: {
      [name]: { endpoints: [{ host, port: 443, protocol: 'rest' }] }
    } }));
  }
  const config = { schemaVersion: 3, install: { version: NEMOCLAW_VERSION },
    onboard: { sandbox: { name: 'demo' } }, deploy: { shared: {
      plugins: { enabled: false }, openclawConfig: { enabled: false }, channelServer: { enabled: false },
      networkPolicy: { enabled: true, dir: policies, trustedPrivateHosts: ['192.168.0.165'] },
      options: { restartGateway: true }
    }, agents } };
  const configPath = path.join(root, 'onboard.yaml');
  const write = () => fs.writeFile(configPath, stringify(config));
  await write();
  const env = { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    NEMOCLAW_DASHBOARD_BIND: '', TEST_ROOT: root };
  const run = (extra = [], overrides = {}) => spawnSync(process.execPath,
    [cli, 'deploy', '--config', configPath, '--non-interactive', ...extra],
    { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60_000 });
  const calls = async () => (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8').catch(() => '')).trim()
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, config, configPath, write, env, run, calls };
}

test('runtime boundaries accept Ready, require full Node version and reject old/prerelease runtimes', () => {
  assert.equal(assertMinimumVersion('v22.19.0', '22.19.0', 'Node'), '22.19.0');
  assert.equal(assertMinimumVersion('nemoclaw v0.0.135', 'v0.0.134', 'NemoClaw'), '0.0.135');
  for (const version of ['20.20.0', '22.18.99', '22.19.0-rc.1', 'unknown']) {
    assert.throws(() => assertMinimumVersion(version, '22.19.0', 'Node'));
  }
  assertSandboxRunning('{"found":true,"phase":"Ready","gatewayState":"present"}');
  assert.throws(() => assertSandboxRunning('{"found":true,"phase":"Stopped","gatewayState":"missing"}'), /尚未运行/);
});

test('OpenClaw Node requirements enforce each supported major and patch boundary', () => {
  for (const version of ['22.22.3', '22.23.0', '24.15.0', '24.18.1', '25.9.0', '26.0.0']) {
    assert.equal(assertOpenClawNodeVersion(`v${version}`), version);
  }
  for (const version of ['22.19.0', '22.22.2', '23.0.0', '23.99.99', '24.14.99', '25.8.99', '24.18.1-rc.1']) {
    assert.throws(() => assertOpenClawNodeVersion(`v${version}`), /sandbox Node.js 版本不满足/);
  }
});

test('npm installation guard rejects unsupported host Node before CLI use', async () => {
  for (const version of ['20.20.0', '22.18.99', '22.19.0-rc.1', '24.18.1-rc.1', '22.19.0', '24.18.1']) {
    const script = `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); require('./bin/check-node-version.cjs');`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: repo, encoding: 'utf8' });
    const supported = ['22.19.0', '24.18.1'].includes(version);
    assert.equal(result.status, supported ? 0 : 1, version);
    if (!supported) assert.match(result.stderr, /不满足安装要求 >=22.19.0/);
  }
  for (const file of ['templates/install-and-up.sh', 'iems/install.sh']) {
    const content = await fs.readFile(path.join(repo, file), 'utf8').catch(error => {
      if (file.startsWith('iems/') && error.code === 'ENOENT') return null;
      throw error;
    });
    if (content !== null) assert(content.includes('NODE_VERSION="${NODE_VERSION:-' + DEFAULT_NODE_VERSION + '}"'));
  }
});

test('two agents receive isolated workspace skills; new policy command batches private/public files', async (t) => {
  const f = await fixture(t);
  const originalPolicies = await Promise.all((await fs.readdir(f.config.deploy.shared.networkPolicy.dir)).sort()
    .map(name => fs.readFile(path.join(f.config.deploy.shared.networkPolicy.dir, name), 'utf8')));
  const result = f.run([], { TEST_NEST_UPLOAD: '1' });
  assert.equal(result.status, 0, result.stderr);
  for (const agent of f.config.deploy.agents) {
    const content = await fs.readFile(path.join(agent.workspace, 'skills/demo/SKILL.md'), 'utf8');
    assert.match(content, new RegExp(`Skill for ${agent.name}`));
  }
  const calls = await f.calls();
  const policies = calls.filter((args) => args[1] === 'policy');
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].slice(1), ['policy', 'add', '--from-dir', f.config.deploy.shared.networkPolicy.dir,
    '--trusted-private-host', '192.168.0.165', '--yes']);
  const policyIndex = calls.indexOf(policies[0]);
  const firstAgentChange = calls.findIndex(args => args[1] === 'agents' && args[2] === 'add');
  const firstUpload = calls.findIndex(args => args[1] === 'upload');
  assert(policyIndex < firstAgentChange && policyIndex < firstUpload, 'apply policies before agent changes and uploads');
  const files = JSON.parse(await fs.readFile(path.join(f.root, 'applied-policies.json'), 'utf8'));
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), originalPolicies);
  for (const file of files) assert(result.stdout.includes(`Policy File: ${file}`));
  assert.match(result.stdout, /Custom policy presets applied by upstream: 2/);
  assert.match(result.stdout, /Sandbox demo 的 2 个 network policy 文件已应用/);
  assert(!calls.some((args) => args[1] === 'skill' || args[1] === 'policy-add'));
  assert.deepEqual(calls.filter((args) => args.includes('skills')).map((args) => args[args.indexOf('--agent') + 1]), ['alpha', 'beta']);
  assert.equal(calls.filter((args) => args[1] === 'gateway').length, 1);
  assert.match(result.stdout, /workspace verified \(1\)/);
});

test('repeat deployment defaults to conflict failure and preserves existing content', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  await fs.writeFile(path.join(f.config.deploy.agents[0].agentContent.hostDir, 'SOUL.md'), 'new content');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Target file already exists/);
  assert.equal(await fs.readFile(path.join(f.config.deploy.agents[0].workspace, 'SOUL.md'), 'utf8'), 'alpha original');
  assert.equal((await f.calls()).filter((args) => args[1] === 'agents' && args[2] === 'add').length, 2);
});

test('fail preflights every content conflict before copying any new workspace file', async t => {
  const f = await fixture(t);
  const agent = f.config.deploy.agents[0];
  await fs.mkdir(agent.workspace, { recursive: true });
  await fs.writeFile(path.join(agent.workspace, 'SOUL.md'), 'keep existing');
  await fs.writeFile(path.join(agent.agentContent.hostDir, 'AAAA-new.txt'), 'must not appear');
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Target file already exists/);
  assert.equal(await fs.readFile(path.join(agent.workspace, 'SOUL.md'), 'utf8'), 'keep existing');
  await assert.rejects(fs.access(path.join(agent.workspace, 'AAAA-new.txt')), { code: 'ENOENT' });
});

test('backup handles file-directory conflicts and preserves uploaded executable permissions', async t => {
  const f = await fixture(t);
  const agent = f.config.deploy.agents[0];
  agent.agentContent.conflictStrategy = 'backup';
  await f.write();
  await fs.mkdir(agent.workspace, { recursive: true });
  await fs.writeFile(path.join(agent.workspace, 'skills'), 'old file in place of directory');
  await fs.writeFile(path.join(agent.agentContent.hostDir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const backup = (await fs.readdir(agent.workspace)).find(name => name.startsWith('skills.bak.'));
  assert(backup);
  assert.equal(await fs.readFile(path.join(agent.workspace, backup), 'utf8'), 'old file in place of directory');
  assert.equal((await fs.stat(path.join(agent.workspace, 'run.sh'))).mode & 0o777, 0o755);
});

test('successful agent-add without a listed agent fails before any upload', async t => {
  const f = await fixture(t);
  const result = f.run([], { TEST_AGENT_CREATE_NO_RECORD: '1' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /agents list 中未找到 alpha/);
  assert(!(await f.calls()).some(args => args[1] === 'upload'));
});

test('multiline sandbox commands stop on the first failure and respect continueOnError', async t => {
  for (const continueOnError of [false, true]) {
    const f = await fixture(t);
    const agent = f.config.deploy.agents[0];
    agent.sandbox.commands = { enabled: true, continueOnError, items: [
      'false\nprintf unexpected > should-not-exist.txt',
      'printf continued > continued.txt'
    ] };
    await f.write();
    const result = f.run();
    assert.equal(result.status, continueOnError ? 0 : 1, result.stdout + result.stderr);
    await assert.rejects(fs.access(path.join(agent.workspace, 'should-not-exist.txt')), { code: 'ENOENT' });
    if (continueOnError) {
      assert.equal(await fs.readFile(path.join(agent.workspace, 'continued.txt'), 'utf8'), 'continued');
      assert.match(result.stdout, /partial \(1\)/);
    } else {
      assert.doesNotMatch(result.stdout, /部署完成/);
      await assert.rejects(fs.access(path.join(agent.workspace, 'continued.txt')), { code: 'ENOENT' });
    }
  }
});

test('backup strategy allows repeat deployment while preserving prior workspace files', async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  for (const agent of f.config.deploy.agents) agent.agentContent.conflictStrategy = 'backup';
  await fs.writeFile(path.join(f.config.deploy.agents[0].agentContent.hostDir, 'SOUL.md'), 'updated');
  await f.write();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const workspace = f.config.deploy.agents[0].workspace;
  const backup = (await fs.readdir(workspace)).find((name) => name.startsWith('SOUL.md.bak.'));
  assert(backup);
  assert.equal(await fs.readFile(path.join(workspace, backup), 'utf8'), 'alpha original');
  assert.equal(await fs.readFile(path.join(workspace, 'SOUL.md'), 'utf8'), 'updated');
});

test('up and deploy dry-run invoke no NemoClaw commands', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', force: true }] };
  await f.write();
  assert.equal(f.run(['--dry-run']).status, 0);
  const up = spawnSync(process.execPath, [cli, 'up', '--config', f.configPath, '--non-interactive', '--dry-run'],
    { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(await f.calls(), []);
});

const pluginInstalls = calls => calls.filter(args => args[1] === 'exec'
  && args[3] === 'openclaw' && args[4] === 'plugins' && args[5] === 'install');

async function configureChannelOverlay(f) {
  const partial = { session: { dmScope: 'per-channel-peer' }, tools: { profile: 'coding', deny: ['cron'] },
    mcp: { servers: { business: { url: 'https://mcp.example.com/mcp' } } },
    channels: { advbot: { accounts: { ec: { customField: 'preserve', gatewayToken: 'stale-overlay-token',
      gatewayUrl: 'ws://stale.example.com' } } } } };
  const partialPath = path.join(f.root, 'overlay.json');
  await fs.writeFile(partialPath, JSON.stringify(partial));
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', force: true }] };
  f.config.deploy.shared.openclawConfig = { enabled: true, file: './overlay.json' };
  f.config.deploy.shared.channelServer = { enabled: true, advbotAccountId: 'ec', url: 'http://channel.example.com:8086' };
  f.config.deploy.agents[0].model = 'custom/test-model';
  for (const agent of f.config.deploy.agents) agent.agentContent.conflictStrategy = 'skip';
  await f.write();
  return { partial, partialPath };
}

test('standalone deploy preserves the bind through channel discovery, restart, verification and cleanup', async t => {
  const f = await fixture(t);
  f.config.onboard.services = { dashboardRemoteAccess: true };
  await configureChannelOverlay(f);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(calls.some(call => call.args[1] === 'dashboard-url'));
  assert(calls.some(call => call.args[1] === 'gateway' && call.args[2] === 'restart'));
  assert(calls.some(call => call.args.includes('rm')));
  assert(calls.every(call => call.dashboardBind === '0.0.0.0'));
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
  assert.equal(config.channels.advbot.accounts.ec.gatewayUrl, 'wss://gateway.example.com:18791');
});

test('deploy bind precedence supports explicit false, legacy YAML, inherited env and the default', async t => {
  for (const [name, onboard, inherited, expected] of [
    ['disabled', { services: { dashboardRemoteAccess: false }, environment: { NEMOCLAW_DASHBOARD_BIND: '0.0.0.0' } }, '0.0.0.0', ''],
    ['legacy YAML', { environment: { NEMOCLAW_DASHBOARD_BIND: '0.0.0.0' } }, '', '0.0.0.0'],
    ['inherited', {}, '0.0.0.0', '0.0.0.0'],
    ['default', {}, '', '']
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      Object.assign(f.config.onboard, onboard);
      await f.write();
      const result = f.run([], { NEMOCLAW_DASHBOARD_BIND: inherited });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const calls = (await fs.readFile(path.join(f.root, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert(calls.length > 0);
      assert(calls.every(call => call.dashboardBind === expected));
    });
  }
});

test('deploy validates the dashboard switch before side effects and dry-run executes nothing', async t => {
  const f = await fixture(t);
  f.config.onboard.services = { dashboardRemoteAccess: 'false' };
  await f.write();
  const invalid = f.run();
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /dashboardRemoteAccess/);
  assert.deepEqual(await f.calls(), []);
  f.config.onboard.services.dashboardRemoteAccess = true;
  await f.write();
  const preview = f.run(['--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Dashboard Bind\s+0\.0\.0\.0/);
  assert.deepEqual(await f.calls(), []);
});

test('channel and partial JSON are committed together, preserve existing state and survive repeat deploy', async (t) => {
  const f = await fixture(t);
  const { partialPath } = await configureChannelOverlay(f);
  const partialText = await fs.readFile(partialPath, 'utf8');
  const configPath = path.join(f.root, 'openclaw.json');
  await fs.writeFile(configPath, JSON.stringify({ gateway: { auth: { token: 'preserve-gateway-secret' } },
    tools: { sessions: { visibility: 'all' } }, channels: { other: { enabled: true } },
    plugins: { entries: { other: { enabled: true, config: { keep: true } } } } }));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(config.session.dmScope, 'per-channel-peer');
    assert.equal(config.tools.profile, 'coding');
    assert.deepEqual(config.tools.deny, ['cron']);
    assert.equal(config.tools.sessions.visibility, 'all');
    assert.equal(config.mcp.servers.business.url, 'https://mcp.example.com/mcp');
    assert.equal(config.gateway.auth.token, 'preserve-gateway-secret');
    assert.equal(config.channels.other.enabled, true);
    assert.equal(config.plugins.entries.other.config.keep, true);
    assert.equal(config.channels.advbot.enabled, true);
    assert.equal(config.plugins.entries.advbot.enabled, true);
    assert.deepEqual(config.channels.advbot.accounts.ec, {
      customField: 'preserve', gatewayToken: 'test-current-gateway-token-123456789',
      gatewayUrl: 'wss://gateway.example.com:18791', enabled: true, accountId: 'ec',
      channelServerUrl: 'http://channel.example.com:8086'
    });
    for (const agent of f.config.deploy.agents) {
      const saved = config.agents.list.find(item => item.id === agent.name);
      assert.equal(saved.workspace, agent.workspace);
      if (agent.model) assert.equal(saved.model, agent.model);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /test-current-gateway-token-123456789|test-dashboard-secret|stale-overlay-token/);
    assert.match(result.stdout, /部署完成/);
  }
  assert.equal(await fs.readFile(partialPath, 'utf8'), partialText, 'host overlay stays unchanged');
  const calls = await f.calls();
  assert.equal(calls.filter(args => args[1] === 'gateway-token').length, 2);
  assert.equal(calls.filter(args => args[1] === 'gateway').length, 2, 'restart once per deployment');
});

test('an existing channel with a stale token is refreshed from the current gateway', async (t) => {
  const f = await fixture(t);
  await configureChannelOverlay(f);
  const configPath = path.join(f.root, 'openclaw.json');
  await fs.writeFile(configPath, JSON.stringify({ plugins: { entries: { advbot: { enabled: true } } },
    channels: { advbot: { enabled: true, accounts: { ec: { enabled: true, accountId: 'ec',
      channelServerUrl: 'http://channel.example.com:8086', gatewayToken: 'expired-token',
      gatewayUrl: 'ws://old-gateway.example.com' } } } } }));
  const result = f.run([], { TEST_LEGACY_CHANNEL_JSON: '1' });
  assert.equal(result.status, 0, result.stderr);
  const account = JSON.parse(await fs.readFile(configPath, 'utf8')).channels.advbot.accounts.ec;
  assert.equal(account.gatewayToken, 'test-current-gateway-token-123456789');
  assert.equal(account.gatewayUrl, 'wss://gateway.example.com:18791');
});

test('invalid or silently dropped merged JSON rolls back and cannot report deployment success', async (t) => {
  for (const failure of ['TEST_CONFIG_INVALID', 'TEST_CONFIG_DROPPED']) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      await configureChannelOverlay(f);
      const configPath = path.join(f.root, 'openclaw.json');
      await fs.writeFile(configPath, JSON.stringify({ tools: { profile: 'minimal' } }));
      const result = f.run([], { [failure]: '1' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /已恢复写入前配置/);
      assert.doesNotMatch(result.stdout, /部署完成/);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.equal(config.tools.profile, 'minimal');
      assert.equal(config.session, undefined);
      assert.equal(config.channels, undefined);
      assert.equal(config.agents.list.length, 2, 'agent-created state is preserved by rollback');
      assert(!(await f.calls()).some(args => args[1] === 'gateway'));
    });
  }
});

test('plugin log mentioning advbot cannot substitute for an actually configured channel', async (t) => {
  const f = await fixture(t);
  await configureChannelOverlay(f);
  const result = f.run([], { TEST_CHANNEL_UNAVAILABLE: '1' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /部署完成/);
  assert.match(result.stderr, /已恢复写入前配置/);
});

test('final verification catches merged config disappearing during gateway restart', async (t) => {
  const f = await fixture(t);
  await configureChannelOverlay(f);
  const result = f.run([], { TEST_RESTART_DROPS_CONFIG: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read-back mismatch/);
  assert.doesNotMatch(result.stdout, /部署完成/);
  const calls = await f.calls();
  const restart = calls.findIndex(args => args[1] === 'gateway');
  const lastCheck = calls.findLastIndex(args => args.includes('VERIFY_ONLY=1'));
  const cleanup = calls.findIndex(args => args[1] === 'exec' && args[3] === 'rm');
  assert(restart >= 0 && lastCheck > restart && cleanup > lastCheck);
});

test('unconfirmed npm plugin source stops non-interactive deploy with actionable configuration', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot' }] };
  await f.write();
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install cancelled; rerun with --force/);
  assert.match(result.stderr, /telemetry.openclaw.ai:443/);
  assert.match(result.stderr, /deploy.shared.plugins.items 中为 id: advbot 设置 force: true/);
  assert.doesNotMatch(result.stdout, /部署完成/);
  const calls = await f.calls();
  const installs = pluginInstalls(calls);
  assert.equal(installs.length, 1);
  assert(!installs[0].includes('--force'), 'never force a non-interactive install without configuration');
  assert(calls.findIndex(args => args[1] === 'policy') < calls.indexOf(installs[0]));
  const applied = JSON.parse(await fs.readFile(path.join(f.root, 'applied-policies.json'), 'utf8'));
  assert.equal(applied.length, 2, 'plugin failure must not prevent policy application or remove applied policies');
});

test('explicit force installs and enables advbot; removing force skips it on repeat deployment', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', force: true }] };
  await f.write();
  const result = f.run([], { TEST_PLUGIN_REQUIRES_POLICY: '1' });
  assert.equal(result.status, 0, result.stderr);
  let installs = pluginInstalls(await f.calls());
  assert.equal(installs.length, 1, 'shared plugin must install once for two agents');
  assert.deepEqual(installs[0].slice(3), ['openclaw', 'plugins', 'install', '@advantech-axa/advbot', '--force']);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
  assert.equal(config.plugins.entries.advbot.enabled, true);
  f.config.deploy.shared.plugins.items[0].force = false;
  for (const agent of f.config.deploy.agents) agent.agentContent.conflictStrategy = 'skip';
  await f.write();
  const repeated = f.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /已安装，跳过安装步骤/);
  installs = pluginInstalls(await f.calls());
  assert.equal(installs.length, 1);
});

test('trusted plugin installation passes each explicit consent and extends an existing allowlist without reinstalling', async t => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true, items: [{ id: 'advbot',
    source: 'npm:@advantech-axa/advbot', trustSource: true, acceptCapabilities: true,
    acknowledgeInstallPolicyWarning: true }] };
  await fs.writeFile(path.join(f.root, 'openclaw.json'), JSON.stringify({ plugins: {
    allow: ['other'], entries: { other: { enabled: true } }
  } }));
  await f.write();
  const result = f.run([], { TEST_PLUGIN_CAPABILITIES: '1', TEST_PLUGIN_POLICY_WARNING: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const installs = pluginInstalls(await f.calls());
  assert.equal(installs.length, 1);
  for (const flag of ['--force', '--accept-capabilities', '--acknowledge-install-policy-warning']) assert(installs[0].includes(flag));
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
  assert.deepEqual(config.plugins.allow, ['other', 'advbot']);
  for (const agent of f.config.deploy.agents) agent.agentContent.conflictStrategy = 'skip';
  await f.write();
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(pluginInstalls(await f.calls()).length, 1);
});

test('missing plugin consent is actionable and policy blocks remain terminal after acknowledgement', async t => {
  for (const [env, consent, message] of [
    [{ TEST_PLUGIN_CAPABILITIES: '1' }, {}, /acceptCapabilities: true/],
    [{ TEST_PLUGIN_POLICY_WARNING: '1' }, {}, /acknowledgeInstallPolicyWarning: true/],
    [{ TEST_PLUGIN_POLICY_BLOCK: '1' }, { acknowledgeInstallPolicyWarning: true }, /security.installPolicy blocked/]
  ]) {
    const f = await fixture(t);
    f.config.deploy.shared.plugins = { enabled: true,
      items: [{ id: 'advbot', source: '@advantech-axa/advbot', trustSource: true, ...consent }] };
    await f.write();
    const result = f.run([], env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /部署完成/);
    assert.equal(pluginInstalls(await f.calls()).length, 1);
  }
});

test('explicit plugin denies are preserved and not silently bypassed', async t => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', trustSource: true }] };
  await f.write();
  await fs.writeFile(path.join(f.root, 'openclaw.json'), JSON.stringify({ plugins: { deny: ['advbot'] } }));
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /plugins.deny explicitly blocks/);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
  assert.deepEqual(config.plugins.deny, ['advbot']);
});

test('up rejects a missing local plugin source before any host or sandbox commands', async t => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: './missing-plugin', trustSource: true }] };
  await f.write();
  const result = spawnSync(process.execPath, [cli, 'up', '--config', f.configPath, '--non-interactive'],
    { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /missing-plugin/);
  assert.deepEqual(await f.calls(), []);
});

test('gateway credentials retain their real value even when it resembles a redactable token', async t => {
  const f = await fixture(t);
  await configureChannelOverlay(f);
  const token = 'npm_1234567890123456789012345';
  const result = f.run([], { TEST_GATEWAY_TOKEN: token });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'openclaw.json'), 'utf8'));
  assert.equal(config.channels.advbot.accounts.ec.gatewayToken, token);
  assert(!(result.stdout + result.stderr).includes(token));
});

test('plugin download and forced install failures retain the upstream error without retries', async (t) => {
  for (const force of [false, true]) {
    await t.test(`force=${force}`, async (t) => {
      const f = await fixture(t);
      f.config.deploy.shared.plugins = { enabled: true,
        items: [{ id: 'advbot', source: '@advantech-axa/advbot', force }] };
      await f.write();
      const result = f.run([], { TEST_PLUGIN_FAILURE: 'npm registry request failed: proxy 403 telemetry.openclaw.ai:443' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /npm registry request failed: proxy 403/);
      assert.doesNotMatch(result.stderr, /设置 force: true/);
      assert.doesNotMatch(result.stdout, /部署完成/);
      assert.equal(pluginInstalls(await f.calls()).length, 1);
    });
  }
});

// Isolate the prompt module in a child process so tests exercise the same
// install flow without a terminal or changes to production dependency injection.
async function runPluginTrustPrompt(f, accepted, overrides = {}) {
  const script = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier === '@inquirer/prompts') return { url: 'test:prompts', shortCircuit: true };
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url !== 'test:prompts') return next(url, context);
        return { format: 'module', shortCircuit: true, source: \`
          import fs from 'node:fs';
          import path from 'node:path';
          export async function confirm(options) {
            fs.appendFileSync(path.join(process.env.TEST_ROOT, 'prompts.jsonl'), JSON.stringify(options) + String.fromCharCode(10));
            return process.env.TEST_CONFIRM_TRUST === '1';
          }
          export function select() { throw new Error('Unexpected select prompt'); }
          export function input() { throw new Error('Unexpected input prompt'); }
        \` };
      }
    });
    const { collectDeployPlan } = await import('./dist/core/context.js');
    const { installPlugins } = await import('./dist/core/install-plugins.js');
    const plan = await collectDeployPlan({ config: process.env.TEST_CONFIG, nonInteractive: true });
    const ctx = plan.agents[0];
    ctx.options.nonInteractive = false;
    try { await installPlugins(ctx); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, encoding: 'utf8', timeout: 15_000,
    env: { ...f.env, TEST_CONFIG: f.configPath, TEST_CONFIRM_TRUST: accepted ? '1' : '0', ...overrides }
  });
}

test('interactive source confirmation retries once only after acceptance and never changes config', async (t) => {
  for (const accepted of [false, true]) {
    await t.test(`accepted=${accepted}`, async (t) => {
      const f = await fixture(t);
      f.config.deploy.shared.plugins = { enabled: true,
        items: [{ id: 'advbot', source: '@advantech-axa/advbot' }] };
      await f.write();
      const original = await fs.readFile(f.configPath, 'utf8');
      const result = await runPluginTrustPrompt(f, accepted);
      assert.equal(result.status, accepted ? 0 : 1, result.stderr);
      const prompts = (await fs.readFile(path.join(f.root, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].default, false);
      assert.match(prompts[0].message, /已审查并信任.*advbot.*@advantech-axa\/advbot/);
      const installs = pluginInstalls(await f.calls());
      assert.equal(installs.length, accepted ? 2 : 1);
      assert(!installs[0].includes('--force'));
      if (accepted) assert(installs[1].includes('--force'));
      else assert.match(result.stderr, /未确认插件 advbot 的安装来源/);
      assert.equal(await fs.readFile(f.configPath, 'utf8'), original);
    });
  }
});

test('a failed retry after interactive trust confirmation stops with the new failure', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot' }] };
  await f.write();
  const result = await runPluginTrustPrompt(f, true, { TEST_PLUGIN_FORCE_FAILURE: 'npm registry still blocked after confirmation' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm registry still blocked after confirmation/);
  assert.equal(pluginInstalls(await f.calls()).length, 2);
});

test('up validates deployment resources before any installation or sandbox calls', async t => {
  const f = await fixture(t);
  await fs.rm(f.config.deploy.agents[0].agentContent.hostDir, { recursive: true });
  const result = spawnSync(process.execPath, [cli, 'up', '--config', f.configPath, '--non-interactive'],
    { env: f.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(await f.calls(), []);
});

test('a subprocess terminated by signal is reported as failure', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'],
    { logCommand: false }), /signal: SIGTERM/);
});

test('legacy skill config and malformed skill frontmatter fail before remote changes', async (t) => {
  const f = await fixture(t);
  f.config.deploy.agents[0].skill = { enabled: true, hostDir: '/old/skills' };
  await f.write();
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skill 已移除/);
  assert.deepEqual(await f.calls(), []);
  delete f.config.deploy.agents[0].skill;
  await f.write();
  await fs.writeFile(path.join(f.config.deploy.agents[0].agentContent.hostDir, 'skills/demo/SKILL.md'),
    '---\nname: broken\ndescription: text: invalid\n---\n');
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frontmatter 无效/);
  assert.deepEqual(await f.calls(), []);
});

test('loopback policies and unused private trust fail before remote changes', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.networkPolicy.trustedPrivateHosts = ['192.168.1.100'];
  await f.write();
  assert.match(f.run().stderr, /未匹配 policy/);
  await fs.writeFile(path.join(f.config.deploy.shared.networkPolicy.dir, 'private.yaml'),
    stringify({ network_policies: { local: { endpoints: [{ host: '127.0.0.1', port: 8086 }] } } }));
  assert.match(f.run().stderr, /loopback endpoint/);
  assert.deepEqual(await f.calls(), []);
});

test('old sandbox OpenClaw and skills found in the wrong workspace fail explicitly', async (t) => {
  const f = await fixture(t);
  assert.match(f.run([], { TEST_OPENCLAW_VERSION: '2026.6.10' }).stderr, /sandbox OpenClaw 版本不满足/);
  assert(!(await f.calls()).some((args) => args[1] === 'agents'));
  const result = f.run([], { TEST_WRONG_SKILL_SCOPE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /未从自己的 workspace/);
});

test('unsupported sandbox Node stops deploy before OpenClaw starts or remote files change', async (t) => {
  const f = await fixture(t);
  const result = f.run([], { TEST_SANDBOX_NODE_VERSION: 'v22.22.2' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sandbox Node.js 版本不满足/);
  assert.match(result.stderr, /更新主机 Node.js 不会更新 sandbox/);
  const calls = await f.calls();
  assert(calls.some((args) => args.includes('node') && args.includes('--version')));
  assert(!calls.some((args) => args.includes('openclaw') || args[1] === 'agents' || args[1] === 'upload'));
});

test('doctor independently reports sandbox Node and rejects unsupported major versions', async (t) => {
  const f = await fixture(t);
  const doctor = (version) => spawnSync(process.execPath, [cli, 'doctor', '--sandbox', 'demo'], {
    env: { ...f.env, TEST_SANDBOX_NODE_VERSION: version }, encoding: 'utf8', timeout: 10_000
  });
  const ok = doctor('v24.18.1');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /sandbox Node.js: ok \(24.18.1\)/);
  const failed = doctor('v23.11.0');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /sandbox Node.js 版本不满足/);
});

test('upstream policy failure is retained and never reported as deployment success', async (t) => {
  const f = await fixture(t);
  f.config.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', force: true }] };
  await f.write();
  const result = f.run([], { TEST_POLICY_FAILURE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /policy rejected by upstream/);
  assert.doesNotMatch(result.stdout, /部署完成/);
  assert.doesNotMatch(result.stdout, /个 network policy 文件已应用/);
  const calls = await f.calls();
  assert.equal(calls.filter(args => args[1] === 'policy').length, 1);
  assert(!calls.some(args => args[1] === 'agents' || args[1] === 'upload'));
  assert.deepEqual(pluginInstalls(calls), []);
  await assert.rejects(fs.access(path.join(f.root, 'applied-policies.json')), { code: 'ENOENT' });
});

test('single-file policy uses from-file before agent creation and disabled policy performs no mutations', async t => {
  for (const enabled of [true, false]) {
    await t.test(`enabled=${enabled}`, async t => {
      const f = await fixture(t);
      f.config.deploy.shared.networkPolicy.enabled = enabled;
      f.config.deploy.shared.networkPolicy.dir = path.join(f.config.deploy.shared.networkPolicy.dir, 'private.yaml');
      await f.write();
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      const policies = (await f.calls()).filter(args => args[1] === 'policy');
      assert.equal(policies.length, enabled ? 1 : 0);
      if (enabled) assert.deepEqual(policies[0].slice(1), ['policy', 'add', '--from-file',
        f.config.deploy.shared.networkPolicy.dir, '--trusted-private-host', '192.168.0.165', '--yes']);
      else await assert.rejects(fs.access(path.join(f.root, 'applied-policies.json')), { code: 'ENOENT' });
    });
  }
});

test('skill ignore patterns apply to discovery and secrets are masked in command output', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await collectWorkspaceSkills(f.config.deploy.agents[0].agentContent.hostDir, ['skills']), []);
  const secret = 'test-fixture-private-gateway-token';
  const result = await runCommand(process.execPath, ['-e', 'console.log(process.env.GATEWAY_TOKEN)'],
    { env: { GATEWAY_TOKEN: secret }, logCommand: false });
  assert.equal(result.stdout.trim(), '******');
});

test('supplied IEMS skills validate and live credential config is excluded from npm package', async (t) => {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  assert(!pkg.files.includes('iems'));
  const content = path.join(repo, 'iems/ienergy-genai-archive/templates/copilot');
  try { await fs.access(content); } catch { t.skip('IEMS bundle is supplied separately'); return; }
  assert.equal((await collectWorkspaceSkills(content, [])).length, 12);
  const configPath = path.join(repo, 'iems/onboard.yaml');
  const raw = await fs.readFile(configPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw !== null) {
    const config = parse(raw);
    for (const agent of config.deploy.agents.filter((agent) => agent.agentContent.enabled)) {
      const directory = path.resolve(path.dirname(configPath), agent.agentContent.hostDir);
      assert.equal((await collectWorkspaceSkills(directory, agent.agentContent.ignore)).length, 12);
    }
    assert.equal(config.install.version, NEMOCLAW_VERSION);
    assert(config.deploy.agents.every((agent) => !Object.hasOwn(agent, 'skill')));
    assert.equal(config.deploy.agents[2].agentContent.enabled, false);
  }
});

test('shell dry-run rejects an old deploy CLI without installing packages', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'bin/nemoclaw-deploy'), '#!/bin/sh\necho 0.0.8\n');
  await fs.chmod(path.join(f.root, 'bin/nemoclaw-deploy'), 0o755);
  const npmMarker = path.join(f.root, 'npm-called');
  await fs.writeFile(path.join(f.root, 'bin/npm'), `#!/bin/sh\ntouch '${npmMarker}'\nexit 1\n`);
  await fs.chmod(path.join(f.root, 'bin/npm'), 0o755);
  const result = spawnSync('bash', [path.join(repo, 'templates/install-and-up.sh'), '--dry-run'], {
    env: { ...f.env, CONFIG: f.configPath, NPM_PREFIX: path.join(f.root, 'empty-prefix'), FORCE_CLI_INSTALL: '0' },
    encoding: 'utf8', timeout: 10_000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /预先安装 nemoclaw-deploy >= 0.0.9/);
  await assert.rejects(fs.access(npmMarker));
  assert.deepEqual(await f.calls(), []);
});
