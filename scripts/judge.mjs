// gate-judge 판정: node scripts/judge.mjs <run_dir>
// 읽기 전용이다. 파일을 만들거나 고치지 않고, 브라우저를 실행하거나 네트워크를 쓰지 않는다.
// 판정 로직은 lib/judge-core.mjs에 있으며, stdout에 판정 JSON만 출력한다.
// 판정할 수 없으면 PASS 대신 NEEDS_ATTENTION을 낸다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTENTION, computeJudgement } from './lib/judge-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

try {
  emit(computeJudgement(ROOT, process.argv[2]));
} catch (e) {
  emit({ verdict: ATTENTION, error_code: e.code || 'JUDGE_ERROR' });
}
