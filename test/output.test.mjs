import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonOutput, commandValue } from '../dist/utils/output.js';
import { runCommand } from '../dist/utils/run.js';
import { withWarningCollection } from '../dist/utils/logger.js';

test('JSON and scalar outputs tolerate surrounding warning diagnostics without altering payloads', () => {
  const payload = { token: 'raw-token', text: 'escaped " braces } [', rows: [1, { enabled: true }] };
  const output = `WARNING: header\n[plugins] discovery done\n${JSON.stringify(payload)}\nWARNING: footer`;
  assert.deepEqual(parseJsonOutput(output), payload);
  assert.deepEqual(parseJsonOutput('WARNING: header\n["alpha", "beta"]\nWARNING: footer'), ['alpha', 'beta']);
  assert.equal(commandValue('WARNING: header\nraw-token\nWARNING: footer'), 'raw-token');
  assert.throws(() => parseJsonOutput('WARNING: no JSON data'), /无法解析/);
});

test('successful stderr warnings are collected while actual nonzero exits still fail', async () => {
  const warnings = [];
  const result = await withWarningCollection(warnings, () => runCommand(process.execPath,
    ['-e', 'console.error("WARNING: advisory"); console.log("done")'], { logCommand: false }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'done');
  assert.deepEqual(warnings, ['WARNING: advisory']);
  await assert.rejects(runCommand(process.execPath,
    ['-e', 'console.error("WARNING: advisory"); console.error("real operation failed"); process.exit(7)'],
    { logCommand: false }), /exitCode: 7/);
});
