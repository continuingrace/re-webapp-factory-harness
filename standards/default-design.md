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
family     Pretendard Variable, Pretendard, system sans-serif
display    32 / 700 / 1.30
h1         28 / 700 / 1.30
h2         24 / 700 / 1.35
h3         20 / 700 / 1.35
h4         18 / 700 / 1.35
title      17 / 600 / 1.40
body-lg    17 / 300 / 1.50
body       15 / 400 / 1.50
body-sm    13 / 400 / 1.50
label      12 / 600 / 1.40
caption    12 / 400 / 1.40
letter-spacing 0
```

### Spacing & Shape

```text
spacing    4, 8, 12, 16, 24, 32, 48, 64
radius     0, 16, 24, 9999
app icon   30% squircle
border     1px
shadow     none
```

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

- Primary button: ink fill, white label, full pill
- Secondary button: white fill, 1px hairline, full pill
- Tertiary button: soft canvas fill, full pill
- Input: field fill, no resting border, 16px radius, 12px 16px padding
- Card: white fill, 1px hairline-soft, 24px radius, 24px padding
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
