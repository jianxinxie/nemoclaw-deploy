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
  const bundledPackages = (await fs.readdir(path.join(directory, 'packages'))).filter(name => name.endsWith('.tgz'));
  assert.deepEqual(bundledPackages, ['advantech-axa-nemoclaw-deploy-' + metadata.version + '.tgz']);
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
    ''
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
  assert.doesNotMatch(deployment.stdout + deployment.stderr, /Channel Registration|\/v1\/openclaw\/agents|注册/);
  assert.doesNotMatch(deployment.stdout + deployment.stderr, /test-current-gateway-token-123456789|test-dashboard-secret/);
  assert.equal(calls.filter(args => args[1] === 'gateway').length, 1);
  const restart = calls.findIndex(args => args[1] === 'gateway');
  assert(calls.findLastIndex(args => args.includes('VERIFY_ONLY=1')) > restart);
  // Run the packaged install.sh with the actual three-agent IEMS configuration.
  // Only credentials and explicit non-interactive confirmations are replaced.
  const fullConfig = parse(await fs.readFile(path.join(directory, 'onboard.yaml'), 'utf8'));
  assert(fullConfig.deploy.agents.every(agent => !Object.hasOwn(agent, 'channelRegistration')));
  fullConfig.onboard.inference.apiKey = 'full-smoke-secret';
  fullConfig.onboard.options.acceptThirdPartySoftware = true;
  for (const item of fullConfig.deploy.shared.plugins.items) {
    item.force = false;
    item.trustSource = true;
    item.acceptCapabilities = true;
    item.acknowledgeInstallPolicyWarning = false;
  }
  for (const agent of fullConfig.deploy.agents) {
    if (agent.agentContent.enabled) agent.agentContent.conflictStrategy = 'backup';
  }
  const restrictedAgent = fullConfig.deploy.agents[0].name;
  const fullPartial = JSON.parse(await fs.readFile(path.join(directory, 'openclaw.json'), 'utf8'));
  fullPartial.agents = { entries: { [restrictedAgent]: { tools: { deny: ['write', 'edit', 'apply_patch'] } } } };
  await fs.writeFile(path.join(directory, 'full-openclaw.json'), JSON.stringify(fullPartial), { mode: 0o600 });
  fullConfig.deploy.shared.openclawConfig = { enabled: true, file: './full-openclaw.json' };
  const fullConfigPath = path.join(directory, 'full-smoke.yaml');
  await fs.writeFile(fullConfigPath, stringify(fullConfig), { mode: 0o600 });
  // Native /sandbox paths contain no spaces; keep their host mapping equivalent.
  // The extracted package and npm prefix above still exercise paths with spaces.
  const fullRoot = path.join(root, 'full-sandbox-transport');
  const fullBin = path.join(fullRoot, 'bin');
  await fs.mkdir(fullBin, { recursive: true });
  await fs.writeFile(path.join(fullRoot, 'openclaw.json'), '{}');
  await fs.writeFile(path.join(fullBin, 'nemoclaw'), fixture, { mode: 0o755 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const full = spawnSync('bash', [path.join(directory, 'install.sh'), '--config', fullConfigPath, '--non-interactive'], {
      encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, NPM_PREFIX: prefix, PACKAGE_SPEC: '', PACKAGE_SHA256: '',
        PACKAGE_NAME: metadata.name, PACKAGE_VERSION: metadata.version, FORCE_CLI_INSTALL: '0',
        PATH: `${fullBin}${path.delimiter}${process.env.PATH}`, TEST_ROOT: fullRoot,
        TEST_NATIVE_PATHS: '1', TEST_AGENT_ENTRIES: '1', TEST_REQUIRE_ONBOARD: '1', TEST_PLUGIN_CAPABILITIES: '1',
        TEST_PLUGIN_POLICY_WARNING: '1', TEST_NEST_UPLOAD: '1', TEST_WARNING_OUTPUT: '1',
        TEST_POLICY_WARNING_ONLY: '1' }
    });
    assert.equal(full.status, 0, full.stdout + full.stderr);
    assert.match(full.stdout, /部署完成/);
    assert.doesNotMatch(full.stdout + full.stderr, /full-smoke-secret|test-current-gateway-token-123456789|Channel Registration/);
  }
  const fullCalls = (await fs.readFile(path.join(fullRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(fullCalls.filter(args => args[0] === 'onboard').length, 1);
  assert.equal(fullCalls.filter(args => args[1] === 'agents' && args[2] === 'add').length, 3);
  assert.equal(fullCalls.filter(args => args[1] === 'exec' && args[4] === 'plugins' && args[5] === 'install').length, 2);
  assert.equal(fullCalls.filter(args => args[1] === 'gateway').length, 2);
  const liveAgents = JSON.parse(await fs.readFile(path.join(fullRoot, 'agents.json'), 'utf8'));
  assert.equal(liveAgents.length, 3);
  for (const agent of fullConfig.deploy.agents) {
    const workspace = path.join(fullRoot, 'sandbox', agent.workspace.slice('/sandbox'.length));
    if (agent.agentContent.enabled) {
      assert.equal((await fs.readdir(path.join(workspace, 'skills'))).length, 12);
      assert((await fs.readdir(workspace)).some(name => /\.bak\./.test(name)));
    } else await assert.rejects(fs.access(path.join(workspace, 'AGENTS.md')), { code: 'ENOENT' });
    if (agent.env.enabled) assert((await fs.readFile(path.join(workspace, '.env'), 'utf8')).includes('EXTRACT_SERVICE_URL='));
  }
  const executable = path.join(fullRoot, 'sandbox/.local/bin/ienergy-query');
  assert((await fs.stat(executable)).mode & 0o111);
  const fullMerged = JSON.parse(await fs.readFile(path.join(fullRoot, 'openclaw.json'), 'utf8'));
  assert.equal(fullMerged.channels.advbot.accounts.ec.gatewayToken, 'test-current-gateway-token-123456789');
  assert.equal(fullMerged.channels.advbot.accounts.ec.gatewayUrl, 'wss://gateway.example.com:18791');
  assert.deepEqual(fullMerged.agents.entries[restrictedAgent].tools.deny, ['write', 'edit', 'apply_patch']);
  for (const agent of fullConfig.deploy.agents.slice(1)) assert.equal(fullMerged.agents.entries[agent.name].tools, undefined);
  assert.equal(fullMerged.agents.list, undefined);
  for (const agent of fullConfig.deploy.agents) {
    await assert.rejects(fs.access(path.join(fullRoot, 'remote', agent.name)), { code: 'ENOENT' });
  }
  console.log('包级测试通过：真实 npm 安装、生产依赖锁、空格路径、prepare-only、重复 dry-run、CLI 复用、4 份策略提前应用、随包 openclaw.json 合并、advbot 账号配置及重启后核验。');
  console.log('完整 IEMS 安装入口测试通过：onboard、3 个 agent、24 个 workspace skills、指定 agent tools 合并、业务程序和 env、重复部署备份、插件复用、网关重启及临时目录清理。');
} finally { await fs.rm(root, { recursive: true, force: true }); }
