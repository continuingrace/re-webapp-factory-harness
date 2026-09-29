// 정적 CSS 수집·해석. .css 파일과 HTML <style> 블록만 판정한다.
// 인라인 style 속성과 CSS-in-JS는 판정하지 않고 marker로 보고한다.
const JS_EXT = /\.(m?js|jsx|ts|tsx)$/i;
const HTML_EXT = /\.html?$/i;
const JS_STYLE_MARKERS = [/\bstyled\./, /\bcss`/, /\.style\.[A-Za-z]+\s*=/, /\.style\.setProperty\(/, /\.style\.cssText/];

export const CSS_KEYWORDS = ['auto', 'inherit', 'initial', 'unset', 'revert', 'normal'];

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function parseDeclarations(css, source) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const text = stripComments(css);
  let m;
  while ((m = re.exec(text))) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      const prop = part.slice(0, i).trim().toLowerCase();
      const value = part.slice(i + 1).replace(/!important/i, '').trim();
      if (prop && value) out.push({ source, selector, prop, value });
    }
  }
  return out;
}

export function tokens(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && /[\s,/]/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function normZero(t) {
  return /^[-+]?0*\.?0+(px|em|rem|%|vh|vw)?$/.test(t) ? '0' : t;
}

export function collectCss(ctx) {
  const decls = [];
  const sources = [];
  const markers = [];
  for (const rel of ctx.files) {
    const text = ctx.text(rel);
    if (text === null) continue;
    if (/\.css$/i.test(rel)) {
      sources.push(rel);
      decls.push(...parseDeclarations(text, rel));
      if (/@import\s+(?:url\(\s*)?["']?(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(stripComments(text))) markers.push({ path: rel, marker: 'external_stylesheet' });
    } else if (HTML_EXT.test(rel)) {
      const styles = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
      if (styles.length) sources.push(rel);
      for (const s of styles) decls.push(...parseDeclarations(s[1], rel));
      if (/\sstyle\s*=\s*["']/i.test(text)) markers.push({ path: rel, marker: 'inline_style_attribute' });
      for (const link of text.matchAll(/<link\b[^>]*>/gi)) {
        const tag = link[0];
        const rels = (/\brel\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
        const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
        if (rels.toLowerCase().split(/\s+/).includes('stylesheet') && (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))) {
          markers.push({ path: rel, marker: 'external_stylesheet' });
        }
      }
    } else if (JS_EXT.test(rel)) {
      if (JS_STYLE_MARKERS.some((re) => re.test(text))) markers.push({ path: rel, marker: 'css_in_js' });
    }
  }
  return { decls, sources, markers };
}

export function selectorList(selector) {
  return selector.split(',').map((s) => s.trim());
}
