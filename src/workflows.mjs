/* 워크플로 읽기·고르기 — 어느 워크플로·작업이 이 이벤트(pull_request/push)에서 돌아야 하는지 GitHub 규칙대로 정한다. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export function loadWorkflows(repoDir) {
  const dir = path.join(repoDir, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), 'utf8');
      const doc = parse(text, { uniqueKeys: false }) ?? {};
      return { file, name: doc.name ?? file, doc, text };
    });
}

/** on: 을 { 이벤트: 설정 } 꼴로. */
export function triggers(doc) {
  /* yaml 1.1 에서 'on' 이 true 로 읽히는 경우까지 받는다. */
  const on = doc.on ?? doc[true] ?? doc.true;
  if (!on) return {};
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
  return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v ?? {}]));
}

/** GitHub 경로·가지 이름 무늬(* ** ? [..] !)를 정규식으로. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') { const j = glob.indexOf(']', i); re += j > i ? glob.slice(i, j + 1) : '\\['; if (j > i) i = j; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 무늬 목록(앞에 ! 은 제외)과 값 하나 — GitHub 처럼 뒤의 무늬가 앞을 덮는다. */
export function matchPatterns(patterns, value) {
  let ok = false;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    if (globToRegExp(neg ? p.slice(1) : p).test(value)) ok = !neg;
  }
  return ok;
}

/**
 * 이 워크플로가 이벤트에서 도는가.
 * opts = { event, branch (push 가지 또는 pull_request 의 기준 가지), changedFiles: string[]|null }
 * 돌지 않으면 { run:false, reason } 을 돌려준다.
 */
export function shouldRun(doc, { event, branch, changedFiles }) {
  const tr = triggers(doc);
  if (!(event in tr)) return { run: false, reason: `${event} 이벤트로 돌지 않음(${Object.keys(tr).join(', ') || '없음'})` };
  const cfg = tr[event] || {};
  if (cfg.branches && branch && !matchPatterns([].concat(cfg.branches), branch)) return { run: false, reason: `가지 ${branch} 가 branches 에 없음` };
  if (cfg['branches-ignore'] && branch && matchPatterns([].concat(cfg['branches-ignore']), branch)) return { run: false, reason: `가지 ${branch} 가 branches-ignore` };
  if (changedFiles) {
    if (cfg.paths && !changedFiles.some((f) => matchPatterns([].concat(cfg.paths), f))) return { run: false, reason: 'paths 에 맞는 바뀐 파일 없음' };
    if (cfg['paths-ignore'] && changedFiles.length && changedFiles.every((f) => matchPatterns([].concat(cfg['paths-ignore']), f))) return { run: false, reason: '바뀐 파일이 모두 paths-ignore' };
  }
  return { run: true };
}

/** workflow_dispatch 입력 기본값. */
export function inputDefaults(doc) {
  const inputs = triggers(doc).workflow_dispatch?.inputs ?? {};
  return Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v?.default ?? (v?.type === 'boolean' ? false : '')]));
}

/** needs 순서대로 작업 이름을 줄 세운다. 고리가 있으면 오류. */
export function jobOrder(jobs) {
  const names = Object.keys(jobs ?? {});
  const done = new Set(); const seen = new Set(); const order = [];
  const visit = (n) => {
    if (done.has(n)) return;
    if (seen.has(n)) throw new Error(`needs 고리: ${n}`);
    seen.add(n);
    for (const d of [].concat(jobs[n]?.needs ?? [])) { if (!jobs[d]) throw new Error(`없는 작업 needs: ${d}`); visit(d); }
    done.add(n); order.push(n);
  };
  names.forEach(visit);
  return order;
}

/** strategy.matrix 를 조합 목록으로(include·exclude 포함). 식이 든 matrix 는 펼치지 못한다 → null. */
export function expandMatrix(strategy) {
  const m = strategy?.matrix;
  if (!m) return [{}];
  if (typeof m === 'string') return null;
  const keys = Object.keys(m).filter((k) => k !== 'include' && k !== 'exclude');
  let combos = [{}];
  for (const k of keys) {
    const vals = m[k];
    if (!Array.isArray(vals)) return null;
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  if (!keys.length) combos = [];
  const same = (a, b) => Object.entries(b).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v));
  for (const ex of [].concat(m.exclude ?? [])) combos = combos.filter((c) => !same(c, ex));
  for (const inc of [].concat(m.include ?? [])) {
    const base = Object.fromEntries(Object.entries(inc).filter(([k]) => keys.includes(k)));
    const hit = combos.filter((c) => Object.keys(base).length && same(c, base));
    if (hit.length) hit.forEach((c) => Object.assign(c, inc)); else combos.push({ ...inc });
  }
  return combos.length ? combos : [{}];
}
