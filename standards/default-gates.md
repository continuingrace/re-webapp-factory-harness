# RE Webapp Factory — default-gates.md

- **역할:** 신규·기존 웹앱의 기본 QA Gate 통과 조건
- **원칙:** 미실행·근거 없음·추정 상태는 통과가 아니다.

## Gate 1 — Structure

### Pass

- 필수 문서와 실제 프로젝트 상태가 일치한다.
- design token이 한곳에서 관리되고 UI가 이를 참조한다.
- 저장소, 운영 URL, 현재 버전이 기록되어 있다.
- favicon, apple-touch-icon, PWA icon과 manifest 존재 여부를 확인했다.
- 비밀키·토큰·개인정보가 추적 파일에 없다.

### Fail

- 필수 파일이 없거나 문서와 구현이 다르다.
- 색상·간격·radius 값이 이유 없이 여러 곳에 중복·하드코딩돼 있다.
- 아이콘 또는 manifest가 없는데 완료로 표시했다.
- 다른 프로젝트의 자산·규칙이 승인 없이 포함됐다.

## Gate 2 — Design

### Pass

- 사용자가 값을 주지 않은 항목은 `default-design.md`를 사용했고 적용 사실을 기록했다.
- Pretendard와 fallback이 정상 작동한다.
- 제목·본문의 크기, 굵기, 행간, 자간이 정의된 계층과 일치한다.
- 간격은 4/8px 체계를 사용하며 콘텐츠가 비좁거나 겹치지 않는다.
- 역할별 radius를 사용한다: 입력 12px, 일반 버튼 12px, 카드 16px, chip·tag·badge·toggle만 pill (`default-design.md` 역할별 radius).
- px 글자 크기는 Typography 토큰의 크기만 사용한다 (DS-07).
- 그림자 대신 tint와 hairline으로 계층을 표현한다.
- 상태는 색상·아이콘·텍스트를 함께 사용한다.

### Fail

- 본문이나 제목이 겹치거나 잘린다.
- 폰트 위계, 행간, 자간, 마진, 패딩 문제로 읽기 어렵다.
- 토큰에 없는 임의 색상·간격·radius가 설명 없이 추가됐다.
- drop shadow, 과도한 accent, 장식색이 관리 UI의 계층을 대신한다.
- 미확인 상태가 성공색 또는 `통과`로 표시된다.

## Gate 3 — Responsive & Mobile

### Required Views

- 360px width
- 390×844
- 768px width **[보완값]**
- 1024px 이상 **[보완값]**

### Pass

- 360px에서 의도하지 않은 가로 스크롤이 없다.
- 390×844에서 핵심 흐름을 완료할 수 있다.
- 터치 대상이 최소 44×44px이다.
- sticky로 정의된 미리보기·도구가 실제 스크롤에서 고정된다.
- sticky 요소가 헤더, 입력, 버튼, 콘텐츠를 가리지 않는다.
- 표와 다열 레이아웃이 모바일 카드·상세 보기로 전환된다.
- 실제 폰트가 로드되지 않아도 기능과 레이아웃이 무너지지 않는다.
- design contract를 선언한 앱은 390×844에서 필드 그룹 간격(MB-08), 글자 역할 토큰(MB-09), 역할별 radius(MB-10)가 기준과 일치한다. 계약을 전혀 선언하지 않은 앱만 근거와 함께 N/A이며, 일부만 또는 잘못 선언한 계약은 FAIL이다.
- 컨테이너별 세로 간격 종류 수는 비차단 진단으로 기록하며, 여백의 편안함·묶음·균형은 사람 검수(HA-01)가 판단한다.

### Fail

- 모바일에서 텍스트·버튼이 잘리거나 겹친다.
- 마진·패딩이 지나치게 좁아 오작동하거나 읽기 어렵다.
- 미리보기 상단 고정이 요구됐지만 작동하지 않는다.
- 효과 글꼴 또는 필수 자산이 누락된다.
- 데스크톱 축소만으로 모바일 화면을 구성했다.

## Gate 4 — Functional & Accessibility

### Pass

- 핵심 버튼, 저장, 미리보기, export 등 정의된 기능이 실제 동작한다.
- 모든 핵심 기능을 키보드로 사용할 수 있다.
- focus가 명확히 보이고 논리적 순서로 이동한다.
- 입력에는 label, 오류 원인, 해결 방법이 있다.
- 텍스트 대비가 WCAG AA를 충족한다. **[보완값]**
- 모달 focus, Escape, focus 복귀가 동작한다.
- 로딩·빈 화면·오류·차단 상태가 정의되어 있다.
- reduced motion 설정을 존중한다.

### Fail

- 보이는 버튼이 동작하지 않거나 결과 피드백이 없다.
- 색상만으로 상태를 구분한다.
- 키보드 focus가 보이지 않거나 화면 밖으로 빠진다.
- 오류 후 사용자 입력이나 작업 상태가 이유 없이 사라진다.
- 체크박스 클릭만으로 검증 근거 없이 통과 처리된다.

## Gate 5 — Deployment

### Pass

- 운영 URL에서 핵심 기능과 링크를 다시 검사했다.
- 배포 버전과 문서·CHANGELOG의 버전이 일치한다.
- GitHub Pages 또는 선택한 배포 설정을 기록했다.
- 실제 모바일 기기에서 홈 화면 추가와 아이콘 표시를 확인했다.
- favicon, apple-touch-icon, manifest, 192/512/maskable icon 요청이 성공한다.
- 사용자 승인 후 배포 결과를 기록했다.

### Fail

- 로컬·미리보기만 확인하고 운영 환경을 통과 처리했다.
- 배포 URL, 버전, 커밋 또는 문서가 서로 다르다.
- 모바일 홈 화면 아이콘이 없거나 잘못 잘린다.
- 폰트·이미지·아이콘·manifest가 운영 환경에서 404 또는 로딩 실패다.
- 되돌리기 어려운 작업을 사용자 승인 없이 실행했다.

## Gate Result Format

모든 Gate 결과는 아래 형식으로 기록한다.

```text
Gate:
상태: NOT_RUN | IN_PROGRESS | PASS | NOT_APPLICABLE | NEEDS_ATTENTION | FAIL | AWAITING_APPROVAL
검사 환경:
검사 항목:
근거:
발견 문제:
다음 행동:
검사 일시:
검사자 또는 도구:
```

상태값은 기계용 값으로 기록하고, 화면과 보고서에는 한글 표시를 함께 보여준다.

| 기계용 값 | 표시값 |
|---|---|
| `NOT_RUN` | 미실행 |
| `IN_PROGRESS` | 진행 중 |
| `PASS` | 통과 |
| `NOT_APPLICABLE` | 적용 대상 아님 (N/A) |
| `NEEDS_ATTENTION` | 확인 필요 |
| `FAIL` | 실패 |
| `AWAITING_APPROVAL` | 사용자 승인 대기 |

## Added Values

다음은 사용자가 제공한 디자인 자료에 없거나 Webapp Factory 운영에 맞게 구체화한 **[보완값]**이다.

- semantic success/warning/danger 색상
- tablet·desktop breakpoint와 최대 콘텐츠 너비
- desktop sidebar 240px
- sticky preview top 24px
- WCAG AA 명시
- favicon·PWA·maskable icon 규격
- 실제 운영 URL과 실제 모바일 홈 화면 확인
- Gate 결과 기록 형식
