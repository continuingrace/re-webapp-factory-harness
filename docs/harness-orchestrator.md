# RE Webapp Factory Harness — 오케스트레이터 (R7)

- **문서 상태:** R7 확정본
- **기준 문서:** `docs/harness-roles.md` (역할·트리거), `docs/harness-pipeline.md` (단계), `docs/harness-artifacts.md` (구조), `standards/checks.json` (판정 SSOT)
- **작성일:** 2026-09-29

> 오케스트레이터는 메인 세션이며, 저장소 루트의 `CLAUDE.md`를 따른다.
> 이 문서는 `CLAUDE.md`에 들어갈 범위와 오케스트레이터 행동 규칙을 정의한다.

---

## 1. `CLAUDE.md` 범위

| 항목 | 규칙 |
|---|---|
| 위치 | 저장소 루트 |
| 길이 | 120줄 이하 |
| 포함 | 트리거, 단계 순서, 역할 호출 순서, 멈춤 조건, 기준 문서 링크 |
| 제외 | radius, viewport, 해시, 재시도 횟수 등 판정 수치. `standards/checks.json`을 참조 |
| 복사 금지 | `checks.json`의 `rule` 값과 동일한 판정 규칙 원문 0건 |

## 2. 모드

| 모드 | 진입 조건 | 쓰기 범위 |
|---|---|---|
| 실행 모드 | `docs/harness-roles.md` 3절의 유효한 실행 트리거로 시작할 때만 | `docs/harness-roles.md` 1절 역할 경계 |
| 개발 모드 | 사용자가 하네스 자체의 설계·구현·수정을 명시적으로 요청하고, 변경 파일을 승인했을 때만 | 승인된 파일만 |
| `MODE_UNCONFIRMED` | 위 두 조건 중 어느 것인지 불명확할 때 | **파일 수정 없음**. 사용자에게 질문 |

### 전환 규칙

- 실행 모드에서 개발 모드로 자동 전환하지 않는다.
- 실행 중 기준 변경 요청이 오면 현재 실행을 `BLOCKED`로 두고, 개발 모드 전환 여부를 확인한다.
- 개발 작업이 끝나도 중단된 실행을 자동 재개하지 않는다. 사용자가 `<run_id> 재개`를 보내야 한다.

`MODE_UNCONFIRMED`는 대화 상태이며, 실행 전체 상태값(`docs/harness-purpose.md` 4-2)이 아니다.

## 3. 실행 모드 — 시작

### 3-1. 신규 실행 — `검수 시작 "<app_path>" <x.y.z>`

1. `app_path`와 목표 버전 형식을 확인한다.
2. `app_slug`를 판정한다 (`docs/harness-artifacts.md` 2-1).
3. `docs/harness-purpose.md` 3절의 필수 입력·조건부 입력·플래그 중 빠진 값을 사용자에게 질문한다.
4. 필수 값이 모두 유효해진 뒤에만 `run_id`와 실행 폴더를 생성한다.
5. `input.json`, `run.json`, `01-intake.a1.json`을 생성한다.
6. 생성 후부터 파일 근거로만 상태를 판단한다.

규칙:

- `app_slug`가 유효하지 않거나 필수 입력이 부족한 동안에는 실행 파일을 만들지 않는다.
- 입력을 임의로 추정하거나 기본 승인으로 채우지 않는다.
- `run_id`가 생성되기 전에는 4절의 종료 형식을 적용하지 않고, 빠진 입력만 질문한다.
- `run_id`가 생성된 이후부터 모든 실행 모드 응답을 4절 형식으로 종료한다.

### 3-2. 기존 실행 — 재개·배포·승인·거절

1. `run_id`와 `run_dir` 경로를 정규화한다.
2. `run.json`을 읽는다.
3. `run.json`이 참조하는 `input.json`, 단계 결과, `approvals.json`을 읽는다.
4. 현재 fingerprint와 `standards_version`을 확인한다.
5. 대화 기억이 아니라 파일 근거로만 상태를 판단한다.
6. `closure.json`이 있으면 닫힌 실행(`CANCELLED`·`SUPERSEDED`)이다. 재개·배포·승인·판정 기록을 하지 않고 닫힌 상태로 보고한다. 새 검수는 새 실행으로 시작한다.

참조 파일이 없거나 실행 폴더 밖을 가리키면 `BLOCKED`. 닫기 기록이 깨졌거나 기존 파일이 바뀌었으면(`CLOSURE_*`) `BLOCKED`.

## 4. 실행 모드 — 종료

`run_id`가 생성된 이후 실행 모드의 모든 응답은 다음 4줄로 끝난다.

