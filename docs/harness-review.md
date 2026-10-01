# RE Webapp Factory Harness — 리뷰 기록 (R8-e)

- **기준 문서:** `docs/harness-verification.md` 5-1·5-2
- **이 문서의 원칙:** 1차 리뷰와 최종 리뷰를 모두 보존한다. 이전 기록은 수정하지 않고 아래에 이어서 적는다.

## 평가 기준

| 항목 | 배점 |
|---|---:|
| 기능·파이프라인 정확성 | 30 |
| Gate·보안·오판 방지 | 25 |
| 자동 테스트·실패 검증 | 20 |
| 구조·유지보수성 | 15 |
| 문서·사용성 | 10 |
| 합계 | 100 |

- 감점: blocker 10, high 5, medium 2, low 1, informational 0
- 같은 원인은 한 번만 감점한다. 각 항목은 0점 아래로 내려가지 않는다.
- 코드·설정·문서·테스트 실행으로 확인된 사실만 감점한다. 추측은 발견 사항이 아니라 미검증 범위로 옮긴다.
- 실제로 `NOT_RUN`인 검증 범위는 "자동 테스트·실패 검증" 항목의 확인된 검증 공백으로만 평가한다.

---

## 1차 리뷰 (2026-09-30)

- **리뷰어:** Explore agent (읽기 전용). Read·Grep·Glob만 사용했고, Bash 시도는 project hook이 `알 수 없는 subagent (agent_type: Explore)`로 차단했다.
- **대상:** 추적 파일 전체와 커밋 예정 파일 3개(`tests/mutations.json`, `tests/expected.json`, `tests/unit/failures.test.mjs`). 추적되지 않는 `node_modules`, `runs`, 임시 파일은 제외했다.
- **리뷰 시점 커밋:** R8-d 완료 커밋(`feat: enforce harness role boundaries`) + 커밋 전 테스트 파일 3개
- **메인 세션이 제공한 실행 결과:** `npm test` 123개 통과·0개 실패·0개 건너뜀, F1~F10 기대 결과와 정확히 일치, 원본 sample-app fingerprint 전후 동일, 임시 폴더·실제 `runs/`·`releases/` 0건, 실제 subagent smoke test 3건 통과, project hook 실제 차단 확인

### 1-1. 총점: **80 / 100**

high 1건(R1)이 있으므로 `docs/harness-verification.md` 5-2에 따라 R8을 완료로 표시하지 않는다.

### 1-2. 항목별 점수

| 항목 | 배점 | 감점 근거 | 계산 | 점수 |
|---|---:|---|---|---:|
| 기능·파이프라인 정확성 | 30 | R2(2), R9(1), R10(1) | 30 − (2+1+1) | 26 |
| Gate·보안·오판 방지 | 25 | R1(5), R3(2), R5(1), R6(1), R7(1), R8(1) | 25 − (5+2+1+1+1+1) | 14 |
| 자동 테스트·실패 검증 | 20 | R4(2) | 20 − 2 | 18 |
| 구조·유지보수성 | 15 | R11(1), R12(1) | 15 − (1+1) | 13 |
| 문서·사용성 | 10 | R13(1) | 10 − 1 | 9 |
| **합계** | 100 | | 26+14+18+13+9 | **80** |

### 1-3. 발견 사항 (심각도순)

모든 발견 사항의 추측 여부는 `false`다.

#### R1 — record-judgement가 판정 JSON을 재계산 없이 기록 (high, −5)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/orchestrator/record-judgement.mjs` — `validateJudge`(12–21), `main`(36–47, 53, 60–63, 77)
- **확인한 코드:** stdin JSON(37행 `JSON.parse(readStdin())`)에서 `judge === 'gate-judge'`, `standards_version`, verdict 스키마, `stage5.binding`과 현재 결합값의 일치만 확인한다. judge를 다시 실행하거나 재계산하지 않는다. `pre_record_authorizations` 추가(60–63)와 `nextStatus`(24–27)는 stdin verdict만 사용한다. `tests/unit/release-flow.test.mjs` 158–165는 스키마 오류와 standards 불일치만 검사한다.
- **실제 결과:** 결합값만 맞춘 JSON을 stdin으로 넣으면 pre_record 허가가 기록되고, 이 허가로 `write-release.mjs`가 릴리스 파일을 만든 뒤 COMPLETE까지 기록되는 코드 경로가 있다. hook-guard는 main의 `echo … | node scripts/orchestrator/record-judgement.mjs …`를 막지 않는다. 문서도 어긋난다(orchestrator 5절 "gate-judge 재판정 → 오케스트레이터 기록", 8절 "judge.mjs 출력을 파이프", roles 2절 "최종 판정에는 gate-judge 결과 사용").
- **관련 규칙:** 5-1 기준 3, 불변 원칙 1, `docs/harness-orchestrator.md` 7절 2·4, `docs/harness-roles.md` 2절
- **권장 보완:** record-judgement가 judge 순수 로직을 import해 재계산하고, stdin을 쓰지 않거나 재계산 결과와 완전히 같을 때만 기록한다. 조작 verdict 거부 테스트를 추가한다.

