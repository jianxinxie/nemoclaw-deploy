#!/usr/bin/env node
// Contract-test transport. All remote filesystem effects are confined to TEST_ROOT.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const root = process.env.TEST_ROOT;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
fs.appendFileSync(path.join(root, 'command-env.jsonl'), JSON.stringify({
  args, dashboardBind: process.env.NEMOCLAW_DASHBOARD_BIND ?? null
}) + '\n');
const registry = path.join(root, 'agents.json');
const agents = () => fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : [];
const mapPath = (value) => value.startsWith('/tmp/nemoclaw-deploy/')
  ? path.join(root, 'remote', value.slice('/tmp/nemoclaw-deploy/'.length)) : value;
const json = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === '--version') {
  const versionFile = path.join(root, 'nemoclaw-version');
  console.log(fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8')
    : process.env.TEST_NEMO_VERSION || 'nemoclaw v0.0.139');
} else if (args[0] === 'onboard') {
  fs.writeFileSync(path.join(root, 'onboard-complete'), 'ready');
} else if (args[1] === 'status') {
  if (process.env.TEST_REQUIRE_ONBOARD && !fs.existsSync(path.join(root, 'onboard-complete'))) {
    console.error('sandbox not yet created'); process.exit(1);
  }
  json({ found: true, phase: process.env.TEST_PHASE || 'Ready', gatewayState: 'present' });
} else if (args[1] === 'agents' && args[2] === 'list') {
  json(agents());
} else if (args[1] === 'agents' && args[2] === 'add') {
  if (process.env.TEST_AGENT_CREATE_NO_RECORD) process.exit(0);
  const list = agents();
  list.push({ id: args[3], workspace: args[args.indexOf('--workspace') + 1] });
  fs.writeFileSync(registry, JSON.stringify(list));
  const configFile = path.join(root, 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.agents ??= {};
  config.agents.list ??= [];
  config.agents.list.push(list.at(-1));
  fs.writeFileSync(configFile, JSON.stringify(config));
} else if (args[1] === 'gateway-token') {
  if (process.env.TEST_GATEWAY_FAILURE) { console.error('gateway token unavailable'); process.exit(1); }
  console.log(process.env.TEST_GATEWAY_TOKEN || 'test-current-gateway-token-123456789');
} else if (args[1] === 'dashboard-url') {
  console.log('https://gateway.example.com:18791/dashboard?view=home#token=test-dashboard-secret');
} else if (args[1] === 'upload') {
  const source = args[2].replace(/\/$/, '');
  let target = mapPath(args[3]);
  if (fs.statSync(source).isDirectory() && process.env.TEST_NEST_UPLOAD) {
    target = path.join(target, path.basename(source));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
} else if (args[1] === 'policy' && args[2] === 'add') {
  if (process.env.TEST_POLICY_FAILURE) { console.error('policy rejected by upstream'); process.exit(1); }
  const directory = args.includes('--from-dir');
  const source = args[args.indexOf(directory ? '--from-dir' : '--from-file') + 1];
  const files = directory ? fs.readdirSync(source).filter(name => /\.ya?ml$/i.test(name)).sort()
    .map(name => path.join(source, name)) : [source];
  fs.writeFileSync(path.join(root, 'applied-policies.json'), JSON.stringify(files));
  console.log('Custom policy presets applied by upstream: ' + files.length);
} else if (args[1] === 'gateway' && args[2] === 'restart') {
  // Process lifecycle is simulated; callers must still query status afterwards.
  if (process.env.TEST_RESTART_DROPS_CONFIG) {
    const configFile = path.join(root, 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    delete config.channels;
    delete config.session;
    fs.writeFileSync(configFile, JSON.stringify(config));
  }
} else if (args[1] === 'exec') {
  let command = args.slice(args.indexOf('--') + 1);
  const env = { ...process.env };
  if (command[0] === 'env') {
    command.shift();
    while (command[0]?.includes('=')) {
      const assignment = command.shift();
      const split = assignment.indexOf('=');
      env[assignment.slice(0, split)] = mapPath(assignment.slice(split + 1));
    }
  }
  if (command[0] === 'openclaw') {
    if (command[1] === '--version') console.log(process.env.TEST_OPENCLAW_VERSION || '2026.9.2');
    else if (command[1] === 'config' && command[2] === 'validate') {
      const configFile = path.join(root, 'openclaw.json');
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.session?.dmScope === 'per-channel-peer' && process.env.TEST_CONFIG_INVALID) {
        console.error('config schema rejected overlay'); process.exit(1);
      }
      if (config.session?.dmScope === 'per-channel-peer' && process.env.TEST_CONFIG_DROPPED) {
        delete config.session;
        fs.writeFileSync(configFile, JSON.stringify(config));
      }
      json({ valid: true });
    }
    else if (command[1] === 'channels' && command[2] === 'list') {
      const config = JSON.parse(fs.readFileSync(path.join(root, 'openclaw.json'), 'utf8'));
      const chat = {};
      if (config.plugins?.entries?.advbot?.enabled && !process.env.TEST_CHANNEL_UNAVAILABLE) {
        const accounts = Object.keys(config.channels?.advbot?.accounts || {});
        chat.advbot = process.env.TEST_LEGACY_CHANNEL_JSON ? accounts
          : { accounts, installed: true, origin: 'configured' };
      } else {
        chat.advbot = { accounts: [], installed: false, origin: 'installable' };
      }
      // A plugin log mentioning advbot is not proof that the channel loaded.
      console.log('[plugins] advbot discovery complete');
      if (command.includes('--json')) json({ chat, auth: [] });
      else console.log(Object.entries(chat).map(([id, entry]) => id + ': '
        + (Array.isArray(entry) ? entry : entry.accounts).join(', ')).join('\n'));
    }
    else if (command[1] === 'plugins') {
      const stateFile = path.join(root, 'plugins.json');
      const plugins = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : [];
      if (command[2] === 'list') {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'openclaw.json'), 'utf8'));
        json({ plugins: plugins.map(plugin => ({ ...plugin,
          enabled: config.plugins?.enabled !== false && !config.plugins?.deny?.includes(plugin.id) &&
            (!config.plugins?.allow?.length || config.plugins.allow.includes(plugin.id)) &&
            config.plugins?.entries?.[plugin.id]?.enabled === true })) });
      } else if (command[2] === 'install') {
        if (process.env.TEST_PLUGIN_REQUIRES_POLICY && !fs.existsSync(path.join(root, 'applied-policies.json'))) {
          console.error('plugin download blocked: required policy has not been applied'); process.exit(1);
        }
        if (process.env.TEST_PLUGIN_FAILURE) { console.error(process.env.TEST_PLUGIN_FAILURE); process.exit(1); }
        if (!command.includes('--force')) {
          console.error('WARNING - Installing plugin from npm registry: ' + command[3]);
          console.error('This source is outside ClawHub review and trust metadata. Only continue if you trust the publisher, package contents, and install source.');
          console.error('Install cancelled; rerun with --force after reviewing the source.');
          console.error("nemoclaw: recent network policy denial detected for telemetry.openclaw.ai:443 inside sandbox 'demo'.");
          process.exit(1);
        }
        if (process.env.TEST_PLUGIN_FORCE_FAILURE) { console.error(process.env.TEST_PLUGIN_FORCE_FAILURE); process.exit(1); }
        if (process.env.TEST_PLUGIN_CAPABILITIES && !command.includes('--accept-capabilities')) {
          console.error('Plugin capabilities require --accept-capabilities'); process.exit(1);
        }
        if (process.env.TEST_PLUGIN_POLICY_WARNING && !command.includes('--acknowledge-install-policy-warning')) {
          console.error('Policy warning: review and use --acknowledge-install-policy-warning'); process.exit(1);
        }
        if (process.env.TEST_PLUGIN_POLICY_BLOCK) {
          console.error('security.installPolicy blocked this plugin'); process.exit(1);
        }
        const plugin = { id: 'advbot', name: '@advantech-axa/advbot', channelIds: ['advbot'] };
        fs.writeFileSync(stateFile, JSON.stringify([...plugins.filter(item => item.id !== plugin.id), plugin]));
      } else throw new Error('Unexpected plugin command: ' + command.join(' '));
    }
    else if (command[1] === 'skills' && command[2] === 'list') {
      const id = command[command.indexOf('--agent') + 1];
      const agent = agents().find((entry) => entry.id === id);
      const skills = [];
      function visit(directory) {
        if (!fs.existsSync(directory)) return;
        const file = path.join(directory, 'SKILL.md');
        if (fs.existsSync(file)) {
          skills.push({ name: fs.readFileSync(file, 'utf8').match(/^name: (.+)$/m)[1],
            source: process.env.TEST_WRONG_SKILL_SCOPE ? 'openclaw-managed' : 'openclaw-workspace',
            eligible: true });
          return;
        }
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) visit(path.join(directory, entry.name));
        }
      }
      visit(path.join(agent.workspace, 'skills'));
      json({ workspaceDir: agent.workspace, skills });
    } else throw new Error('Unexpected OpenClaw command: ' + command.join(' '));
  } else if (command[0] === 'mkdir') {
    fs.mkdirSync(mapPath(command.at(-1)), { recursive: true });
  } else if (command[0] === 'rm') {
    const target = mapPath(command.at(-1));
    if (!target.startsWith(root + path.sep)) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(target, { recursive: true, force: true });
  } else if (command[0] === 'sh') {
    if (!env.COMMAND_WORKDIR?.startsWith(root + path.sep)) throw new Error('Unsafe fixture command workdir');
    const result = spawnSync('/bin/sh', command.slice(1).map(mapPath), { env, encoding: 'utf8' });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  } else if (command[0] === 'node') {
    if (command[1] === '--version') {
      console.log(process.env.TEST_SANDBOX_NODE_VERSION || 'v24.22.1');
      process.exit(0);
    }
    command = command.slice(1).map(mapPath);
    if (command[0] === '-e') {
      const encoded = command[1].match(/Buffer\.from\('([^']+)','base64'\)/)?.[1];
      if (!encoded) throw new Error('Expected encoded inline script');
      const script = Buffer.from(encoded, 'base64').toString('utf8')
        .replaceAll('/sandbox/.openclaw/openclaw.json', path.join(root, 'openclaw.json'));
      command[1] = `eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString('utf8'))`;
    } else {
      let script = fs.readFileSync(command[0], 'utf8');
      script = script.replaceAll('/sandbox/.openclaw/openclaw.json', path.join(root, 'openclaw.json'));
      fs.writeFileSync(command[0], script);
    }
    const result = spawnSync(process.execPath, command, { env, encoding: 'utf8' });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  } else throw new Error('Unexpected exec command: ' + command.join(' '));
} else throw new Error('Unexpected NemoClaw command: ' + args.join(' '));