```text
run_id: <값>
실행 상태: <기계용 값> (<한글 표시>)
미해결 항목: <check_id 목록 또는 없음>
다음에 필요한 사용자 문장: <R6 트리거 중 하나 또는 없음>
```

## 5. 역할 호출 순서

```text
1단계  오케스트레이터: 입력 접수·형식 검증 → 01-intake 기록
2~4단계 harness-runner 실행 → gate-judge 재판정 → 오케스트레이터가 record-judgement로 재계산·기록
5단계  사람 승인 기록(HA-01 → HA-02 → HA-03)
       → record-judgement(상태를 AWAITING_APPROVAL로 기록) → 다시 record-judgement(pre_record 허가 기록)
       → release-recorder 기록
       → record-judgement(post_record) → complete_allowed이면 COMPLETE
```

- `record-judgement`는 전달받은 판정을 신뢰하지 않고, 실행 파일과 단계 결과로 gate-judge와 같은 순수 로직(`scripts/lib/judge-core.mjs`)을 다시 계산해 그 결과만 기록한다.
- JG-02 `pre_record`는 `run.json` 상태가 `AWAITING_APPROVAL`일 때만 판정되므로, 4단계 결과를 먼저 기록한 뒤 한 번 더 판정·기록한다.

## 6. 오케스트레이터 쓰기 범위

- 쓸 수 있는 파일: 해당 실행 폴더의 `input.json`, `run.json`, `approvals.json`, `01-intake.a*.json`, `05-release.a*.json`, `closure.json`(close-run helper로만), `report.md`(report-run helper로만, 파생 문서)
- `01-intake.a*.json`의 작성 주체는 오케스트레이터다. 사용자가 제공한 입력과 기계적 형식 검증 결과만 기록한다.
- `05-release.a*.json`의 작성 주체는 오케스트레이터다. `gate-judge`와 `release-recorder`가 반환한 결과만 원문 그대로 기록한다.

## 7. 절대 하지 않는 일

1. 검사 단계 2~4를 직접 실행하거나 `02~04` 결과를 직접 쓰지 않는다. `run-stage.mjs`·`write-release.mjs`를 직접 실행하지 않는다 (hook이 차단).
2. `PASS`, `FAIL`, `release_record_allowed`, `complete_allowed`를 임의로 생성하거나 변경하지 않는다.
3. 사용자 메시지 없이 승인을 생성하지 않는다.
4. `post_record`의 `complete_allowed`가 `true`가 아니면 `COMPLETE`로 바꾸지 않는다.
5. 안전 검사나 hook 차단을 우회하지 않는다. `BLOCKED`로 보고한다.
6. push, 배포, 공개 저장소 조작을 하지 않는다.

## 8. 승인·배포 기록

오케스트레이터는 실행 폴더 파일을 직접 편집하지 않고 아래 helper를 통해 기록한다. 사용자 원문은 파일(`--statement-file`)로 전달하며 셸 명령 문자열에 넣지 않는다.

| 상황 | helper |
|---|---|
| 신규 실행 | `node scripts/orchestrator/start-run.mjs <input.json>` |
| 배포했어 | `node scripts/orchestrator/set-deployment.mjs <run_dir> <url> --statement-file <path>` (사용자정보·query·fragment가 있는 URL은 거부) |
| 운영 URL 확인·사람 승인 | `node scripts/orchestrator/record-approval.mjs <run_dir> <approval_type> <APPROVE\|REJECT> --statement-file <path>` |
| 판정 기록 | `node scripts/orchestrator/record-judgement.mjs <run_dir> [--judge-file <path>]` — 항상 재계산한 결과를 기록한다. gate-judge 출력을 `--judge-file`로 넘기면 정규화한 전체 결과가 재계산 결과와 완전히 같을 때만 기록하고, 다르면 `JUDGE_RESULT_MISMATCH`로 거부한다 |
| 릴리스 기록 (release-recorder만) | `node scripts/write-release.mjs <run_dir>` |
| 실행 취소·폐기 | `node scripts/orchestrator/close-run.mjs <run_dir> <cancel\|supersede> <basis> --statement-file <path> [--superseded-by <run_id>]` (8-5) |
| 요약 보고서 | `node scripts/orchestrator/report-run.mjs <run_dir>` — `report.md`만 만든다. 공식 JSON과 상태를 바꾸지 않으며 판정 근거로 쓰지 않는다 (`docs/harness-artifacts.md` 2-3) |

### 8-1. 운영 URL 확인 — `OPERATING_URL_CONFIRMATION`

- `approvals.json`에 기록하며, HA-01~03과 구분한다. 사람 승인 3종의 개수에 포함하지 않는다.
- `APPROVE`: 사용자가 실제 운영 주소라고 확인. `REJECT`: 미리보기·임시 주소라고 확인.
- 사용자 메시지 전체 원문이 필수다.
- 현재 `run_id`, fingerprint, `target_version`, `operating_url`과 모두 일치해야 유효하다.
- 같은 deployment에서 `REJECT`한 URL을 `APPROVE`로 덮어쓸 수 없다. 새 deployment가 기록돼야 다시 확인할 수 있다.

