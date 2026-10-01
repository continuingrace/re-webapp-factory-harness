# RE Webapp Factory — default-design.md

- **역할:** 개별 웹앱에 디자인 값이 없을 때 사용하는 기본값
- **적용 조건:** 사용자가 별도 값을 지정하지 않았고 앱별 `design.md`가 없을 때
- **우선순위:** 앱별 승인 규칙보다 항상 낮음

> 이 파일을 적용하면 완료 보고에 “Factory 기본 디자인 적용”이라고 명시한다. 사용자가 제공하지 않은 보완값은 `[보완값]`으로 표시했다.

## 1. Default Tokens

### Colors

```text
ink             #141414
ink-soft        #262626
canvas          #FFFFFF
canvas-soft     #F3F3F3
field           #F0F0F0
hairline-soft   #F0F0F0
hairline        #E0E0E0
text-muted      #707070
text-faint      #ADADAD
accent/info     #0066FF
success         #16803A  [보완값]
warning         #9A5B00  [보완값]
danger          #C62828  [보완값]
```

### Typography

```text
family         Pretendard Variable, Pretendard, system sans-serif
display        32 / 700 / 1.30
title          28 / 700 / 1.30   화면 제목
section        24 / 700 / 1.35   섹션 제목
subsection     20 / 700 / 1.35   카드·하위 섹션 제목
subsection-sm  18 / 700 / 1.35   작은 하위 제목
emphasis       17 / 600 / 1.40   강조 행, 기능 제목
body-lg        17 / 300 / 1.50
body           15 / 400 / 1.50   기본 본문
body-sm        13 / 400 / 1.50   보조 설명·상태 문구
label          12 / 600 / 1.40   필드 라벨·배지·상태 레이블
caption        12 / 400 / 1.40   메타 정보
letter-spacing 0
```

토큰 이름은 HTML 태그 이름(h1~h4)과 겹치지 않는 의미 역할명이다. 태그와 토큰은 독립적이다 (예: `<h2 data-type="subsection">`).

### Spacing & Shape

```text
spacing    4, 8, 12, 16, 24, 32, 48, 64
radius     0, 12, 16, 9999
app icon   30% squircle
border     1px
shadow     none
```

역할별 radius (2026-10-01 실기기 모바일 검수 거절과 390×844 화면 비교에 따른 조정, **[Factory 조정]**):

| 토큰 | 값 | 대상 |
|---|---|---|
| `radius.none` | 0 | 화면 끝까지 닿는 영역 |
| `radius.field` | 12px | input, textarea, select |
| `radius.control` | 12px | 일반 버튼, `[role=button]` |
| `radius.card` | 16px | 카드, 패널, 미리보기 |
| `radius.pill` | 9999px | chip, tag, badge, toggle처럼 의도적으로 pill 형태인 요소만 |
| `radius.app-icon` | 30% | 앱 아이콘 |

### Design Contract

앱이 HTML에 역할을 선언하면 하네스가 그 요소만 기계적으로 검사한다 (MB-08~10). `data-ui`·`data-type`을 하나도 선언하지 않은 앱만 근거와 함께 `NOT_APPLICABLE`이다.

| 속성 | 값 | 검사 |
|---|---|---|
| `data-ui="field-group"` | 라벨·입력·보조 문구 묶음 | MB-08: 라벨→`data-ui="field"` 간격 ≤ 8px, field→다음 요소 간격 ≥ 12px (390×844) |
| `data-ui="field"`·`"button"`·`"card"`·`"pill"` | 구성요소 역할 | MB-10: 계산된 radius가 역할 토큰과 일치. pill 형태 버튼은 `data-ui="pill"`이어야 함 (정사각형 원형 아이콘 버튼 제외) |
| `data-type="<token>"` | Typography 토큰 이름 (display~caption) | MB-09: 계산된 글자 크기·굵기가 토큰과 일치 |

계약을 일부만 선언하거나 잘못 선언하면 N/A로 빠지지 않는다:

