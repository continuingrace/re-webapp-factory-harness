// stage 3 전용 로컬 정적 서버. 127.0.0.1에만 바인딩하고 OS가 정한 임의 포트를 쓴다.
// GET·HEAD만 허용, 디렉터리 목록 없음, link 미추적, app_path 밖 경로 거부, 바깥으로 요청하지 않음.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './paths.mjs';
import { isExcludedDir, isExcludedFile } from './fingerprint.mjs';

const HOST = '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// policy: checks.json policies.fingerprint. 제외 목록에 해당하는 경로는 fingerprint·정적 검사 범위 밖이므로 제공하지 않는다.
// 제외 판정은 app_path 기준 상대 경로에만 적용하므로, app_path 자체가 dist·build여도 그 안의 파일은 제공된다.
export function resolveRequestPath(root, rawUrl, policy, platform = process.platform) {
  if (!policy) return { code: 500 };
  const rawPath = String(rawUrl || '').split(/[?#]/)[0];
  if (!rawPath.startsWith('/')) return { code: 400 };
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { code: 400 };
  }
  if (decoded.includes('\0')) return { code: 400 };
  const segs = decoded.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.includes(':'))) return { code: 400 };
  if (decoded.endsWith('/') && segs.length) return { code: 403 };
  const rel = segs.length ? segs : ['index.html'];
  if (rel.some((s) => isExcludedDir(s, policy, platform)) || isExcludedFile(rel[rel.length - 1], policy, platform)) return { code: 403, excluded: true };
  let cur = root;
  for (const s of rel) {
    cur = path.join(cur, s);
    if (!isInside(root, cur)) return { code: 400 };
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return { code: 404 };
    }
    if (st.isSymbolicLink()) return { code: 403 };
  }
  if (!fs.lstatSync(cur).isFile()) return { code: 403 };
  return { code: 200, file: cur };
}

export function startStaticServer(appPath, policy) {
  if (!policy || !Array.isArray(policy.exclude_dirs)) return Promise.reject(Object.assign(new Error('FINGERPRINT_POLICY_REQUIRED'), { code: 'FINGERPRINT_POLICY_REQUIRED' }));
  const root = fs.realpathSync.native(path.resolve(appPath));
  const sockets = new Set();
  const excludedRequests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const r = resolveRequestPath(root, req.url, policy);
    if (r.excluded) excludedRequests.push(String(req.url).split(/[?#]/)[0]);
    if (r.code !== 200) {
      res.writeHead(r.code);
      res.end();
      return;
    }
    const body = fs.readFileSync(r.file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(r.file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const { port, address } = server.address();
      resolve({
        origin: `http://${HOST}:${port}`,
        port,
        address,
        excludedRequests: () => [...excludedRequests],
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
