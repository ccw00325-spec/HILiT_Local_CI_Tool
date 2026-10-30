/* 대체 규칙(.github/local-ci.yml) · 로컬 캐시 · LF 꺼내기 · 경로 정규화 · 복잡한 if/matrix 시나리오 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseLocalConfig, ConfigError, inputEnv, actionName } from '../src/local-config.mjs';
import { LocalCache, hashFiles } from '../src/cache.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

function repoWith(files, gitConfig = {}) {
  const dir = tmp('local-ci-up-');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  for (const [k, v] of Object.entries(gitConfig)) g('config', k, v);
  for (const [f, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); }
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return { dir, commit: (f, c) => { writeFileSync(path.join(dir, f), c); g('add', '-A'); g('commit', '-q', '-m', f); } };
}

function run(dir, extra = [], cacheDir = tmp('local-ci-cache-')) {
  const out = tmp('local-ci-out-');
  const r = spawnSync(process.execPath, [CLI, 'run', '--repo', dir, '--event', 'push', '--ref', 'main', '--out', out, '--quiet', '--cache-dir', cacheDir, ...extra], { encoding: 'utf8' });
  const sumFile = path.join(out, 'summary.json');
  return { ...r, cacheDir, out, sum: existsSync(sumFile) ? JSON.parse(readFileSync(sumFile, 'utf8')) : null, md: existsSync(path.join(out, 'summary.md')) ? readFileSync(path.join(out, 'summary.md'), 'utf8') : '' };
}

const wf = (body) => `name: T\non: [push]\njobs:\n${body}`;

/* ---------- 대체 규칙 ---------- */

test('대체 규칙 파일: 형식 검사', () => {
  assert.deepEqual(parseLocalConfig(''), { actions: {} });
  const c = parseLocalConfig('actions:\n  Docker/Build-Push-Action:\n    run: echo hi\n  aws/login:\n    skip: 로그인 안 함\n');
  assert.deepEqual(c.actions['docker/build-push-action'], { run: 'echo hi', shell: 'bash' });
  assert.deepEqual(c.actions['aws/login'], { skip: '로그인 안 함' });
  assert.throws(() => parseLocalConfig('actions:\n  a/b:\n    run: x\n    skip: y\n'), ConfigError);
  assert.throws(() => parseLocalConfig('actions:\n  a/b:\n    skip: ""\n'), /이유/);
  assert.throws(() => parseLocalConfig('actions:\n  a/b:\n    command: x\n'), /모르는 항목/);
  assert.throws(() => parseLocalConfig('rules: {}\n'), /actions 만/);
  assert.throws(() => parseLocalConfig('actions:\n  a/b:\n    skip: y\n    shell: bash\n'), /shell 은 run/);
  assert.equal(actionName('Org/Act@v3'), 'org/act');
  assert.deepEqual(inputEnv({ 'node-version': '20', 'my input': 'x' }), { 'INPUT_NODE-VERSION': '20', INPUT_NODE_VERSION: '20', INPUT_MY_INPUT: 'x' });
});

test('대체 규칙으로 실행 · 건너뜀, 규칙 없는 action 은 자세한 경고', () => {
  const { dir } = repoWith({
    '.github/workflows/ci.yml': wf(`  a:
    runs-on: ubuntu-latest
    steps:
      - uses: acme/build-image@v2
        with:
          tag: demo-\${{ github.event_name }}
          build-args: X=1
      - run: test "$(cat built.txt)" = "demo-push|X=1"
      - uses: acme/cloud-login@v1
      - uses: acme/unknown@v9
        with:
          region: ap
`),
    '.github/local-ci.yml': 'actions:\n  acme/build-image:\n    run: printf \'%s|%s\' "$INPUT_TAG" "$INPUT_BUILD_ARGS" > built.txt\n  acme/cloud-login:\n    skip: 로컬에서는 로그인하지 않음\n',
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = r.sum.jobs[0];
  assert.deepEqual(a.steps.map((s) => s.status), ['success', 'success', 'skipped', 'skipped']);
  assert.match(a.steps[0].note, /대체 규칙으로 실행/);
  assert.match(a.steps[2].note, /대체 규칙으로 건너뜀 — 로컬에서는 로그인하지 않음/);
  assert.match(a.steps[3].note, /지원하지 않는 action/);
  assert.equal(a.partial, true);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0], /acme\/unknown@v9.*입력: region.*local-ci\.yml.*actions\."acme\/unknown"/);
  assert.equal(r.sum.rules, 2);
});

