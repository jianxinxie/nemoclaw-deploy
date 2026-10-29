#!/usr/bin/env node
// Emulate a download to disk; no network or host installation is performed.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
fs.appendFileSync(path.join(process.env.TEST_ROOT, 'downloads.jsonl'), JSON.stringify(args) + '\n');
fs.writeFileSync(output, process.env.TEST_DOWNLOAD_CONTENT ?? 'node "$TEST_INSTALLER_SCRIPT"\n');
if (process.env.TEST_DOWNLOAD_FAILURE) {
  console.error('curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL');
  process.exit(35);
}