#### R2 — ST-05 UI 버전 위치가 index.html로 한정 (medium, −2)

- **category:** 기능·파이프라인 정확성
- **파일·위치:** `scripts/stages/stage2-static.mjs` — `judgeVersionMatch` 192–194
- **확인한 코드:** `const uiFiles = ctx.exists('index.html') ? ['index.html'] : []`
- **실제 결과:** ST-01은 `src/main.*`, `app/page.*`, `pages/index.*`도 진입점으로 인정한다. 버전이 JS 소스에만 표시되면 UI 위치가 `NOT_APPLICABLE`이 되고, 나머지 위치가 일치하면 ST-05가 PASS가 된다. UI 버전 불일치를 확인하지 않고 통과한다.
- **관련 규칙:** checks.json ST-05 `locations.ui: "진입점 HTML/소스의 v?X.Y.Z 표시"`, 불변 원칙 1
- **권장 보완:** ST-01이 찾은 진입점 전체(소스 포함)를 UI 위치로 검사하고, 판정할 수 없으면 `NEEDS_ATTENTION`.

#### R3 — git commit fingerprint에 gitignore 파일 변경 미반영 (medium, −2)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/lib/fingerprint.mjs` — `gitCleanCommit` 66–77(71행), `computeFingerprint` 90–91, `walkApp` 18–44; `scripts/lib/local-server.mjs`
- **확인한 코드:** 깨끗한지 판단할 때 `git status --porcelain --untracked-files=all`만 쓰고 `--ignored`는 없다. `walkApp`은 gitignore와 무관하게 파일을 수집하고, stage 2와 local-server가 이 파일을 쓴다.
- **실제 결과:** app_path가 깨끗한 git 저장소면 fingerprint가 commit SHA가 되어, 검사·제공되는 gitignore 파일이 바뀌어도 fingerprint가 같다. HA 승인과 stage 3·4 근거가 계속 "현재"로 인정된다. `docs/harness-artifacts.md` 6절(content hash만 설명)과 `docs/harness-pipeline.md` 4절(commit SHA 설명)도 다르다.
- **관련 규칙:** checks.json JG-01 `max_pass_with_stale_fingerprint: 0`, HA `match: fingerprint`, `docs/harness-artifacts.md` 6
- **권장 보완:** 무시 파일이 있으면 content hash를 쓰거나 commit SHA와 결합하고, artifacts 6절을 갱신한다.

#### R4 — 실제 운영 환경 검증 공백 (medium, −2)

- **category:** 자동 테스트·실패 검증
- **파일·위치:** `tests/unit/release-flow.test.mjs` `writeSyntheticStage4`(43–65), `tests/unit/integrity.test.mjs` 80–93(run-stage 4 호출 금지)
- **확인한 내용:** 실제 HTTPS 운영 URL 성공 경로와 실제 모바일 기기 승인 end-to-end는 `NOT_RUN`이다. stage 4는 모의 resolver·transport의 합성 결과(`end_to_end: false`)만 쓴다.
- **실제 결과:** `netguard.defaultTransport`의 실제 TLS 연결, DNS pinning, redirect 경로와 COMPLETE 전이가 자동 검증되지 않았다.
- **관련 규칙:** `docs/harness-verification.md` 2(R8-c 제한), 5-2, 6-3
- **권장 보완:** 실제 운영 URL이 생기면 stage 4·5 end-to-end를 1회 실행해 6-3에 기록한다.
- **비고:** 버그가 아니라 검증 공백으로만 평가했다.

#### R5 — main 세션이 runner·recorder 스크립트를 직접 실행할 수 있음 (low, −1)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/hook-guard.mjs` — `decide` 176–184, `shellViolation` 115–125
- **확인한 코드:** main 역할의 Bash는 git 위반과 보호 경로 쓰기 동사만 검사한다. `node scripts/run-stage.mjs …`, `node scripts/write-release.mjs …`가 허용된다.
- **실제 결과:** main 세션이 `02~04` 결과와 `releases/`를 직접 만들 수 있다.
- **관련 규칙:** `docs/harness-roles.md` 1절, `docs/harness-orchestrator.md` 7절 1
- **권장 보완:** main 역할에서 두 스크립트 실행을 차단하거나, 스크립트가 실행 주체를 확인한다.

