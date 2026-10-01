# RE Webapp Factory Harness — 역할 (R6)

- **문서 상태:** R6 확정본
- **기준 문서:** `docs/harness-pipeline.md` (단계), `docs/harness-artifacts.md` (구조 SSOT), `standards/checks.json` (판정 SSOT)
- **작성일:** 2026-09-29

> 판정은 `scripts/`의 스크립트가 하고, 에이전트는 스크립트를 실행하고 결과를 옮긴다.
> 어떤 역할도 PASS·FAIL을 스스로 판단하거나 만들어내지 않는다.

---

## 1. 역할과 편집 경계

| 역할 | 단계 | 쓰기 허용 (이 경로만) | 하는 일 |
|---|---|---|---|
| 오케스트레이터 (메인 세션, `CLAUDE.md`) | 1, 5 | 해당 실행 폴더의 `input.json`, `run.json`, `approvals.json`, `01-intake.a*.json`, `05-release.a*.json` | 입력 접수, 역할 호출, 사용자 승인·거절 원문 기록, 판정 결과 기록, 실행 상태 갱신 |
| `harness-runner` | 2, 3, 4 | 해당 실행 폴더의 `02-*.a*.json`, `03-*.a*.json`, `04-*.a*.json`, `evidence/` | 판정 스크립트 실행, 단계 결과와 근거 파일 작성 |
| `release-recorder` | 5 | `releases/<slug>/` | 실행 상태가 `AWAITING_APPROVAL`이고 가장 최근의 유효한 `pre_record` 허가(`release_record_allowed: true`)가 있을 때만 릴리스 기록 작성. 기록 생성 후 오케스트레이터에 `post_record` 판정을 요청하며, 실행 상태를 직접 `COMPLETE`로 변경하지 않음 |
| `gate-judge` | 2~5 확인 | **없음 (읽기 전용)** | 판정 재실행, 결과를 응답으로만 반환 |

"해당 실행 폴더"는 `runs/<slug>/<run_id>/`이며, 다른 `run_id`의 폴더는 쓰지 않는다.

### 공통 금지

- 누구도 다음을 수정하지 않는다: 대상 `app_path`, `docs/`, `standards/`, `.git/`, 기존 `continuingrace/webapp-factory` 저장소
- 실행 중 어떤 역할도 하네스 자체 코드(`scripts/`, `.claude/`)나 기준 문서를 고치지 않는다.
- `release-recorder`는 동일 앱·동일 버전의 기록이 이미 있으면 쓰지 않고 `BLOCKED`로 보고한다.

## 2. 판정자 — `gate-judge`

| 구분 | 내용 |
|---|---|
| 허용 도구 | `Read`, `Grep`, `Glob` |
| 허용 명령 | `node scripts/judge.mjs <run_dir>` 하나 |
| 금지 | 파일 쓰기·수정, 네트워크 요청, Git 변경, 환경설정 변경 |

- `judge.mjs`는 stdout에 **판정 JSON만** 출력하고 파일을 쓰지 않는다.
- `<run_dir>`는 정규화 후 현재 저장소의 `runs/` 내부여야 한다. 아니면 실행하지 않는다.

### 판정 방식

- 비네트워크 검사(stage 1·2)는 직접 재실행한다.
- 브라우저·운영 검사(stage 3·4)는 브라우저를 실행하거나 네트워크를 쓰지 않고, `harness-runner`가 evidence에 남긴 원시 측정값을 `standards/checks.json` 기준으로 재판정한다.
- runner가 기록한 상태값(`PASS`·`FAIL` 등)을 단순 복사하지 않는다.
- 필수 측정값이 없거나 fingerprint·`standards_version`이 현재 값과 다르면 `NEEDS_ATTENTION` 또는 `BLOCKED`로 판정한다.
- 스크린샷은 보조 근거이며 자동 `PASS`의 단독 근거로 사용하지 않는다.

### runner와 judge 결과가 다를 때

