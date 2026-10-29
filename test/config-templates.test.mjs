import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { collectDeployPlan } from '../dist/core/context.js';
import { collectOnboardContext } from '../dist/core/onboard-context.js';
import { validateDeployResources } from '../dist/commands/deploy.js';

test('both shipped YAML templates resolve their enabled local resources', async () => {
  for (const file of ['onboard.yaml', 'onboard.full.yaml']) {
    const config = fileURLToPath(new URL(`../templates/${file}`, import.meta.url));
    const options = { config, dryRun: true, nonInteractive: true };
    const onboard = await collectOnboardContext(options);
    const plan = await collectDeployPlan(options);
    assert.equal(onboard.onboard.sandbox.name, plan.sandboxName);
    const skills = await validateDeployResources(plan);
    assert(skills[0].some(skill => skill.name === 'python-demo'));
  }
});
