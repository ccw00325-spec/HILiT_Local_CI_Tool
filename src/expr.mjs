/* GitHub Actions 식(`${{ ... }}`) 계산기 — 로컬 실행에 필요한 만큼만.
 *
 * 지원: 문자열('..', '' 이스케이프)·숫자·true/false/null, 속성 접근(a.b, a['b'], a.*.b 는 미지원), ! && || == != < <= > >=, 괄호,
 * 함수 success() failure() always() cancelled() contains() startsWith() endsWith() format() join() toJSON() fromJSON() hashFiles().
 * 값 규칙은 GitHub 과 같게: 문자열 비교는 대소문자를 가리지 않고, && || 는 마지막으로 본 값을 돌려준다.
 */

export class ExprError extends Error {}

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === "'") {
      let s = '';
      i += 1;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { s += "'"; i += 2; continue; }
        if (src[i] === "'") break;
        s += src[i]; i += 1;
      }
      if (src[i] !== "'") throw new ExprError(`닫히지 않은 문자열: ${src}`);
      i += 1;
      out.push({ t: 'str', v: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('!<>()[],.'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }
    const num = /^-?(0x[0-9a-f]+|\d+(\.\d+)?(e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && (c !== '-' || /\d/.test(src[i + 1] || ''))) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new ExprError(`알 수 없는 글자 '${c}': ${src}`);
  }
  return out;
}

const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '' || Number.isNaN(v));

function coerceNum(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return NaN;
}

function equals(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b && (typeof a === 'object')) return a === b;
  if (typeof a === typeof b) return a === b;
  return coerceNum(a) === coerceNum(b);
}

const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

function makeFunctions(ctx) {
  return {
    success: () => ctx.status === 'success',
    failure: () => ctx.status === 'failure',
    always: () => true,
    cancelled: () => false,
    contains: (hay, needle) => {
      if (Array.isArray(hay)) return hay.some((x) => equals(x, needle));
      return String(lower(hay ?? '')).includes(String(lower(needle ?? '')));
    },
    startsWith: (a, b) => String(lower(a ?? '')).startsWith(String(lower(b ?? ''))),
    endsWith: (a, b) => String(lower(a ?? '')).endsWith(String(lower(b ?? ''))),
    format: (fmt, ...args) => String(fmt).replace(/\{(\d+)\}/g, (_, k) => String(args[Number(k)] ?? '')),
    join: (arr, sep = ',') => (Array.isArray(arr) ? arr.join(sep) : String(arr ?? '')),
    toJSON: (v) => JSON.stringify(v, null, 2),
    fromJSON: (s) => JSON.parse(s),
    hashFiles: (...patterns) => (ctx.hashFiles ? ctx.hashFiles(patterns) : ''),
  };
}

/** 식 하나를 계산한다. ctx = { github, env, inputs, matrix, steps, runner, secrets, needs, vars, job, status, hashFiles, onSecret }. */
export function evaluate(src, ctx = {}) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p]?.t === 'op' && toks[p].v === v;
  const eat = (v) => { if (!isOp(v)) throw new ExprError(`'${v}' 가 필요합니다: ${src}`); p += 1; };
  const fns = makeFunctions(ctx);

  function primary() {
    const tk = peek();
    if (!tk) throw new ExprError(`식이 끝났습니다: ${src}`);
    if (isOp('(')) { p += 1; const v = orExpr(); eat(')'); return v; }
    if (tk.t === 'str' || tk.t === 'num') { p += 1; return tk.v; }
    if (tk.t === 'id') {
      p += 1;
      if (tk.v === 'true') return true;
      if (tk.v === 'false') return false;
      if (tk.v === 'null') return null;
      if (isOp('(')) {
        p += 1;
        const args = [];
        if (!isOp(')')) { args.push(orExpr()); while (isOp(',')) { p += 1; args.push(orExpr()); } }
        eat(')');
        const fn = fns[tk.v] ?? fns[Object.keys(fns).find((k) => k.toLowerCase() === tk.v.toLowerCase())];
        if (!fn) throw new ExprError(`지원하지 않는 함수 ${tk.v}()`);
        return fn(...args);
      }
      if (tk.v === 'secrets') ctx.onSecret?.();
      let v = ctx[tk.v];
      const path = [tk.v];
      for (;;) {
        if (isOp('.')) {
          p += 1;
          const name = peek();
          if (!name || name.t !== 'id') throw new ExprError(`'.' 뒤 이름이 필요합니다: ${src}`);
          p += 1; path.push(name.v);
          v = v === null || v === undefined ? undefined : v[name.v];
        } else if (isOp('[')) {
          p += 1; const k = orExpr(); eat(']'); path.push(String(k));
          v = v === null || v === undefined ? undefined : v[k];
        } else break;
      }
      if (path[0] === 'secrets' && path.length > 1) ctx.onSecret?.(path[1]);
      return v === undefined ? null : v;
    }
    throw new ExprError(`예상하지 못한 '${tk.v}': ${src}`);
  }
  function unary() {
    if (isOp('!')) { p += 1; return !truthy(unary()); }
    return primary();
  }
  function cmp() {
    let a = unary();
    const tk = peek();
    if (tk?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(tk.v)) {
      p += 1;
      const b = unary();
      switch (tk.v) {
        case '==': a = equals(a, b); break;
        case '!=': a = !equals(a, b); break;
        case '<': a = coerceNum(a) < coerceNum(b); break;
        case '<=': a = coerceNum(a) <= coerceNum(b); break;
        case '>': a = coerceNum(a) > coerceNum(b); break;
        default: a = coerceNum(a) >= coerceNum(b);
      }
    }
    return a;
  }
  function andExpr() {
    let a = cmp();
    while (isOp('&&')) { p += 1; const b = cmp(); a = truthy(a) ? b : a; }
    return a;
  }
  function orExpr() {
    let a = andExpr();
    while (isOp('||')) { p += 1; const b = andExpr(); a = truthy(a) ? a : b; }
    return a;
  }
  const v = orExpr();
  if (p !== toks.length) throw new ExprError(`남은 글자가 있습니다: ${src}`);
  return v;
}

/** 문자열 안의 `${{ }}` 를 모두 바꾼다. 문자열이 아니면 그대로. */
export function interpolate(value, ctx) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = evaluate(e, ctx);
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

/** `if:` 조건. 상태 함수가 없으면 success() && (조건) 으로 본다(GitHub 규칙). */
export function condition(src, ctx) {
  if (src === undefined || src === null || src === '') return ctx.status === 'success';
  if (typeof src === 'boolean') return src && ctx.status === 'success';
  let s = String(src).trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(s);
  if (m) s = m[1];
  const hasStatus = /\b(success|failure|always|cancelled)\s*\(/i.test(s);
  const v = evaluate(s, ctx);
  return hasStatus ? truthy(v) : ctx.status === 'success' && truthy(v);
}

export { truthy };
