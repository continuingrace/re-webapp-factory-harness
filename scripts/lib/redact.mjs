// evidence에 남기는 문자열 마스킹 (네트워크 없음).
// URL은 사용자정보·fragment를 지우고 query 값을 가리며, ST-03 비밀 패턴은 규칙 ID로 바꾸고, 길이를 제한한다.
export function maskUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return '[invalid-url]';
  }
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

// 개인키 블록: BEGIN 머리글부터 대응 END 줄까지 본문 전체를 하나의 값으로 바꾼다. END가 없으면(잘린 출력) 끝까지 가린다.
function maskPrivateKeyBlocks(text, block) {
  if (!block) return text;
  const begin = new RegExp(block.begin, 'g');
  const end = new RegExp(block.end, 'g');
  let out = '';
  let pos = 0;
  let m;
  while ((m = begin.exec(text))) {
    out += text.slice(pos, m.index);
    end.lastIndex = begin.lastIndex;
    const e = end.exec(text);
    const stop = e ? e.index + e[0].length : (block.unterminated === 'mask_to_end' ? text.length : begin.lastIndex);
    out += `[REDACTED:${block.rule_id}]`;
    pos = stop;
    begin.lastIndex = stop;
  }
  return out + text.slice(pos);
}

// patterns: { ruleId: regexSource } (checks.json ST-03 rule.patterns), maxChars: policies.evidence_text.max_chars,
// privateKeyBlock: policies.evidence_text.private_key_block. 마스킹은 모두 길이 자르기 전에 적용한다.
export function redactText(text, { patterns, maxChars, privateKeyBlock }) {
  let out = maskPrivateKeyBlocks(String(text), privateKeyBlock);
  for (const [id, src] of Object.entries(patterns)) out = out.replace(new RegExp(src, 'g'), `[REDACTED:${id}]`);
  out = out.replace(URL_IN_TEXT, (u) => maskUrl(u));
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}
