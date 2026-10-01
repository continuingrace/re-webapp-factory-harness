# RE Webapp Factory Harness — 검증 (R8)

- **문서 상태:** R8 계획 확정본 (결과는 R8-e에서 기록)
- **기준 문서:** `docs/harness-purpose.md`, `docs/harness-pipeline.md`, `docs/harness-artifacts.md`, `docs/harness-roles.md`, `docs/harness-orchestrator.md`, `standards/checks.json`
- **작성일:** 2026-09-29

> 이 문서는 하네스 v1 구현의 하위 라운드, 검증 방법, 실패 사례, 리뷰 기준과 최종 결과를 기록한다.
> 결과 칸은 실제로 실행한 뒤에만 채우며, 실행하지 않은 항목은 `NOT_RUN`으로 둔다.

---

## 1. 공통 규칙

- `scripts/` 안의 판정 수치는 `standards/checks.json`에서만 읽는다.
- 구현 중 `checks.json`의 규칙 변경이 필요하면 임의로 고치지 않고, 해당 라운드를 멈춰 승인을 요청한다.
- check 32개를 임의로 추가·삭제·통합하지 않는다.
- 실제 운영 URL이 없는 상태에서 `COMPLETE`를 만들지 않는다.
- 각 하위 라운드 커밋은 로컬에만 만들고 push하지 않는다.
- 명령 안전 검사 오류가 나면 우회하지 않는다.

## 2. 하위 라운드

모든 하위 라운드는 **초안 → 승인 → 구현 → 검증 → 로컬 커밋** 순서로 진행한다.

| 라운드 | 범위 | 외부 패키지 |
|---|---|---|
| R8-a 핵심 판정 엔진 | checks.json 로더·스키마 검증, fingerprint, source document 정규화 해시, 실행 폴더·경로 정규화, stage 1 접수, stage 2 정적 검사, `judge.mjs` 읽기 전용 출력, Node 내장 test runner 단위 테스트, `tests/` 생성 | 없음 |
| R8-b 브라우저 검사와 샘플 앱 | stage 3 브라우저 검사, Playwright·axe-core, `fixtures/sample-app/`, viewport 값은 checks.json에서 읽음, 샘플 앱 stage 1~3 검증, 원본 fingerprint 불변 확인 | Playwright, axe-core (실행 직전 재승인) |
| R8-c 운영 검사와 릴리스 흐름 | stage 4 운영 URL 검사, stage 5 승인 유효성, JG-01, JG-02 `pre_record`·`post_record`, release-recorder, `01-intake`·`05-release` 생성 흐름, 거절 테스트 | 없음 |
| R8-d 역할과 경계 강제 | `scripts/hook-guard.mjs`, `.claude/settings.json`, `.claude/agents/` 3개, 차단 테스트 (모의 tool input만 사용) | 없음 |
| R8-e 실패 검증과 리뷰 | 실패 사례 10개, 원본 fingerprint 전후 비교, 읽기 전용 리뷰, 이 문서에 결과 기록, `CLAUDE.md` 초안 준비 | 없음 |

### 테스트 구조 (R8-a 구현 커밋에서 생성)

```text
tests/
├─ unit/*.test.mjs      단위 테스트 (Node 내장 test runner)
├─ mutations.json       F1~F10 mutation 정의
└─ expected.json        기대 결과
```

R8-a에서 `docs/harness-artifacts.md`에 `tests/`를 추가할 때, 같은 커밋에서 `standards/checks.json`의 해당 문서 해시를 갱신하고 `standards_version`을 `1.1.2`로 올린다. check 32개와 판정 규칙은 변경하지 않는다.

### R8-c 제한

- 실제 HTTPS 운영 URL이 없으므로 stage 4의 성공 end-to-end 결과를 `PASS`로 만들지 않는다.
- 구현과 거절 테스트는 완료하되, 실제 운영 URL 성공 검증은 `NOT_RUN`으로 남긴다.

### R8-d 제한

- hook은 테스트 입력만 받아 검증한다. 실제 push나 파괴 명령을 실행하지 않는다.

## 3. 샘플 앱 통과 조건

| 조건 | 기준 |
|---|---|
| stage 1~3 결과 | 모든 적용 check가 `PASS` 또는 근거 있는 `NOT_APPLICABLE` |
| 정상 종료 상태 | `AWAITING_DEPLOYMENT` |
| 원본 보존 | 검증 전후 `fixtures/sample-app/` fingerprint 동일 |

