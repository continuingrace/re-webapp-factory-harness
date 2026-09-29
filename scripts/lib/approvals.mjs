// 사람 승인 기록(approvals.json) 해석. 원문이 없는 기록은 승인으로 인정하지 않는다.
export const URL_CONFIRMATION = 'OPERATING_URL_CONFIRMATION';
export const APPROVAL_BINDING = ['run_id', 'fingerprint', 'target_version', 'operating_url'];

export function hasStatement(rec) {
  return Boolean(rec) && typeof rec.statement === 'string' && rec.statement.trim() !== '';
}

export function matchesBinding(rec, binding) {
  return APPROVAL_BINDING.every((f) => rec[f] === binding[f]);
}

// 현재 deployment의 운영 URL 확인 상태. 같은 deployment에서 REJECT가 한 번이라도 있으면 REJECT다.
export function urlConfirmation(approvals, binding, deploymentId) {
  const recs = approvals
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.approval_type === URL_CONFIRMATION && r.deployment_id === deploymentId && hasStatement(r) && matchesBinding(r, binding));
  if (!recs.length) return { status: 'MISSING', indexes: [] };
  const rejected = recs.find(({ r }) => r.decision === 'REJECT');
  if (rejected) return { status: 'REJECT', indexes: [rejected.index] };
  const last = recs[recs.length - 1];
  return { status: last.r.decision === 'APPROVE' ? 'APPROVE' : 'MISSING', indexes: [last.index] };
}
