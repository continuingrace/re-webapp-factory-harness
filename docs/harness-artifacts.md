# RE Webapp Factory Harness — 산출물 (R4)

- **문서 상태:** R4 확정본
- **기준 문서:** `docs/harness-purpose.md`, `docs/harness-pipeline.md`
- **작성일:** 2026-09-29

> 이 문서는 하네스 v1의 파일 이름·위치·규칙 SSOT·재개 방식·fingerprint 계산을 정의한다.
> `standards/checks.json`의 실제 검사 항목은 R5에서 채운다.

---

## 1. 저장소 구조

```text
README.md                  소개·설치·테스트·기본 사용법 (private·public 공통)
docs/                      기준·설계 문서
├─ harness-limitations.md  알려진 한계와 미검증 범위 (public 포함)
└─ harness-operations.md   private 운영 절차 (public export 제외)
standards/
├─ default-design.md       사람이 읽는 생성 앱 기본 디자인
├─ default-gates.md        사람이 읽는 Gate 설명
└─ checks.json             기계 판정 SSOT (R5에서 작성)
fixtures/sample-app/       실습용 샘플 앱
config/
├─ *.schema.json           local 설정 형식 (추적)
├─ *.example.json          예시 값만 있는 설정 (추적)
└─ *.local.json            실제 비공개 설정 (.gitignore, 커밋 안 함, Claude 직접 접근 차단)
scripts/                   판정 스크립트 (구현 라운드에서 작성)
scripts/tools/             개발용 도구 (추적 파일의 비공개 식별자 검사 등)
scripts/release/           public export·scan (지정 commit의 추적 파일만, allowlist manifest, 네트워크·push 없음)
ops/public-map.json        공개 이력 대응표 (private 전용, export 제외. private·public commit 대응 기록)
tests/                     단위 테스트·mutation 정의·기대 결과·fixture 식별자 설정
.claude/settings.json      project hook(PreToolUse → scripts/hook-guard.mjs)과 git push 차단 권한
.claude/agents/            harness-runner·release-recorder·gate-judge 정의와 agent 전용 hook
.harness-inbox/            사용자 원문(--statement-file) 임시 보관 (.gitignore, 커밋 안 함)
.export/                   public export staging (.gitignore, 커밋 안 함)
runs/                      실행 결과 (.gitignore, 커밋 안 함)
releases/                  릴리스 기록 (커밋 대상)
```

## 2. 실행 결과

```text
runs/<app-slug>/<run_id>/
├─ input.json              최초 실행 입력 + app_slug + 앱별 승인 override
├─ run.json                누적 실행 기록
├─ 01-intake.a1.json       단계 결과
├─ 02-static.a1.json
├─ 03-browser.a1.json
├─ 04-production.a1.json
├─ approvals.json          사람 승인 기록
├─ evidence/               스크린샷 등 단계 근거 파일 (harness-runner만 작성)
├─ 05-release.a1.json
├─ closure.json            실행 닫기 기록 (CANCELLED·SUPERSEDED일 때만, 2-2)
└─ report.md               사람이 읽는 파생 요약 보고서 (판정 근거 아님, 2-3)

releases/<app-slug>/v<x.y.z>.md
```

### 이름 규칙

| 대상 | 규칙 |
|---|---|
| `run_id` | `YYYYMMDD-HHMMSS-KST-<6자리 임의값>` |
| `app-slug` | `^[a-z0-9]+(?:-[a-z0-9]+)*$` (결정 방식은 2-1) |
| 단계 결과 | `<단계번호>-<단계명>.a<시도번호>.json`. 덮어쓰지 않고 새 파일 생성 |

### 2-1. `app_slug` 결정

1. `app_path`의 마지막 폴더명이 허용 형식과 일치하면 그대로 `app_slug`로 사용한다.
2. 일치하지 않으면 자동 변환하거나 폴더명을 바꾸지 않는다.
3. 사용자에게 명시적 `app_slug` 입력을 요청하고 실행 상태를 `BLOCKED`로 둔다.
4. 사용자가 유효한 값을 입력하면 1단계부터 재개한다.
5. 동일 `app_slug`의 기존 실행이 다른 canonical `app_path`를 가리키면 `APP_SLUG_COLLISION`으로 `BLOCKED`.