#### R6 — 바이너리 추정 파일을 비밀·혼입 검사에서 건너뜀 (low, −1)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/stages/stage2-static.mjs` — `buildContext` 28, `judgeSecretScan` 141, `judgePatternAbsent` 166
- **확인한 코드:** 첫 8000바이트에 NUL이 있으면 텍스트로 보지 않고 ST-03·ST-04 내용 검사를 건너뛴다.
- **실제 결과:** 건너뛴 파일이 있어도 PASS이며 evidence에는 `binary_skipped` 개수만 남는다. 제외 범위와 8000이라는 값이 checks.json에 없다.
- **관련 규칙:** 5-1 기준 1, checks.json ST-03·ST-04 scope
- **권장 보완:** 바이너리 판별 규칙을 checks.json policies로 옮기거나, 건너뛴 파일이 있으면 `NEEDS_ATTENTION`.

#### R7 — judge가 runner의 "실행 중 fingerprint 변경" 표시를 무시 (low, −1)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/judge.mjs` — `rejudge` 39–48, `compare` 26–37
- **확인한 코드:** `run-stage.mjs` 57–63은 측정 중 fingerprint가 바뀌면 `run_status: 'BLOCKED'`, `fingerprint_changed_during_run: true`를 기록한다. judge는 status·failure_code만 비교하고 재계산한다.
- **실제 결과:** 측정 중 앱이 바뀌었다 되돌아간 경우 runner는 BLOCKED, judge는 `AWAITING_DEPLOYMENT`를 낼 수 있고 불일치로 기록되지 않는다.
- **관련 규칙:** `docs/harness-roles.md` 2절
- **권장 보완:** `fingerprint_changed_during_run === true`이면 judge도 BLOCKED.

#### R8 — operating_url 원문이 마스킹 없이 출력·기록됨 (low, −1)

- **category:** Gate·보안·오판 방지
- **파일·위치:** `scripts/write-release.mjs` 46–52, `scripts/stages/stage5-release.mjs` 95·141(`bind_to`, `binding`), `scripts/orchestrator/set-deployment.mjs` 19
- **확인한 코드:** stage 4 evidence는 `maskUrl`로 query 값을 마스킹하지만, judge stdout(stage5.binding), run.json, approvals.json, 05-release, 커밋 대상 `releases/*.md`에는 URL 원문이 들어간다. set-deployment는 userinfo만 거부한다.
- **실제 결과:** query에 토큰이 포함된 URL이면 출력과 커밋 대상 파일로 그대로 나간다.
- **관련 규칙:** 5-1 기준 4, checks.json `policies.production_network.evidence_fields: masked_url`
- **권장 보완:** set-deployment에서 query·fragment가 있는 URL을 거부하거나, 기록·출력에 마스킹된 URL을 쓴다.

#### R9 — DS-04·DS-05가 `font` 단축 속성과 외부 CSS를 검사하지 않음 (low, −1)

- **category:** 기능·파이프라인 정확성
- **파일·위치:** `scripts/stages/stage2-static.mjs` — `judgeLineHeight` 289, `judgeFontFamily` 325; `scripts/lib/css.mjs` `collectCss` 54–74
- **확인한 코드:** 검사 대상이 `d.prop === 'line-height'`, `d.prop === 'font-family'`뿐이다. 로컬 `.css`와 `<style>`만 수집하고 외부 `<link href="https://…">`는 marker 없이 무시한다.
- **실제 결과:** `font: 16px/1.2 Arial` 같은 단축 속성이나 외부 CSS를 써도 PASS가 나올 수 있다.
- **관련 규칙:** checks.json DS-04·DS-05, `docs/harness-verification.md` 5-3
- **권장 보완:** `font` 단축 속성을 해석하거나 marker로 보고하고, 외부 stylesheet가 있으면 `NEEDS_ATTENTION`.

#### R10 — HA 거절 뒤 같은 결합값으로 재승인 가능 (low, −1)

- **category:** 기능·파이프라인 정확성
- **파일·위치:** `scripts/stages/stage5-release.mjs` `judgeApprovals` 34–38, `scripts/orchestrator/record-approval.mjs` 39–53
- **확인한 코드:** HA 판정은 현재 결합값과 일치하는 마지막 기록을 쓴다. 같은 fingerprint·URL에서 REJECT 후 APPROVE하면 PASS다. `tests/unit/release-flow.test.mjs` 148–151이 이 흐름을 허용한다. 운영 URL 확인(8-1)은 같은 deployment에서 거절이 유지된다.
- **실제 결과:** `docs/harness-pipeline.md` 3절은 사람 거절을 BLOCKED로 두고 2단계·4단계로 복귀하게 하며(fingerprint나 배포 변경 전제), checks.json도 `on_reject: "BLOCKED"`다. HA와 URL 확인의 정책이 다르다.
- **관련 규칙:** checks.json HA-01~03 `on_reject`, `docs/harness-pipeline.md` 3
- **권장 보완:** 거절 뒤 재승인 정책을 문서로 정하고 구현·문서·테스트를 맞춘다.