### 8-2. 사람 승인 — HA-01~03

- `MOBILE_DEVICE_REVIEW` → `HOME_ICON_REVIEW`(`pwa_installable: yes`일 때) → `FINAL_RELEASE` 순서로만 기록한다.
- 앞 단계가 현재 결합값으로 `APPROVE`되지 않았으면 뒤 단계는 기록하지 않는다.
- 결합값(`run_id`, fingerprint, `target_version`, `operating_url`)은 helper가 현재 값으로 채운다. 하나라도 바뀌면 이전 승인은 재사용하지 않는다.
- 빈 원문은 승인으로 기록하지 않는다. 기록은 append-only이며 거절도 보존한다.
- 같은 결합값에서 `REJECT`가 한 번 기록되면 `APPROVE`를 추가해 뒤집을 수 없다 (`APPROVAL_REJECTED_FOR_BINDING`). 다시 승인하려면 새 실행을 시작하거나 fingerprint·deployment 변경으로 결합값이 달라져야 한다.

### 8-3. 배포 정보 — `run.json.deployment`

- `input.json`은 수정하지 않는다. 배포 정보는 `run.json.deployment` 배열에 append한다.
- 각 항목: `deployment_id`, `release_phase`, `operating_url`, `recorded_at`, 사용자 메시지 원문(`statement`), fingerprint, `target_version`.
- 가장 최근 deployment가 현재 입력이다. 새 deployment가 추가되면 stage 4~5 결과와 이전 URL에 묶인 확인·승인이 무효화된다.
- stage 3이 현재 fingerprint에서 `AWAITING_DEPLOYMENT`가 아니면 기록하지 않고 `BLOCKED`로 보고한다.
- `run.json`은 원자적으로 교체하며, 기존 deployment 항목을 수정·삭제하지 않는다.

### 8-4. judge phase

- judge는 정확한 릴리스 경로(`releases/<slug>/v<x.y.z>.md`)의 일반 파일 존재 여부로 phase를 정한다. 파일 없음: `pre_record`, 있음: `post_record`.
- symlink·junction은 릴리스 기록으로 인정하지 않는다.
- `post_record`는 현재 값과 일치하는 유효한 최신 `pre_record` 허가가 반드시 있어야 한다. 파일은 있으나 허가가 없거나 결합값이 다르면 `pre_record`로 되돌리지 않고 `FAIL`이다.
- `record-judgement`는 judge 판정값을 바꾸지 않는다. `COMPLETE`는 `post_record`의 `complete_allowed: true`이고 stage 4 결과가 합성(검증용)이 아닐 때만 기록한다.

### 8-5. 실행 취소·폐기 — `closure.json`

| 사용자 문장 | 기록 | basis |
|---|---|---|
| `실행 취소 <run_id> [이유]` | `CANCELLED` (`cancel`) | `USER_CANCEL`. `--superseded-by`를 쓰지 않는다 |
| `실행 폐기 <run_id> [이유]` | `SUPERSEDED` (`supersede`) | 실행 결과의 `standards_version`이 현재와 다르면 `STANDARDS_CHANGED`, 새 실행으로 대체했으면 `REPLACED_BY_RUN` + `--superseded-by <새 run_id>` |

- run_id가 없거나 존재하지 않으면 기록하지 않고 다시 묻는다. 사용자 원문은 승인과 같은 `.harness-inbox/` 규칙으로 파일에 저장해 `--statement-file`로 넘기고, 기록이 성공하면 삭제한다. 실패하면 원문 파일을 남기고 경로를 보고한다.
- `COMPLETE`이거나 이미 닫힌 실행은 닫을 수 없다(`RUN_COMPLETE_CANNOT_CLOSE`·`RUN_ALREADY_CLOSED`). 되돌릴 수 없다.
- `--superseded-by`는 같은 app_slug 폴더에 존재하는 다른 열린 실행이어야 한다. `REPLACED_BY_RUN`에는 필수이고, 취소에는 허용하지 않는다.
- helper는 `closure.json`만 새로 만들고 기존 실행 파일과 원문 파일을 바꾸거나 지우지 않는다. 실패하면 아무것도 쓰지 않는다.
- 닫힌 뒤에는 `run-stage`·`write-release`·`record-judgement`·`record-approval`·`set-deployment`가 `RUN_CLOSED`로 거부하고, judge는 닫힌 상태와 `release_record_allowed: false`·`complete_allowed: false`를 보고한다.