`input.json`에는 다음을 함께 기록한다.

| 필드 | 값 |
|---|---|
| `app_slug` | 결정된 값 |
| 결정 방식 | `DERIVED` \| `USER_PROVIDED` |
| canonical `app_path` | 정규화된 절대 경로 |

### 쓰기 규칙

- `run.json`만 현재 상태와 결과 파일 위치를 갱신한다.
- `run.json.deployment`는 배포 정보의 **append-only 배열**이다. 기존 항목을 수정·삭제하지 않으며, 가장 최근 항목이 현재 입력(`release_phase`, `operating_url`)이 된다 (`docs/harness-orchestrator.md` 8-3).
- `run.json` 갱신은 임시 파일에 쓴 뒤 교체하는 원자적 쓰기로 하며, 실패하면 원본이 보존된다.
- `approvals.json`은 기존 기록을 삭제하지 않는 **append-only 배열**이다.
- `runs/`는 `.gitignore`에 추가하고 커밋하지 않는다.
- `releases/`는 커밋 대상이다.
- 릴리스 기록은 실행 상태가 `AWAITING_APPROVAL`이고 `gate-judge`의 `pre_record` 판정이 `release_record_allowed: true`일 때 생성한다. 생성 후 `post_record` 판정이 `complete_allowed: true`일 때 오케스트레이터가 실행 상태를 `COMPLETE`로 변경한다.
- 동일 앱·동일 버전의 릴리스 기록이 이미 있으면 덮어쓰지 않고 `BLOCKED`.

### 2-2. 실행 닫기 기록 — `closure.json`

- `scripts/orchestrator/close-run.mjs`만 만든다. exclusive create로 한 번만 쓰며 덮어쓰거나 지우지 않는다. 기존 실행 파일은 바꾸지 않는다.
- 필드: `schema_version`, `run_id`, `app_slug`, `status`(`CANCELLED`·`SUPERSEDED`), `kind`(`cancel`·`supersede`), `basis`(`USER_CANCEL`·`STANDARDS_CHANGED`·`REPLACED_BY_RUN`), `superseded_by`(run_id 또는 null), `previous_status`, `run_standards_version`, `current_standards_version`, 사용자 원문 `statement`, `recorded_at`, `files`(불변성 해시).
- 불변성 해시 대상: `input.json`, `run.json`, `approvals.json`, 단계 결과(`0N-<단계명>.a<N>.json`), `evidence/` 아래 파일. 제외: `closure.json` 자체와 파생 보고서 `report.md`. 그 밖의 파일·link가 있으면 닫지 않는다.
- 읽을 때마다 해시를 다시 계산한다. 닫기 기록이 깨졌거나 기존 파일이 바뀌었으면 `CLOSURE_INVALID`·`CLOSURE_INTEGRITY_MISMATCH`로 모든 진행 helper가 거부하고 judge는 `NEEDS_ATTENTION`을 낸다.
- 규칙 SSOT: `standards/checks.json` `policies.run_closure`.

### 2-3. 실행 요약 보고서 — `report.md`

- `scripts/orchestrator/report-run.mjs`가 공식 JSON(`input.json`·`run.json`·`approvals.json`·단계 결과·`closure.json`)을 읽기만 하고 만드는 **파생 문서**다. 판정 근거가 아니며 상단에 그 사실을 표시한다. 다시 만들면 교체한다.
- 원본이 없거나 손상됐거나 닫기 기록 무결성이 맞지 않으면 만들지 않는다. 임시 파일에 쓴 뒤 교체하므로 부분 보고서가 남지 않는다.
- 같은 원본이면 같은 바이트: UTF-8, LF, 생성 시각 없음, 단계 번호·check_id·파일 이름 순 정렬.
- 넣지 않는 것: 앱 절대경로, 사용자 원문, evidence 원문, local 설정 값, URL의 사용자정보·경로·query·fragment(운영 주소는 scheme·host만).
- `closure.json` 불변성 해시 대상이 아니므로 닫힌 실행에서도 다시 만들 수 있다. 규칙 SSOT: `policies.run_report`.