test('대체 규칙 파일이 틀리면 사용법 오류(2)로 멈춘다', () => {
  const { dir } = repoWith({ '.github/workflows/ci.yml': wf('  a:\n    runs-on: x\n    steps:\n      - run: true\n'), '.github/local-ci.yml': 'actions:\n  a/b: hello\n' });
  const r = run(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /local-ci\.yml/);
});

test('list 는 대체 규칙·모르는 action 을 표시한다', () => {
  const { dir } = repoWith({
    '.github/workflows/ci.yml': wf('  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n      - uses: m/run@v1\n      - uses: m/skip@v1\n      - uses: m/none@v1\n'),
    '.github/local-ci.yml': 'actions:\n  m/run:\n    run: "true"\n  m/skip:\n    skip: 이유\n',
  });
  const r = spawnSync(process.execPath, [CLI, 'list', '--repo', dir, '--event', 'push', '--ref', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /대체 규칙 .*: 2개/);
  assert.match(r.stdout, /- uses actions\/checkout/);
  assert.match(r.stdout, /↪ uses m\/run/);
  assert.match(r.stdout, /⤼ uses m\/skip/);
  assert.match(r.stdout, /⚠ uses m\/none/);
});

/* ---------- 로컬 캐시 ---------- */

const CACHE_WF = wf(`  a:
    runs-on: ubuntu-latest
    steps:
      - id: c
        uses: actions/cache@v4
        with:
          path: |
            deps
            ~/.npm
          key: deps-\${{ hashFiles('lock.txt') }}
          restore-keys: deps-
      - if: steps.c.outputs.cache-hit != 'true'
        run: mkdir -p deps && cat lock.txt > deps/installed.txt && echo installed >> log.txt
      - run: test -f deps/installed.txt && echo "hit=\${{ steps.c.outputs.cache-hit }} matched=\${{ steps.c.outputs.cache-matched-key }}"
      - run: test -n "$npm_config_cache" && test -d "$npm_config_cache"
`);

test('actions/cache: 첫 실행 저장 → 같은 키 적중 → 키가 바뀌면 restore-keys 로 되살림', () => {
  const { dir, commit } = repoWith({ '.github/workflows/ci.yml': CACHE_WF, 'lock.txt': 'v1' });
  const cacheDir = tmp('local-ci-cache-');
  const r1 = run(dir, [], cacheDir);
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  const s1 = r1.sum.jobs[0];
  assert.equal(s1.steps[1].status, 'success');
  assert.match(s1.steps[0].note, /캐시 없음 — 작업이 통과하면 저장/);
  assert.match(s1.steps[0].note, /작업 사본 밖 경로는 저장하지 않음\(~\/\.npm\)/);
  assert.equal(s1.cache.find((c) => c.saved)?.saved, 1);
  assert.match(r1.md, /💾 캐시 저장: `deps-[0-9a-f]{64}`/);

  const r2 = run(dir, [], cacheDir);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  const s2 = r2.sum.jobs[0];
  assert.match(s2.steps[0].note, /캐시 적중 · 경로 1개 되살림/);
  assert.equal(s2.steps[1].status, 'skipped'); /* cache-hit 이 true 라 설치 단계를 건너뜀 */
  assert.ok(!s2.cache.some((c) => c.saved)); /* 정확히 맞았으면 다시 저장하지 않음 */

  commit('lock.txt', 'v2');
  const r3 = run(dir, [], cacheDir);
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  const s3 = r3.sum.jobs[0];
  assert.match(s3.steps[0].note, /비슷한 캐시 되살림\(deps-/);
  assert.equal(s3.steps[1].status, 'success'); /* 부분 일치는 cache-hit=false → 다시 설치 */
  assert.ok(s3.cache.some((c) => c.saved)); /* 새 키로 저장 */
});

test('--no-cache 이면 저장도 복원도 하지 않는다', () => {
  const { dir } = repoWith({ '.github/workflows/ci.yml': CACHE_WF.replace(/      - run: test -n "\$npm_config_cache".*\n/, ''), 'lock.txt': 'v1' });
  const cacheDir = tmp('local-ci-cache-');
  run(dir, [], cacheDir);
  const r = run(dir, ['--no-cache'], cacheDir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.sum.jobs[0].steps[0].note, /캐시 꺼짐/);
  assert.equal(r.sum.jobs[0].steps[1].status, 'success');
  assert.equal(r.sum.host.cache, '꺼짐');
});

test('실패한 작업은 캐시를 저장하지 않는다 · fail-on-cache-miss', () => {
  const { dir } = repoWith({ '.github/workflows/ci.yml': wf(`  a:
    runs-on: x
    steps:
      - uses: actions/cache@v4
        with: { path: d, key: k1 }
      - run: mkdir d && touch d/f && exit 1
  b:
    runs-on: x
    steps:
      - uses: actions/cache/restore@v4
        with: { path: d, key: none, fail-on-cache-miss: true }
`) });
  const r = run(dir);
  assert.equal(r.status, 1);
  const a = r.sum.jobs.find((j) => j.name === 'a');
  assert.ok(!a.cache.some((c) => c.saved));
  const b = r.sum.jobs.find((j) => j.name === 'b');
  assert.equal(b.steps[0].status, 'failure');
  assert.match(b.steps[0].note, /fail-on-cache-miss/);
});

test('LocalCache · hashFiles 단위', () => {
  const ws = tmp('local-ci-ws-');
  mkdirSync(path.join(ws, 'a', 'b'), { recursive: true });
  writeFileSync(path.join(ws, 'a', 'b', 'x.lock'), '1');
  writeFileSync(path.join(ws, 'a', 'y.lock'), '2');
  const h1 = hashFiles(ws, ['**/*.lock']);
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(hashFiles(ws, ['**/*.lock']), h1);
  assert.notEqual(hashFiles(ws, ['**/*.lock', '!a/y.lock']), h1);
  assert.equal(hashFiles(ws, ['nothing/**']), '');
  assert.equal(hashFiles(ws, [`${ws.replace(/\\/g, '/')}/a/y.lock`]), hashFiles(ws, ['a/y.lock']));
  const c = new LocalCache(tmp('local-ci-c-'), 'o/r');
  const { inside, outside } = LocalCache.splitPaths(['a', '../escape', '~/.npm', '!a/b'], ws);
  assert.deepEqual(inside.map((x) => x.rel), ['a']);
  assert.deepEqual(outside, ['../escape', '~/.npm']);
  assert.equal(c.save('k-1', inside), 1);
  assert.equal(c.find('k-1').exact, true);
  assert.equal(c.find('k-2', ['zz-', 'k-']).exact, false);
  assert.equal(c.find('k-2', ['zz-']), null);
});

/* ---------- 줄바꿈 · 경로 ---------- */

test('작업 사본은 이 PC 의 core.autocrlf 와 상관없이 LF 로 꺼낸다 · 경로는 / 로', () => {
  const { dir } = repoWith({
    '.github/workflows/ci.yml': wf(`  a:
    runs-on: ubuntu-latest
    steps:
      - run: bash ./scripts/check.sh
      - run: |
          case "$GITHUB_WORKSPACE$RUNNER_TEMP$GITHUB_OUTPUT\${{ github.workspace }}\${{ runner.temp }}" in *\\\\*) echo "역슬래시가 남음"; exit 1;; esac
          cd "$GITHUB_WORKSPACE" && test -f scripts/check.sh
`),
    'scripts/check.sh': 'set -e\nx=1\nif [ "$x" = 1 ]; then\n  echo ok\nfi\n',
  }, { 'core.autocrlf': 'true' });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr + r.md);
  assert.equal(r.sum.host.eol, 'LF로 꺼냄');
  assert.ok(!r.sum.notes.some((n) => /CRLF/.test(n)));
});

test('커밋된 스크립트 자체에 CRLF 가 있으면 미리 알린다', () => {
  const { dir } = repoWith({
    '.github/workflows/ci.yml': wf('  a:\n    runs-on: x\n    steps:\n      - run: "true"\n'),
    '.gitattributes': 'win.sh -text\n',
    'win.sh': 'echo hi\r\n',
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.sum.notes.some((n) => /CRLF.*win\.sh/.test(n)), JSON.stringify(r.sum.notes));
  assert.match(r.md, /⚠️ 커밋된 셸 스크립트에 CRLF/);
});

/* ---------- 복잡한 if · matrix ---------- */

test('matrix include/exclude 조합 · 조합별 if · 결과 개수', () => {
  const { dir } = repoWith({ '.github/workflows/ci.yml': wf(`  m:
    runs-on: x
    strategy:
      fail-fast: false
      matrix:
        os: [a, b]
        n: [1, 2]
        exclude:
          - os: b
            n: 2
        include:
          - os: a
            extra: yes
          - os: c
            n: 3
    steps:
      - run: echo "\${{ matrix.os }}-\${{ matrix.n }}-\${{ matrix.extra }}" > "$RUNNER_TEMP/id"
      - if: \${{ matrix.n > 1 && (matrix.os == 'a' || contains(matrix.os, 'c')) }}
        run: echo big
      - if: matrix.extra == 'yes' && !startsWith(matrix.os, 'b')
        run: test "\${{ matrix.os }}" = a
`) });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const names = r.sum.jobs.map((j) => j.name).sort();
  assert.deepEqual(names, ['m (a, 1, yes)', 'm (a, 2, yes)', 'm (b, 1)', 'm (c, 3)']);
  const st = Object.fromEntries(r.sum.jobs.map((j) => [j.name, j.steps.map((s) => s.status).join(',')]));
  assert.equal(st['m (a, 1, yes)'], 'success,skipped,success');
  assert.equal(st['m (a, 2, yes)'], 'success,success,success');
  assert.equal(st['m (b, 1)'], 'success,skipped,skipped');
  assert.equal(st['m (c, 3)'], 'success,success,skipped');
});

test('fail-fast: 기본은 첫 실패에서 멈추고, false 면 모든 조합을 돈다', () => {
  const body = (ff) => wf(`  m:
    runs-on: x
    strategy:
      ${ff}
      matrix:
        k: [1, 2, 3]
    steps:
      - run: test "\${{ matrix.k }}" != 1
`);
  const r1 = run(repoWith({ '.github/workflows/ci.yml': body('fail-fast: true') }).dir);
  assert.equal(r1.status, 1);
  assert.equal(r1.sum.jobs.length, 1);
  const r2 = run(repoWith({ '.github/workflows/ci.yml': body('fail-fast: false') }).dir);
  assert.equal(r2.status, 1);
  assert.deepEqual(r2.sum.jobs.map((j) => j.status), ['failure', 'success', 'success']);
});

test('needs · always() · failure() · 작업 출력 · continue-on-error 흐름', () => {
  const { dir } = repoWith({ '.github/workflows/ci.yml': wf(`  a:
    runs-on: x
    outputs:
      v: \${{ steps.s.outputs.v }}
    steps:
      - id: s
        run: echo "v=7" >> "$GITHUB_OUTPUT"
      - run: exit 5
        continue-on-error: true
  b:
    needs: a
    runs-on: x
    steps:
      - run: test "\${{ needs.a.outputs.v }}" = 7 && test "\${{ needs.a.result }}" = success
      - run: exit 1
      - if: failure()
        run: echo cleanup
      - if: success()
        run: echo never
      - if: always()
        run: echo always
  c:
    needs: b
    runs-on: x
    steps:
      - run: echo skipped
  d:
    needs: b
    if: always()
    runs-on: x
    steps:
      - run: echo runs
`) });
  const r = run(dir);
  assert.equal(r.status, 1);
  const j = Object.fromEntries(r.sum.jobs.map((x) => [x.name, x]));
  assert.equal(j.a.status, 'success');
  assert.match(j.a.steps[1].note, /continue-on-error/);
  assert.deepEqual(j.b.steps.map((s) => s.status), ['success', 'failure', 'success', 'skipped', 'success']);
  assert.equal(j.c.status, 'skipped');
  assert.equal(j.d.status, 'success');
});
