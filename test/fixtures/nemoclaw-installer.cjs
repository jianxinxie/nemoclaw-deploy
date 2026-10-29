#!/usr/bin/env node
// Runs only behind the curl fixture; never installs packages or touches host state.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.TEST_ROOT;
const selected = Object.fromEntries(['NEMOCLAW_INSTALL_TAG', 'NEMOCLAW_INSTALL_REF',
  'NEMOCLAW_SANDBOX_NAME', 'NEMOCLAW_NON_INTERACTIVE'].map((key) => [key, process.env[key]]));
fs.writeFileSync(path.join(root, 'installer.json'), JSON.stringify(selected));
fs.writeFileSync(path.join(root, 'installer-dashboard-bind.json'),
  JSON.stringify(process.env.NEMOCLAW_DASHBOARD_BIND ?? null));
if (process.env.TEST_INSTALL_FAILURE) {
  console.error('fixture installer failed before onboarding');
  process.exit(23);
}
fs.writeFileSync(path.join(root, 'nemoclaw-version'),
  process.env.TEST_INSTALL_VERSION || `nemoclaw ${process.env.NEMOCLAW_INSTALL_REF}`);
if (process.env.TEST_INSTALL_NEW_CLI) {
  const bin = path.join(process.env.HOME, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(process.env.TEST_INSTALL_NEW_CLI, path.join(bin, 'nemoclaw'));
  fs.chmodSync(path.join(bin, 'nemoclaw'), 0o755);
}
