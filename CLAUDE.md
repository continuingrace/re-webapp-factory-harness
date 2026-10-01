# RE Webapp Factory Harness — CLAUDE.md

이 저장소는 개인용 RE Webapp Factory 하네스 v1(실습)이다. 판정은 `scripts/`의 스크립트가 하고,
메인 세션(오케스트레이터)은 역할을 호출하고 결과를 기록만 한다. 판정 수치는 이 문서에 두지 않는다 — `standards/checks.json`만 기준이다.

## 기준 문서
- 목적·입력·상태값·완료 기준: `docs/harness-purpose.md`
- 단계·무효화 규칙: `docs/harness-pipeline.md`
- 파일 구조·fingerprint·승인 기록: `docs/harness-artifacts.md`
- 역할·트리거·hook 경계: `docs/harness-roles.md`
- 오케스트레이터 행동·helper: `docs/harness-orchestrator.md`
- 판정 SSOT: `standards/checks.json` / 사람이 읽는 기준: `standards/default-design.md`, `standards/default-gates.md`
- 불변 원칙: `docs/story-service.md` (확인 안 한 것은 통과가 아니다 / 비공개 업무·개인 프로젝트 자료를 가져오거나 섞지 않는다)

## 모드
- **실행 모드:** 아래 트리거 문장으로 시작할 때만. 역할 경계(`docs/harness-roles.md` 1절) 안에서만 쓴다.
- **개발 모드:** 사용자가 하네스 자체의 설계·구현·수정을 명시적으로 요청하고 변경 파일을 승인했을 때만.
- 어느 쪽인지 불명확하면 파일을 수정하지 않고 질문한다 (`MODE_UNCONFIRMED`).
- 실행 중 기준 변경 요청이 오면 실행을 `BLOCKED`로 두고 개발 모드 전환 여부를 묻는다. 개발이 끝나도 자동 재개하지 않는다.

## 트리거 (상태를 바꾸는 명령은 run_id 필수)
| 문장 | 동작 |
|---|---|
| `검수 시작 "<app_path>" <x.y.z>` | 신규 실행 |
| `<run_id> 재개` | 재개 |
| `배포했어 <run_id> <url>` | deployment 기록 |
| `모바일 검수 승인·거절 <run_id> [이유]` | HA-01 |
| `아이콘 승인·거절 <run_id> [이유]` | HA-02 |
| `최종 릴리스 승인·거절 <run_id> [이유]` | HA-03 |
| `실행 취소 <run_id> [이유]` | `CANCELLED` (`close-run.mjs … cancel USER_CANCEL`) |
| `실행 폐기 <run_id> [이유]` | `SUPERSEDED` (`close-run.mjs … supersede STANDARDS_CHANGED` 또는 `REPLACED_BY_RUN --superseded-by <새 run_id>`) |
- run_id가 없거나 존재하지 않으면 기록하지 않고 다시 묻는다.
- 승인·거절·취소·폐기 원문은 사용자 메시지 전체를 아래 규칙대로 임시 파일에 저장해 `--statement-file`로 넘긴다. 요약·보완하지 않는다.
- `<run_id> 보고서` → `node scripts/orchestrator/report-run.mjs <run_dir>`로 `report.md`(파생 요약, 판정 근거 아님)를 만든다. 상태를 바꾸지 않는다.
- 닫힌 실행(`closure.json`)은 재개·배포·승인·판정 기록을 하지 않고 닫힌 상태로 보고한다. `COMPLETE`·이미 닫힌 실행은 닫을 수 없고 되돌릴 수 없다 (`docs/harness-orchestrator.md` 8-5).

## `.harness-inbox/` 생명주기 (승인 원문 임시 파일)
- 현재 run_id에 결합된 `.harness-inbox/<run_id>/` 내부에만 만든다.
- symlink·junction·경로 이탈을 허용하지 않고, Git에 추가하지 않는다 (`.gitignore` 대상).
- 승인·배포·취소·폐기 기록이 성공하면 해당 임시 파일을 즉시 삭제한다.
- 기록이 실패하면 파일을 숨기지 말고 남은 경로를 사용자에게 보고한다.
- 실행 완료와 제출 전에는 `.harness-inbox/`가 비어 있어야 한다.
- 임시 파일의 원문을 stdout·stderr·hook 로그·테스트 결과에 출력하지 않는다.

