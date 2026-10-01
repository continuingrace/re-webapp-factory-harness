# RE Webapp Factory — design.md

- **문서 버전:** v0.2
- **상태:** Webapp Factory 기본 디자인 기준
- **적용 대상:** RE Webapp Factory 관리 화면
- **개별 앱 적용:** 별도 디자인 기준이 없을 때만 `../standards/default-design.md` 사용

## 0. 기준 출처 표시

이 문서는 사용자가 제공한 공개 외부 디자인 참고 자료를 참고해 RE Webapp Factory 운영 화면에 맞게 재구성한 것이다. 원 자료에 대한 소유권을 주장하지 않으며, 그 자료의 서비스·브랜드·원문·파일을 복제하지 않는다. 참고 사실과 권리 검토 상태는 `harness-limitations.md` 6절에 둔다.

- **[제공 기준]** 사용자가 제공한 값이나 원칙을 그대로 사용
- **[Factory 적용]** 제공 기준을 Webapp Factory 목적에 맞게 재해석
- **[보완값]** 사용자가 지정하지 않아 운영·접근성·QA를 위해 추가한 값

`[보완값]`은 사용자가 다른 값을 정하면 교체할 수 있다. 비공개 업무·개인 프로젝트의 디자인 시스템과 자산은 사용하지 않는다.

---

## 1. Design Intent

RE Webapp Factory는 여러 개인 웹앱의 상태, 문제, 다음 행동을 빠르게 판단하게 하는 운영 도구다. 장식보다 가독성, 상태의 진실성, 안전한 실행을 우선한다.

### 핵심 원칙

1. **상태 우선:** 앱 이름, 버전, 배포, QA, 문서 동기화, 다음 작업을 먼저 보여준다.
2. **흰 캔버스:** 관리 UI는 무채색으로 물러나고 앱 미리보기와 산출물이 색을 담당한다. **[제공 기준·Factory 적용]**
3. **타이포그래피 중심:** 색 대신 크기·굵기·여백으로 계층을 만든다. **[제공 기준]**
4. **무그림자:** 면 색상과 1px 경계선으로 깊이를 표현한다. **[제공 기준]**
5. **검증 상태 구분:** 미확인·진행·통과·주의·실패를 숨기거나 혼동시키지 않는다. **[Factory 적용]**
6. **안전한 기본값:** 사용자가 디자인 값을 정하지 않아도 `../standards/default-design.md`로 진행하되, 적용 사실을 기록한다.

---

## 2. Color Tokens

### Base Palette

| Token | Value | Use | 출처 |
|---|---:|---|---|
| `color.ink` | `#141414` | 제목, 본문, Primary CTA, 역상 배경 | 제공 기준 |
| `color.ink-soft` | `#262626` | 보조 제목, 강한 보조 텍스트 | 제공 기준 |
| `color.canvas` | `#FFFFFF` | 기본 페이지·카드 배경 | 제공 기준 |
| `color.canvas-soft` | `#F3F3F3` | 선택 영역, 보조 패널, 필터 트랙 | 제공 기준 |
| `color.field` | `#F0F0F0` | 입력 필드 배경 | 제공 기준 |
| `color.hairline-soft` | `#F0F0F0` | 흰 카드의 약한 1px 경계 | 제공 기준 |
| `color.hairline` | `#E0E0E0` | 컨트롤, 구획의 1px 경계 | 제공 기준 |
| `color.text-muted` | `#707070` | 설명, 메타 정보 | 제공 기준 |
| `color.text-faint` | `#ADADAD` | placeholder, 비활성 보조 정보 | 제공 기준 |
| `color.on-ink` | `#FFFFFF` | Ink 배경 위 텍스트 | Factory 적용 |
| `color.accent` | `#0066FF` | 현재 선택, 정보, 링크, focus 보조 | 제공값·Factory 적용 |

### Semantic Palette

운영 화면에는 명확한 상태 표현이 필요하므로 아래 값을 추가한다. **[보완값]**

| Token | Value | Meaning |
|---|---:|---|
| `color.success` | `#16803A` | 실제 검증 통과 |
| `color.warning` | `#9A5B00` | 확인 또는 보완 필요 |
| `color.danger` | `#C62828` | 실패, 오류, 파괴적 행동 |
| `color.info` | `#0066FF` | 진행, 선택, 일반 안내 |

### Color Rules

