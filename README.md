# HILiT Local CI Tool (`local-ci`)

GitHub Actions를 쓸 수 없을 때(결제 문제, 사용량 한도, 네트워크 등) **저장소의 `.github/workflows`를 그대로 읽어 같은 단계를 이 PC의 깨끗한 작업 사본에서 돌리는 도구**입니다. 돌린 결과는 GitHub 커밋 상태(`local-ci/<워크플로 이름>`)와 PR 댓글로 남길 수 있습니다.

- 실행할 커밋을 `git worktree`로 따로 꺼내서 돌립니다. 작업 폴더에 남아 있는 커밋하지 않은 수정은 섞이지 않습니다.
- 워크플로 파일도 실행할 커밋에 들어 있는 것을 읽습니다.
- **비밀 키(`secrets.*`)를 쓰는 단계는 돌리지 않습니다.** 결과에 "비밀 키 필요 — 로컬에서 돌리지 않음"으로 표시합니다. 이 도구는 비밀 키를 읽거나 넘기지 않습니다.

## 설치

```bash
git clone https://github.com/ccw00325-spec/HILiT_Local_CI_Tool.git
cd HILiT_Local_CI_Tool && npm ci
```

필요한 것: Node.js 20 이상, git, bash(Windows는 Git Bash를 자동으로 찾습니다. `LOCAL_CI_BASH`로 바꿀 수 있습니다), 결과를 남길 때는 로그인된 `gh` CLI.

## 쓰는 법

```bash
# 어떤 워크플로·작업·단계가 돌지 미리 보기(🔒 = 비밀 키 필요 단계)
node src/cli.mjs list --repo ../MyRepo --event pull_request --ref my-branch --base origin/main

# PR 검사 대신 돌리기
node src/cli.mjs run --repo ../MyRepo --event pull_request --ref my-branch --base origin/main

# 결과를 GitHub에 남기기(커밋 상태 + PR 댓글)
node src/cli.mjs run --repo ../MyRepo --ref my-branch --post --pr 47

# main 병합 뒤(push) 검사
node src/cli.mjs run --repo ../MyRepo --event push --ref origin/main
```

| 옵션 | 뜻 |
|---|---|
| `--event pull_request\|push` | 어떤 이벤트로 볼지. 기본값은 `pull_request` |
| `--ref` | 돌릴 커밋·가지. 기본값은 `HEAD` |
| `--base` | 바뀐 파일(`paths` 거르기)을 셀 기준. PR이면 기본값 `origin/main`, push면 바로 앞 커밋 |
| `--branch` | `branches` 거르기에 쓸 가지 이름(자동으로 알아낸 값을 덮어씀) |
| `--workflow`, `--job` | 특정 워크플로 파일·이름, 작업만 돌림(여러 번 줄 수 있음) |
| `--post`, `--pr N` | 커밋 상태를 남기고, PR이 있으면 댓글도 남김 |
| `--out` | 로그·요약을 둘 폴더(기본값은 OS 임시 폴더) |
| `--keep` | 끝난 뒤 작업 사본을 지우지 않음 |
| `--quiet` | 단계 출력을 화면에 흘리지 않고 요약만 출력 |
| `--no-cache` | 로컬 캐시를 쓰지 않음(저장도 복원도 하지 않음) |
| `--cache-dir` | 캐시 폴더(기본값: Windows `%LOCALAPPDATA%\local-ci`, macOS `~/Library/Caches/local-ci`, Linux `~/.cache/local-ci`, 또는 `LOCAL_CI_CACHE_DIR`) |

## 모르는 action 대신 돌리기 — `.github/local-ci.yml`

로컬 CI가 직접 처리하지 않는 `uses:` action(도커 빌드, 클라우드 로그인 등)은 기본으로 건너뛰고, 어떤 입력을 받는 action이었는지와 대체 방법을 결과에 경고로 남깁니다.
검사할 저장소에 `.github/local-ci.yml`을 두면 그 action을 대신 돌릴 명령으로 바꾸거나, 이유를 적고 건너뛸 수 있습니다. 이 파일도 워크플로처럼 **실행할 커밋에 들어 있는 것**을 읽습니다.

```yaml
actions:
  docker/build-push-action:            # uses: 의 @버전 앞 이름(대소문자 무시)
    run: docker build -t "$INPUT_TAGS" .
    shell: bash                        # 생략하면 bash
  aws-actions/configure-aws-credentials:
    skip: 로컬에서는 클라우드에 로그인하지 않음
```

- `run`에는 `${{ }}` 식을 쓸 수 있습니다. 원래 단계의 `with:` 값은 GitHub처럼 `INPUT_<이름>` 환경 변수로 들어옵니다(`build-args` → `INPUT_BUILD-ARGS`, bash에서 쓰기 쉬운 `INPUT_BUILD_ARGS`도 함께).
- `run`과 `skip` 중 하나만 적습니다. `skip`에는 이유를 적어야 합니다. 형식이 틀리면 종료 코드 `2`로 멈춥니다.
- `list`에서 `↪`(대체 실행) · `⤼`(대체 규칙으로 건너뜀) · `⚠`(모르는 action) 표시로 미리 볼 수 있습니다.
- 대체 규칙으로 건너뛴 단계가 있는 작업은 "통과(일부 단계 건너뜀)"로 표시됩니다.

## 로컬 캐시

기본으로 켜져 있습니다. 같은 저장소를 다시 검사할 때 의존성 설치를 처음부터 하지 않게 합니다.

