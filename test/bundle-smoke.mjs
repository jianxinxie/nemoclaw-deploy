// Run after bundle:iems. NPM_OFFLINE=1 makes npm use only its existing cache.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-bundle-smoke-'));
try {
  const extracted = path.join(root, 'directory with spaces');
  await fs.mkdir(extracted);
  const archive = path.join(repo, 'iems-install-' + metadata.version + '.zip');
  const unzip = spawnSync('unzip', ['-q', archive, '-d', extracted], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr);
  const directory = path.join(extracted, 'iems');
  const config = path.join(root, 'custom config.yaml');
  await fs.writeFile(config, [
    'schemaVersion: 3', 'install: { enabled: false }',
    'onboard:', '  sandbox: { name: demo }',
    '  inference: { provider: custom, endpointUrl: https://api.example.com/v1, apiKey: smoke-key }',
    'deploy:', '  shared:', '    plugins: { enabled: false }', '    openclawConfig: { enabled: false }',
    '    channelServer: { enabled: false }', '    networkPolicy: { enabled: false }',
    '    options: { restartGateway: false }', '  agents:', '    - name: demo',
    '      agentContent: { enabled: false }', '      env: { enabled: false }',
    '      sandbox: { uploads: { enabled: false }, commands: { enabled: false } }',
    '      channelRegistration: { enabled: false }', ''
  ].join('\n'));
  const prefix = path.join(root, 'prefix with spaces');
  const run = args => {
    const result = spawnSync('bash', [path.join(directory, 'install.sh'), '--config', config,
      '--non-interactive', ...args], { encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NPM_PREFIX: prefix, FORCE_CLI_INSTALL: '0', PACKAGE_SPEC: '',
        npm_config_cache: path.join(root, 'empty npm cache'),
        PACKAGE_NAME: metadata.name, PACKAGE_VERSION: metadata.version, PACKAGE_SHA256: '' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert(!result.stdout.includes('smoke-key'));
    return result.stdout;
  };
  run(['--prepare-only']);
  const selected = await fs.readlink(path.join(prefix, 'bin/nemoclaw-deploy'));
  assert.match(run(['--dry-run']), /复用已验证/);
  assert.equal(await fs.readlink(path.join(prefix, 'bin/nemoclaw-deploy')), selected);
  const realCli = await fs.realpath(selected);
  const cliRoot = path.dirname(path.dirname(realCli));
  const lock = JSON.parse(await fs.readFile(path.join(repo, 'package-lock.json'), 'utf8'));
  for (const dep of Object.keys(metadata.dependencies)) {
    const installed = JSON.parse(await fs.readFile(path.join(cliRoot, 'node_modules', dep, 'package.json'), 'utf8'));
    assert.equal(installed.version, lock.packages['node_modules/' + dep].version, dep + ' must match lock');
  }
  const releases = (await fs.readdir(prefix)).filter(name => name.startsWith('.release.'));
  assert.equal(releases.length, 1);

  // Exercise the installed CLI against the four policies shipped in the ZIP.
  // The transport confines every sandbox effect to this test's temporary root.
  const policyConfig = parse(await fs.readFile(config, 'utf8'));
  policyConfig.onboard.services = { dashboardRemoteAccess: true };
  policyConfig.deploy.shared.plugins = { enabled: true,
    items: [{ id: 'advbot', source: '@advantech-axa/advbot', trustSource: true,
      acceptCapabilities: true, acknowledgeInstallPolicyWarning: true }] };
  policyConfig.deploy.shared.openclawConfig = { enabled: true, file: './openclaw.json' };
  policyConfig.deploy.shared.channelServer = { enabled: true, advbotAccountId: 'ec',
    url: 'http://channel.example.com:8086' };
  policyConfig.deploy.shared.options.restartGateway = true;
  policyConfig.deploy.shared.networkPolicy = { enabled: true, dir: './policies',
    trustedPrivateHosts: ['172.21.92.121', '192.168.0.165'] };
  const policyConfigPath = path.join(directory, 'policy-smoke.yaml');
  await fs.writeFile(policyConfigPath, stringify(policyConfig));
  const policyFiles = (await fs.readdir(path.join(directory, 'policies'))).filter(name => /\.ya?ml$/i.test(name)).sort();
  assert.equal(policyFiles.length, 4);
  const originals = await Promise.all(policyFiles.map(name => fs.readFile(path.join(directory, 'policies', name), 'utf8')));
  const transport = path.join(root, 'sandbox transport');
  const transportBin = path.join(transport, 'bin');
  await fs.mkdir(transportBin, { recursive: true });
  await fs.writeFile(path.join(transport, 'openclaw.json'), '{}');
  const fixture = (await fs.readFile(path.join(repo, 'test/fixtures/nemoclaw.cjs'), 'utf8'))
    .replace('#!/usr/bin/env node', `#!${process.execPath}`);
  await fs.writeFile(path.join(transportBin, 'nemoclaw'), fixture, { mode: 0o755 });
  const deployment = spawnSync(process.execPath, [path.join(prefix, 'bin/nemoclaw-deploy'),
    'deploy', '--config', policyConfigPath, '--non-interactive'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${transportBin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: transport,
      TEST_PLUGIN_CAPABILITIES: '1', TEST_PLUGIN_POLICY_WARNING: '1' }
  });
  assert.equal(deployment.status, 0, deployment.stdout + deployment.stderr);
  const calls = (await fs.readFile(path.join(transport, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const pluginInstall = calls.find(args => args[1] === 'exec' && args[4] === 'plugins' && args[5] === 'install');
  assert(pluginInstall);
  for (const flag of ['--force', '--accept-capabilities', '--acknowledge-install-policy-warning']) assert(pluginInstall.includes(flag));
  const environment = (await fs.readFile(path.join(transport, 'command-env.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(environment.every(call => call.dashboardBind === '0.0.0.0'));
  const policies = calls.filter(args => args[1] === 'policy');
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0].slice(1), ['policy', 'add', '--from-dir', path.join(directory, 'policies'),
    '--trusted-private-host', '172.21.92.121', '--trusted-private-host', '192.168.0.165', '--yes']);
  assert(calls.indexOf(policies[0]) < calls.findIndex(args => args[1] === 'agents' && args[2] === 'add'));
  assert.equal(JSON.parse(await fs.readFile(path.join(transport, 'applied-policies.json'), 'utf8')).length, 4);
  assert.deepEqual(await Promise.all(policyFiles.map(name => fs.readFile(path.join(directory, 'policies', name), 'utf8'))), originals);
  assert.match(deployment.stdout, /Sandbox demo 的 4 个 network policy 文件已应用/);
  const merged = JSON.parse(await fs.readFile(path.join(transport, 'openclaw.json'), 'utf8'));
  assert.equal(merged.tools.profile, 'coding');
  assert.equal(merged.session.dmScope, 'per-channel-peer');
  assert.equal(merged.cron.enabled, false);
  assert.equal(merged.env.shellEnv.enabled, true);
  assert.equal(merged.mcp.servers.carbon.transport, 'streamable-http');
  assert.equal(merged.channels.advbot.enabled, true);
  assert.equal(merged.channels.advbot.accounts.ec.channelServerUrl, 'http://channel.example.com:8086');
  assert.equal(merged.channels.advbot.accounts.ec.gatewayToken, 'test-current-gateway-token-123456789');
  assert.equal(merged.channels.advbot.accounts.ec.gatewayUrl, 'wss://gateway.example.com:18791');
  assert.doesNotMatch(deployment.stdout + deployment.stderr, /test-current-gateway-token-123456789|test-dashboard-secret/);
  assert.equal(calls.filter(args => args[1] === 'gateway').length, 1);
  const restart = calls.findIndex(args => args[1] === 'gateway');
  assert(calls.findLastIndex(args => args.includes('VERIFY_ONLY=1')) > restart);
  console.log('包级测试通过：真实 npm 安装、生产依赖锁、空格路径、prepare-only、重复 dry-run、CLI 复用、4 份策略提前应用、随包 openclaw.json 合并、advbot 账号配置及重启后核验。');
} finally { await fs.rm(root, { recursive: true, force: true }); }