- Primary CTA는 `color.ink`를 사용하고 accent blue를 CTA 장식색으로 남용하지 않는다. **[제공 기준·Factory 적용]**
- `success`는 실제 검사 근거가 있을 때만 사용한다.
- 상태는 색상만으로 전달하지 않고 아이콘·레이블·설명을 함께 표시한다.
- 사용자 콘텐츠와 앱 미리보기 외 UI chrome에 추가 브랜드 색상을 도입하지 않는다.
- 텍스트와 배경은 WCAG AA 대비를 충족해야 한다. **[보완값]**

---

## 3. Typography

### Font

**Pretendard Variable**을 기본으로 사용한다. **[제공 기준]**

```css
font-family: "Pretendard Variable", Pretendard, -apple-system,
  BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
```

### Type Scale

| Token | Size | Weight | Line height | Letter spacing | Use |
|---|---:|---:|---:|---:|---|
| `type.display` | 32px | 700 | 1.30 | 0 | 핵심 카운터, 중요한 선언 |
| `type.h1` | 28px | 700 | 1.30 | 0 | 화면 제목 |
| `type.h2` | 24px | 700 | 1.35 | 0 | 섹션 제목 |
| `type.h3` | 20px | 700 | 1.35 | 0 | 카드 제목 |
| `type.h4` | 18px | 700 | 1.35 | 0 | 하위 제목 |
| `type.title` | 17px | 600 | 1.40 | 0 | 강조 행, 기능 제목 |
| `type.body-lg` | 17px | 300 | 1.50 | 0 | 리드 설명 |
| `type.body` | 15px | 400 | 1.50 | 0 | 기본 본문 |
| `type.body-sm` | 13px | 400 | 1.50 | 0 | 보조 설명 |
| `type.link` | 15px | 600 | 1.50 | 0 | 링크, 버튼 레이블 |
| `type.label` | 12px | 600 | 1.40 | 0 | 배지, 상태 레이블 |
| `type.caption` | 12px | 400 | 1.40 | 0 | 메타 정보 |

### Typography Rules

- 제목은 700, 본문은 400, 리드 문장은 300의 대비를 기본으로 한다. **[제공 기준]**
- 한글 제목 행간은 1.3–1.35, 본문은 1.5를 유지한다. **[제공 기준]**
- 자간은 기본 0이며 임의 음수 자간을 사용하지 않는다. **[제공 기준]**
- URL, 버전, 경로는 필요할 때만 monospace를 사용한다. **[Factory 적용]**
- 글꼴 로딩 실패 시 fallback에서도 레이아웃과 기능이 유지되어야 한다. **[보완값]**

---

## 4. Spacing, Radius, Elevation

### Spacing

8px 기본 단위와 4px 보조 단위를 사용한다. **[제공 기준]**

```text
4 / 8 / 12 / 16 / 24 / 32 / 48 / 64
```

| Token | Value | Use |
|---|---:|---|
| `space.xxs` | 4px | 아이콘과 레이블의 미세 간격 |
| `space.xs` | 8px | 밀접한 요소 |
| `space.sm` | 12px | 작은 그룹 |
| `space.md` | 16px | 기본 내부 여백·모바일 좌우 여백 |
| `space.lg` | 24px | 카드 내부·그룹 간격 |
| `space.xl` | 32px | 섹션 내부 구분 |
| `space.section` | 48px | 섹션 사이 |
| `space.section-lg` | 64px | 주요 화면 단위 사이 |

### Radius

| Token | Value | Use | 출처 |
|---|---:|---|---|
| `radius.none` | 0px | full-bleed 영역 | 제공 기준 |
| `radius.sm` | 16px | 입력, QA 행, 작은 카드 | 제공 기준 |
| `radius.md` | 24px | 앱 카드, 패널, 미리보기 | 제공 기준 |
| `radius.full` | 9999px | 버튼, 필터, 배지, 토글 | 제공 기준 |
| `radius.app-icon` | 30% | 앱 아이콘 squircle | 제공 기준 |

**[Factory 조정]** 개별 앱 기본값과 하네스 판정은 `../standards/default-design.md`의 역할별 radius를 따른다 (입력·버튼 12px, 카드 16px, pill은 chip·tag·badge·toggle만). 위 표는 참고 기준이다.

### Elevation

- 카드, 버튼, 내비게이션에 drop shadow를 사용하지 않는다. **[제공 기준]**
- 계층은 `canvas-soft`, hairline, 1px outline으로 만든다.
- 모달과 팝오버도 그림자보다 경계선과 배경 차이를 우선한다. **[Factory 적용]**

