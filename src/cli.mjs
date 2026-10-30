#!/usr/bin/env node
/* local-ci — GitHub Actions 를 못 쓸 때(결제 문제·사용량 한도) 같은 워크플로 단계를 이 PC 의 깨끗한 작업 사본에서 돌린다.
 *
 *   local-ci list [--repo .] [--event pull_request] [--ref HEAD] [--base origin/main]
 *   local-ci run  [--repo .] [--event pull_request] [--ref HEAD] [--base origin/main] [--workflow ci.yml] [--job web]
 *                 [--post] [--pr 12] [--out <폴더>] [--keep] [--quiet] [--no-cache] [--cache-dir <폴더>]
 *
 * 검사할 저장소에 .github/local-ci.yml 이 있으면 모르는 action 을 대신 돌릴 명령(대체 규칙)으로 쓴다.
 * actions/cache 와 npm·pip·yarn 패키지 캐시는 기본으로 이 PC 캐시 폴더에 저장해 다음 실행에 다시 쓴다(--no-cache 로 끔).
 * --post 는 결과를 커밋 상태(local-ci/<워크플로 이름>)로, --pr 이 있으면 PR 댓글로도 남긴다(gh 로그인 필요).
 * 종료 코드: 0 통과 · 1 실패 · 2 사용법 오류.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadWorkflows, shouldRun, inputDefaults, jobOrder, expandMatrix } from './workflows.mjs';
import { runJob, makeWorkspace, removeWorkspace, crlfScripts, bashVersion, BUILTIN_ACTIONS } from './runner.mjs';
import { CONFIG_PATH, parseLocalConfig, actionName } from './local-config.mjs';
import { LocalCache, defaultCacheRoot } from './cache.mjs';
import { summarize, toMarkdown, postToGitHub, repoSlug } from './report.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['post', 'keep', 'quiet', 'help', 'no-cache'].includes(key)) { out[key] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`--${key} 값이 없습니다`);
    i += 1;
    if (['workflow', 'job'].includes(key)) (out[key] ||= []).push(v); else out[key] = v;
  }
  return out;
}

const git = (repo, ...args) => String(execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })).trim();

function plan(opts) {
  const repo = path.resolve(opts.repo || '.');
  const event = opts.event || 'pull_request';
  const ref = opts.ref || 'HEAD';
  const sha = git(repo, 'rev-parse', `${ref}^{commit}`);
  /* push 는 GitHub 처럼 바로 앞 커밋과 견줘 paths 를 본다. */
  let base = opts.base ?? (event === 'pull_request' ? 'origin/main' : null);
  if (!base && event === 'push') { try { git(repo, 'rev-parse', `${sha}~1`); base = `${sha}~1`; } catch { base = null; } }
  let changed = null;
  if (base) {
    try { changed = git(repo, 'diff', '--name-only', `${base}...${sha}`).split('\n').filter(Boolean); } catch { changed = null; }
  }
  let branch = null;
  if (event === 'pull_request') branch = base ? base.replace(/^origin\//, '') : 'main';
  else { try { branch = git(repo, 'rev-parse', '--abbrev-ref', ref); } catch { branch = null; } if (branch === 'HEAD') branch = null; }
  if (branch) branch = branch.replace(/^(origin|upstream)\//, '');
  if (opts.branch) branch = opts.branch;
  /* 워크플로는 실행할 커밋의 것을 읽는다(작업 폴더의 미커밋 수정이 끼지 않게). */
  const tmp = path.join(os.tmpdir(), `local-ci-read-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  let wfs = [];
  const files = git(repo, 'ls-tree', '--name-only', `${sha}:.github/workflows`).split('\n').filter((f) => /\.ya?ml$/i.test(f));
  mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true });
  for (const f of files) writeFileSync(path.join(tmp, '.github', 'workflows', f), execFileSync('git', ['-C', repo, 'show', `${sha}:.github/workflows/${f}`]));
  wfs = loadWorkflows(tmp);
  rmSync(tmp, { recursive: true, force: true });
  /* 대체 규칙도 실행할 커밋의 것을 읽는다. */
  let configText = null;
  try { configText = String(execFileSync('git', ['-C', repo, 'show', `${sha}:${CONFIG_PATH}`], { stdio: ['ignore', 'pipe', 'pipe'] })); } catch { configText = null; }
  const config = parseLocalConfig(configText);
  const selected = wfs
    .filter((w) => !opts.workflow || opts.workflow.some((x) => x === w.file || x === w.name))
    .map((w) => ({ ...w, ...shouldRun(w.doc, { event, branch, changedFiles: changed }) }));
  return { repo, event, ref, sha, base, branch, changed, workflows: selected, config, hasConfig: configText !== null };
}

function printPlan(p) {
  console.log(`저장소 ${p.repo}\n커밋 ${p.sha.slice(0, 10)} · 이벤트 ${p.event}${p.base ? ` · 기준 ${p.base}` : ''}${p.changed ? ` · 바뀐 파일 ${p.changed.length}` : ''}`);
  const nRules = Object.keys(p.config.actions).length;
  console.log(p.hasConfig ? `대체 규칙 ${CONFIG_PATH}: ${nRules}개` : `대체 규칙 없음(${CONFIG_PATH})`);
  console.log('표시: 🔒 비밀 키 필요 · ↪ 대체 규칙으로 실행 · ⤼ 대체 규칙으로 건너뜀 · ⚠ 모르는 action(건너뜀)');
  for (const w of p.workflows) {
    console.log(`${w.run ? '▶' : '⏭'} ${w.name} (${w.file})${w.run ? '' : ` — ${w.reason}`}`);
    if (!w.run) continue;
    for (const j of jobOrder(w.doc.jobs)) {
      const job = w.doc.jobs[j];
      const mx = expandMatrix(job.strategy);
      console.log(`   · ${j}${mx === null ? ' (matrix 식은 펼치지 못함)' : mx.length > 1 ? ` ×${mx.length}` : ''} — 단계 ${(job.steps || []).length}개`);
      for (const s of job.steps || []) {
        const secret = /\bsecrets\s*\./.test(JSON.stringify(s));
        let mark = secret ? '🔒' : '-';
        if (!secret && s.uses) {
          const r = p.config.actions[actionName(s.uses)];
          mark = r?.run ? '↪' : r?.skip ? '⤼' : BUILTIN_ACTIONS.has(actionName(s.uses)) ? '-' : '⚠';
        }
        console.log(`       ${mark} ${s.name ?? (s.uses ? `uses ${s.uses}` : String(s.run).split('\n')[0].slice(0, 80))}`);
      }
    }
  }
}

async function run(opts) {
  const p = plan(opts);
  if (!opts.quiet) printPlan(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(opts.out || path.join(os.tmpdir(), 'local-ci', `${path.basename(p.repo)}-${p.sha.slice(0, 8)}-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  let slug = null; try { slug = repoSlug(p.repo); } catch { /* origin 없음 */ }
  const cacheRoot = opts['cache-dir'] ? path.resolve(opts['cache-dir']) : defaultCacheRoot();
  const cache = opts['no-cache'] ? null : new LocalCache(cacheRoot, slug ?? path.basename(p.repo));
  const runRec = {
    repo: p.repo, sha: p.sha, event: p.event, base: p.base, startedAt: new Date().toISOString(),
    host: { platform: `${process.platform}-${os.arch()}`, node: process.version, bash: bashVersion(), eol: 'LF로 꺼냄', cache: cache ? cache.dir : '꺼짐' },
    rules: Object.keys(p.config.actions).length, notes: [],
    workflows: p.workflows.map(({ file, name, run: r, reason }) => ({ file, name, run: r, reason })), jobs: [],
  };
  const toRun = p.workflows.filter((w) => w.run);
  /* 러너 OS 와 이 PC 가 다르면 한 번 알린다. */
  const runsOn = new Set(toRun.flatMap((w) => Object.values(w.doc.jobs || {}).map((j) => JSON.stringify(j['runs-on'] ?? '')).filter(Boolean)));
  const wantsLinux = [...runsOn].some((x) => /ubuntu|linux/i.test(x));
  if (wantsLinux && process.platform !== 'linux') {
    runRec.notes.push(`워크플로는 리눅스 러너(ubuntu)를 쓰고 이 PC는 ${process.platform === 'win32' ? 'Windows' : 'macOS'}입니다. 셸 단계는 bash 로 돌리고 작업 사본은 LF 로 꺼내며 경로는 / 로 맞췄지만, 리눅스 전용 명령(apt-get 등)·대소문자 구분 경로는 다르게 동작할 수 있습니다.`);
  }
  let ws = null;
  try {
    if (toRun.length) {
      ws = makeWorkspace(p.repo, p.sha, outDir);
      const crlf = crlfScripts(ws);
      if (crlf.length) runRec.notes.push(`커밋된 셸 스크립트에 CRLF 가 있습니다(${crlf.slice(0, 5).join(', ')}${crlf.length > 5 ? ` 외 ${crlf.length - 5}개` : ''}). GitHub 러너에서도 \$'\\r' 오류가 날 수 있으니 LF 로 바꾸거나 .gitattributes 에 eol=lf 를 두세요.`);
    }
    const github = {
      event_name: p.event, sha: p.sha, ref: p.event === 'pull_request' ? `refs/pull/${opts.pr ?? 0}/merge` : `refs/heads/${p.branch ?? ''}`,
      ref_name: p.branch ?? '', base_ref: p.event === 'pull_request' ? p.branch : '', head_ref: '', repository: slug ?? '', repository_owner: slug?.split('/')[0] ?? '',
      actor: 'local-ci', run_id: String(Date.now()), run_number: '1', server_url: 'https://github.com', event: {},
    };
    for (const w of toRun) {
      const order = jobOrder(w.doc.jobs);
      const needsOut = {};
      for (const j of order) {
        if (opts.job && !opts.job.includes(j)) continue;
        const job = w.doc.jobs[j];
        const deps = [].concat(job.needs ?? []);
        const depFailed = deps.some((d) => needsOut[d]?.result !== 'success');
        const mx = expandMatrix(job.strategy);
        if (mx === null) { runRec.jobs.push({ name: j, file: w.file, workflow: w.name, status: 'skipped', reason: 'matrix 식은 펼치지 못함', steps: [], warnings: [] }); needsOut[j] = { result: 'skipped', outputs: {} }; continue; }
        if (depFailed && !/always\(\)/.test(String(job.if ?? ''))) { runRec.jobs.push({ name: j, file: w.file, workflow: w.name, status: 'skipped', reason: `앞 작업(${deps.join(', ')})이 통과하지 않음`, steps: [], warnings: [] }); needsOut[j] = { result: 'skipped', outputs: {} }; continue; }
        let agg = 'success'; let outputs = {};
        for (const m of mx) {
          const r = await runJob({ wf: w, jobName: j, job, matrix: m, workspace: ws, outDir, github, inputs: inputDefaults(w.doc), needs: needsOut, echo: !opts.quiet, config: p.config, cache });
          runRec.jobs.push(r);
          if (r.status === 'failure') agg = 'failure';
          else if (r.status === 'skipped' && agg === 'success' && mx.length === 1) agg = 'skipped';
          outputs = { ...outputs, ...r.outputs };
          if (r.status === 'failure' && job.strategy?.['fail-fast'] !== false && mx.length > 1) break;
        }
        needsOut[j] = { result: agg, outputs };
      }
    }
  } finally {
    if (ws && !opts.keep) removeWorkspace(p.repo, ws);
  }
  runRec.ms = Date.now() - t0;
  const md = toMarkdown(runRec);
  writeFileSync(path.join(outDir, 'summary.md'), md);
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(runRec, null, 2));
  console.log(`\n${md}\n\n로그: ${outDir}`);
  const s = summarize(runRec);
  if (opts.post) {
    const slug = repoSlug(p.repo);
    const posted = postToGitHub(runRec, { slug, pr: opts.pr, mdFile: path.join(outDir, 'comment.md') });
    console.log(`GitHub 에 남김: ${posted.join(', ')}`);
  }
  return s.state === 'failure' ? 1 : 0;
}

const HELP = `local-ci — GitHub Actions 워크플로를 로컬 깨끗한 작업 사본에서 돌립니다.

  local-ci list [--repo .] [--event pull_request|push] [--ref HEAD] [--base origin/main]
  local-ci run  [--repo .] [--event pull_request|push] [--ref HEAD] [--base origin/main] [--branch main]
                [--workflow ci.yml]... [--job web]... [--post] [--pr N] [--out 폴더] [--keep] [--quiet]
                [--no-cache] [--cache-dir 폴더]

  .github/local-ci.yml 대체 규칙 · 로컬 캐시(기본 켬) · 작업 사본은 항상 LF 로 꺼냄 — README 참고
`;

try {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  if (opts.help || !cmd) { console.log(HELP); process.exit(cmd ? 0 : 2); }
  if (cmd === 'list') { printPlan(plan(opts)); process.exit(0); }
  if (cmd === 'run') process.exit(await run(opts));
  console.error(`모르는 명령: ${cmd}\n${HELP}`); process.exit(2);
} catch (e) {
  console.error(`local-ci: ${e.message}`);
  process.exit(2);
}

