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

종료 코드: `0` 통과(또는 돌릴 작업 없음) · `1` 실패 · `2` 사용법 오류.

## GitHub Actions와 같게 맞춘 것

- `on:` 이벤트와 `branches`·`branches-ignore`·`paths`·`paths-ignore` 거르기(`!` 무늬 포함)
- 작업 `needs` 순서, `if:` 조건(상태 함수가 없으면 `success() &&`), `strategy.matrix`(include/exclude), `fail-fast`
- 단계 `run`: 기본 셸 `bash --noprofile --norc -eo pipefail`, `shell: python|pwsh|sh`, `working-directory`, `defaults.run`, `env`(워크플로 → 작업 → 단계 순)
- `$GITHUB_ENV`·`$GITHUB_PATH`·`$GITHUB_OUTPUT`(여러 줄 값 포함)·`$GITHUB_STEP_SUMMARY`, `steps.<id>.outputs`, `continue-on-error`, `timeout-minutes`
- `${{ }}` 식: `github`·`env`·`inputs`(workflow_dispatch 기본값)·`matrix`·`steps`·`needs`·`runner`와 `success() failure() always() contains() startsWith() endsWith() format() join() toJSON() fromJSON() hashFiles()`
- `uses:` 중 `actions/checkout`(이미 꺼낸 작업 사본을 씀), `actions/setup-node`·`setup-python`·`setup-java`(설치하지 않고 이 PC 버전만 확인해 다르면 경고), `actions/cache`·`download-artifact`(할 일 없음), `actions/upload-artifact`(로그 폴더로 복사)

## 다른 점과 한계

- **실행 환경이 GitHub의 Ubuntu 러너가 아니라 이 PC입니다.** OS·도구 버전 차이로 생기는 문제는 잡지 못할 수 있습니다. 결과의 "실행 환경" 줄에 기록됩니다.
- 비밀 키 단계, 다른 `uses:` action, `services`·`container`, 재사용 워크플로(`jobs.<id>.uses`), 식으로 만든 matrix는 돌리지 않습니다. 결과에 "건너뜀"으로 남고, 그런 작업은 "통과(일부 단계 건너뜀)"로 표시됩니다.
- Windows에서는 bash 단계의 `python`·`python3`가 `py -3`(또는 `LOCAL_CI_PYTHON`)을 부르도록 연결합니다. Microsoft Store의 python 껍데기를 피하기 위해서입니다.
- `schedule`·`workflow_dispatch` 전용 워크플로는 `--event`로 그 이벤트를 직접 고를 때만 돕니다.

## 시험

```bash
npm test
```

## 라이선스

Apache-2.0. 의존성은 `yaml`(ISC) 하나뿐입니다.
