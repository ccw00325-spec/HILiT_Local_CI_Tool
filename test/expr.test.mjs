import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, interpolate, condition } from '../src/expr.mjs';

test('기본 식', () => {
  const ctx = { inputs: { target: '' }, github: { event_name: 'push', ref: 'refs/heads/main' }, matrix: { node: 24 }, status: 'success' };
  assert.equal(evaluate("inputs.target || 'all'", ctx), 'all');
  assert.equal(evaluate("github.event_name == 'PUSH'", ctx), true);
  assert.equal(evaluate("startsWith(github.ref, 'refs/heads/')", ctx), true);
  assert.equal(evaluate('matrix.node >= 20 && matrix.node', ctx), 24);
  assert.equal(evaluate("contains(fromJSON('[\"a\",\"b\"]'), 'B')", ctx), true);
  assert.equal(evaluate("format('{0}-{1}', 'a', 2)", ctx), 'a-2');
  assert.equal(evaluate("'it''s'", ctx), "it's");
  assert.equal(evaluate('!(1 == 2)', ctx), true);
});

test('문자열 바꾸기와 조건', () => {
  const ctx = { inputs: { target: '' }, runner: { temp: '/tmp/x' }, status: 'success' };
  assert.equal(interpolate("out=\"${{ runner.temp }}/plan.json\" t=${{ inputs.target || 'all' }}", ctx), 'out="/tmp/x/plan.json" t=all');
  assert.equal(condition(undefined, ctx), true);
  assert.equal(condition("${{ github.event_name == 'push' }}", { ...ctx, github: { event_name: 'pull_request' } }), false);
  assert.equal(condition('always()', { ...ctx, status: 'failure' }), true);
  assert.equal(condition("inputs.target == ''", { ...ctx, status: 'failure' }), false); /* 상태 함수가 없으면 success() && */
});

test('비밀 키 접근을 알린다', () => {
  let hit = null;
  evaluate('secrets.HF_TOKEN', { secrets: {}, onSecret: (k) => { if (k) hit = k; } });
  assert.equal(hit, 'HF_TOKEN');
});