---

## 5. Layout & Responsive

### Mobile Baseline

- 기준 프레임: `390 × 844` **[제공 기준]**
- 최소 너비: `360px` **[제공 기준]**
- 좌우 여백: `16px` **[제공 기준]**
- 최소 터치 영역: `44 × 44px` **[제공 기준]**
- 최소 너비에서 가로 스크롤이 없어야 한다.

### Factory Responsive Defaults

운영 대시보드의 데스크톱 사용을 위해 아래 값을 추가한다. **[보완값]**

| Name | Range / Value | Behavior |
|---|---|---|
| Mobile | `360–767px` | 단일 열, 메뉴 축약, 카드형 데이터 |
| Tablet | `768–1023px` | 2열 허용, 보조 패널 접기 |
| Desktop | `1024px+` | 사이드바 + 콘텐츠, 표 사용 가능 |
| Content max | `1440px` | 중앙 정렬 최대 너비 |
| Sidebar | `240px` | 데스크톱 기본 너비 |

### Layout Rules

- Dashboard는 `상태 요약 → 주의 필요 → 다음 작업 → 최근 활동` 순서로 배치한다.
- 모바일에서는 핵심 정보가 단일 열로 읽혀야 한다.
- 표는 모바일에서 핵심 열만 카드나 상세 보기로 변환한다.
- sticky로 정의된 미리보기·도구 영역은 실제 viewport에서 고정 여부를 검사한다. **[As-Is 반영]**
- sticky 요소가 내비게이션을 가리거나 스크롤을 막으면 실패다.

---

## 6. Core Components

### Buttons

- 모든 버튼·토글·배지는 `radius.full` pill을 사용한다. **[제공 기준]**
- Primary: ink 배경 + 흰색 레이블
- Secondary: 흰색 배경 + hairline + ink 레이블
- Tertiary: canvas-soft 배경 + ink 레이블
- Danger: danger 색상은 파괴적 작업에만 사용
- 한 화면의 Primary 행동은 원칙적으로 하나다. **[보완값]**
- 버튼 문구는 `확인`보다 `QA 시작`, `릴리스 기록`처럼 결과를 표현한다.

### Inputs

- 기본 배경 `color.field`, 테두리 없음, `radius.sm`
- padding `12px 16px`
- focus 시 2px ink 또는 accent ring
- 레이블은 입력 후에도 사라지지 않는다.
- 오류는 필드 가까이에서 원인과 해결 방법을 설명한다.

### App Card

반드시 표시한다.

- 앱 이름과 설명
- 현재 버전
- 저장소·운영 URL
- 배포·QA·문서 동기화 상태
- 최근 변경일
- 다음 작업

기본 surface는 흰색 + 1px hairline-soft + `radius.md`다.

### Status Badge

| State | Label | Visual rule |
|---|---|---|
| `not-checked` | 미확인 | 중립 회색 + 아이콘 |
| `in-progress` | 진행 중 | info + 진행 아이콘 |
| `passed` | 통과 | success + 체크 아이콘 |
| `needs-attention` | 확인 필요 | warning + 경고 아이콘 |
| `failed` | 실패 | danger + 오류 아이콘 |
| `blocked` | 사용자 결정 필요 | ink + 정지 아이콘 |

### QA Item

각 항목은 검사명, 상태, 통과 기준, 검사 근거, 검사 시각, 다음 행동을 가진다. 체크박스 클릭만으로 `passed`가 되지 않는다.

### Document Item

문서명, 역할, 공통/앱별/참고 구분, 최근 수정일, 적용 대상, 충돌 상태를 표시한다.

### Navigation

- 데스크톱: 240px sidebar **[보완값]**
- 모바일: logomark/서비스명 + 핵심 CTA + 메뉴
- 현재 위치는 색상뿐 아니라 배경·굵기·접근성 속성으로 표시한다.

### Preview Panel

- 데스크톱에서 필요 시 `top: 24px` sticky를 기본으로 한다. **[보완값·As-Is 반영]**
- 모바일에서는 콘텐츠를 가리지 않도록 일반 흐름 또는 명시된 축약 모드로 전환한다.
- 390px 기준에서 sticky, 확대, 스크롤, 입력 상호작용을 검증한다.

---

## 7. App Icon & PWA Defaults