## 3. 규칙 SSOT — `standards/checks.json`

기계 판정의 **단일 SSOT**다. 스크립트는 판정값을 이 파일에서만 읽는다.

### 최상위 필드

| 필드 | 설명 |
|---|---|
| `schema_version` | 파일 구조 버전 |
| `standards_version` | 판정 기준 버전. 변경 시 R3 무효화 규칙 적용 |
| `source_documents` | 근거 문서 목록과 SHA-256 |
| `checks` | 검사 항목 배열 |

형식:

```json
{
  "schema_version": "1.0.0",
  "standards_version": "1.0.0",
  "source_documents": [
    {
      "path": "standards/default-design.md",
      "sha256": "..."
    },
    {
      "path": "standards/default-gates.md",
      "sha256": "..."
    }
  ],
  "checks": []
}
```

### check 필드

| 필드 | 설명 |
|---|---|
| `check_id` | 검사 항목 식별자 |
| `gate` | Gate 1~5 |
| `stage` | 파이프라인 단계 1~5 |
| `description` | 설명 |
| `applies_when` | 적용 조건 (플래그 등) |
| `rule` | 셀 수 있는 판정 규칙 |
| `failure_code` | 실패 코드 |
| `overrideable` | 앱별 변경 가능 여부 |
| `evidence_required` | 필요한 근거 |
| `source_reference` | 근거 문서 위치 |

### 규칙

- `default-design.md`와 `default-gates.md`는 사람이 읽는 설명 문서다.
- 앱별 승인 override는 `input.json`에 값·이유·승인 문장·기준 문서 위치와 함께 기록한다.
- `overrideable: false`인 항목은 앱별로 변경할 수 없다.
- 최상위 불변 원칙 2개는 `overrideable: false`다.
- Markdown 규칙과 `checks.json`은 같은 변경에서 함께 갱신한다. 둘이 다르면 해당 Gate가 `FAIL`이다.

### `source_documents` 규칙

- 각 check의 `source_reference`가 가리키는 모든 문서는 `source_documents`에 반드시 등록한다.
- 등록된 문서의 현재 SHA-256과 기록값이 다르면 `FAIL` (`STANDARDS_DRIFT`).
- `source_reference` 문서가 `source_documents`에 없으면 `FAIL`.
- 문서를 수정하면 같은 커밋에서 `checks.json`의 규칙·해시·`standards_version`을 함께 갱신한다.
- `checks.json` 자신은 `source_documents`에 넣지 않는다.

## 4. 재개

- 자연어 트리거: `<run_id> 재개`
- 재개 조건
  - `run.json`과 참조된 단계 결과가 모두 있어야 한다.
  - JSON 구조와 fingerprint를 검증한다.
- 재개 방법: R3 무효화 표(`docs/harness-pipeline.md` 4-1)로 시작 단계를 계산하고, 새 시도 번호로 실행한다.
- 다음 경우 `BLOCKED`
  - 파일이 없음
  - 파일이 깨짐
  - 결과 위치가 실행 폴더 밖을 가리킴

## 5. 사람 승인 기록 — `approvals.json`

| 필드 | 설명 |
|---|---|
| `approval_type` | 승인 항목 (`MOBILE_DEVICE_REVIEW`, `HOME_ICON_REVIEW`, `FINAL_RELEASE`, `OPERATING_URL_CONFIRMATION`) |
| `decision` | `APPROVE` \| `REJECT` |
| `statement` | 사용자가 실제로 쓴 문장 원문 |
| `approved_at` | 승인 시각 |
| `fingerprint` | 승인 당시 fingerprint |
| `target_version` | 승인 당시 목표 버전 |
| `operating_url` | 승인 당시 운영 URL |
| `run_id` | 실행 ID |