## 실행 순서
1. 신규: 빠진 입력을 질문 → 모두 유효할 때만 `node scripts/orchestrator/start-run.mjs <input.json>`
2. 기존 실행은 먼저 `run.json`과 참조 파일을 읽고, 대화 기억이 아니라 파일로만 상태를 판단한다.
3. 단계 2·3: **harness-runner** 호출 → **gate-judge** 호출 → `node scripts/orchestrator/record-judgement.mjs <run_dir> --judge-file <gate-judge 출력 파일>`
4. 3단계가 `AWAITING_DEPLOYMENT`면 멈추고 사용자의 배포를 기다린다. 하네스는 배포하지 않는다.
5. `배포했어` → `set-deployment.mjs` → 사용자에게 운영 주소인지 확인 → `record-approval.mjs … OPERATING_URL_CONFIRMATION`
6. **운영 URL 확인을 기록한 뒤에** harness-runner로 단계 4를 실행한다 (확인 전 결과는 stale로 무효). → gate-judge → record-judgement
7. 사람 승인은 HA-01 → HA-02(해당 시) → HA-03 순서로만 기록한다.
8. 모든 승인 뒤 record-judgement를 다시 실행해 pre_record 허가를 기록한다.
9. **release-recorder 호출 직전에 record-judgement를 한 번 더 실행**하고, 허가가 현재 값과 맞을 때만 release-recorder를 호출한다.
10. release-recorder 기록 후 gate-judge → record-judgement(post_record). `COMPLETE`는 이 기록만 만든다.

## 멈춤 조건 (`BLOCKED`로 보고하고 사용자에게 묻는다)
- 판정에 `FAIL`·`NEEDS_ATTENTION`이 있음, runner·judge 불일치, 오래된 근거(stale)
- 입력·파일이 없거나 깨짐, 경로가 실행 폴더·저장소 밖
- hook 또는 명령 안전 검사가 막음 — 다른 형태로 바꿔 우회하지 않는다
- 사용자가 거절함 — 같은 결합값에서 거절은 되돌릴 수 없다. 새 실행 또는 앱 수정·재배포가 필요하다

## 절대 하지 않는 일
- 검사 단계 2~4를 직접 실행하거나 `02~04` 결과를 쓰기, `run-stage.mjs`·`write-release.mjs` 직접 실행
- `PASS`·`FAIL`·`release_record_allowed`·`complete_allowed`를 만들거나 바꾸기
- 사용자 메시지 없이 승인 만들기, 원문을 셸 명령 문자열에 넣기
- `runs/`·`releases/`·`.git/`을 Write·Edit로 직접 쓰기, 저장소 밖 쓰기
- push, force push, 파괴적 Git 명령, 배포, 공개 저장소 조작 (push는 사용자가 `! git push origin main`으로 직접 한다)
- 비공개 업무·개인 프로젝트의 저장소·자산·문서·규칙 가져오기
- `config/*.local.json`을 Read·Write·Edit나 셸 명령으로 직접 열기·출력·수정·복사하기 (값 변경은 사용자가 Claude 밖에서 한다)

## 실행 모드 응답의 마지막 4줄 (run_id 생성 후)
```text
run_id: <값>
실행 상태: <기계용 값> (<한글 표시>)
미해결 항목: <check_id 목록 또는 없음>
다음에 필요한 사용자 문장: <트리거 중 하나 또는 없음>
```

## 개발 모드
- 변경 전 초안을 보여주고 승인받은 파일만 수정한다. 커밋은 로컬만 한다.
- `standards/`·`docs/`의 source document를 고치면 같은 변경에서 `checks.json` 해시와 `standards_version`을 갱신한다.
- 완료 전 `npm test` 전체 통과와 F1~F10 일치를 확인한다.
- 알려진 한계·미검증 범위: `docs/harness-verification.md` 6절, `docs/harness-review.md` 부록
