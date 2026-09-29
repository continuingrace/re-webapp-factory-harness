// 앱 fingerprint. 제외 목록과 link 처리는 checks.json policies.fingerprint에서 읽는다.
// symlink·junction은 따라가지 않으며, app_path 밖의 경로를 읽지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

// 대소문자를 구분하지 않는 파일시스템(policies.fingerprint.case_insensitive_platforms)에서는
// 이름과 정책 값을 같은 방식으로 접어 비교한다. fingerprint와 로컬 서버가 이 두 함수만 쓴다.
export function caseInsensitive(policy, platform = process.platform) {
  return Array.isArray(policy.case_insensitive_platforms) && policy.case_insensitive_platforms.includes(platform);
}

export function globMatch(glob, name, ignoreCase = false) {
  return new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`, ignoreCase ? 'i' : '').test(name);
}

export function isExcludedFile(name, policy, platform) {
  const ci = caseInsensitive(policy, platform);
  return policy.exclude_globs.some((g) => globMatch(g, name, ci));
}

export function isExcludedDir(name, policy, platform) {
  const ci = caseInsensitive(policy, platform);
  return policy.exclude_dirs.some((d) => (ci ? d.toLowerCase() === name.toLowerCase() : d === name));
}

export function walkApp(appPath, policy) {
  const root = fs.realpathSync.native(path.resolve(appPath));
  const files = [];
  const links = [];
  const unsupported = [];
  const rec = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(childAbs);
      const excludedDir = isExcludedDir(name, policy);
      if (st.isSymbolicLink()) {
        if (excludedDir || isExcludedFile(name, policy)) continue;
        links.push(childRel);
      } else if (st.isDirectory()) {
        if (!excludedDir) rec(childAbs, childRel);
      } else if (st.isFile()) {
        if (!isExcludedFile(name, policy)) files.push(childRel);
      } else {
        unsupported.push(childRel);
      }
    }
  };
  rec(root, '');
  files.sort();
  return { root, files, links, unsupported };
}

export function readAppFile(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')));
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// 파일별 항목: sha256( u32(경로 바이트 길이) ‖ 경로 ‖ u64(내용 바이트 길이) ‖ 내용 ).
// 전체: sha256( 형식 표시 ‖ u32(파일 수) ‖ 파일별 32바이트 해시를 경로 순서로 ). 경로·내용·파일 경계가 모두 구분된다.
function contentHash(walk, encoding) {
  const outer = createHash('sha256');
  outer.update(Buffer.from(encoding, 'utf8'));
  outer.update(u32(walk.files.length));
  for (const rel of walk.files) {
    const p = Buffer.from(rel, 'utf8');
    const c = readAppFile(walk.root, rel);
    outer.update(createHash('sha256').update(u32(p.length)).update(p).update(u64(c.length)).update(c).digest());
  }
  return outer.digest('hex');
}

// fingerprint는 항상 검사 대상 파일(제외 목록 적용 후, gitignore와 무관)의 content hash다.
// 로컬 서버도 같은 제외 목록의 경로를 제공하지 않으므로(local-server.mjs), 검사·브라우저 제공 파일과 fingerprint 범위가 같다.
export function computeFingerprint(appPath, policy) {
  const walk = walkApp(appPath, policy);
  const blockedLinks = [...walk.links, ...walk.unsupported];
  if (blockedLinks.length) {
    return {
      status: policy.links_outside_excluded.status,
      failure_code: policy.links_outside_excluded.failure_code,
      links: blockedLinks,
      walk,
    };
  }
  return { status: 'OK', type: 'content_sha256', value: contentHash(walk, policy.encoding), walk };
}