## 4. 실패 사례

### 4-1. 방식

- 원본 `fixtures/sample-app/`을 직접 수정하지 않는다.
- 테스트할 때 OS 임시 폴더에 복사본을 만들고, 종료 후 폐기한다.
- 저장소에는 복사본을 커밋하지 않고, **재현 가능한 mutation 정의와 기대 결과만** 저장한다.
- F2·F8·F9는 앱 파일이 아니라 실행 기록을 망가뜨리는 사례다. 실제 운영 URL 없이 stage 5에 도달할 수 없으므로, 임시 폴더에 **합성 실행 폴더**를 만들어 판정기만 검사한다.
- F2·F8·F9의 결과에는 다음을 반드시 기록한다.
  - `verification_type: judge_unit`
  - `end_to_end: false`
  - 실제 stage 5 end-to-end 통과 근거로 사용하지 않는다.

### 4-2. 사례와 기대 결과

| # | 대상 | 검증 유형 | mutation | 기대 `check_id / failure_code` |
|---|---|---|---|---|
| F1 | 앱 복사본 | pipeline | 파일 1개에 fixture 식별자 문자열 추가 (`tests/fixtures/identifiers.fixture.json`) | ★ `ST-04 / FOREIGN_PROJECT_MIXED` (불변 원칙 2) |
| F2 | 합성 실행 폴더 | `judge_unit` | `evidence`가 빈 `PASS` 항목 삽입 | ★ `JG-01 / UNVERIFIED_PASS` (불변 원칙 1) |
| F3 | 앱 복사본 | pipeline | README의 버전만 변경 | `ST-05 / VERSION_MISMATCH` |
| F4 | 앱 복사본 | pipeline | `letter-spacing: -0.02em` 추가 | `DS-01 / DESIGN_LETTER_SPACING` |
| F5 | 앱 복사본 | pipeline | 360px보다 넓은 고정 너비 요소 추가 | `MB-01 / MOBILE_OVERFLOW` |
| F6 | 앱 복사본 | pipeline | 아이콘 파일 1개 삭제 | `ST-02 / ICON_MISSING` |
| F7 | 앱 복사본 | pipeline | 가짜 토큰 형식 문자열 추가 | `ST-03 / SECRET_DETECTED` + 출력·로그·evidence에 완성 토큰 0건 |
| F8 | 합성 실행 폴더 | `judge_unit` | 승인 기록 뒤 fingerprint 변경 | `HA-01 / APPROVAL_STALE` |
| F9 | 합성 실행 폴더 | `judge_unit` | `pre_record` 뒤 `operating_url` 변경 | `JG-02 / PRE_RECORD_AUTHORIZATION_STALE` |
| F10 | hook 모의 입력 | `hook_unit` | `docs/` 쓰기 요청, `git push` 요청 | hook 차단 2건 |

### 4-3. F7 비밀 문자열 처리

- 탐지될 수 있는 완성 문자열을 저장소 파일에 커밋하지 않는다.
- 실행할 때 문자열 조각을 테스트 메모리나 임시 파일에서 결합하고, 테스트 후 제거한다.
- 출력·로그·evidence에 완성된 토큰 문자열이 0건인지 함께 검사한다.

### 4-4. F10 hook 검사

- hook에 모의 tool input을 전달해 차단 결과만 검사한다.
- 실제 `docs/` 쓰기나 실제 `git push`를 실행하지 않는다.

### 4-5. 통과 기준

- 각 사례에서 기대한 `check_id`와 `failure_code` 쌍이 **정확히** 나와야 한다.
- 모든 사례가 끝난 뒤 원본 `sample-app` fingerprint가 검증 전과 같아야 한다.

## 5. 읽기 전용 리뷰

### 5-1. 기준

1. `scripts/` 안에 `checks.json` 대신 직접 적힌 판정 수치 0건
2. 역할별 쓰기 경로가 `docs/harness-roles.md`와 다른 곳 0건
3. `PASS`를 근거 없이 만드는 코드 경로 0건
4. 비밀값이 출력이나 evidence로 나가는 경로 0건
5. 허용되지 않은 네트워크 호출 0건 (5-3)

### 5-2. 규칙

