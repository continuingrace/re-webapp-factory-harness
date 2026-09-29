# RE Webapp Factory Harness (v1)

개인 웹앱을 GitHub 기반으로 만들고 운영하는 1인 메이커를 위한 **Claude Code 검수·릴리스 하네스**입니다.
구현이 끝난 웹앱을 5개 QA Gate로 검수하고, 버전·문서·운영 URL을 맞춘 뒤 사람 승인을 거쳐 릴리스 기록을 남깁니다.
판정은 스크립트가 하고, 에이전트는 스크립트를 실행하고 결과를 옮기기만 합니다.

## 해결하려는 문제 (`docs/PRD.md`)

- 새 웹앱마다 폴더 구조, 문서, 디자인 기준과 개발 절차가 달라진다.
- 기능 수정 후 모바일·접근성·실제 배포 환경 검수가 빠지기 쉽다.
- 코드 변경과 버전 번호, README, CHANGELOG가 어긋난다.
- 반복 수정: 폰트 위계·행간·자간·여백, 모바일 상단 고정, 홈 화면 아이콘 누락 (`docs/story-work.md`)

## v1 범위

하네스 실습용 v1은 유저스토리 중 두 가지만 다룹니다 (`docs/harness-purpose.md`).

- **Story 3:** 5개 QA Gate 검수 (Structure, Design, Responsive & Mobile, Functional & Accessibility, Deployment)
- **Story 4:** 버전·README·CHANGELOG·운영 URL 동기화, 사용자 최종 승인, 릴리스 결과 기록

### 5단계 파이프라인 (`docs/harness-pipeline.md`)

| # | 단계 | 하는 일 | 정상 종료 상태 |
|---|---|---|---|
| 1 | 접수 | 입력 형식, app_slug, Node 버전 확인 | `IN_PROGRESS` |
| 2 | 정적 검사 | 구조·아이콘·비밀정보·혼입·버전·디자인 규칙 | `IN_PROGRESS` |
| 3 | 브라우저 검사 | 설치된 Chrome으로 모바일·접근성 측정 | `AWAITING_DEPLOYMENT` |
| 4 | 운영 검사 | 사용자가 배포한 HTTPS 운영 URL 검사 | `AWAITING_APPROVAL` |
| 5 | 사람 승인·릴리스 기록 | 모바일 기기 검수 → 홈 아이콘 승인 → 최종 승인 → 릴리스 기록 | `COMPLETE` |

- 하네스는 배포하지 않습니다. 3단계 뒤 사용자가 직접 배포합니다.
- 판정 기준값은 `standards/checks.json` 하나에만 있습니다 (check 32개).

## 역할 (`docs/harness-roles.md`, `.claude/agents/`)

| 역할 | 하는 일 | 경계 |
|---|---|---|
| 오케스트레이터 (메인 세션, `CLAUDE.md`) | 입력 접수, 역할 호출, 승인 원문·판정 기록 | 판정값을 만들거나 바꾸지 않음 |
| `harness-runner` | 2~4단계 판정 스크립트 실행 | 허용 명령 1개, 파일 직접 쓰기 금지 |
| `gate-judge` | 결과를 `checks.json` 기준으로 읽기 전용 재판정 | 파일·네트워크·브라우저 사용 없음 |
| `release-recorder` | 유효한 pre_record 허가가 있을 때만 릴리스 기록 생성 | 실행 상태를 직접 바꾸지 않음 |

역할 경계는 `.claude/settings.json`의 PreToolUse hook과 각 agent 정의의 hook이 함께 강제합니다 (`scripts/hook-guard.mjs`).

## 설치와 실행

요구사항 (`package.json`, `standards/checks.json` `required_tools`):

- Node.js 20 이상 (검증 환경: Node 24.19.0, Windows)
- 설치된 Google Chrome (3단계가 `channel: "chrome"`으로 실행, 다른 브라우저로 자동 전환하지 않음)
- 개발 의존성: `playwright@1.63.0`, `@axe-core/playwright@4.13.0`

