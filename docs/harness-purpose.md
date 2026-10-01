# RE Webapp Factory Harness — 목적 (R2)

- **문서 상태:** R2 확정본
- **기준 문서:** `docs/story-service.md` (판정 기준), `docs/story-work.md` (As-Is 경험 기록)
- **작성일:** 2026-09-29

> 이 문서는 하네스 실습 v1의 목적·입력·상태값·완료 기준을 정의한다.
> 서비스 전체 목적은 `docs/story-service.md`, 실제 작업 경험은 `docs/story-work.md`를 따르며, 이 문서는 두 문서를 수정하거나 합치지 않는다.

---

## 1. v1 범위

> 아래 범위는 **하네스 실습용 v1 결정**이며, PRD의 우선순위가 아니다.

| 구분 | 유저스토리 |
|---|---|
| **v1 포함** | Story 3 — 5개 QA Gate 검수 |
| **v1 포함** | Story 4 — 버전·README·CHANGELOG·운영 URL 동기화, 사용자 최종 승인, 릴리스 결과 기록 |
| 후속 범위 | Story 1 — 기존 기준 문서 등록·분류 |
| 후속 범위 | Story 2 — 신규 앱 설정 |
| 후속 범위 | Story 5 — 전체 앱 대시보드 |

- **시작점:** 구현 또는 수정이 끝난 웹앱이 검수를 기다리는 상태
- **종료점:** QA 근거가 기록되고, 버전·문서·운영 URL이 일치하며, 사용자 최종 승인을 받은 릴리스 기록이 남은 상태

## 2. 사용자

**1인 메이커 한 명.** 다중 사용자, 역할, 권한 구분은 v1 범위에서 제외한다.

| 사용자가 하는 일 | 조건 |
|---|---|
| 자연어로 하네스 실행 | 항상 |
| 실제 모바일 기기 검수 | 항상 |
| 홈 아이콘 시각 승인 | `pwa_installable: yes`일 때 |
| 배포 실행 | 항상 (하네스는 배포하지 않음) |
| 운영 URL 확인 | `postdeploy`일 때 |
| 최종 릴리스 승인 | 항상 |

## 3. 매번 달라지는 입력

### 필수 입력

| 필드 | 형식 | 설명 |
|---|---|---|
| `app_path` | 폴더 경로 | 검수할 앱 폴더 |
| `target_version` | `x.y.z` | 목표 버전 |
| `change_summary` | 1~3줄 | 변경 요약 |
| `release_phase` | `predeploy` \| `postdeploy` | 실행 단계 |

### 조건부 입력

| 필드 | 조건 |
|---|---|
| `operating_url` | `predeploy`: 없어도 됨 / `postdeploy`: **필수**. 인정 조건은 6절 |

### 해당 여부 플래그

| 플래그 | 값 | 관련 As-Is |
|---|---|---|
| `sticky_preview` | `yes` \| `no` | G4 상단 고정 |
| `effect_font` | `yes` \| `no` | G4 효과 글꼴 |
| `local_state` | `yes` \| `no` | 저장·복구 검사 |
| `pwa_installable` | `yes` \| `no` | G5 홈 화면 아이콘 |

- 플래그가 `no`이면 해당 검사를 자동 통과시키지 않고, 적용 대상이 아니라는 근거와 함께 `NOT_APPLICABLE`(N/A)로 기록한다.

### 고정 기준

- Gate 정의: `standards/default-gates.md`
- 디자인 값: 앱별 `design.md`가 있으면 승인된 override로 적용하고, 없으면 `standards/default-design.md`를 사용한다.
- 판정 기준 2개: 7절
- 비공개 식별자: 하네스 루트의 `config/identifiers.local.json`(Git 추적 안 함, 형식은 `config/identifiers.schema.json`). 경로는 `checks.json` `policies.private_identifiers`로 고정하며 대상 앱이나 명령 인자로 바꿀 수 없다.
  - 파일이 없거나 잘못되면 IN-01은 `NEEDS_ATTENTION`, 실행은 `BLOCKED`, ST-04는 `NOT_RUN`이다. ST-04를 `PASS`로 추정하지 않는다.
  - 식별자 id는 의미 없는 이름(`ID-PRIVATE-n`)을 쓴다. 결과·evidence에는 id·가린 경로·건수만 남는다.
  - 값 변경은 사용자가 Claude 밖에서 직접 한다.

## 4. 상태값

스크립트는 **기계용 값**만 기록하고, 화면과 보고서에는 **표시값**을 함께 보여준다.

### 4-1. 검사 항목 상태

| 기계용 값 | 표시값 | 완료 가능 |
|---|---|---|
| `NOT_RUN` | 미실행 | 불가 |
| `IN_PROGRESS` | 진행 중 | 불가 |
| `PASS` | 통과 | 가능 (근거 필수) |
| `NOT_APPLICABLE` | 적용 대상 아님 (N/A) | 가능 (근거 필수) |
| `NEEDS_ATTENTION` | 확인 필요 | 불가 |
| `FAIL` | 실패 | 불가 |
| `AWAITING_APPROVAL` | 사용자 승인 대기 | 불가 |

### 4-2. 실행 전체 상태

| 기계용 값 | 의미 |
|---|---|
| `IN_PROGRESS` | 검사 진행 중 |
| `AWAITING_APPROVAL` | 사람 검수 또는 승인 대기 |
| `AWAITING_DEPLOYMENT` | 사용자 배포 대기 |
| `COMPLETE` | 모든 완료 조건 충족 |
| `BLOCKED` | 사용자 결정이나 외부 조건 없이는 진행 불가 |
| `CANCELLED` | 취소됨 — 사용자가 진행 중인 실행을 공식적으로 중단함 (종료 상태) |
| `SUPERSEDED` | 폐기(대체됨) — 이전 기준의 실험이거나 새 실행으로 대체됨 (종료 상태) |

