/* 로컬 캐시 — actions/cache 를 이 PC 폴더로 흉내 내고, npm·pip·yarn 패키지 캐시를 실행마다 다시 쓴다.
 *
 *   <캐시 폴더>/<저장소>/entries/<키 해시>/meta.json + data/<경로 순번>/
 *   <캐시 폴더>/<저장소>/pkg/{npm,pip,yarn}
 *
 * GitHub 와 같게: 키가 정확히 맞으면 cache-hit=true, restore-keys 앞부분이 맞으면 가장 최근 것을 되살리고 cache-hit=false,
 * 작업이 통과했고 정확히 맞은 적이 없을 때만 작업 끝에 저장한다.
 * 작업 사본 밖 경로(~/.npm 등)는 이 PC 의 실제 폴더를 덮어쓰게 되므로 저장·복원하지 않는다 — 패키지 캐시 폴더가 그 역할을 한다. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { matchPatterns } from './workflows.mjs';

export function defaultCacheRoot() {
  if (process.env.LOCAL_CI_CACHE_DIR) return process.env.LOCAL_CI_CACHE_DIR;
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  return path.join(base, 'local-ci');
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export class LocalCache {
  /** root = 캐시 폴더, repoKey = 저장소별 칸 이름 */
  constructor(root, repoKey) {
    this.dir = path.join(root, repoKey.replace(/[^\w.-]+/g, '_'));
    this.entries = path.join(this.dir, 'entries');
  }

  /** 패키지 관리자가 쓸 캐시 폴더(환경 변수). 워크플로·단계 env 가 같은 이름을 정하면 그쪽이 이긴다. */
  packageEnv() {
    const pkg = path.join(this.dir, 'pkg');
    const env = { npm_config_cache: path.join(pkg, 'npm'), PIP_CACHE_DIR: path.join(pkg, 'pip'), YARN_CACHE_FOLDER: path.join(pkg, 'yarn') };
    for (const d of Object.values(env)) mkdirSync(d, { recursive: true });
    return env;
  }

  /** 작업 사본 안 경로만 고른다. 돌려주는 것: { inside: [{rel, abs}], outside: [원래 문자열] } */
  static splitPaths(paths, workspace) {
    const inside = []; const outside = [];
    for (const raw of paths) {
      if (raw.startsWith('!')) continue;
      const p = raw.replace(/^~(?=$|[\\/])/, os.homedir());
      const abs = path.resolve(workspace, p);
      const rel = path.relative(workspace, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) outside.push(raw); else inside.push({ rel: rel.split(path.sep).join('/'), abs });
    }
    return { inside, outside };
  }

  #entryDir(key) { return path.join(this.entries, sha(key).slice(0, 32)); }

  #meta(dir) { try { return JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; } }

  /** 키로 찾는다. 정확히 맞는 것 → restore-keys 앞부분이 맞는 것 중 가장 최근 것. 없으면 null. */
  find(key, restoreKeys = []) {
    const exact = this.#entryDir(key);
    const m = this.#meta(exact);
    if (m && m.key === key) return { dir: exact, meta: m, exact: true };
    if (!existsSync(this.entries)) return null;
    const all = readdirSync(this.entries).map((d) => ({ dir: path.join(this.entries, d), meta: this.#meta(path.join(this.entries, d)) })).filter((e) => e.meta);
    for (const prefix of restoreKeys) {
      const hits = all.filter((e) => e.meta.key.startsWith(prefix)).sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
      if (hits.length) return { ...hits[0], exact: false };
    }
    return null;
  }

  /** 찾은 항목을 작업 사본에 되살린다. 저장할 때와 같은 경로 목록만 되살린다. */
  restore(entry, inside) {
    let n = 0;
    for (const p of inside) {
      const i = entry.meta.paths.indexOf(p.rel);
      if (i < 0) continue;
      const src = path.join(entry.dir, 'data', String(i));
      if (!existsSync(src)) continue;
      mkdirSync(path.dirname(p.abs), { recursive: true });
      cpSync(src, p.abs, { recursive: true, force: true });
      n += 1;
    }
    return n;
  }

  /** 작업 사본의 경로들을 키로 저장한다. 저장한 경로 수를 돌려준다. */
  save(key, inside) {
    const dir = this.#entryDir(key);
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    const saved = [];
    for (const p of inside) {
      if (!existsSync(p.abs)) continue;
      cpSync(p.abs, path.join(tmp, 'data', String(saved.length)), { recursive: true });
      saved.push(p.rel);
    }
    if (!saved.length) { rmSync(tmp, { recursive: true, force: true }); return 0; }
    writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ key, paths: saved, savedAt: new Date().toISOString() }, null, 2));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(tmp, dir, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    return saved.length;
  }
}

/** GitHub hashFiles(): 작업 사본에서 무늬에 맞는 파일마다 sha256 → 그 값들을 이어 다시 sha256. 맞는 파일이 없으면 ''. */
export function hashFiles(workspace, patterns) {
  const pats = patterns.flatMap((p) => String(p).split('\n')).map((p) => p.trim()).filter(Boolean)
    .map((p) => (p.startsWith('!') ? `!${normalizePattern(p.slice(1), workspace)}` : normalizePattern(p, workspace)));
  if (!pats.length) return '';
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) {
        const rel = path.relative(workspace, abs).split(path.sep).join('/');
        if (matchPatterns(pats, rel)) files.push(abs);
      }
    }
  };
  walk(workspace);
  if (!files.length) return '';
  files.sort();
  const outer = createHash('sha256');
  for (const f of files) outer.update(createHash('sha256').update(readFileSync(f)).digest());
  return outer.digest('hex');
}

function normalizePattern(p, workspace) {
  let x = p.replace(/\\/g, '/');
  const ws = workspace.replace(/\\/g, '/').replace(/\/$/, '');
  if (x.startsWith(`${ws}/`)) x = x.slice(ws.length + 1);
  return x.replace(/^\.\//, '');
}

/** 폴더 크기(바이트) — 보고용. */
export function sizeOf(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return st.size;
    return readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch { return 0; }
}