- 리뷰 에이전트는 파일을 수정하거나 자동 수정 제안을 적용하지 않는다.
- 발견 사항은 `severity`, 파일, 위치, 근거, 관련 규칙으로만 보고한다.
- `blocker` 또는 `high` 항목이 1개 이상이면 R8을 완료로 표시하지 않는다.
- 실제 운영 URL 성공 검증이 없다는 사실은 `blocker`가 아니지만, 6-3 "미검증 범위"에 반드시 표시한다.
- `PASS`를 추정하지 않는다.

### 5-3. 네트워크 허용 범위

| 구분 | 허용 |
|---|---|
| stage 3 | 사용자가 제공한 로컬 테스트 URL 또는 하네스가 `127.0.0.1`에 띄운 로컬 정적 서버로의 브라우저 접근과, 그 페이지가 직접 요청한 하위 리소스 |
| stage 4 | 사용자가 제공한 `operating_url`, 허용된 redirect 목적지, 해당 운영 페이지가 직접 참조하는 자산 |
| 패키지 설치 | 사용자가 R8-b에서 별도로 승인한 설치 명령에 한함 |

추가 규칙:

- stage 3에서 접근한 모든 origin을 evidence에 기록한다.
- 대상 페이지가 요청하지 않은 임의 외부 API 호출을 금지한다.
- stage 4 이외의 판정 스크립트가 임의 외부 URL로 직접 요청하는 코드 경로 0건
- stage 1·2·5, `judge`, `hook-guard`, `release-recorder`의 네트워크 호출 0건
- 허용 여부가 불명확하면 `PASS`가 아니라 `NEEDS_ATTENTION`으로 기록한다.

### 5-4. 셸 명령 분석의 한계 (R8-d)

- `scripts/hook-guard.mjs`의 셸 명령 해석은 **완전한 보안 경계가 아니다.** 알려진 형태(따옴표로 감싼 git 실행 파일, `git -C … push`, 결합된 force 옵션, 보호 경로를 향한 redirect·tee·cp/copy·mv/move·rm/del·Remove-Item·Set-Content·Out-File 등)만 차단한다.
- 환경 변수·별칭·스크립트 파일 내부 명령 등으로 우회하는 형태는 탐지하지 못할 수 있다.
- 주 방어선은 subagent의 제한된 tools, 정확히 일치해야 하는 명령 allowlist, 스크립트 내부의 경로 검증이다.

### 5-5. 최종 push

- hook이 활성화되면 에이전트의 모든 `git push`가 차단된다. hook을 끄거나 수정해서 push하지 않는다.
- 최종 push는 사용자가 직접 `! git push origin main`으로 실행한다. force push는 사용자 직접 실행이라도 사용하지 않는다.

## 6. 결과 (R8-e에서 기록)

### 6-1. 하위 라운드

| 라운드 | 상태 | 커밋 |
|---|---|---|
| R8-a | 완료 | `feat: implement harness core judgment engine` |
| R8-b | 완료 | `feat: add browser QA and sample app` |
| R8-c | 완료 | `feat: implement production and release flow` |
| R8-d | 완료 (실제 subagent smoke test 3건 통과) | `feat: enforce harness role boundaries` |
| R8-e | 완료 후보 — 1차 리뷰 80/100(high 1) → 1차 보완 커밋 → 2차 독립 리뷰 **85/100**(공식 점수, blocker·high 0) → 표적 보완(S1·S2·S3·S5·S6·S7·S10 + 추가 보안 2건, 독립 재채점 없음) (`docs/harness-review.md`) | `test: verify harness failure cases and initial review`, `fix: address approved harness review findings`, `docs: record second harness review`, 이번 커밋 |

### 6-2. 실패 사례

| # | 검증 유형 | end_to_end | 기대 | 실제 | 상태 |
|---|---|---|---|---|---|
| F1~F10 | 4-2 표 | F1~F10 모두 `false` (F1~F7은 pipeline 유형이지만 판정 함수를 직접 호출하며, run-stage → judge → record 전체 경로는 아님) | 4-2 표 | 아래 결과 | 아래 결과 |

실행 결과 (`tests/unit/failures.test.mjs`, 2026-09-30, 정의: `tests/mutations.json`, 기대: `tests/expected.json`):