#### R11 — 충돌 기록이 영구적이고 failure_code 의미가 섞임 (low, −1)

- **category:** 구조·유지보수성
- **파일·위치:** `scripts/orchestrator/record-judgement.mjs` 56–59, `scripts/stages/stage5-release.mjs` 113–114, `scripts/judge.mjs` 61–62
- **확인한 코드:** runner·judge 불일치가 run.json `conflicts`에 영구 누적되고, post_record는 이를 `RELEASE_RECORD_CONFLICT`로 판정한다. stage 2 비교는 runner 결과의 fingerprint가 현재 값인지 먼저 확인하지 않는다.
- **실제 결과:** runner 실행 뒤 앱이 바뀌기만 해도 충돌이 기록되고 그 실행은 영구히 COMPLETE가 불가능해진다(fail-closed이므로 잘못된 통과는 아니다). 릴리스 기록 충돌 코드가 runner·judge 충돌에 재사용된다.
- **관련 규칙:** checks.json JG-02 `post_record.max_conflict_records`, `docs/harness-roles.md` 2절
- **권장 보완:** stage 2 비교 전 fingerprint가 오래됐는지 먼저 판정하고, 충돌 종류를 나눠 기록한다.

#### R12 — required_tools의 node 최소 버전을 확인하는 코드 없음 (low, −1)

- **category:** 구조·유지보수성
- **파일·위치:** `standards/checks.json` 14행
- **확인한 명령:** Grep `required_tools|min_version` — 코드에서 쓰는 곳은 `scripts/stages/stage3-browser.mjs` 23행(browser 항목)뿐
- **실제 결과:** `node min_version 20`과 `policies.missing_tool` 사이에 연결된 코드가 없다. 테스트는 Node 24.19.0에서만 실행됐다.
- **관련 규칙:** checks.json `required_tools`, `policies.missing_tool`
- **권장 보완:** 시작 시 `process.versions.node`를 확인한다.

#### R13 — verification 6-2와 expected.json의 end_to_end 값 불일치 (low, −1)

- **category:** 문서·사용성
- **파일·위치:** `docs/harness-verification.md` 166행, `tests/expected.json`, `tests/unit/failures.test.mjs` 55행
- **확인한 내용:** 문서는 "F2·F8·F9·F10은 false"라고만 적어 F1~F7이 true처럼 읽힌다. expected.json과 테스트는 F1~F10 모두 false다. F1~F7은 판정 함수를 직접 호출하며, F7만 run-stage 2단계를 추가로 실행한다.
- **관련 규칙:** `docs/harness-verification.md` 4-1, 6-2
- **권장 보완:** 6-2를 "F1~F10 모두 end_to_end: false"로 고친다.

#### R14 — checks.json 밖의 측정 파라미터 (informational, 0)

- `scripts/stages/stage3-browser.mjs` 109행 `waitForTimeout(100)`, 184·189행 `.slice(0, 200)`, 225행 `total + 2`; `scripts/lib/netguard.mjs` 21–27·60–62행 주소 범주별 CIDR
- 판정 임계값이 아니라 측정·분류용 값이다. sticky 측정 대기 시간은 결과에 영향을 줄 수 있어 checks.json 이동 검토를 권장한다.

#### R15 — hook의 셸 해석 한계 (informational, 0)

- `scripts/hook-guard.mjs` main 분기. `node -e`로 파일 쓰기, git alias(`git -c alias.x=push x`)는 탐지하지 않는다.
- `docs/harness-verification.md` 5-4에 이미 기록된 한계이므로 감점하지 않는다.

### 1-4. 감점 계산

| 등급 | 건수 | 감점 |
|---|---|---|
| high | R1 | 5 |
| medium | R2, R3, R4 | 2 × 3 = 6 |
| low | R5~R13 | 1 × 9 = 9 |
| informational | R14, R15 | 0 |
| **합계** | | **20** → 100 − 20 = **80** |

같은 원인은 한 번만 감점했다: orchestrator 5절·8절 문서 불일치와 조작 입력 테스트 부재는 R1에, artifacts 6절 문서 불일치는 R3에 포함했다.

### 1-5. 미검증 범위

- 실제 HTTPS 운영 URL에서의 stage 4 성공 경로: `NOT_RUN` (실제 TLS, DNS pinning, redirect 재검증은 모의 입력으로만 확인)
- 실제 모바일 기기 검수, 홈 아이콘 승인, 최종 승인이 들어간 stage 5 end-to-end와 실제 `COMPLETE` 전이: `NOT_RUN`
- Node 20에서 `npm test`(glob 해석) 동작: 미실행
- 대상 앱 `.git/config`의 `core.fsmonitor` 등이 fingerprint용 `git status`에 주는 영향: 미실행
- `package-lock.json`의 다른 OS용 선택 의존성 누락 여부: 미대조 (확인된 사실: 패키지 4개 정확한 버전 고정, registry.npmjs.org 주소, sha512 integrity, 불필요한 패키지 없음)
- sample-app 아이콘 PNG의 실제 픽셀 내용, `sw.js` 동작: 코드 수준에서 미확인
- `.claude/agents` hook의 exec form 동작: 메인 세션 smoke 결과를 신뢰