- 기존 결과를 덮어쓰지 않는다.
- 두 결과와 충돌 내용을 모두 보존한다 (오케스트레이터가 `run.json`에 기록).
- 실행 상태는 `BLOCKED`.

### 최종 판정

- 최종 판정에는 `gate-judge` 결과를 사용한다.
- 사용자 확인 전에는 `COMPLETE`로 바꾸지 않는다.

### 릴리스 기록 2단계 판정 (JG-02)

```text
1. 오케스트레이터 → gate-judge: pre_record 판정 요청
2. pre_record 통과 → release_record_allowed: true
   오케스트레이터가 결과를 아래 6개 값과 묶어 run.json에 기록
3. release-recorder: 가장 최근의 유효한 pre_record 허가 확인 → 릴리스 기록 생성
4. release-recorder → 오케스트레이터: post_record 판정 요청
5. 오케스트레이터 → gate-judge: post_record 판정 요청
6. post_record 통과 → complete_allowed: true
   오케스트레이터가 실행 상태를 COMPLETE로 변경
```

`pre_record` 허가에 묶는 값:

- `run_id`
- `app_slug`
- `target_version`
- `fingerprint`
- `operating_url`
- `standards_version`

- 6개 값 중 하나라도 현재 값과 다르면 `post_record`는 `PRE_RECORD_AUTHORIZATION_STALE`로 `FAIL`이다.
- 오래된 `pre_record` 허가를 자동으로 갱신하거나 재사용하지 않는다.

## 3. 자연어 트리거

상태를 바꾸는 명령에는 `run_id`가 필수다.

| 문장 | 동작 |
|---|---|
| `검수 시작 "<app_path>" <x.y.z>` | 1단계 접수. 빠진 입력은 질문 |
| `<run_id> 재개` | `docs/harness-artifacts.md` 4절 재개 규칙 적용 |
| `배포했어 <run_id> <url>` | `postdeploy` 전환, 운영 URL 확인 질문 |
| `모바일 검수 승인 <run_id>` | HA-01 `APPROVE` |
| `모바일 검수 거절 <run_id> <이유>` | HA-01 `REJECT` |
| `아이콘 승인 <run_id>` | HA-02 `APPROVE` |
| `아이콘 거절 <run_id> <이유>` | HA-02 `REJECT` |
| `최종 릴리스 승인 <run_id>` | HA-03 `APPROVE` |
| `최종 릴리스 거절 <run_id> <이유>` | HA-03 `REJECT` |
| `실행 취소 <run_id> [이유]` | `CANCELLED` 닫기 기록 (`docs/harness-orchestrator.md` 8-5) |
| `실행 폐기 <run_id> [이유]` | `SUPERSEDED` 닫기 기록 (이전 기준 실험 또는 새 실행으로 대체) |

### 규칙

- `run_id`가 없거나 존재하지 않으면 기록하지 않고 다시 질문한다.
- 승인·거절의 `statement`에는 사용자 메시지 **전체 원문**을 그대로 저장한다.
- 에이전트는 승인 문장을 생성·요약·보완하지 않는다.
- 현재 fingerprint, `target_version`, `operating_url`과 일치하지 않으면 승인을 인정하지 않는다.
- 취소·폐기 원문도 사용자 메시지 전체를 그대로 저장한다. 닫힌 실행(`CANCELLED`·`SUPERSEDED`)에서는 harness-runner·release-recorder의 스크립트가 `RUN_CLOSED`로 거부하고, gate-judge는 닫힌 상태를 그대로 보고한다.

## 4. 경계의 기계적 강제

R6에서는 규칙만 정의하고, hook과 판정 스크립트는 구현 라운드에서 별도 승인 후 만든다.

### PreToolUse hook이 차단하는 것