| # | 검증 유형 | 실행 범위 | 실제 FAIL·NEEDS_ATTENTION | 기대와 일치 |
|---|---|---|---|---|
| F1 | pipeline | stage 2 판정 함수 | `ST-04 / FOREIGN_PROJECT_MIXED` | 일치 |
| F2 | judge_unit | stage 5 판정 함수 | `JG-01 / UNVERIFIED_PASS`, `JG-02 / COMPLETION_UNMET`(파생) | 일치 |
| F3 | pipeline | stage 2 판정 함수 | `ST-05 / VERSION_MISMATCH` | 일치 |
| F4 | pipeline | stage 2 판정 함수 | `DS-01 / DESIGN_LETTER_SPACING` | 일치 |
| F5 | pipeline | stage 2·3 (설치된 Chrome) | `MB-01 / MOBILE_OVERFLOW`, `MB-05 / FONT_FALLBACK_BROKEN`(같은 360px 원인) | 일치 |
| F6 | pipeline | stage 2 판정 함수 | `ST-02 / ICON_MISSING` | 일치 |
| F7 | pipeline | stage 2 판정 함수 + run-stage 2 | `ST-03 / SECRET_DETECTED`, 완성 토큰 노출 0건 | 일치 |
| F8 | judge_unit | stage 5 판정 함수 | `HA-01 / APPROVAL_STALE`, `JG-02 / COMPLETION_UNMET`(파생) | 일치 |
| F9 | judge_unit | stage 5 판정 함수 | `JG-02 / PRE_RECORD_AUTHORIZATION_STALE` | 일치 |
| F10 | hook_unit | 모의 hook 입력 | 차단 2건 (runner의 docs 쓰기, main의 git push) | 일치 |

- 원본 `fixtures/sample-app` fingerprint: 실행 전후 동일
- 전체 테스트: 최초 실행 123개 통과 → 1차 보완 후 140개 → 2차 표적 보완 후 149개 → 추가 보안 2건 보완 후 **152개 통과, 0개 실패, 0개 건너뜀** (`npm test`, 테스트 파일을 순서대로 실행하는 `--test-concurrency=1`)
- F1~F10은 각 보완 후에도 기대 결과와 정확히 일치했다.
- fingerprint는 항상 content hash다 (길이 접두사 인코딩 `policies.fingerprint.encoding`). Git commit SHA와 `git status`는 쓰지 않는다.
- 부수 효과: 테스트 임시 폴더 0개, 실제 `runs/`·`releases/` 0건

### 6-3. 미검증 범위

- 실제 HTTPS 운영 URL에서의 stage 4 성공 경로: `NOT_RUN`
- 실제 모바일 기기 검수, 홈 아이콘 시각 승인, 최종 릴리스 승인이 들어간 stage 5 end-to-end와 실제 `COMPLETE` 전이: `NOT_RUN`
- Node 20에서 `npm test` 동작: 미실행 (Node 24.19.0에서만 실행)
- `package-lock.json`의 다른 OS용 선택 의존성 대조: 미실행

### 6-4. 리뷰 발견 사항

1차 리뷰 전체 기록은 `docs/harness-review.md`에 있다.

| # | severity | 파일 | 요약 |
|---|---|---|---|
| R1 | high | `scripts/orchestrator/record-judgement.mjs` | stdin 판정 JSON을 재계산 없이 기록 |
| R2 | medium | `scripts/stages/stage2-static.mjs` | ST-05 UI 버전 위치가 index.html로 한정 |
| R3 | medium | `scripts/lib/fingerprint.mjs` | commit SHA fingerprint에 gitignore 파일 변경 미반영 |
| R4 | medium | `tests/unit/release-flow.test.mjs` | 실제 운영 환경 검증 공백 |
| R5~R13 | low | 여러 파일 | `docs/harness-review.md` 참조 |
| R14·R15 | informational | — | 감점 없음 |

2차 독립 리뷰 (공식 점수 85/100, 전체 기록은 `docs/harness-review.md` 2절):