### 1-6. 보완 우선순위 (리뷰어 제안)

1. R1 — record-judgement 재계산, 조작 입력 거부 테스트
2. R3 — fingerprint에 검사·제공되는 gitignore 파일 반영, artifacts 6절 갱신
3. R2 — ST-05 UI 위치를 진입점 전체로 확대
4. R7 / R8 / R6
5. R5 / R10 / R11 / R9
6. R12 / R13
7. R4 — 실제 운영 URL이 생기면 stage 4·5 end-to-end 1회 실행

### 1-7. 해석 항목 판단

| # | 항목 | 판단 |
|---|---|---|
| a | ST-05: README의 모든 X.Y.Z가 목표 버전과 같아야 함 | 잘못된 통과 위험은 없고 잘못된 실패 위험이 있다(의존성 버전 문자열 등). 감점 없음, 대상 문자열 명확화 권장 |
| b | DS: px 아닌 단위·`var()`·`calc()`는 `NEEDS_ATTENTION` | 문제 아님 (`judgeCssValues` 266–272, 5-3과 일치). 실제 앱에서 rem·var 사용 시 대부분 멈추므로 문서화 권장 |
| c | 미리보기로 표시(REJECT)한 URL은 요청하지 않음 | 문제 아님 (`stage4-production.mjs` 38–46, `stage4-evaluate.mjs` 13행, orchestrator 8-1과 일치) |
| d | HA: 앞 단계 대기면 뒤도 대기, 거절·만료면 `NOT_RUN` | 문제 아님 (F8에서 fail-closed 확인). 재승인 문제는 R10 |
| e | JG-02 pre_record 2회 판정 흐름 | 문제 아님 (checks.json `requires_run_status`, release-flow 185–198). orchestrator 5절에 순서 한 줄 추가 권장 |
| f | required_tools의 node 항목 | 문제 있음 → R12 |
| g | `.harness-inbox/` | 문제 아님 (gitignore, 문서화됨). 원문 파일 수동 정리 필요 |
| h | F1~F7도 `end_to_end: false` | 구현 기록이 정확하고 문서가 틀림 → R13 |

### 1-8. 사용자 결정 (2026-09-30)

- 1차 결과 80/100 승인
- 보완 승인: R1~R3, R5~R13, R4(가능한 범위의 결정적 테스트만. 실제 운영 URL·실제 기기 검증은 계속 `NOT_RUN`)
- R14·R15: 이번에는 수정하지 않음
- R10 정책: 같은 `run_id`·fingerprint·`target_version`·`operating_url` 결합값에서 REJECT가 기록되면 APPROVE로 뒤집을 수 없다. 재승인은 새 실행 또는 결합값 변경이 있어야 한다. 거절 기록은 보존한다.

---

## 1차 보완 (2026-09-30)

- 커밋: `fix: address approved harness review findings`
- 보완 항목: R1~R3, R5~R13, R4(결정적 테스트만. 실제 운영 URL·실제 기기 검증은 `NOT_RUN` 유지)
- 보완 후 실행 결과: `npm test` 140개 통과·0개 실패·0개 건너뜀, F1~F10 기대 결과와 정확히 일치, 원본 sample-app fingerprint 전후 동일, 임시 폴더·실제 `runs/`·`releases/`·Chrome 프로필 변경 0건, checks.json `standards_version` 1.3.0·check 32개·정규화 해시 7/7

---

## 2차 독립 리뷰 (2026-09-30)

- **리뷰어:** 새 Explore agent (읽기 전용). 1차 점수·발견 사항을 전달하지 않았고, 이 문서와 `docs/harness-verification.md` 6-4절은 읽지 않도록 지시했다. 리뷰어는 두 파일을 열지 않았다고 보고했다.
- **리뷰 시점 커밋:** 1차 보완 커밋(`fix: address approved harness review findings`)
- **기준:** 1차와 같은 100점 배점과 감점 규칙

### 2-1. 총점: **85 / 100** (blocker 0, high 0, medium 4, low 7, informational 2)

### 2-2. 항목별 점수

| 항목 | 배점 | 감점 근거 | 계산 | 점수 |
|---|---:|---|---|---:|
| 기능·파이프라인 정확성 | 30 | S1(2) | 30 − 2 | 28 |
| Gate·보안·오판 방지 | 25 | S2(2), S3(2), S5(1), S6(1), S7(1) | 25 − 7 | 18 |
| 자동 테스트·실패 검증 | 20 | S4(2), S11(1) | 20 − 3 | 17 |
| 구조·유지보수성 | 15 | S8(1), S9(1) | 15 − 2 | 13 |
| 문서·사용성 | 10 | S10(1) | 10 − 1 | 9 |
| **합계** | 100 | | 100 − 15 | **85** |