```bash
npm ci
npm test
```

- `npm test`는 `node --test --test-concurrency=1 "tests/unit/*.test.mjs"`를 실행합니다.
- 브라우저 테스트 파일 간 임시 프로필 경쟁을 없애기 위해 테스트 파일을 순서대로 실행합니다.

## 자연어 트리거 (Claude Code 세션에서)

| 문장 | 동작 |
|---|---|
| `검수 시작 "fixtures/sample-app" 1.0.0` | 신규 실행 |
| `<run_id> 재개` | 재개 |
| `배포했어 <run_id> <url>` | 배포 기록 |
| `모바일 검수 승인 <run_id>` / `모바일 검수 거절 <run_id> <이유>` | HA-01 |
| `아이콘 승인 <run_id>` / `아이콘 거절 <run_id> <이유>` | HA-02 |
| `최종 릴리스 승인 <run_id>` / `최종 릴리스 거절 <run_id> <이유>` | HA-03 |

실습 대상 앱은 `fixtures/sample-app/`입니다.

## 검증 결과 (`docs/harness-verification.md`)

- 전체 테스트: **152개 통과, 0개 실패, 0개 건너뜀**
- 실패 사례 F1~F10: 기대한 `check_id / failure_code`와 정확히 일치 (`tests/mutations.json`, `tests/expected.json`)

## 리뷰 (`docs/harness-review.md`)

- 1차 리뷰 80/100 → 보완 → **공식 2차 독립 리뷰 85/100** (blocker·high 0)
- 이후 2차 리뷰의 주요 문제(S1·S2·S3·S5·S6·S7·S10)와 추가 보안 2건을 보완했지만, **독립 재채점은 하지 않았습니다.**
- 알려진 한계는 `docs/harness-verification.md` 6절과 `docs/harness-review.md` 부록에 있습니다.

## 검증하지 않은 범위

- 실제 HTTPS 운영 URL에서의 4단계 성공 경로: `NOT_RUN`
- 실제 모바일 기기 검수·홈 아이콘 승인·최종 승인이 들어간 5단계 end-to-end와 실제 `COMPLETE` 전이: `NOT_RUN`
- Node 20, macOS·Linux에서의 실행

## 주요 문서

| 문서 | 내용 |
|---|---|
| `CLAUDE.md` | 오케스트레이터 지침 |
| `docs/PRD.md` | 서비스 PRD |
| `docs/story-service.md` | 유저스토리와 불변 원칙 |
| `docs/story-work.md` | 하네스 도입 전 작업 방식 (As-Is) |
| `docs/harness-purpose.md` | v1 목적·입력·상태값·완료 기준 |
| `docs/harness-pipeline.md` | 단계·실패 복귀·무효화 규칙 |
| `docs/harness-artifacts.md` | 파일 구조·규칙 SSOT·fingerprint |
| `docs/harness-roles.md` | 역할·트리거·경계 강제 |
| `docs/harness-orchestrator.md` | 오케스트레이터 행동 규칙 |
| `docs/harness-verification.md` | 검증 계획과 결과 |
| `docs/harness-review.md` | 리뷰 기록 |
| `standards/checks.json` | 판정 SSOT |

## 공개 제출판 안내

이 저장소는 공개 제출용 사본입니다. 업무 관련 고유명사는 일반 식별자로 치환했습니다.

| 원래 식별자 | 공개판 |
|---|---|
| 업무 프로젝트 이름 | `WORK_PROJECT` |
| 업무 브랜드 A | `WORK_BRAND_A` |
| 업무 브랜드 B | `WORK_BRAND_B` |

문서의 의미("업무 프로젝트·브랜드 자료를 개인 하네스에 가져오거나 혼합하지 않는다")와 탐지 규칙·테스트는 같은 식별자로 맞췄습니다.