- `actions/cache`·`actions/cache/restore`·`actions/cache/save`: `key`가 정확히 맞으면 되살리고 `cache-hit=true`, `restore-keys` 앞부분이 맞으면 가장 최근 것을 되살리고 `cache-hit=false`. 작업이 통과했고 정확히 맞은 적이 없을 때만 작업 끝에 저장합니다(GitHub와 같음). `hashFiles()`도 GitHub와 같은 방식으로 계산합니다.
- 작업 사본 밖 경로(`~/.npm` 등)는 이 PC의 실제 폴더를 덮어쓰게 되므로 저장·복원하지 않습니다. 대신 모든 단계에 **npm·pip·yarn 패키지 캐시 폴더**(`npm_config_cache`·`PIP_CACHE_DIR`·`YARN_CACHE_FOLDER`)를 캐시 폴더 안으로 지정해, `npm ci`처럼 깨끗하게 설치하는 단계도 받은 패키지를 다시 씁니다. 워크플로가 같은 환경 변수를 정하면 워크플로 값이 이깁니다.

## 운영체제 차이 줄이기

- **작업 사본은 이 PC의 `core.autocrlf`와 상관없이 항상 LF로 꺼냅니다.** GitHub 리눅스 러너와 같은 줄바꿈이라 Windows에서도 셸 스크립트가 `$'\r'` 오류로 깨지지 않습니다. `.gitattributes`의 `eol` 지정은 그대로 따릅니다.
- 커밋된 `.sh`·`.bash` 파일 자체에 CRLF가 있으면(GitHub에서도 깨지는 경우) 결과 맨 위에 경고로 알립니다.
- Windows에서는 `GITHUB_WORKSPACE`·`RUNNER_TEMP`·`GITHUB_OUTPUT` 등 경로와 `${{ github.workspace }}`·`${{ runner.temp }}`를 `/` 구분자로 넘깁니다. Git Bash에서 `\`가 이스케이프로 읽혀 경로가 깨지는 일을 막습니다.
- 워크플로가 리눅스 러너를 쓰는데 이 PC가 Windows·macOS이면, 다르게 동작할 수 있는 점을 결과에 한 번 적습니다. 결과의 "실행 환경" 줄에는 bash 버전·줄바꿈 방식·캐시 여부가 함께 기록됩니다.

종료 코드: `0` 통과(또는 돌릴 작업 없음) · `1` 실패 · `2` 사용법 오류.

## GitHub Actions와 같게 맞춘 것

- `on:` 이벤트와 `branches`·`branches-ignore`·`paths`·`paths-ignore` 거르기(`!` 무늬 포함)
- 작업 `needs` 순서, `if:` 조건(상태 함수가 없으면 `success() &&`), `strategy.matrix`(include/exclude), `fail-fast`
- 단계 `run`: 기본 셸 `bash --noprofile --norc -eo pipefail`, `shell: python|pwsh|sh`, `working-directory`, `defaults.run`, `env`(워크플로 → 작업 → 단계 순)
- `$GITHUB_ENV`·`$GITHUB_PATH`·`$GITHUB_OUTPUT`(여러 줄 값 포함)·`$GITHUB_STEP_SUMMARY`, `steps.<id>.outputs`, `continue-on-error`, `timeout-minutes`
- `${{ }}` 식: `github`·`env`·`inputs`(workflow_dispatch 기본값)·`matrix`·`steps`·`needs`·`runner`와 `success() failure() always() contains() startsWith() endsWith() format() join() toJSON() fromJSON() hashFiles()`
- `uses:` 중 `actions/checkout`(이미 꺼낸 작업 사본을 씀), `actions/setup-node`·`setup-python`·`setup-java`(설치하지 않고 이 PC 버전만 확인해 다르면 경고), `actions/cache`(로컬 캐시, 아래 참고), `download-artifact`(할 일 없음), `actions/upload-artifact`(로그 폴더로 복사). 그 밖의 action은 `.github/local-ci.yml` 대체 규칙으로 돌립니다.

## 다른 점과 한계

- **실행 환경이 GitHub의 Ubuntu 러너가 아니라 이 PC입니다.** OS·도구 버전 차이로 생기는 문제는 잡지 못할 수 있습니다. 결과의 "실행 환경" 줄에 기록됩니다.
- 비밀 키 단계, 대체 규칙이 없는 `uses:` action, `services`·`container`, 재사용 워크플로(`jobs.<id>.uses`), 식으로 만든 matrix는 돌리지 않습니다. 결과에 "건너뜀"으로 남고, 그런 작업은 "통과(일부 단계 건너뜀)"로 표시됩니다.
- Windows에서는 bash 단계의 `python`·`python3`가 `py -3`(또는 `LOCAL_CI_PYTHON`)을 부르도록 연결합니다. Microsoft Store의 python 껍데기를 피하기 위해서입니다.
- `schedule`·`workflow_dispatch` 전용 워크플로는 `--event`로 그 이벤트를 직접 고를 때만 돕니다.

## 시험

```bash
npm test
```

시험 21개: 식 계산, 워크플로 고르기(paths·branches 무늬), 단계 실행·환경 넘기기·비밀 키 건너뛰기, 대체 규칙(형식 검사·실행·건너뜀·경고·`list` 표시), 로컬 캐시(저장 → 적중 → restore-keys 되살림, `--no-cache`, 실패 시 저장 안 함, `fail-on-cache-miss`, `hashFiles`), LF 꺼내기·CRLF 경고·경로 구분자, matrix include/exclude·조합별 `if`, `fail-fast`, `needs`·`always()`·`failure()`·작업 출력·`continue-on-error`.

## 라이선스

Apache-2.0. 의존성은 `yaml`(ISC) 하나뿐입니다.