### 2-3. 발견 사항 (추측 여부는 모두 `false`)

| # | severity | category | 감점 | 파일·위치 | 확인한 코드와 실제 결과 | 권장 보완 |
|---|---|---|---:|---|---|---|
| S1 | medium | 기능·파이프라인 | 2 | `scripts/run-stage.mjs` 71–80, `scripts/lib/judge-core.mjs` `staleReason`·`rejudge`, `scripts/stages/stage4-evaluate.mjs` 18, `scripts/orchestrator/record-judgement.mjs` 71–73, `scripts/stages/stage5-release.mjs` 119–120 | 운영 URL 확인 전에 stage 4를 실행하면 runner PD-01은 `AWAITING_APPROVAL`, 확인 뒤 judge는 PASS로 재계산한다. `staleReason`은 fingerprint·standards_version·deployment_id만 봐서 이 차이를 불일치로 처리하고, record-judgement가 현재 fingerprint로 `conflicts`에 남긴다. 충돌 필터가 fingerprint만 봐서 stage 4 재실행·새 deployment 뒤에도 남아 `RUNNER_JUDGE_CONFLICT`로 COMPLETE가 막힌다. 테스트는 항상 확인 뒤 stage 4를 실행해 이 순서를 검증하지 않았다 | 확인 상태 변경을 stale 사유로 처리, 충돌 필터에 deployment 반영, 순서 테스트 추가 |
| S2 | medium | Gate·보안 | 2 | `scripts/write-release.mjs` 34–40, `scripts/orchestrator/record-approval.mjs` 45 | write-release는 `run.status`와 최신 허가의 결합값 6개만 확인하고 approvals를 다시 보지 않는다. pre_record 허가 → 거절 기록 → record-judgement 재호출 없이 release-recorder 실행 순서면 릴리스 파일이 생성되고 이후 같은 버전은 `RELEASE_RECORD_EXISTS`로 막힌다 | write-release에서 HA 상태 재계산 또는 허가에 approvals 상태 결합 |
| S3 | medium | Gate·보안 | 2 | `scripts/lib/local-server.mjs` `resolveRequestPath` 23–51, `scripts/lib/fingerprint.mjs` 28–32·60–61, `standards/checks.json` 31–32·173, `scripts/stages/stage2-static.mjs` 196·218 | 로컬 서버가 `exclude_dirs`(dist, build 등)를 확인하지 않고 제공한다. 그 파일이 바뀌어도 fingerprint가 같고 ST-03·ST-04 검사 범위 밖이다. `fingerprint.mjs` 주석과 `docs/harness-artifacts.md` 6절 문구("브라우저 제공 대상 파일 모두 포함")와 맞지 않는다 | 서버에서 제외 경로 요청 거부 또는 제공 시 NEEDS_ATTENTION |
| S4 | medium | 자동 테스트 | 2 | `docs/harness-verification.md` 189–190, `tests/unit/release-flow.test.mjs` 266–283 | 실제 HTTPS 운영 URL 성공, 실제 기기 승인 end-to-end가 `NOT_RUN`. COMPLETE 전이는 모의 응답 judge_unit으로만 확인 (검증 공백으로만 평가) | 실제 URL로 stage 4 1회 실행 후 기록 |
| S5 | low | Gate·보안 | 1 | `scripts/stages/stage3-browser.mjs` 181–190 `measureConsole` | 콘솔·페이지 오류 원문 200자를 마스킹 없이 FA-01 evidence에 기록 | ST-03 패턴·URL query 마스킹 또는 개수만 기록 |
| S6 | low | Gate·보안 | 1 | `scripts/stages/stage3-evaluate.mjs` `evalTargetSize`·`evalFocus`, `scripts/stages/stage4-evaluate.mjs` `evalAssets` | 측정 대상 0개일 때 MB-03·PD-02는 PASS, FA-03은 NEEDS_ATTENTION | 0개 처리 규칙을 checks.json에 두고 통일 |
| S7 | low | Gate·보안 | 1 | `scripts/lib/fingerprint.mjs` `contentHash` 49–58 | 파일별 해시에 경로·내용 구분자가 없어 `{ab: c}`와 `{a: bc}`가 같은 값 (결함 출처는 artifacts 6절 정의) | 길이 접두사·구분자, standards_version 갱신 |
| S8 | low | 구조 | 1 | `scripts/stages/stage3-browser.mjs` 109 | MB-04 대기 100ms가 checks.json 밖 | rule에 `settle_ms` |
| S9 | low | 구조 | 1 | `stage5-release.mjs` 18, `record-approval.mjs` 42·48, `run-stage.mjs` 28–35, `run-state.mjs` 9–18 | applies_when 정규식 3곳 중복, 최신 결과 탐색 2곳 중복 | `appliesWhen`·`latestValidResult`로 통일 |
| S10 | low | 문서 | 1 | `docs/harness-verification.md` 184·192 | 테스트 수 123(실제 140), 없어진 git status 미검증 항목이 남음 | 갱신 |
| S11 | low | 자동 테스트 | 1 | `package.json` engines, `standards/checks.json` 14, verification 191 | Node 20에서 미실행 (검증 공백) | Node 20에서 1회 실행 |
| S12 | info | Gate·보안 | 0 | `scripts/hook-guard.mjs` `shellViolation`, `judge-core.mjs` `rawsFromItems` | `node -e`로 runs/ 쓰기 미탐지, judge는 runner 원시값 신뢰. 5-4·roles 2절에 문서화됨 | 결과 파일 무결성 표시 검토 |
| S13 | info | 문서 | 0 | `hook-guard.mjs` 133–158, orchestrator 7, 저장소 루트 | 실행·개발 모드를 hook이 강제하지 않음, CLAUDE.md 없음 | CLAUDE.md에 호출 순서 명시 |

