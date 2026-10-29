import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, withCommandEnvironment } from '../dist/utils/run.js';
import { maskSensitiveText } from '../dist/utils/mask.js';

test('URL token redaction preserves surrounding JSON and never changes raw machine output', async () => {
  const text = JSON.stringify({ url: 'http://127.0.0.1:18791/#token=private-value', ready: true });
  assert.deepEqual(JSON.parse(maskSensitiveText(text)), {
    url: 'http://127.0.0.1:18791/#token=******', ready: true
  });
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.env.GATEWAY_TOKEN)'], {
    env: { GATEWAY_TOKEN: 'npm_1234567890123456789012345' }, rawOutput: true, logCommand: false
  });
  assert.equal(result.stdout, 'npm_1234567890123456789012345');
  await assert.rejects(runCommand(process.execPath,
    ['-e', 'console.error(process.env.GATEWAY_TOKEN); process.exit(1)'], {
      env: { GATEWAY_TOKEN: 'private-value' }, rawOutput: true, logCommand: false
    }), error => !error.message.includes('private-value') && error.message.includes('******'));
});

test('command environment scopes isolate concurrent operations and survive errors without leaking', async () => {
  const key = 'NEMOCLAW_DEPLOY_SCOPE_TEST';
  const original = process.env[key];
  const read = () => runCommand(process.execPath,
    ['-e', `process.stdout.write(process.env.${key} ?? '<unset>')`], { logCommand: false });
  const settled = await Promise.allSettled([
    withCommandEnvironment({ [key]: 'first' }, async () => {
      assert.equal((await read()).stdout, 'first');
      await assert.rejects(withCommandEnvironment({ [key]: 'nested' }, async () => {
        assert.equal((await read()).stdout, 'nested');
        await runCommand(process.execPath, ['-e', 'process.exit(9)'], { logCommand: false });
      }), /exitCode: 9/);
      assert.equal((await read()).stdout, 'first');
    }),
    withCommandEnvironment({ [key]: 'second' }, async () => {
      assert.equal((await read()).stdout, 'second');
    })
  ]);
  for (const result of settled) assert.equal(result.status, 'fulfilled', result.reason?.stack);
  assert.equal(process.env[key], original);
  assert.equal((await read()).stdout, original ?? '<unset>');
});
