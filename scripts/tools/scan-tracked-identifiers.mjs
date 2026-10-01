// 개발용 도구: Git 추적 파일에 비공개 식별자가 남았는지 검사한다.
//   node scripts/tools/scan-tracked-identifiers.mjs
// 하네스 루트의 local 식별자 설정만 쓰며 경로 인자를 받지 않는다. 파일을 만들거나 고치지 않는다.
// 출력에는 opaque id·가린 경로·건수만 담는다. 발견하면 exit 1, 설정을 불러오지 못하면 exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadChecks } from '../lib/checks.mjs';
import { countIdentifier, identifiersSummary, loadIdentifiers, maskText } from '../lib/identifiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 바이너리(NUL 포함)도 건너뛰지 않고 latin1로 읽는다. 경로와 내용 모두 검사한다.
export function scanFiles(root, rels, ids) {
  const hits = [];
  for (const rel of rels) {
    for (const e of ids.entries) {
      const n = countIdentifier(e, rel);
      if (n) hits.push({ path: maskText(rel, ids), id: e.id, target: 'path', count: n });
    }
    const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
    const text = buf.includes(0) ? buf.toString('latin1') : buf.toString('utf8');
    for (const e of ids.entries) {
      const n = countIdentifier(e, text);
      if (n) hits.push({ path: maskText(rel, ids), id: e.id, target: 'content', count: n });
    }
  }
  return { scanned: rels.length, hits };
}

function main() {
  const { data, errors } = loadChecks(ROOT);
  if (errors.length) return { code: 2, out: { ok: false, error_code: 'CHECKS_INVALID' } };
  const ids = loadIdentifiers(ROOT, data.policies.private_identifiers);
  if (!ids.ok) return { code: 2, out: { ok: false, identifiers_config: identifiersSummary(ids) } };
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  // 작업 트리에서 지운 추적 파일은 읽을 수 없으므로 목록으로만 보고한다.
  const rels = listed.filter((rel) => fs.existsSync(path.join(ROOT, ...rel.split('/'))));
  const missing = listed.length - rels.length;
  const r = scanFiles(ROOT, rels, ids);
  return { code: r.hits.length ? 1 : 0, out: { ok: r.hits.length === 0, identifiers: ids.entries.map((e) => e.id), scanned: r.scanned, missing_in_worktree: missing, hits: r.hits } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code, out } = main();
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = code;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, error_code: e.code || 'SCAN_ERROR' })}\n`);
    process.exitCode = 2;
  }
}