- 역할별 허용 경로 밖의 쓰기
- `git push`
- force push (`--force`, `-f`, `--force-with-lease`)
- 강제 브랜치 변경 (`git checkout -f`, `git switch --discard-changes`, `git reset --hard`, `git branch -D` 등)
- 심볼릭 링크나 junction을 통한 경계 우회
- 모든 역할의 `config/*.local.json` 직접 접근
  - Read·Grep·Write·Edit·MultiEdit·NotebookEdit 도구로 지정하는 것 (Windows 대소문자, `/`·`\`, 절대·상대경로, 말미 점, `::$DATA`를 정규화해 비교)
  - 셸 명령줄에서 해당 파일을 지정하거나, config 폴더를 glob으로 펼치거나, config를 포함하는 폴더를 재귀 검색하는 것
  - Git 상태 확인 결과를 `xargs` 등으로 다른 명령에 넘기는 것
  - 허용: 내용을 읽지 않는 `git status`·`git check-ignore`·`git ls-files`, 그리고 명령줄에 경로 없이 스크립트 내부 로더로 읽는 하네스 스크립트 실행
  - 셸 해석은 완전한 보안 경계가 아니다. local 값 변경은 사용자가 Claude 밖에서 직접 한다

### 판정할 수 없을 때

- 역할을 식별할 수 없거나 경로 정규화에 실패하면 **허용하지 않고 차단**한다.

### 역할 식별 (R8-d 확정)

hook 입력의 `agent_id`·`agent_type`으로 역할을 정한다.

| 입력 | 역할 |
|---|---|
| `agent_id` 있음 + `agent_type: harness-runner` | harness-runner |
| `agent_id` 있음 + `agent_type: release-recorder` | release-recorder |
| `agent_id` 있음 + `agent_type: gate-judge` | gate-judge |
| `agent_id` 있음 + `agent_type` 없음·알 수 없는 값 | **차단** |
| `agent_id` 없음 | 메인 세션 |
| 입력 JSON 해석 불가 | **차단** |

- 전역 project hook(`.claude/settings.json`)과 각 agent 정의(`.claude/agents/*.md`)의 agent 전용 hook을 **모두** 통과해야 실행된다.
- agent 전용 hook은 `scripts/hook-guard.mjs`에 예상 역할(`--expect-role`)을 넘기며, 실제 `agent_type`과 다르면 차단한다.
- hook은 셸 문자열이 아니라 exec form(`command: node`, `args: [${CLAUDE_PROJECT_DIR}/scripts/hook-guard.mjs, …]`)으로 실행한다.
- hook 입력 전체를 파일이나 로그에 저장하지 않는다.

### subagent Bash 규칙

- 허용 명령 전체가 **정확히** 일치해야 한다. 단순 prefix 일치로 허용하지 않는다.
- `run_dir`는 `runs/<slug>/<run_id>` 상대 경로 형식만 허용하며, 스크립트에서도 canonical path가 저장소 `runs/` 내부인지 다시 확인한다.
- `&&`, `||`, `;`, `|`, `>`, `<`, 백틱, `$()`, 변수 확장, 따옴표, 줄바꿈이 있으면 차단한다.

### 메인 세션

- 사용자가 승인한 개발 모드에서 `docs/`, `standards/`, `scripts/`, `.claude/` 편집을 허용한다.
- 모든 세션에서 저장소 밖, `.git/`, symlink·junction 경로 쓰기를 금지한다.
- `runs/`·`releases/`는 Write·Edit로 직접 쓰지 않고 승인된 스크립트만 사용한다.
- git push와 파괴적 Git 명령(`reset --hard`, `checkout -f`, `switch --discard-changes`, `branch -D`, `clean -f`, force 옵션)을 차단한다.
- 역할 전용 스크립트 `scripts/run-stage.mjs`(harness-runner)와 `scripts/write-release.mjs`(release-recorder)를 직접 실행하지 않는다. hook이 차단한다.
- 판정 기록은 `record-judgement`가 gate-judge와 같은 순수 로직(`scripts/lib/judge-core.mjs`)으로 재계산한 결과만 사용한다. 전달받은 판정 JSON은 재계산 결과와 완전히 같을 때만 받아들인다.

### 차단되었을 때

- 명령을 다른 형태로 바꿔 우회하지 않는다.
- 실행 상태를 `BLOCKED`로 두고 사용자에게 보고한다.