### 2-4. 감점 계산과 중복 여부

- medium 4 × 2 = 8, low 7 × 1 = 7, informational 0 → 감점 15, **85점**
- S1·S2는 원인이 다르다(stale 판정 기준 / approvals 재확인). 두 시나리오 테스트 부재는 각 항목에 포함했다.
- S3·S7은 fingerprint 관련이지만 원인이 다르다(서버 제공 범위 / 해시 구성).
- S4·S11은 서로 다른 검증 공백이다.

### 2-5. 미검증 범위

- Windows 경로 정규화 우회(`runs./x`, `runs /x`, `runs::$DATA`)의 실제 동작
- 실제 HTTPS 운영 URL stage 4 성공, 실제 기기 승인 stage 5 end-to-end, 실제 COMPLETE 전이: `NOT_RUN`
- Node 20, macOS·Linux 동작
- S1·S2 시나리오의 실제 실행 (코드 경로로만 확인)
- netguard 전체 요청 시간 제한, SSOT에 없는 예약 대역(100.64.0.0/10 등)
- 일부 테스트 파일·기준 문서 본문의 전체 대조

### 2-6. 1차 대비 비교

| 항목 | 배점 | 1차 | 2차 | 차이 |
|---|---:|---:|---:|---:|
| 기능·파이프라인 정확성 | 30 | 26 | 28 | +2 |
| Gate·보안·오판 방지 | 25 | 14 | 18 | +4 |
| 자동 테스트·실패 검증 | 20 | 18 | 17 | −1 |
| 구조·유지보수성 | 15 | 13 | 13 | 0 |
| 문서·사용성 | 10 | 9 | 9 | 0 |
| **합계** | 100 | **80** | **85** | **+5** |
| high 이상 | | 1 | 0 | |

- 1차의 R1~R3, R5~R7, R9~R13은 2차에서 다시 보고되지 않았다.
- R4는 S4로 유지됐다(의도한 `NOT_RUN`).
- 1차 informational R14(측정 상수)는 2차에서 S8(low −1)로, 1차 미검증 범위의 Node 20은 S11(low −1)로 채점됐다. 리뷰어 간 채점 차이다.
- S1은 R11 보완에서 충돌을 fingerprint로만 거르도록 한 부분과, S3·S10은 R3 보완 때 쓴 문서 문구·미갱신 문서와 관련 있다.

### 2-7. 사용자 결정 (2026-09-30)

- 2차 결과 85/100을 공식 점수로 기록한다. 전체 3차 재채점은 하지 않는다.
- 보완: S1, S2, S3, S5, S6, S7, S10
- 보류: S4(`NOT_RUN` 유지), S8·S9·S11(알려진 한계), S12(문서화된 정보 항목), S13(CLAUDE.md 확정 시 해결)
- 보완 후에는 수정 파일과 관련 호출 경로만 대상으로 읽기 전용 표적 검토를 1회 수행하고, 새 점수는 계산하지 않는다.

---

## 부록 — 2차 리뷰 후 보완 검증 (2026-09-30)

> **공식 독립 리뷰 점수는 2차 85/100으로 유지한다.** 2차 리뷰 후 S1·S2·S3·S5·S6·S7·S10 및 추가 보안 2건을 보완했으나 **독립 재채점은 하지 않았다.**

### A-1. 표적 검토 (읽기 전용, 1회)

