import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { shouldRun, matchPatterns, jobOrder, expandMatrix, inputDefaults } from '../src/workflows.mjs';

test('이벤트·가지·경로 걸러내기', () => {
  const doc = parse(`
on:
  push:
    branches: [main]
  pull_request:
    paths: ['src/**', '!src/docs/**']
  workflow_dispatch:
    inputs:
      target: { default: all }
`);
  assert.equal(shouldRun(doc, { event: 'push', branch: 'main' }).run, true);
  assert.equal(shouldRun(doc, { event: 'push', branch: 'feat/x' }).run, false);
  assert.equal(shouldRun(doc, { event: 'pull_request', branch: 'main', changedFiles: ['src/a/b.js'] }).run, true);
  assert.equal(shouldRun(doc, { event: 'pull_request', branch: 'main', changedFiles: ['src/docs/a.md'] }).run, false);
  assert.equal(shouldRun(doc, { event: 'schedule' }).run, false);
  assert.deepEqual(inputDefaults(doc), { target: 'all' });
});

test('무늬', () => {
  assert.equal(matchPatterns(['**.md'], 'docs/a/b.md'), true);
  assert.equal(matchPatterns(['docs/*'], 'docs/a/b.md'), false);
  assert.equal(matchPatterns(['release/**', '!release/old'], 'release/old'), false);
});

test('needs 순서와 matrix', () => {
  assert.deepEqual(jobOrder({ b: { needs: 'a' }, a: {}, c: { needs: ['a', 'b'] } }), ['a', 'b', 'c']);
  assert.throws(() => jobOrder({ a: { needs: 'b' }, b: { needs: 'a' } }));
  assert.deepEqual(expandMatrix({ matrix: { os: ['l', 'w'], n: [1, 2], exclude: [{ os: 'w', n: 1 }], include: [{ os: 'l', n: 1, extra: true }] } }),
    [{ os: 'l', n: 1, extra: true }, { os: 'l', n: 2 }, { os: 'w', n: 2 }]);
  assert.equal(expandMatrix({ matrix: '${{ fromJSON(x) }}' }), null);
});
