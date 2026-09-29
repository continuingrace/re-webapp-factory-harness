// 실행 폴더·경로 정규화와 app_slug 판정.
import fs from 'node:fs';
import path from 'node:path';

export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// run_dir는 정규화 후 <root>/runs 내부여야 하며, link를 통해 밖으로 나가면 안 된다.
export function resolveRunDir(root, runDir) {
  if (!runDir) return { ok: false, code: 'RUN_DIR_MISSING' };
  const runsRoot = path.join(root, 'runs');
  const abs = path.resolve(runDir);
  if (!isInside(runsRoot, abs)) return { ok: false, code: 'RUN_DIR_OUTSIDE_RUNS' };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, code: 'RUN_DIR_MISSING' };
  const real = fs.realpathSync.native(abs);
  const realRuns = fs.realpathSync.native(runsRoot);
  if (!isInside(realRuns, real)) return { ok: false, code: 'RUN_DIR_OUTSIDE_RUNS' };
  return { ok: true, dir: real };
}

// 실행 폴더 안의 일반 파일만 읽는다 (link 금지).
export function readRunJson(runDir, name) {
  const p = path.join(runDir, name);
  if (!isInside(runDir, path.resolve(p))) return { ok: false, code: 'RUN_FILE_OUTSIDE' };
  if (!fs.existsSync(p)) return { ok: false, code: 'RUN_FILE_MISSING' };
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: 'RUN_FILE_NOT_REGULAR' };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { ok: false, code: 'RUN_FILE_INVALID_JSON' };
  }
}

export function canonicalAppPath(appPath) {
  return fs.realpathSync.native(path.resolve(appPath));
}

export function deriveAppSlug(appPath, regexSource, provided) {
  const re = new RegExp(regexSource);
  if (provided !== undefined && provided !== null && provided !== '') {
    return re.test(provided)
      ? { ok: true, slug: provided, source: 'USER_PROVIDED' }
      : { ok: false, code: 'APP_SLUG_INVALID', slug: provided };
  }
  const base = path.basename(path.resolve(appPath));
  return re.test(base)
    ? { ok: true, slug: base, source: 'DERIVED' }
    : { ok: false, code: 'APP_SLUG_INVALID', slug: base };
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// 같은 app_slug의 기존 실행이 다른 canonical app_path를 가리키면 충돌.
export function findSlugCollision(root, slug, canonical) {
  const dir = path.join(root, 'runs', slug);
  if (!fs.existsSync(dir)) return null;
  for (const runId of fs.readdirSync(dir)) {
    const inputFile = path.join(dir, runId, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    try {
      const other = JSON.parse(fs.readFileSync(inputFile, 'utf8')).app_path_canonical;
      if (other && !samePath(other, canonical)) return { run_id: runId };
    } catch {
      return { run_id: runId, unreadable: true };
    }
  }
  return null;
}