### 인정 조건

- `statement`가 비어 있으면 인정하지 않는다.
- 현재 fingerprint, 목표 버전, 운영 URL, `run_id`가 **모두** 일치해야 한다.
- 하나라도 변경되면 이전 승인은 재사용하지 않는다.
- 거절 기록도 삭제하지 않고 보존한다.

## 6. fingerprint

### 계산

fingerprint는 **항상** 아래 방식의 content hash다. Git commit SHA를 쓰지 않으며, `.gitignore`는 고려하지 않는다. 제외는 아래 제외 목록(`standards/checks.json` `policies.fingerprint`)만 따른다.

**하나의 범위 정책:** fingerprint, 정적 검사(stage 2), 로컬 서버가 브라우저에 제공하는 파일(stage 3)의 범위는 같다. 로컬 서버는 제외 목록에 해당하는 경로 요청을 `403`으로 거부하고, 거부한 요청 경로를 evidence(`network.excluded_path_requests`)에 남긴다. 제외 판정은 `app_path` 기준 상대 경로에만 적용하므로, `app_path` 자체가 `dist`·`build` 폴더여도 그 안의 파일은 모두 검사·제공된다. 대소문자를 구분하지 않는 파일시스템(`policies.fingerprint.case_insensitive_platforms`, 현재 `win32`)에서는 fingerprint와 로컬 서버 모두 이름과 제외 목록을 대소문자 무시로 비교한다 (예: `DIST/`, `debug.LOG`도 제외).

1. `app_path` 내부 파일만 대상으로 한다.
2. 제외 폴더 밖에서 symlink 또는 junction을 발견하면 따라가지 않고 `FINGERPRINT_LINK_UNSUPPORTED`로 `BLOCKED`. 제외 폴더 내부의 link는 fingerprint 대상에서 제외한다.
3. 상대 경로는 `/`로 정규화한다.
4. 파일을 상대 경로 순으로 정렬한다.
5. 파일마다 `SHA-256( u32(경로 UTF-8 바이트 길이) ‖ 경로 ‖ u64(내용 바이트 길이) ‖ 원본 바이트 )`를 구한다 (길이 접두사로 경로·내용 경계를 구분).
6. 최종값은 `SHA-256( 형식 표시 ‖ u32(파일 수) ‖ 파일별 32바이트 해시를 경로 순서로 )`다. 형식 표시는 `policies.fingerprint.encoding`이다.

### 제외 목록

```text
.git/
node_modules/
dist/
build/
coverage/
.cache/
.next/
.turbo/
playwright-report/
test-results/
tmp/
.tmp/
runs/
*.log
.DS_Store
Thumbs.db
```

- 제외 경로의 파일은 검사하지 않고 브라우저에도 제공하지 않는다 (위 범위 정책).
- fingerprint 계산 오류나 `app_path` 밖으로 나가는 경로가 발견되면 `BLOCKED`.

## 7. 샘플 앱 — `fixtures/sample-app/`

```text
fixtures/sample-app/
├─ index.html
├─ src/
│  ├─ style.css
│  └─ app.js
├─ icons/
│  ├─ favicon.svg
│  ├─ apple-touch-icon.png
│  ├─ icon-192.png
│  ├─ icon-512.png
│  └─ icon-maskable-512.png
├─ manifest.webmanifest
├─ sw.js
├─ package.json
├─ README.md
└─ CHANGELOG.md
```

| 플래그 | 기본값 |
|---|---|
| `sticky_preview` | `yes` |
| `effect_font` | `no` |
| `local_state` | `yes` |
| `pwa_installable` | `yes` |

- 샘플 앱은 기본 상태에서 모든 검사를 통과할 수 있어야 한다.
- 실패 fixture는 R8에서 원본을 훼손하지 않는 별도 복사본으로 만든다.
