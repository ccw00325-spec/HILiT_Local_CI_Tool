/* 작업(job) 실행기 — 깨끗한 작업 사본에서 run: 단계를 GitHub 기본 셸 규칙(bash -eo pipefail)으로 돌린다.
 * 비밀 키(secrets.*)를 쓰는 단계는 돌리지 않고 「비밀 키 필요」로 건너뛴다. 이 도구는 비밀 키를 읽지도 넘기지도 않는다. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, createWriteStream, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { interpolate, condition, ExprError } from './expr.mjs';
import { CONFIG_PATH, actionName, inputEnv } from './local-config.mjs';
import { LocalCache, hashFiles } from './cache.mjs';

const isWin = process.platform === 'win32';
/** Windows 경로를 / 로 — Git Bash 에서 역슬래시가 이스케이프로 읽혀 경로가 깨지는 것을 막는다(node·pwsh 도 / 를 받는다). */
export const fwd = (p) => (isWin && typeof p === 'string' ? p.replace(/\\/g, '/') : p);

/** 로컬 CI 가 직접 처리하는 action. 나머지는 .github/local-ci.yml 대체 규칙이 있어야 돈다. */
export const BUILTIN_ACTIONS = new Set(['actions/checkout', 'actions/setup-node', 'actions/setup-python', 'actions/setup-java',
  'actions/cache', 'actions/cache/restore', 'actions/cache/save', 'actions/download-artifact', 'actions/upload-artifact']);

/** Windows 에서는 WSL bash 가 아니라 Git Bash 를 쓴다. LOCAL_CI_BASH 로 바꿀 수 있다. */
export function findBash() {
  if (process.env.LOCAL_CI_BASH) return process.env.LOCAL_CI_BASH;
  if (!isWin) return 'bash';
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return cands.find((c) => existsSync(c)) || 'bash';
}

function versionOf(cmd, args) {
  try { return String(execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })).trim(); } catch { return null; }
}

/** 지원하는 uses: — 실제로 할 일이 없거나 이 PC 버전만 확인하면 되는 것들. 대체 규칙(rules)이 있으면 그것이 먼저다. */
function handleUses(uses, withArgs, env, rules = {}, cacheOn = false) {
  const name = actionName(uses);
  const w = withArgs || {};
  const rule = rules[name];
  if (rule?.skip) return { status: 'skipped', note: `대체 규칙으로 건너뜀 — ${rule.skip}`, ruleSkip: true };
  if (rule?.run) return { mapped: rule };
  if (name === 'actions/checkout') {
    if (w.repository || w.path) return { status: 'skipped', note: '다른 저장소·경로 checkout 은 지원하지 않음' };
    return { status: 'success', note: '이미 깨끗한 작업 사본' };
  }
  if (name === 'actions/setup-node') {
    const v = versionOf('node', ['--version']);
    const want = String(w['node-version'] ?? '').replace(/\.x$/, '');
    const ok = !want || (v && v.replace(/^v/, '').split('.')[0] === want.split('.')[0]);
    const pm = w.cache ? ` · ${w.cache} 캐시는 ${cacheOn ? '로컬 패키지 캐시 폴더' : '꺼짐(--no-cache)'}` : '';
    return { status: 'success', note: `node ${v ?? '없음'}${want ? ` (워크플로 ${want})` : ''}${pm}`, warn: ok ? null : `node 주 버전이 다릅니다: ${v} ≠ ${want}` };
  }
  if (name === 'actions/setup-python') {
    const py = env.LOCAL_CI_PYTHON || (isWin ? 'py' : 'python3');
    const v = versionOf(py, ['--version']);
    const want = String(w['python-version'] ?? '');
    const ok = !want || (v && v.replace(/^Python\s*/, '').startsWith(want.replace(/\.x$/, '')));
    return { status: 'success', note: `${py} ${v ?? '없음'}${want ? ` (워크플로 ${want})` : ''}`, warn: ok ? null : `python 버전이 다릅니다: ${v} ≠ ${want}` };
  }
  if (name === 'actions/setup-java') {
    const v = versionOf('java', ['-version']);
    return { status: v ? 'success' : 'skipped', note: v ? 'java 있음' : 'java 없음', warn: v ? `java 버전 확인 필요(워크플로 ${w['java-version'] ?? '?'})` : null };
  }
  if (name === 'actions/cache' || name === 'actions/cache/restore' || name === 'actions/cache/save') return { cache: name };
  if (name === 'actions/download-artifact') return { status: 'success', note: '로컬에서는 할 일 없음' };
  if (name === 'actions/upload-artifact') return { status: 'success', note: '산출물 복사', artifact: w.path };
  const keys = Object.keys(w);
  return {
    status: 'skipped', note: `지원하지 않는 action: ${uses} — 대체 규칙 없음`,
    warn: `알 수 없는 action \`${uses}\`${keys.length ? `(입력: ${keys.join(', ')})` : ''}을 건너뛰었습니다. 이 단계가 만드는 결과에 기대는 뒤 단계는 실패할 수 있습니다. `
      + `대신 돌리려면 ${CONFIG_PATH} 의 actions."${name}" 에 run: 명령(with: 값은 INPUT_<이름> 환경 변수) 또는 skip: 이유를 적으세요.`,
  };
}

function parseKeyFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hd = /^([^=<]+)<<(.+)$/.exec(line);
    if (hd) {
      const [, k, delim] = hd; const buf = [];
      for (i += 1; i < lines.length && lines[i] !== delim; i += 1) buf.push(lines[i]);
      out[k] = buf.join('\n');
    } else if (line.includes('=')) {
      const j = line.indexOf('='); out[line.slice(0, j)] = line.slice(j + 1);
    }
  }
  return out;
}

function runScript({ shell, script, cwd, env, logFile, timeoutMs, echo }) {
  const tmp = path.join(env.RUNNER_TEMP, `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let cmd, args;
  const sh = (shell || 'bash').toLowerCase();
  if (sh === 'bash' || sh === 'sh') {
    writeFileSync(`${tmp}.sh`, script);
    cmd = findBash(); args = sh === 'sh' ? ['-e', `${tmp}.sh`] : ['--noprofile', '--norc', '-eo', 'pipefail', `${tmp}.sh`];
  } else if (sh === 'python') {
    writeFileSync(`${tmp}.py`, script);
    cmd = env.LOCAL_CI_PYTHON || (isWin ? 'py' : 'python3'); args = [`${tmp}.py`];
  } else if (sh === 'pwsh' || sh === 'powershell') {
    writeFileSync(`${tmp}.ps1`, `$ErrorActionPreference = 'stop'\n${script}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`);
    cmd = sh; args = ['-NoProfile', '-NonInteractive', '-File', `${tmp}.ps1`];
  } else {
    return Promise.resolve({ code: 1, note: `지원하지 않는 shell: ${shell}` });
  }
  return new Promise((resolve) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const tee = (chunk) => { log.write(chunk); if (echo) process.stdout.write(chunk); };
    child.stdout.on('data', tee); child.stderr.on('data', tee);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); log.end(); resolve({ code: 1, note: `실행 실패: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); log.end(); resolve({ code: timedOut ? 124 : code ?? 1, note: timedOut ? '시간 초과' : null }); });
  });
}

/**
 * 작업 하나를 돌린다.
 * p = { wf, jobName, job, matrix, workspace, outDir, github, inputs, needs, echo }
 * 돌려주는 것: { name, status: success|failure|skipped, steps: [...], warnings: [], outputs }
 */
