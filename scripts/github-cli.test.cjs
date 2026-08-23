'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { githubApiArgs, githubCliEnvironment, releaseUploadArgs } = require('./github-cli.cjs');

test('GitHub CLI uses stored authentication and preserves command arguments', () => {
  assert.deepEqual(githubCliEnvironment({ PATH: '/bin', GH_TOKEN: 'old', GITHUB_TOKEN: 'old-too' }), { PATH: '/bin' });
  assert.deepEqual(githubApiArgs('PATCH', 'repos/o/r/releases/1', true), ['api', '--method', 'PATCH', 'repos/o/r/releases/1', '--input', '-']);
  assert.deepEqual(releaseUploadArgs('o/r', 'v1', '/tmp/app.zip', { clobber: true }), ['release', 'upload', 'v1', '--repo', 'o/r', '--clobber', '/tmp/app.zip']);
});