`CANCELLED`·`SUPERSEDED`는 사용자 문장으로만 기록하며 되돌릴 수 없다. `COMPLETE` 실행은 닫을 수 없다. 기존 실행 파일은 바꾸지 않고 닫기 기록(`closure.json`)만 추가한다 (`docs/harness-artifacts.md` 2-2, `docs/harness-orchestrator.md` 8-5).

### 4-3. 후속 수정 후보 (R5)

- `standards/default-gates.md`의 결과 형식 한글 상태값(`미실행 | 진행 중 | 통과 | 확인 필요 | 실패 | 사용자 결정 필요`)을 4-1의 기계용 값에 맞게 수정한다.

## 5. 완료 기준

> 모든 필수 검사 결과가 `PASS` 또는 근거가 기록된 `NOT_APPLICABLE`이고, `NOT_RUN`·`IN_PROGRESS`·`NEEDS_ATTENTION`·`FAIL`·`AWAITING_APPROVAL`이 각각 0개이며, 목표 버전이 프로젝트에 존재하는 모든 적용 대상 버전 위치와 일치하고, `postdeploy` 단계에서 운영 URL이 6절의 인정 조건을 모두 충족하며, 필요한 사람 검수 항목마다 승인 기록이 존재하는 릴리스 기록 파일이 생성되어 실행 전체 상태가 `COMPLETE`가 되면 완료다.

### 5-1. 버전 위치

실제 프로젝트에 **존재하는 위치만** 적용 대상으로 삼는다.

- `package.json`
- 화면의 버전 표시
- `README`
- `CHANGELOG` 최신 항목
- 프로젝트가 별도로 선언한 버전 파일

존재하지 않는 위치는 근거와 함께 `NOT_APPLICABLE`로 기록한다. 존재하는 위치의 값이 목표 버전과 다르면 `FAIL`이다.

### 5-2. 사람 승인 기록

| 승인 항목 | 필요 건수 | 기준 시점 |
|---|---|---|
| 실제 모바일 기기 검수 | 항상 1건 | `postdeploy` 운영 URL 기준 |
| 홈 아이콘 시각 승인 | `pwa_installable: yes`일 때 1건 | `postdeploy` 운영 URL을 홈 화면에 추가한 결과 기준 |
| 최종 릴리스 승인 | 항상 1건 | 위 검사와 필요한 승인이 모두 끝난 뒤 |

## 6. 운영 URL 인정 조건

`postdeploy`의 운영 URL은 다음 조건을 **모두** 만족해야 한다. 이 절은 URL 자체의 유효성만 다루며, 사람 검수와 최종 승인은 5절의 별도 완료 조건이다.

1. `release_phase`가 `postdeploy`
2. 사용자가 이 URL을 실제 운영 주소라고 확인한 기록이 있음
3. 프로토콜이 `https:`
4. localhost 또는 비공개 네트워크 주소가 아님
5. redirect를 따라간 최종 응답이 HTTP 200

### 운영 URL로 인정하지 않는 대상

- `localhost`
- `127.0.0.0/8`
- `0.0.0.0`
- `::1`
- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `169.254.0.0/16`
- `.local` 호스트
- 사용자가 미리보기라고 표시한 주소
- `http:` 주소

### 판정 원칙

- 특정 호스팅 도메인이라는 이유만으로 미리보기라고 단정하지 않는다. `github.io`, `vercel.app`, `netlify.app`, `pages.dev` 등도 사용자가 실제 운영 주소로 승인하면 사용할 수 있다.
- 운영 주소인지 불명확하면 `FAIL`로 추정하지 않고 `AWAITING_APPROVAL`로 멈춘다.

## 7. 판정 기준 (`docs/story-service.md`의 최상위 불변 원칙)

1. 실제 확인하지 않은 기능·링크·배포·QA 상태를 통과나 완료로 기록하지 않는다.
2. 업무·개인 프로젝트의 저장소·자산·문서·규칙을 자동으로 가져오거나 혼합하지 않는다.

두 원칙은 R5의 기계 판정과 사람 승인 조건에 반드시 연결한다.

## 8. 진행 방식

```text
1. predeploy 실행
2. Gate 1~4 + 배포 전 검사
3. 결과 저장 → AWAITING_DEPLOYMENT
4. 사용자가 직접 배포
5. operating_url 입력 → 같은 실행을 postdeploy로 재개
6. Gate 5 + 운영 URL 기술 검사
7. 실제 모바일 기기 검수
8. 홈 아이콘 시각 승인(pwa_installable: yes인 경우)
9. 최종 릴리스 승인
10. 모든 완료 조건 재판정 → COMPLETE
```

- 하네스는 배포를 **직접 실행하지 않는다.**
- 로컬 URL은 Gate 1~4 실습에 사용할 수 있지만, 최종 릴리스 완료 근거로 사용하지 않는다.
- 실제 운영 URL이 없으면 `AWAITING_DEPLOYMENT`에 머무는 것이 정상이며, 완료로 기록하지 않는다.

## 9. 실습 대상

- `fixtures/sample-app/` (테스트 대상 샘플 앱, R4에서 파일 구성 확정 후 생성)
- 기존 공개 저장소 `continuingrace/webapp-factory`는 사용하지 않는다.
