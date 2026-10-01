# RE Webapp Factory Harness

정적 웹앱의 배포 전·후 검수를 Claude Code의 역할(subagent)과 판정 스크립트로 나눠 수행하는 개인 실습용 하네스다.
판정은 [`scripts/`](scripts/)의 스크립트가 [`standards/checks.json`](standards/checks.json) 기준으로 하고, 사람 승인과 배포는 사용자가 한다.
원칙은 하나다: 확인하지 않은 것은 통과가 아니다.

## 구성

- 단계: 1 입력 확인 → 2 정적 검사 → 3 브라우저 검사 → (사용자 배포) → 4 운영 URL 검사 → 사람 승인 → 5 릴리스 기록
- 역할: `harness-runner`(2~4단계 실행), `gate-judge`(읽기 전용 재판정), `release-recorder`(릴리스 기록). 정의는 [`.claude/agents/`](.claude/agents/)에 있다.
- 기준 문서
  - 목적·상태값·완료 기준: [docs/harness-purpose.md](docs/harness-purpose.md)
  - 단계·무효화 규칙: [docs/harness-pipeline.md](docs/harness-pipeline.md)
  - 파일 구조·fingerprint·승인 기록: [docs/harness-artifacts.md](docs/harness-artifacts.md)
  - 역할·hook 경계: [docs/harness-roles.md](docs/harness-roles.md)
  - 오케스트레이터 행동: [docs/harness-orchestrator.md](docs/harness-orchestrator.md)
  - 목적과 실제 작업 근거: [docs/PRD.md](docs/PRD.md), [docs/story-service.md](docs/story-service.md), [docs/story-work.md](docs/story-work.md)
  - 사람이 읽는 판정 기준: [standards/default-design.md](standards/default-design.md), [standards/default-gates.md](standards/default-gates.md)

## 요구 사항

- 지원 기준: Node.js 20 이상
- 현재 실제 검증 환경: Node.js 24
- Node.js 20 직접 실행: `NOT_RUN`
- 브라우저 검사: 설치된 Chrome (Playwright `chrome` 채널)

## 설치와 테스트

```text
npm ci
npm test
```

`npm test`는 단위 테스트와 실패 주입 검증(F1~F10)을 순서대로 실행한다. 테스트는 임시 폴더와 fixture 설정만 쓴다.

## 기본 사용법 (Claude Code)

1. 비공개 식별자 설정을 만든다.
   - [`config/identifiers.example.json`](config/identifiers.example.json)과 [`config/identifiers.schema.json`](config/identifiers.schema.json) 형식에 맞춰 `config/identifiers.local.json`을 사용자가 직접 만든다.
   - local 설정은 `.gitignore` 대상이며 Git에 커밋하지 않는다.
   - 판정 스크립트는 판정을 위해 이 설정을 읽는다. 실제 값은 결과·evidence·보고에 기록하지 않는다.
2. Claude Code에서 트리거 문장으로 실행한다. 전체 규칙은 [CLAUDE.md](CLAUDE.md)에 있다.

| 문장 | 동작 |
|---|---|
| `검수 시작 "<app_path>" <x.y.z>` | 신규 실행 |
| `<run_id> 재개` | 재개 |
| `배포했어 <run_id> <url>` | 배포 주소 기록 |
| `모바일 검수 승인·거절 <run_id> [이유]` | 모바일 검수 승인 |
| `아이콘 승인·거절 <run_id> [이유]` | 아이콘 승인 |
| `최종 릴리스 승인·거절 <run_id> [이유]` | 최종 승인 |

하네스는 배포하거나 push하지 않는다.

## 공개판 안내

공개 저장소는 비공개 원본의 지정 commit에서 allowlist 기준으로 내보낸 사본이다.
원본 문서는 비공개 식별자를 일반화한 표현으로 작성하며, 내보낼 때 비공개 식별자·개인 경로·비밀값·원본 commit 정보가 발견되면 내보내지 않고 중단한다.
공개 버전 목록은 공개판에만 생성되는 `PUBLIC_RELEASES.md`에 있다.

## 한계

알려진 한계와 미검증 범위는 [docs/harness-limitations.md](docs/harness-limitations.md)에 모았다.
요약하면 hook은 완전한 OS sandbox가 아니며, 실제 HTTPS 운영 URL·실제 모바일 기기·실제 `COMPLETE` 전이는 검증하지 않았다(`NOT_RUN`).

## 라이선스

미정. 공개 반영 단계에서 정한다.
