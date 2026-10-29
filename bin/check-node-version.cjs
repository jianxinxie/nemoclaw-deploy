#!/usr/bin/env node

// Installation-time guard; keep compatible with older Node runtimes.
const fs = require('node:fs');
const path = require('node:path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const minimum = pkg.engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
if (!minimum) throw new Error('Unsupported package engines.node format');
const required = minimum.slice(1).map(Number);
const actual = process.versions.node.split('.').map(Number);
let supported = !process.versions.node.includes('-');
for (let index = 0; supported && index < 3; index++) {
  if (actual[index] === required[index]) continue;
  supported = actual[index] > required[index];
  break;
}
if (!supported) {
  console.error(`Node.js ${process.versions.node} 不满足安装要求 ${pkg.engines.node}。请先升级 Node.js，或运行安装脚本自动准备运行环境。`);
  process.exit(1);
}