| # | severity | 요약 | 처리 |
|---|---|---|---|
| S1 | medium | stage 4 선실행 뒤 운영 URL 확인 시 영구 충돌 | 보완 완료 (회귀 테스트) |
| S2 | medium | pre_record 허가 뒤 거절이 있어도 릴리스 파일 생성 가능 | 보완 완료 (회귀 테스트) |
| S3 | medium | 로컬 서버가 fingerprint 제외 경로 제공 | 보완 완료 — 표적 검토에서 Windows 대소문자 우회 발견 후 추가 보완 (회귀 테스트) |
| S4 | medium | 실제 운영 URL·실기기 검증 공백 | 보류 (`NOT_RUN`) |
| S5 | low | 콘솔 오류 원문 미마스킹 | 보완 완료 — 표적 검토에서 개인키 본문 노출 발견 후 추가 보완 (회귀 테스트) |
| S6 | low | 측정 대상 0개 처리 불일치 | 보완 완료 (회귀 테스트) |
| S7 | low | fingerprint 해시 경계 모호 | 보완 완료 (회귀 테스트) |
| S8·S9·S11 | low | 측정 상수, 로직 중복, Node 20 미실행 | 보류 (알려진 한계) |
| S10 | low | 검증 문서 오래된 정보 | 보완 완료 |
| S12·S13 | informational | hook 한계(문서화됨), CLAUDE.md 없음 | 보류 / CLAUDE.md 확정 시 해결 |

표적 보완 뒤 알려진 한계 (이번 제출에서 수정하지 않음):

- scheme 없는 상대 URL(`/api?token=…`)과 값 없는 query 키는 evidence 마스킹 대상이 아니다.
- evidence 문자열은 `max_chars` 200자에 말줄임표 1자가 붙을 수 있고, 콘솔 메시지 개수 상한이 없다.
- `policies.zero_targets.applies_to`는 문서 역할이며 코드가 직접 읽지 않는다 (적용 check는 evaluator에 있다).
- S1 회귀 테스트는 stage 4 재실행을 합성 결과로 검증했고, 실제 `run-stage 4` 경로는 통합 테스트하지 않았다.
- hook 오탐: 역할 전용 스크립트 경로 문자열이 들어간 읽기 명령·heredoc도 차단할 수 있다. fail-closed이며 Read·Grep 도구로 대체 가능하다. "실제 node 실행 형태일 때만 차단"으로 정교화할 후보.
- 흐름 테스트가 중간에 실패하면 공유 `releases/` 정리가 남아 뒤 테스트가 연쇄 실패할 수 있다. 테스트 격리 개선 후보.
- 실제 HTTPS 운영 URL과 실제 모바일 기기 end-to-end는 `NOT_RUN`이다.
- 테스트 재현성: 브라우저 테스트 파일 간 임시 프로필 경쟁을 없애기 위해 `npm test`는 테스트 파일을 순서대로 실행한다(`--test-concurrency=1`).

v1.1 (standards 1.6.0) 비공개 식별자 local 설정의 알려진 한계:

- 자동 테스트는 fixture 식별자만 쓴다. 실제 식별자가 추적 파일에 없는지는 `node scripts/tools/scan-tracked-identifiers.mjs`로 따로 확인한다.
- 로더의 길이 0 regex 검사(빈 문자열과 몇 개의 probe 문자열)는 보조 방어이며 완전한 증명이 아니다. 조건부 길이 0 regex는 스캔 중 발견 즉시 ST-04 `NEEDS_ATTENTION / CHECK_INCONCLUSIVE`로 멈춘다.
- regex 성능(과도한 백트래킹)은 사용자가 설정한 local 값의 책임이며 시간 제한을 두지 않는다.
- ST-04 evidence의 경로는 식별자 부분을 가리지만, 다른 check의 evidence 경로는 가리지 않는다.
- 설정 해시를 기록하지 않는다. 설정이 바뀌면 gate-judge·record-judgement·write-release의 재계산 결과가 runner 결과와 달라져 `BLOCKED`가 되며, 판정 결과가 같게 나오는 변경은 감지하지 않는다.
- hook의 셸 명령 해석은 완전한 보안 경계가 아니다. `config/*.local.json` 직접 지정·glob·brace 확장·재귀 검색·상태 확인 결과 전달을 막지만, 모든 간접 접근을 막는다고 보장하지 않는다.

v1.1 hook glob·brace 판정 보강 (`fix: harden hook glob matching`):

