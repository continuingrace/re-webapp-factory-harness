// 운영 URL 형식 검사 (네트워크 없음). PD-01 규칙의 deny_userinfo·deny_query·deny_fragment를 적용한다.
// 사용자정보·query·fragment가 있는 URL은 기록·출력·릴리스 기록에 들어가지 않도록 입력 단계에서 거부한다.
export function operatingUrlViolation(raw, rule) {
  if (typeof raw !== 'string' || raw === '') return 'URL_NOT_HTTPS';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'URL_NOT_HTTPS';
  }
  if (rule.deny_userinfo && (u.username || u.password || /^[a-z]+:\/\/[^/?#]*@/i.test(raw))) return 'URL_USERINFO_FORBIDDEN';
  if (rule.deny_query && (u.search || raw.includes('?'))) return 'URL_QUERY_OR_FRAGMENT_FORBIDDEN';
  if (rule.deny_fragment && (u.hash || raw.includes('#'))) return 'URL_QUERY_OR_FRAGMENT_FORBIDDEN';
  return null;
}