- 새 Explore agent가 수정 파일과 관련 호출 경로만 검토했다. 1차·2차 점수와 발견 사항은 전달하지 않았고, 점수를 매기지 않았다.
- 결과: S1·S2·S5·S6·S7·S10 충족, **S3 부분 충족**(Windows 대소문자 우회), 새 blocker·high 없음. 참고 사항으로 개인키 본문 노출(medium)과 low 항목들이 보고됐다.
- 메인 세션이 임시 폴더에서 로컬 서버를 실행해 S3 우회를 확인했다: `/DIST/app.css`, `/Dist/app.css`, `/debug.LOG`가 200으로 제공됐고, 끝 점(`/dist./`)은 404로 우회되지 않았다.
- 사용자 결정에 따라 S3 대소문자 우회와 개인키 본문 노출을 추가 보완했다. 이후 추가 리뷰는 실행하지 않았다.

### A-2. 보완 항목과 테스트 근거

| 항목 | 보완 | 회귀 테스트 |
|---|---|---|
| S1 | stage 4 결과에 측정 당시 운영 URL 확인 상태를 기록하고, 확인 상태·deployment가 바뀐 결과는 stale(`URL_CONFIRMATION_CHANGED`/`EVIDENCE_STALE`)로 분류. 충돌은 현재 fingerprint·현재 deployment만 집계 | `release-flow.test.mjs` "S1 stage 4 선실행 → 확인·새 deployment → stage 4 재실행 → 정상 진행" |
| S2 | `write-release`가 파일 생성 직전 judge 순수 로직으로 pre_record 조건을 재계산하고 바로 exclusive create. 이미 파일이 있으면 먼저 거부 | `release-flow.test.mjs` "S2 pre_record 허가 뒤 거절이 추가되면 릴리스 파일을 만들지 않는다" |
| S3 | 로컬 서버가 fingerprint 제외 경로를 403으로 거부하고 요청 경로를 evidence에 기록. 정책 없이 시작 불가. **추가:** `win32`에서 fingerprint와 서버가 같은 대소문자 무시 판정 사용 (`policies.fingerprint.case_insensitive_platforms`) | `second-review-fixes.test.mjs` S3 3건 + "S3 추가: Windows 대소문자 우회" |
| S5 | 콘솔·페이지 오류 원문에 ST-03 패턴·URL 사용자정보·query·fragment 마스킹, 길이 제한(`policies.evidence_text`). **추가:** 개인키 블록을 BEGIN부터 END(없으면 끝)까지 하나의 값으로 마스킹, 길이 자르기 전에 적용 | `second-review-fixes.test.mjs` S5 2건 + 개인키 2건 (실제 Chrome으로 `run-stage 3` 실행, stdout·stderr·결과 파일에 sentinel 본문·완성 토큰 0건) |
| S6 | 측정 대상 0개면 `NEEDS_ATTENTION` (`policies.zero_targets`: MB-03·FA-03·PD-02) | `second-review-fixes.test.mjs` S6 |
| S7 | fingerprint를 길이 접두사 인코딩으로 변경 (`policies.fingerprint.encoding`) | `second-review-fixes.test.mjs` S7 |
| S10 | verification 문서의 테스트 수와 fingerprint 방식 갱신 | — |

### A-3. 보완 후 실행 결과

- `npm test`(테스트 파일 순차 실행 `--test-concurrency=1`): **152개 통과, 0개 실패, 0개 건너뜀**
- F1~F10: 기대 결과와 정확히 일치
- `standards/checks.json`: `standards_version` 1.5.0, check 32개, ID 중복 0, 자리표시자 0, source_reference 누락 0, 스키마 오류 0, 정규화 해시 7/7
- 부수 효과: 테스트 임시 폴더 0, Playwright 임시 폴더 0, 실제 `runs/`·`releases/` 0건, 사용자 Chrome 프로필 변경 0건
- 추적 파일의 완성 토큰·sentinel 개인키 본문: 0건

### A-4. 남은 감점과 알려진 한계

- 2차 리뷰의 남은 항목: S4(실제 운영·실기기 검증 공백, `NOT_RUN`), S8(측정 상수), S9(로직 중복), S11(Node 20 미실행), S12·S13(정보 항목)
- 표적 검토 후 알려진 한계: scheme 없는 상대 URL query 마스킹, 200자 + 말줄임표 표기와 메시지 개수 상한, `zero_targets.applies_to`를 코드가 직접 읽지 않음, S1의 실제 `run-stage 4` 통합 테스트 공백
- hook 오탐: 역할 전용 스크립트 경로 문자열이 들어간 읽기 명령·heredoc도 차단될 수 있음 (fail-closed, 제출 후 "실제 node 실행 형태일 때만 차단"으로 정교화 후보)
- 테스트 정리: 흐름 테스트 중간 실패 시 공유 `releases/` 정리가 남아 연쇄 실패 가능 (테스트 격리 개선 후보)
- 실제 HTTPS 운영 URL 성공 경로, 실제 모바일 기기 승인이 들어간 stage 5 end-to-end, 실제 `COMPLETE` 전이: `NOT_RUN`
