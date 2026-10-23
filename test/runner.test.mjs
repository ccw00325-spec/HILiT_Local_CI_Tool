import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

function repoWith(workflow, files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'local-ci-test-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), workflow);
  for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); }
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return dir;
}

test('단계 실행·환경 넘기기·출력·비밀 키 건너뛰기·실패 감지', () => {
  const dir = repoWith(`
name: T
on: [push]
env:
  GREETING: hi
jobs:
  a:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: sub
    steps:
      - uses: actions/checkout@v4
      - id: one
        run: |
          echo "FROM_STEP=yes" >> "$GITHUB_ENV"
          echo "val=42" >> "$GITHUB_OUTPUT"
          test -f marker.txt
      - run: test "$FROM_STEP" = yes && test "$GREETING" = hi && test "\${{ steps.one.outputs.val }}" = 42
      - name: 비밀
        run: echo "\${{ secrets.TOKEN }}"
      - if: failure()
        run: echo never
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: exit 3
`, { 'sub/marker.txt': 'x' });
  const out = path.join(dir, '..', `${path.basename(dir)}-out`);
  const r = spawnSync(process.execPath, [CLI, 'run', '--repo', dir, '--event', 'push', '--ref', 'main', '--out', out, '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const sum = JSON.parse(readFileSync(path.join(out, 'summary.json'), 'utf8'));
  const a = sum.jobs.find((j) => j.name === 'a');
  assert.equal(a.status, 'success');
  assert.equal(a.partial, true);
  assert.deepEqual(a.steps.map((s) => s.status), ['success', 'success', 'success', 'skipped', 'skipped']);
  assert.match(a.steps[3].note, /비밀 키/);
  const b = sum.jobs.find((j) => j.name === 'b');
  assert.equal(b.status, 'failure');
  assert.equal(b.steps[0].exitCode, 3);
});

test('이벤트에 맞지 않는 워크플로는 돌리지 않는다', () => {
  const dir = repoWith('on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: exit 1\n');
  const r = spawnSync(process.execPath, [CLI, 'run', '--repo', dir, '--event', 'push', '--ref', 'main', '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /돌릴 작업 없음/);
});