- 해결: 짝이 맞지 않는 `[`가 든 정상 명령에서 glob 정규식 생성이 예외를 내 "판정 중 오류"로 차단되던 오탐. glob은 `*`·`**`·`?`·닫힌 `[...]`만 해석하고(닫힌 괄호식은 내용과 무관하게 한 글자로 넓게 판정) 나머지 문자는 리터럴로 처리한다. `[!x]`를 정규식 문자 집합으로 잘못 해석해 통과하던 경우도 막는다.
- 해결: brace 확장(`{a,b}`, `{x..y}`, 중첩)으로 local 설정을 가리키던 우회. 전개하지 않고 가장 바깥 확장 가능 그룹을 와일드카드로 넓혀 판정한다(선형, 중첩 깊이 32 초과는 차단). 이 때문에 `ls {config,docs}/*`처럼 config 폴더를 포함할 수 있는 확장도 차단된다.
- 판정 불가·내부 오류는 `HOOK_GLOB_INVALID`·`HOOK_BRACE_UNDECIDABLE`·`HOOK_BRACE_INVALID`·`HOOK_INTERNAL_ERROR` 코드로 차단하며, 명령 원문과 패턴 내용은 출력하지 않는다.

v1.1 보호 경로 glob·brace 우회 차단 (`fix: block protected path glob and brace bypass`):

- 해결: 알려진 쓰기 동사(`rm`·`cp`·`mv`·`tee`·`del`·`Remove-Item`·`Set-Content`·`sed -i` 등)의 인자와 redirect 대상이 glob(`*`·`**`·`?`·`[...]`), brace, Windows 말미 점·공백, 8.3 짧은 이름(`RELEAS~1`), Git Bash·Cygwin 드라이브 표기(`/c/…`, `/cygdrive/c/…`), 서브셸 괄호로 `runs/`·`releases/`·`.git`을 가리키던 우회. 셸 확장·파일 열거 없이 구성요소가 보호 폴더 이름과 일치할 수 있으면 막는다. 상대경로는 깊이와 관계없이 보고, 절대경로는 glob 앞 리터럴 부분이 저장소 안이거나 저장소의 상위일 때만 본다.
- 해결: `cd`·`pushd`·`Set-Location` 등으로 보호 경로(일 수 있는 곳)로 이동한 뒤의 쓰기 동사나 상대경로 redirect.
- 쓰기 대상에 실행 시 값이 정해지는 구성요소(`$X`·`${X}`·`$(…)`·백틱·`%X%`·`$env:X`, 다른 사용자의 `~name`)가 있으면 `HOOK_WRITE_TARGET_UNDECIDABLE`로 막는다. 맨 앞 `~`는 hook 프로세스의 홈 폴더로 풀어 같은 기준으로 판정한다. 판정 중 오류는 `HOOK_PROTECTED_INVALID`로 막는다. 메시지에는 변수명·경로·명령 원문을 넣지 않는다.
- 새로 차단되는 정상 명령(승인된 보수적 판정): `rm -rf node_modules/*`·`rm -rf dist/*`처럼 보호 폴더 이름과 일치할 수 있는 glob 구성요소가 든 삭제(리터럴 경로 `node_modules/.cache`는 허용), 쓰기 동사 인자에 `$`가 든 명령(`sed -i 's/a$/b/' …`, `cp a "$X"`), `echo x > "$TMPDIR/x.txt"`처럼 변수로 시작하는 redirect.

hook의 범위 (명시적 한계):

- hook은 완전한 OS sandbox가 아니다. 알려진 쓰기 동사·redirect·Git 파괴 명령·local 설정 경로를 문자열로 판정하는 방어선이며, 실행 프로그램의 의미를 분석하지 않는다.
- 쓰기 동사 목록 밖의 명령은 판정하지 않는다. 예: `find runs -delete`, `node -e`로 파일 조작, `tar -C runs -x`, `rsync`, `robocopy`, 스크립트 파일 내부의 쓰기. 이 경우의 주 방어선은 subagent의 제한된 도구, 역할별 정확한 명령 allowlist, 판정 스크립트의 fingerprint·경로 검증이다.
- 따옴표 안의 `$`·glob도 셸과 달리 확장될 수 있다고 보고 막는다(셸보다 넓게 판정).

v1.1 보호 경로 상위 삭제·이동 차단 (`fix: block protected path ancestor deletion`):

