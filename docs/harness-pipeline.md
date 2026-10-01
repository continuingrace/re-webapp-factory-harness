# RE Webapp Factory Harness — 파이프라인 (R3)

- **문서 상태:** R3 확정본
- **기준 문서:** `docs/harness-purpose.md` (입력·상태값·완료 기준)
- **작성일:** 2026-09-29

> 단계별 파일명·폴더·fingerprint 포함·제외 목록은 R4에서 확정한다.
> v1은 대상 앱의 코드·디자인·문서를 **수정하지 않고**, 검사 결과와 릴리스 기록만 쓴다.

---

## 1. 단계

| # | 단계 | 하는 일 | 정상 종료 시 실행 상태 |
|---|---|---|---|
| 1 | 접수 | 필수·조건부 입력, 플래그 값, `target_version` 형식(`x.y.z`), `app_path` 존재 확인. 누적 실행 기록 생성 | `IN_PROGRESS` |
| 2 | 정적 검사 | Gate 1 Structure, Gate 2 Design 중 자동 판정 항목, 버전 위치 일치, 비밀정보, 비공개 프로젝트 식별자 혼입 검사 | `IN_PROGRESS` |
| 3 | 브라우저 검사 | 로컬 URL에서 Gate 3 Responsive & Mobile, Gate 4 Functional & Accessibility | `AWAITING_DEPLOYMENT` |
| 4 | 운영 검사 | `postdeploy` 재개. Gate 5 Deployment, 운영 URL 인정 조건 5개, 운영 자산 요청 | `AWAITING_APPROVAL` |
| 5 | 사람 승인·릴리스 기록 | 실제 모바일 기기 검수 → 홈 아이콘 시각 승인(`pwa_installable: yes`) → 최종 릴리스 승인 → 모든 완료 조건 재판정 → 릴리스 기록 | `COMPLETE` |

- 사용자 수정·결정 또는 외부 조치 없이는 진행할 수 없으면 실행 상태는 `BLOCKED`다.
- 검사 실패는 **검사 항목 상태 `FAIL`**, **실행 전체 상태 `BLOCKED`** 로 구분한다.
- 사용자는 어느 단계에서든 `COMPLETE`가 아닌 실행을 공식적으로 닫을 수 있다: 취소는 `CANCELLED`, 이전 기준 실험·새 실행으로 대체는 `SUPERSEDED`. 닫힌 실행은 어떤 단계도 다시 실행하지 않으며 되돌릴 수 없다. 기존 결과는 그대로 보존하고 새 검수는 새 실행으로 한다 (`docs/harness-orchestrator.md` 8-5).

## 2. 단계 입출력

### 읽기

- 최초 실행 입력
- 누적 실행 기록
- 필요한 이전 단계의 원본 결과
- 앱 fingerprint
- 사용한 기준 문서 버전

### 쓰기

- 단계별 결과 **1개**
- 검사 항목마다 다음 필드를 기록한다.

| 필드 | 설명 |
|---|---|
| `check_id` | 검사 항목 식별자 |
| `status` | `docs/harness-purpose.md` 4-1의 기계용 값 |
| `evidence` | 근거 |
| `checked_at` | 검사 시각 |
| `fingerprint` | 검사 당시 앱 fingerprint |
| `standards_version` | 사용한 기준 문서 버전 |
| `failure_code` | 실패 코드 (`FAIL`일 때) |
| `next_action` | 다음 행동 |

- 누적 실행 기록에는 **단계 결과의 상태와 위치만** 갱신한다.

## 3. 실패 시 복귀

| 상황 | 항목 상태 | 실행 상태 | 복귀 |
|---|---|---|---|
| 1단계 입력 오류 | `FAIL` | `BLOCKED` | 입력 수정 → 1단계 |
| 2·3단계 검사 실패 | `FAIL` | `BLOCKED` | 사용자가 앱 수정 → 2단계 |
| 4단계 URL·자산 문제 — 앱 코드·자산 변경 | `FAIL` | `BLOCKED` | 2단계 |
| 4단계 URL·자산 문제 — 코드 변경 없이 재배포만 | `FAIL` | `BLOCKED` | 4단계 |
| 운영 주소 여부 불명확 | `AWAITING_APPROVAL` | `AWAITING_APPROVAL` | 사용자 확인 → 4단계 재판정 |
| 5단계 승인만 남음 | `AWAITING_APPROVAL` | `AWAITING_APPROVAL` | 승인 추가 → 5단계 재판정 |
| 사람이 수정 필요로 거절 — 앱 코드·디자인·문서 변경 | `FAIL` | `BLOCKED` | 2단계 |
| 사람이 수정 필요로 거절 — 배포만 변경 | `FAIL` | `BLOCKED` | 4단계 |