export async function runJob(p) {
  const { wf, jobName, job, matrix, outDir, echo } = p;
  const workspace = p.workspace;
  const rules = p.config?.actions ?? {};
  const cache = p.cache ?? null;
  const pendingSaves = [];
  const label = Object.keys(matrix || {}).length ? `${jobName} (${Object.values(matrix).join(', ')})` : jobName;
  const jobDir = path.join(outDir, `${wf.file.replace(/\.ya?ml$/, '')}--${label.replace(/[^\w.-]+/g, '_')}`);
  mkdirSync(jobDir, { recursive: true });
  const runnerTemp = path.join(jobDir, 'tmp'); mkdirSync(runnerTemp, { recursive: true });
  const files = { env: path.join(runnerTemp, 'github_env'), path: path.join(runnerTemp, 'github_path'), out: path.join(runnerTemp, 'github_output'), summary: path.join(jobDir, 'step-summary.md') };
  const result = { name: label, workflow: wf.name, file: wf.file, status: 'success', steps: [], warnings: [], outputs: {}, cache: [] };
  const steps = {};
  const ctx = {
    github: { ...p.github, workspace: fwd(workspace), job: jobName },
    inputs: p.inputs || {}, matrix: matrix || {}, needs: p.needs || {}, steps, vars: {},
    runner: { os: isWin ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : 'Linux'), temp: fwd(runnerTemp), arch: os.arch() === 'x64' ? 'X64' : os.arch(), name: 'local-ci' },
    secrets: {}, job: { status: 'success' }, status: 'success', env: {},
    hashFiles: (pats) => hashFiles(workspace, pats),
  };
  const pkgEnv = cache ? cache.packageEnv() : {};
  /* 작업 단위 if: */
  if (job.if !== undefined) {
    try { if (!condition(job.if, ctx)) { result.status = 'skipped'; result.reason = 'if 조건 거짓'; return result; } } catch (e) { result.status = 'skipped'; result.reason = `if 계산 불가: ${e.message}`; return result; }
  }
  if (job.services || job.container) { result.status = 'skipped'; result.reason = 'services/container 는 지원하지 않음'; return result; }
  if (job.uses) { result.status = 'skipped'; result.reason = `재사용 워크플로(${job.uses})는 지원하지 않음`; return result; }
  const usesSecret = (obj) => /\bsecrets\s*\./.test(JSON.stringify(obj ?? ''));
  const evalEnv = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, String(interpolate(typeof v === 'string' ? v : JSON.stringify(v), ctx))]));
  let jobEnv;
  try {
    const wfEnv = evalEnv(wf.doc.env);
    ctx.env = { ...wfEnv };
    jobEnv = { ...wfEnv, ...evalEnv(job.env) };
  } catch (e) { result.status = 'failure'; result.reason = `env 계산 실패: ${e.message}`; return result; }
  const extraPath = [];
  /* Windows 의 python 은 스토어 연결 껍데기일 수 있다 — bash 단계에서 python·python3 이 실제 해석기를 부르게 한다. */
  if (isWin) {
    const bin = path.join(runnerTemp, 'bin'); mkdirSync(bin, { recursive: true });
    const py = (process.env.LOCAL_CI_PYTHON || 'py -3').replace(/\\/g, '/');
    for (const n of ['python', 'python3']) writeFileSync(path.join(bin, n), `#!/bin/sh\nexec ${py} "$@"\n`);
    extraPath.push(bin);
  }
  const defaultsRun = { ...(wf.doc.defaults?.run || {}), ...(job.defaults?.run || {}) };
  /** actions/cache · cache/restore · cache/save */
  function handleCache(kind, w, step, rec, stepsOut, res) {
    const key = String(w.key ?? '');
    const lines = (v) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
    const outputs = { 'cache-hit': 'false', 'cache-primary-key': key, 'cache-matched-key': '' };
    if (!cache) {
      rec.status = 'success'; rec.note = '캐시 꺼짐(--no-cache)';
    } else if (!key) {
      rec.status = 'failure'; rec.note = 'key 가 비어 있음';
    } else {
      const { inside, outside } = LocalCache.splitPaths(lines(w.path), workspace);
      const notes = [];
      if (kind === 'actions/cache/save') {
        const n = cache.save(key, inside);
        res.cache.push({ key, saved: n });
        notes.push(n ? `캐시 저장 · 경로 ${n}개` : '저장할 경로 없음');
      } else {
        const entry = cache.find(key, lines(w['restore-keys']));
        if (entry) {
          outputs['cache-hit'] = entry.exact ? 'true' : 'false';
          outputs['cache-matched-key'] = entry.meta.key;
          const n = String(w['lookup-only']) === 'true' ? 0 : cache.restore(entry, inside);
          notes.push(entry.exact ? `캐시 적중 · 경로 ${n}개 되살림` : `비슷한 캐시 되살림(${entry.meta.key}) · 경로 ${n}개`);
          res.cache.push({ key, hit: entry.exact, matched: entry.meta.key });
        } else {
          notes.push(kind === 'actions/cache' ? '캐시 없음 — 작업이 통과하면 저장' : '캐시 없음');
          res.cache.push({ key, hit: false });
          if (String(w['fail-on-cache-miss']) === 'true') { rec.status = 'failure'; rec.note = '캐시 없음(fail-on-cache-miss)'; }
        }
        if (kind === 'actions/cache' && !(entry && entry.exact)) pendingSaves.push({ key, inside });
      }
      if (outside.length) notes.push(`작업 사본 밖 경로는 저장하지 않음(${outside.join(', ')}) — 패키지 캐시 폴더가 대신함`);
      if (rec.status !== 'failure') { rec.status = 'success'; rec.note = notes.join(' · '); }
    }
    if (step.id) stepsOut[step.id] = { outputs, outcome: rec.status, conclusion: rec.status };
  }
  const jobTimeout = (job['timeout-minutes'] ?? 360) * 60000;
  const t0 = Date.now();
  for (const [k, step] of (job.steps || []).entries()) {
    const sname = step.name ?? (step.uses ? `uses ${step.uses}` : String(step.run ?? '').split('\n')[0].slice(0, 70));
    const rec = { index: k + 1, name: sname, status: 'success', ms: 0 };
    result.steps.push(rec);
    ctx.env = { ...jobEnv };
    ctx.job.status = result.status === 'failure' ? 'failure' : 'success';
    ctx.status = ctx.job.status;
    let run;
    try { run = condition(step.if, ctx); } catch (e) { rec.status = 'skipped'; rec.note = `if 계산 불가: ${e.message}`; continue; }
    if (!run) { rec.status = 'skipped'; rec.note = 'if 조건 거짓'; continue; }
    if (usesSecret(step)) { rec.status = 'skipped'; rec.note = '비밀 키(secrets) 필요 — 로컬에서 돌리지 않음'; rec.secret = true; continue; }
    const st = Date.now();
    try {
      const stepEnv = { ...jobEnv, ...evalEnv(step.env) };
      ctx.env = stepEnv;
      let spec = null;
      if (step.uses) {
        const withArgs = Object.fromEntries(Object.entries(step.with || {}).map(([a, b]) => [a, interpolate(typeof b === 'string' ? b : String(b), ctx)]));
        const h = handleUses(step.uses, withArgs, stepEnv, rules, !!cache);
        if (h.mapped) {
          spec = { script: interpolate(String(h.mapped.run), ctx), shell: h.mapped.shell, wd: '.', extraEnv: inputEnv(withArgs), mapped: true };
        } else if (h.cache) {
          handleCache(h.cache, withArgs, step, rec, steps, result);
        } else {
          rec.status = h.status; rec.note = h.note;
          if (h.ruleSkip) rec.ruleSkip = true;
          if (h.warn) result.warnings.push(h.warn);
          if (h.artifact) {
            const dst = path.join(jobDir, 'artifacts');
            for (const ap of String(h.artifact).split('\n').map((x) => x.trim()).filter(Boolean)) {
              try { cpSync(path.join(workspace, ap), path.join(dst, path.basename(ap)), { recursive: true }); } catch { /* 없으면 그냥 둔다 */ }
            }
          }
        }
      } else if (step.run !== undefined) {
        spec = { script: interpolate(String(step.run), ctx), shell: step.shell ?? defaultsRun.shell, wd: interpolate(step['working-directory'] ?? defaultsRun['working-directory'] ?? '.', ctx), extraEnv: {} };
      }
      if (spec) {
        const { script, wd } = spec;
        const env = {
          ...process.env, ...pkgEnv, ...stepEnv, ...spec.extraEnv,
          CI: 'true', LOCAL_CI: 'true', GITHUB_WORKSPACE: fwd(workspace), GITHUB_ENV: fwd(files.env), GITHUB_PATH: fwd(files.path), GITHUB_OUTPUT: fwd(files.out),
          GITHUB_STEP_SUMMARY: fwd(files.summary), GITHUB_EVENT_NAME: ctx.github.event_name, GITHUB_SHA: ctx.github.sha, GITHUB_REF: ctx.github.ref,
          GITHUB_REPOSITORY: ctx.github.repository ?? '', RUNNER_TEMP: fwd(runnerTemp), RUNNER_OS: ctx.runner.os,
        };
        if (extraPath.length) { const key = Object.keys(env).find((x) => x.toLowerCase() === 'path') || 'PATH'; env[key] = [...extraPath, env[key]].join(path.delimiter); }
        writeFileSync(files.out, '');
        const logFile = path.join(jobDir, `${String(k + 1).padStart(2, '0')}.log`);
        writeFileSync(logFile, `${spec.mapped ? `# 대체 규칙(${CONFIG_PATH}) — ${step.uses}\n` : ''}$ ${script}\n`);
        rec.log = path.relative(outDir, logFile);
        if (spec.mapped) rec.note = `대체 규칙으로 실행 (${CONFIG_PATH})`;
        if (echo) process.stdout.write(`\n── [${label}] ${k + 1}. ${sname}\n`);
        const remaining = Math.max(1000, jobTimeout - (Date.now() - t0));
        const stepTimeout = step['timeout-minutes'] ? Math.min(remaining, step['timeout-minutes'] * 60000) : remaining;
        const r = await runScript({ shell: spec.shell, script, cwd: path.resolve(workspace, wd), env, logFile, timeoutMs: stepTimeout, echo });
        rec.exitCode = r.code;
        if (r.note) rec.note = r.note;
        if (r.code !== 0) rec.status = step['continue-on-error'] ? 'success' : 'failure';
        if (r.code !== 0 && step['continue-on-error']) rec.note = `${rec.note ?? ''} 실패했지만 continue-on-error`.trim();
        /* 다음 단계로 넘길 환경·경로·출력 */
        Object.assign(jobEnv, parseKeyFile(files.env)); writeFileSync(files.env, '');
        if (existsSync(files.path)) { extraPath.unshift(...readFileSync(files.path, 'utf8').split(/\r?\n/).filter(Boolean).reverse()); writeFileSync(files.path, ''); }
        if (step.id) steps[step.id] = { outputs: parseKeyFile(files.out), outcome: r.code === 0 ? 'success' : 'failure', conclusion: rec.status };
      } else if (!step.uses) {
        rec.status = 'skipped'; rec.note = 'run 도 uses 도 없음';
      }
    } catch (e) {
      rec.status = 'failure'; rec.note = e instanceof ExprError ? `식 계산 실패: ${e.message}` : String(e.message || e);
    }
    rec.ms = Date.now() - st;
    if (rec.status === 'failure') result.status = 'failure';
  }
  /* 작업 출력 */
  for (const [k, v] of Object.entries(job.outputs || {})) { try { result.outputs[k] = interpolate(v, ctx); } catch { /* 계산 못 하면 뺀다 */ } }
  /* actions/cache 의 저장은 GitHub 처럼 작업이 통과했을 때만 */
  if (cache && result.status === 'success') {
    for (const ps of pendingSaves) { const n = cache.save(ps.key, ps.inside); if (n) result.cache.push({ key: ps.key, saved: n }); }
  }
  if (result.status !== 'failure' && result.steps.some((s) => s.secret || s.ruleSkip || /지원하지 않는/.test(s.note || ''))) result.partial = true;
  return result;
}

