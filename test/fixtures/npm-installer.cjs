#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('11.0.0'); process.exit(0); }
const root = process.env.TEST_ROOT;
fs.appendFileSync(path.join(root, 'npm-calls.jsonl'), JSON.stringify(args) + '\n');
const prefix = args[args.indexOf('--prefix') + 1];
fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
const version = process.env.TEST_NPM_CLI_VERSION || '0.0.10';
fs.writeFileSync(path.join(prefix, 'bin/nemoclaw-deploy'), [
  '#!/bin/sh',
  'if [ "$1" = --version ]; then echo ' + version + '; exit 0; fi',
  'touch "$TEST_ROOT/used-bundled-cli"',
  'printf \'%s\\n\' "$*" >> "$TEST_ROOT/up-calls"',
  'exit 0', ''
].join('\n'), { mode: 0o755 });
if (process.env.TEST_NPM_INSTALL_FAILURE) process.exit(23);
if (process.env.TEST_NPM_WAIT) {
  console.log('npm-fixture-waiting');
  setInterval(() => {}, 1000);
}