홈 화면에 추가한 뒤 아이콘 누락을 발견했던 As-Is 문제를 예방한다.

아래 파일과 설정을 기본 요구사항으로 둔다. **[보완값]**

- `favicon.ico` 또는 SVG favicon
- `apple-touch-icon.png` — 180×180
- PWA icon — 192×192
- PWA icon — 512×512
- maskable 512×512 icon
- Web App Manifest의 `name`, `short_name`, `icons`, `start_url`, `display`, `theme_color`, `background_color`

아이콘은 `radius.app-icon` 30% squircle을 시각 기준으로 하되, OS 마스킹 안전 영역 안에 핵심 도형을 둔다. 실제 모바일 홈 화면에 추가해 최종 확인하기 전에는 통과로 기록하지 않는다.

---

## 8. Interaction & Accessibility

- 모든 기능은 키보드로 사용할 수 있어야 한다.
- focus는 항상 보이며 최소 2px의 명확한 ring을 사용한다.
- 상태를 색상만으로 표현하지 않는다.
- 의미 있는 제목 구조와 landmark를 사용한다.
- 모달은 focus trap, Escape 닫기, 닫힌 후 focus 복귀를 지원한다.
- 동작 피드백은 진행·성공·실패를 구분한다.
- `prefers-reduced-motion`을 존중한다.
- 오류 발생 시 원인, 보존된 상태, 다음 행동을 알려준다.
- 자동 수정 후 변경된 파일과 항목을 요약한다.

---

## 9. Design Gate Summary

세부 통과·실패 조건은 `../standards/default-gates.md`를 Source of Truth로 사용한다.

1. **Structure:** 토큰·필수 문서·아이콘·manifest 구조
2. **Design:** 컬러·서체·간격·radius·컴포넌트 일관성
3. **Responsive & Mobile:** 360/390px, sticky, overflow, touch target
4. **Functional & Accessibility:** 동작, 키보드, focus, 대비, 오류 상태
5. **Deployment:** 실제 URL, 실제 모바일, 폰트·아이콘·manifest 확인

어느 Gate도 미실행 상태에서 통과로 기록할 수 없다.

---

## 10. Do / Do Not

### Do

- 흰 캔버스와 근블랙 ink를 기본으로 사용한다.
- 콘텐츠와 앱 미리보기가 색을 담당하게 한다.
- 8px 간격과 4px 보조 단위를 사용한다.
- 모든 인터랙션 요소에 pill geometry를 일관되게 사용한다.
- 제목 700, 본문 400, 리드 300의 대비를 활용한다.
- QA 상태에는 근거와 다음 행동을 함께 표시한다.
- 모바일과 실제 배포 환경에서 확인한다.

### Do Not

- drop shadow로 계층을 만들지 않는다.
- accent blue를 모든 CTA와 장식에 남용하지 않는다.
- 임의 색상, 간격, radius를 토큰 밖에서 추가하지 않는다.
- 음수 자간과 과도하게 좁은 행간을 사용하지 않는다.
- 모바일을 데스크톱의 단순 축소판으로 만들지 않는다.
- 미검증 상태를 `passed`로 표시하지 않는다.
- 비공개 업무·개인 프로젝트의 디자인, 자산, 프롬프트를 자동 적용하지 않는다.

---

## 11. Rule Precedence

```text
사용자의 현재 명시적 결정
→ 해당 앱의 승인된 design.md
→ RE Webapp Factory의 승인된 design.md
→ ../standards/default-design.md
→ 참고 자료
```

- 앱별 규칙이 공통 규칙과 다르면 차이를 기록한다.
- 충돌을 AI가 임의로 병합하거나 해결하지 않는다.
- 사용자가 값을 정하지 않은 경우에만 `../standards/default-design.md`를 적용한다.
- 기본값을 적용한 항목은 생성 결과와 완료 보고에 표시한다.

---

## 12. 참고 자료에서 제외한 요소

다음은 제공 자료의 고유 서비스 표현이므로 Webapp Factory 기본값으로 채택하지 않았다.

- 가격제, Popular 배지와 상업 강조 규칙
- Awards 트로피·수상자 레이아웃
- 인물 사진의 흑백 처리와 큐레이터 그리드
- 로고 marquee와 브랜드 cloud
- 마케팅 페이지 footer 구성
- testimonial·pricing 전용 카드

이 요소들은 향후 개별 웹앱이 필요로 할 때 앱별 `design.md`에서 별도로 정의한다.