/** ref 를 detached 작업 사본으로 꺼낸다. 이 PC 의 core.autocrlf 와 상관없이 GitHub 리눅스 러너처럼 LF 로 꺼낸다
 * (.gitattributes 의 eol 지정은 그대로 따른다). */
export function makeWorkspace(repoDir, ref, baseDir) {
  const ws = path.join(baseDir, 'workspace');
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repoDir, 'worktree', 'add', '--detach', '--force', ws, ref], { stdio: 'pipe' });
  return ws;
}

/** 커밋된 셸 스크립트에 CRLF 가 있으면 GitHub 러너에서도 깨진다 — 미리 알린다. */
export function crlfScripts(ws) {
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.(sh|bash)$/i.test(ent.name) && readFileSync(abs).includes(13)) out.push(path.relative(ws, abs).split(path.sep).join('/'));
    }
  };
  walk(ws);
  return out;
}

export function bashVersion() {
  const v = versionOf(findBash(), ['--version']);
  const m = v && /version\s+(\d+(?:\.\d+)*)/.exec(v);
  return m ? m[1] : null;
}

export function removeWorkspace(repoDir, ws) {
  try { execFileSync('git', ['-C', repoDir, 'worktree', 'remove', '--force', ws], { stdio: 'pipe' }); } catch { /* 이미 없음 */ }
  try { execFileSync('git', ['-C', repoDir, 'worktree', 'prune'], { stdio: 'pipe' }); } catch { /* 무시 */ }
}

