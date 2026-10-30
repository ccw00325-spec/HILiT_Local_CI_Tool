/* 검사할 저장소의 .github/local-ci.yml — 로컬 CI 가 기본으로 모르는 action 을 대신 돌릴 명령으로 바꾸거나, 이유를 적고 건너뛴다.
 *
 *   actions:
 *     docker/build-push-action:      # uses: 의 @버전 앞 이름(대소문자 무시)
 *       run: docker build -t "$INPUT_TAGS" .
 *       shell: bash                  # 생략하면 bash
 *     aws-actions/configure-aws-credentials:
 *       skip: 로컬에서는 클라우드에 로그인하지 않음
 *
 * run 에는 ${{ }} 식을 쓸 수 있고, 원래 단계의 with: 값은 GitHub 처럼 INPUT_<이름> 환경 변수로 들어온다.
 * 이 파일도 워크플로처럼 실행할 커밋에 들어 있는 것을 읽는다. */
import { parse } from 'yaml';

export const CONFIG_PATH = '.github/local-ci.yml';

export class ConfigError extends Error {}

/** 텍스트를 읽어 { actions: { 이름: { run, shell } | { skip } } } 로. 틀린 곳이 있으면 ConfigError. */
export function parseLocalConfig(text, file = CONFIG_PATH) {
  if (text == null || !String(text).trim()) return { actions: {} };
  let doc;
  try { doc = parse(String(text)) ?? {}; } catch (e) { throw new ConfigError(`${file}: YAML 을 읽지 못했습니다 — ${e.message}`); }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new ConfigError(`${file}: 맨 위는 키-값이어야 합니다`);
  const unknownTop = Object.keys(doc).filter((k) => k !== 'actions');
  if (unknownTop.length) throw new ConfigError(`${file}: 모르는 항목 ${unknownTop.join(', ')} (actions 만 씁니다)`);
  const actions = {};
  for (const [rawName, rule] of Object.entries(doc.actions ?? {})) {
    const name = actionName(rawName);
    const where = `${file}: actions."${rawName}"`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new ConfigError(`${where} 는 run 또는 skip 을 가진 키-값이어야 합니다`);
    const keys = Object.keys(rule);
    const bad = keys.filter((k) => !['run', 'shell', 'skip'].includes(k));
    if (bad.length) throw new ConfigError(`${where}: 모르는 항목 ${bad.join(', ')} (run · shell · skip 만 씁니다)`);
    const hasRun = rule.run !== undefined; const hasSkip = rule.skip !== undefined;
    if (hasRun === hasSkip) throw new ConfigError(`${where}: run 과 skip 중 하나만 적어야 합니다`);
    if (hasRun && (typeof rule.run !== 'string' || !rule.run.trim())) throw new ConfigError(`${where}.run 이 비어 있습니다`);
    if (hasSkip && (typeof rule.skip !== 'string' || !rule.skip.trim())) throw new ConfigError(`${where}.skip 에 건너뛰는 이유를 적어야 합니다`);
    if (rule.shell !== undefined && !hasRun) throw new ConfigError(`${where}: shell 은 run 과 함께만 씁니다`);
    if (actions[name]) throw new ConfigError(`${where}: 같은 action 이 두 번 있습니다`);
    actions[name] = hasRun ? { run: rule.run, shell: rule.shell ?? 'bash' } : { skip: rule.skip.trim() };
  }
  return { actions };
}

/** uses: 값에서 대체 규칙을 찾을 이름(@버전 앞, 소문자). */
export function actionName(uses) {
  return String(uses).trim().split('@')[0].toLowerCase();
}

/** with: 값을 GitHub 처럼 INPUT_<대문자 이름> 으로. 이름의 - 와 공백은 _ 로 바꾼 이름도 함께 둔다(bash 에서 쓰기 쉽게). */
export function inputEnv(withArgs) {
  const env = {};
  for (const [k, v] of Object.entries(withArgs || {})) {
    const up = k.toUpperCase().replace(/ /g, '_');
    env[`INPUT_${up}`] = String(v);
    env[`INPUT_${up.replace(/-/g, '_')}`] = String(v);
  }
  return env;
}