- "앱 변경"과 "배포만 변경"은 **source fingerprint 비교**로 구분한다. fingerprint가 달라졌으면 앱 변경, 같으면 배포만 변경이다.
- **사람 거절은 되돌릴 수 없다 (R8-e 확정).** 같은 `run_id`·fingerprint·`target_version`·`operating_url` 결합값에서 `REJECT`가 한 번 기록되면 `APPROVE`를 추가해 뒤집을 수 없다. 다시 승인하려면 새 실행을 시작하거나, 앱 수정(fingerprint 변경)·재배포(deployment 변경)로 결합값이 달라져야 한다. 거절 기록은 삭제하지 않고 보존한다.

### 반복 실패로 인한 `BLOCKED` 확정

> 동일한 앱 fingerprint에서 동일한 `check_id`와 동일한 `failure_code`가 **3회 연속** 발생한 경우

- 단계 전체의 서로 다른 실패를 합산하지 않는다.

## 4. 이전 결과 재사용

### fingerprint

| 대상 상태 | fingerprint |
|---|---|
| 모든 경우 (Git 저장소 여부·작업 트리 상태와 무관) | 검수 대상 파일의 content hash |

- R8-e에서 commit SHA 방식을 없앴다. gitignore된 파일도 검사·브라우저 제공 대상이므로 content hash에 포함한다.
- 제외 대상과 계산 방법은 `docs/harness-artifacts.md` 6절과 `standards/checks.json` `policies.fingerprint`를 따른다.

### 무효화 규칙

| 변경 | 다시 실행할 범위 |
|---|---|
| source fingerprint 변경 | 2단계 이후 모두 `NOT_RUN` |
| 목표 버전·적용 플래그·기준 문서 버전 변경 | 영향받는 단계 이후 `NOT_RUN` (4-1 표) |
| source는 같고 운영 URL·배포 정보만 변경 | 4·5단계만 재실행 |
| source와 4단계 근거가 같고 승인만 추가 | 5단계만 재판정 |
| fingerprint를 확인할 수 없음 | 이전 `PASS` 재사용 금지 |

### 4-1. 입력·기준 변경별 최초 무효화 단계

| 변경된 값 | 최초 무효화 단계 | 무효화 범위 | 이유 |
|---|---:|---|---|
| `app_path` | 1 | 전체 | 검수 대상 자체가 변경됨 |
| source fingerprint | 2 | 2~5 | 앱 코드·자산·문서가 변경됨 |
| `target_version` | 2 | 2~5 | 버전 위치와 배포 결과 재검사 |
| `pwa_installable` | 2 | 2~5 | 아이콘·manifest·설치 승인 변경 |
| `sticky_preview` | 3 | 3~5 | sticky 동작 검사 변경 |
| `local_state` | 3 | 3~5 | 저장·복구 검사 변경 |
| `effect_font` | 3 | 3~5 | 브라우저·운영 환경 글꼴 검사 변경 |
| `release_phase` | 4 | 4~5 | 운영 검사 단계 변경 |
| `operating_url` | 4 | 4~5 | URL·운영 자산 근거 변경 |
| 운영 URL 확인 기록 | 4 | 4~5 | 운영 주소 판정 변경 |
| 기준 문서 버전 | 2 | 2~5 | 판정 기준 변경 |
| `change_summary` | 5 | 5 | 릴리스 기록만 변경 |
| 모바일·아이콘·최종 승인 기록 | 5 | 5 | 사람 승인 결과만 변경 |

추가 원칙:

- 단계 1은 재개할 때마다 현재 입력 형식을 다시 검사한다.
- `change_summary`만 바뀌면 2~4단계 결과를 무효화하지 않는다.
- 최초 무효화 단계 이후 결과는 모두 `NOT_RUN`으로 변경한다.
- 여러 값이 함께 바뀌면 가장 이른 단계를 사용한다.
- 변경 영향을 판정할 수 없으면 2단계부터 다시 실행한다.
