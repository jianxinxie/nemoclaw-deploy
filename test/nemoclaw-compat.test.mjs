import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../dist/utils/run.js';
import { NEMOCLAW_VERSION } from '../dist/utils/versions.js';

const source = process.env.NEMOCLAW_COMPAT_SOURCE;
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const revision = 'a08ae7aa911ef5bd7a4b72d9020f575d75d0adb1';

// This suite uses the official compiled CLI and parser. It performs no sandbox
// operations and isolates all CLI state from the user's installed NemoClaw.
test('official NemoClaw v0.0.139 compatibility', { skip: !source }, async (t) => {
  const root = path.resolve(source);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nemoclaw-official-compat-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, NEMOCLAW_HOME: path.join(home, '.nemoclaw'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'), NEMOCLAW_DISABLE_TELEMETRY: '1' };
  const bin = path.join(root, 'bin/nemoclaw.js');
  const identity = JSON.parse(await fs.readFile(path.join(root, 'dist/build-identity.json'), 'utf8'));
  assert.equal(`v${identity.nemoclawVersion}`, NEMOCLAW_VERSION);
  assert.equal(identity.sourceRevision, revision, 'build must come from the exact official v0.0.139 tag');
  const run = (command, args) => runCommand(command, args, { env, logCommand: false, timeoutMs: 30_000 });

  await t.test('real CLI and installer report the pinned version', async () => {
    const cli = await run(process.execPath, [bin, '--version']);
    assert.match(cli.stdout, /nemoclaw v0\.0\.139\b/);
    const installer = await run('bash', [path.join(root, 'scripts/install.sh'), '--version']);
    assert.match(installer.stdout, /0\.0\.139\b/);
  });

  await t.test('remote bind changes the forward target while the default dashboard URL stays loopback', async () => {
    const script = `
      const { createRequire } = require('node:module');
      const load = createRequire(process.argv[1] + '/package.json');
      const { buildChain } = load('./dist/lib/dashboard/contract.js');
      const { buildDashboardUrl } = load('./dist/lib/dashboard-url-command.js');
      const chain = buildChain({ port: 18791, bindOverride: '0.0.0.0', isWsl: false });
      const dashboard = new URL(buildDashboardUrl('fixture-token', 18791));
      console.log(JSON.stringify({ bind: chain.bindAddress, forward: chain.forwardTarget,
        access: chain.accessUrl, url: dashboard.origin + dashboard.pathname,
        tokenMatches: dashboard.hash === '#token=fixture-token' }));
    `;
    const result = await run(process.execPath, ['-e', script, root]);
    assert.deepEqual(JSON.parse(result.stdout), { bind: '0.0.0.0', forward: '0.0.0.0:18791',
      access: 'http://127.0.0.1:18791', url: 'http://127.0.0.1:18791/', tokenMatches: true });
  });

  // Parse the arguments with the real oclif definitions without running the
  // actions: parser failures catch removed flags, positional arguments, and
  // mutually exclusive options while keeping host services untouched.
  const parseScript = `
    const { createRequire } = require('node:module');
    const load = createRequire(process.argv[1] + '/package.json');
    const { Parser, Flags } = load('@oclif/core');
    const C = load('./dist/commands/' + process.argv[2] + '.js').default;
    const flags = { ...C.baseFlags, ...C.flags };
    if (C.enableJsonFlag) flags.json = Flags.boolean();
    Parser.parse(JSON.parse(process.argv[3]), { args: C.args || {}, flags, strict: C.strict })
      .then(() => process.stdout.write('parsed'))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  const onboardArgs = ['--name', 'demo', '--agent', 'openclaw', '--non-interactive',
    '--yes-i-accept-third-party-software', '--yes', '--tool-disclosure', 'progressive',
    '--from', '/tmp/Dockerfile', '--gpu', '--sandbox-gpu', '--sandbox-gpu-device', 'all',
    '--control-ui-port', '18791', '--no-ollama-autostart'];
  const cases = [
    ['onboard', onboardArgs],
    ['onboard', ['--fresh', '--recreate-sandbox', ...onboardArgs]],
    ['onboard', ['--resume', '--non-interactive', '--tool-disclosure', 'progressive']],
    ['onboard', ['--name', 'demo', '--agent', 'openclaw', '--no-gpu', '--no-sandbox-gpu']],
    ['sandbox/policy/add', ['demo', '--from-dir', '/tmp/policies', '--trusted-private-host',
      'api.corp.example', '--trusted-private-host', '192.168.0.165', '--yes']],
    ['sandbox/policy/add', ['demo', '--from-file', '/tmp/policy.yaml', '--yes']],
    ['sandbox/gateway/restart', ['demo', '--quiet']],
    ['sandbox/gateway/token', ['demo', '--quiet']],
    ['sandbox/dashboard-url', ['demo', '--quiet']],
    ['sandbox/status', ['demo', '--json']],
    ['sandbox/upload', ['demo', '/tmp/content/', '/tmp/nemoclaw-deploy/alpha/agent-content/']],
    ['sandbox/exec', ['demo', '--', 'env', 'WORKSPACE=/sandbox/workspace/alpha', 'node', '/tmp/merge.mjs']]
  ];
  for (const [command, args] of cases) {
    await t.test(`official parser accepts ${command}: ${args[0]}`, async () => {
      const result = await run(process.execPath, ['-e', parseScript, root, command, JSON.stringify(args)]);
      assert.equal(result.stdout, 'parsed');
    });
  }

  await t.test('sandbox-first aliases still route through the official CLI', async () => {
    for (const args of [['demo', 'gateway-token'], ['demo', 'policy', 'add'],
      ['demo', 'gateway', 'restart'], ['demo', 'agents', 'add'], ['demo', 'agents', 'list']]) {
      const result = await run(process.execPath, [bin, ...args, '--help']);
      assert.match(result.stdout, /USAGE|Usage|usage/);
    }
  });

  await t.test('local doctor accepts the real v0.0.139 CLI', async () => {
    const localBin = path.join(home, 'bin');
    await fs.mkdir(localBin);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(path.join(localBin, 'nemoclaw'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(bin)} "$@"\n`, { mode: 0o755 });
    const result = await runCommand(process.execPath, [path.join(repo, 'bin/nemoclaw-deploy.js'), 'doctor'], {
      env: { ...env, PATH: `${localBin}:${process.env.PATH}` }, logCommand: false, timeoutMs: 30_000
    });
    assert.match(result.stdout, /nemoclaw: ok \(0\.0\.139\)/);
  });
});