- 해결: 삭제 동사(`rm`·`rmdir`·`del`·`erase`·`rd`·`Remove-Item`·`ri`)와 이동 동사(`mv`·`move`·`Move-Item`·`mi`·`Rename-Item`·`ren`·`rni`)의 source가 저장소 루트, 저장소의 상위(드라이브 루트·홈 포함), 또는 `runs/`·`releases/`·`.git`과 같거나 그 상위이던 우회(`rm -rf .`, `rm -rf ..`, 저장소 절대경로, `mv . ../backup`, `Remove-Item . -Recurse` 등). 이동 목적지(`-Destination`·`-NewName`·`-t`·마지막 인자)는 source로 보지 않는다.
- 작업 위치는 hook 입력의 `cwd`와 명령 안의 `cd`·`pushd`·`chdir`·`Set-Location`·`sl`·`Push-Location`으로 도달할 수 있는 위치를 모두 모은 집합으로 판정한다. 서브셸·파이프로 위치가 되돌아가는 경우를 놓치지 않기 위해 순서 추적 대신 집합을 쓴다(집합 크기 64 초과는 알 수 없는 위치로 본다).
- `/`·`\`, `.`·`..`(`...` 이상은 `..`로 봄), 말미 점·공백, 대체 데이터 스트림, 대소문자, `~`, Git Bash·Cygwin 드라이브 표기를 정규화한다. glob은 전개하지 않고 리터럴 prefix 이후 구성요소를 저장소까지 남은 경로 구성요소와 순서대로 비교해 일치할 수 있을 때만 막는다(`../*`·`../claude*` 차단, `../*.bak`·`/tmp/*` 허용). `**`, glob 뒤의 `..`, 변수, 다른 사용자의 `~name`, 드라이브 상대경로(`C:foo`)는 판정 불가로 막는다.
- 판정 불가는 `HOOK_WRITE_TARGET_UNDECIDABLE`, 판정 중 오류는 `HOOK_PROTECTED_INVALID`, 차단 사유는 `보호 경로의 상위 경로 삭제·이동`이며 경로·명령 원문을 출력하지 않는다.
- 전제: hook 입력의 `cwd`가 셸의 실제 작업 위치와 같다고 본다. `cwd`가 없으면 알 수 없는 위치로 보고 상대경로 삭제·이동을 막는다.
- 승인된 오탐: 가능한 작업 위치 집합에 시작 위치가 남으므로 `cd docs/sub && rm -rf ..`도 막는다. `cd node_mod* && rm -f a`처럼 glob·변수로 이동하거나 `cd -`·`popd` 뒤의 상대경로 삭제·이동, `cwd`가 없는 입력의 상대경로 삭제·이동도 막는다.
- 이 커밋으로 hook 보완을 마친다. 쓰기 동사 목록 밖의 임의 프로그램 의미 분석은 blocker급 직접 우회가 아닌 한 위 "hook의 범위" 한계로 문서화만 한다.

## 7. 패키지와 브라우저

### 7-1. 패키지

- 저장소 루트의 `package.json`·`package-lock.json`에 devDependencies를 정확한 버전으로 고정한다: `playwright@1.63.0`, `@axe-core/playwright@4.13.0`.
- `node_modules/`는 `.gitignore`에 추가한다. Git에는 올라가지 않지만 클라우드 동기화 폴더에 있으면 동기화 대상이 될 수 있다.

### 7-2. 브라우저 — 설치된 Chrome 채널 사용

- 최초 계획은 Chromium headless shell 다운로드였으나, `cdn.playwright.dev` 다운로드가 30초 제한 2회, 180초 제한 1회 모두 시간 초과로 실패했다. 다운로드는 더 시도하지 않는다.
- stage 3은 설치된 Chrome을 `channel: "chrome"`, `headless: true`로 실행한다. 경로를 하드코딩하지 않는다.
- `launchPersistentContext`와 사용자 `userDataDir`를 사용하지 않고, 실행마다 새 임시 browser context를 사용한다.
- Edge나 다른 브라우저로 자동 fallback하지 않는다. Chrome이 없거나 실행할 수 없으면 stage 3 전체를 `NEEDS_ATTENTION / TOOL_MISSING`으로 기록한다.

### 7-3. 제한

- 브라우저 버전이 고정되지 않는다. 실행마다 실제 브라우저 버전을 evidence에 기록한다.
- 사용자 Chrome 프로필 경로, 쿠키, 로그인 상태, 방문 기록, 확장 프로그램은 기록하지 않는다.
- 브라우저 업데이트·텔레메트리 통신은 판정 근거로 사용하지 않는다.