| 상황 | 결과 |
|---|---|
| `data-ui`는 있고 `data-type`이 하나도 없음 | MB-09 `FAIL` (`CONTRACT_INCOMPLETE`) |
| `data-type`은 있고 `data-ui`가 하나도 없음 | MB-10 `FAIL` (`CONTRACT_INCOMPLETE`) |
| `data-ui="field"`가 `field-group` 밖에 있음 | MB-08 `FAIL` (`FIELD_OUTSIDE_GROUP`) |
| `field-group` 안에 `field`가 없음 | MB-08 `FAIL` (`FIELD_GROUP_WITHOUT_FIELD`) |
| 정해지지 않은 `data-ui` 값 | MB-10 `FAIL` (`CONTRACT_INVALID`) |
| 정해지지 않은 `data-type` 값 | MB-09 `FAIL` (`TYPE_TOKEN_UNKNOWN`) |
| 선언한 요소가 화면에 하나도 보이지 않음 | `NEEDS_ATTENTION` (`CHECK_INCONCLUSIVE`, 측정 대상 0개) |

- 근거: 2026-10-01 실기기 검수에서 입력창과 보조 문구 사이 8px이 답답하고, 글자 위계·묶음이 불명확하다는 거절 사유 **[Factory 조정]**.
- 글자 크기(px)는 Typography 토큰의 크기만 쓴다 (DS-07). px가 아닌 단위·`var()`·`calc()`는 다른 DS 검사와 같이 판정할 수 없는 값으로 `NEEDS_ATTENTION`이다.
- 기계 검사는 명백한 수치 문제만 막는다. 여백의 편안함, 의미상 묶음, 전체 균형, 위계가 충분히 읽히는지는 사람 검수(HA-01)가 판단한다.
- 컨테이너별 세로 간격 종류 수는 비차단 진단으로만 기록한다 (판정·완료에 영향 없음).

## 2. Default Layout

- Mobile baseline: 390×844
- Minimum width: 360px
- Mobile side padding: 16px
- Minimum touch target: 44×44px
- Mobile: single column
- Tablet: 768–1023px, up to two columns **[보완값]**
- Desktop: 1024px+, sidebar + content **[보완값]**
- Content maximum: 1440px **[보완값]**
- Desktop sidebar: 240px **[보완값]**
- Section gap: 48px; major section gap: 64px

## 3. Default Components

- Primary button: ink fill, white label, 12px radius (`radius.control`)
- Secondary button: white fill, 1px hairline, 12px radius (`radius.control`)
- Tertiary button: soft canvas fill, 12px radius (`radius.control`)
- Input: field fill, no resting border, 12px radius (`radius.field`), 12px 16px padding
- Card: white fill, 1px hairline-soft, 16px radius (`radius.card`), 24px padding
- Chip·tag·badge·toggle: 9999px pill (`radius.pill`, `data-ui="pill"`). 그 밖의 요소는 pill을 쓰지 않는다.
- QA row: soft canvas or white, 16px radius, status icon + label + evidence
- Focus: visible 2px ink/accent ring
- Sticky preview: desktop top 24px when the screen contains a preview **[보완값]**

## 4. Default States

```text
미확인             neutral + status icon
진행 중            info + progress icon
통과               success + check icon
확인 필요          warning + warning icon
실패               danger + error icon
사용자 결정 필요   ink + stop icon
```

상태는 색상만으로 표현하지 않는다. 검사 근거가 없으면 `통과`를 사용할 수 없다.

## 5. Default App Icon Set

아래 값은 As-Is의 아이콘 누락 방지를 위해 추가한 기본값이다. **[보완값]**

- favicon
- apple-touch-icon 180×180
- PWA icon 192×192
- PWA icon 512×512
- maskable icon 512×512
- Web App Manifest

아이콘 디자인이 정해지지 않았으면 임시 아이콘임을 표시하고, 공개 릴리스 전에 사용자 승인을 받는다.

## 6. Default Copy Rules

- 한 화면의 Primary CTA는 하나만 둔다. **[보완값]**
- 행동명은 구체적으로 쓴다: `확인`보다 `QA 시작`, `릴리스 기록`.
- 오류는 원인과 해결 방법을 함께 쓴다.
- AI가 완료 여부를 추정하지 않는다.

## 7. Override Record

기본값과 다른 값을 사용하면 해당 앱의 `design.md`에 다음을 기록한다.

```text
항목:
Factory 기본값:
앱별 값:
변경 이유:
승인자:
승인일:
```
