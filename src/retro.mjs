import path from 'node:path';
import { readJSON } from './io.mjs';
import { classifyProviderFailure, listJobs } from './jobs.mjs';

// A retrospective over the job journal, after prompt-agent's session scoring:
// the numbers a person would otherwise count by hand before deciding what to
// change in the harness. It reads only; every figure comes from job records and
// their result files, and a job whose files are gone is counted, not guessed.

const STARTED = new Set(['STARTING','READY','RUNNING']);
const bump = (map,key,by=1) => { map[key] = (map[key] ?? 0) + by; };
const minutes = job => {
  const end = Date.parse(job.updated ?? ''), start = Date.parse(job.created ?? '');
  return Number.isFinite(end) && Number.isFinite(start) ? Math.round((end-start)/60000) : null;
};

/**
 * Input actually processed. Codex counts cached input inside input_tokens;
 * Claude reports cache writes and reads beside it. Adding Codex's cached field
 * again would double its share.
 */
export function inputTokens(usage) {
  if (!usage) return 0;
  const n = key => Number(usage[key] ?? 0);
  return usage.provider === 'claude' ? n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') : n('input_tokens');
}

/** Why a job did not complete, in the words a next step can act on. */
export function failureCause(job) {
  if (job.status === 'CANCELLED') return /^orphaned/.test(job.error ?? '') ? 'cancelled: orphaned worker' : 'cancelled';
  const provider = job.runtime?.provider ?? job.requested?.provider ?? null;
  const kind = (job.providerFailure ?? classifyProviderFailure(`${job.error ?? ''} ${job.providerError ?? ''}`.trim(),provider))?.kind;
  if (kind) return `provider: ${kind}`;
  if (job.status === 'TIMED_OUT') return job.termination && !job.termination.confirmed ? 'timeout: termination unconfirmed' : 'timeout';
  if (job.error && !job.runtime) return `refused before start: ${job.error.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g,'<id>').slice(0,120)}`;
  return `run failed: ${(job.error ?? 'no error recorded').slice(0,120)}`;
}

export async function retro(ws, { since = null } = {}) {
  const from = since ? Date.parse(since) : null;
  const jobs = (await listJobs(ws)).filter(job => from === null || Date.parse(job.created ?? 0) >= from);
  const report = {
    window: { since: since ?? null, jobs: jobs.length, first: null, last: null },
    status: {}, causes: {}, byModel: {}, byRole: {},
    criteria: { answered: 0, pass: 0, fail: 0, unknown: 0, gapJobs: 0, missingResults: 0 },
    delegated: 0, staleEvidence: 0, slowest: [],
  };
  const created = jobs.map(job => job.created).filter(Boolean).sort();
  report.window.first = created[0] ?? null;
  report.window.last = created.at(-1) ?? null;
  for (const job of jobs) {
    bump(report.status,job.status);
    const model = `${job.runtime?.provider ?? job.requested?.provider ?? '?'}/${job.runtime?.model ?? job.requested?.model ?? '?'}`;
    const entry = report.byModel[model] ??= { jobs:0, completed:0, failed:0, reportedCostUsd:0, inputTokens:0, outputTokens:0 };
    entry.jobs++;
    if (job.status === 'COMPLETED') entry.completed++;
    else if (!STARTED.has(job.status) && job.status !== 'QUEUED') { entry.failed++; bump(report.causes,failureCause(job)); }
    if (typeof job.usage?.reportedCostUsd === 'number') entry.reportedCostUsd = Math.round((entry.reportedCostUsd + job.usage.reportedCostUsd)*100)/100;
    entry.inputTokens += inputTokens(job.usage);
    entry.outputTokens += Number(job.usage?.output_tokens ?? 0);
    const role = report.byRole[job.packet?.role ?? '?'] ??= { jobs:0, completed:0 };
    role.jobs++;
    if (job.status === 'COMPLETED') role.completed++;
    if (job.delegation) report.delegated++;
    if (job.status === 'COMPLETED') {
      if (job.evidenceFreshness === 'STALE') report.staleEvidence++;
      if (job.resultGaps) report.criteria.gapJobs++;
      const result = job.artifactDirectory ? await readJSON(path.join(job.artifactDirectory,'result.json')).catch(() => null) : null;
      if (!result) report.criteria.missingResults++;
      for (const c of result?.criteria ?? []) {
        report.criteria.answered++;
        bump(report.criteria,c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : 'unknown');
      }
    }
    const took = minutes(job);
    if (took !== null) report.slowest.push({ id:job.id, role:job.packet?.role ?? null, status:job.status, minutes:took });
  }
  report.slowest = report.slowest.sort((a,b) => b.minutes-a.minutes).slice(0,5);
  report.causes = Object.fromEntries(Object.entries(report.causes).sort((a,b) => b[1]-a[1]));
  const share = report.criteria.answered ? report.criteria.unknown/report.criteria.answered : 0;
  report.criteria.unknownShare = Math.round(share*100)/100;
  report.attention = attention(report);
  return report;
}

/** The few lines worth acting on; the rest of the report is there to check them against. */
function attention(r) {
  const out = [];
  const quota = Object.entries(r.causes).filter(([k]) => k === 'provider: QUOTA').reduce((n,[,v]) => n+v,0);
  if (quota) out.push(`${quota} job(s) stopped on a provider limit: run on a model with headroom, or record a delegation before resubmitting.`);
  const network = r.causes['provider: NETWORK'];
  if (network) out.push(`${network} job(s) lost the network; they were not retried automatically.`);
  const refused = Object.entries(r.causes).filter(([k]) => k.startsWith('refused before start')).reduce((n,[,v]) => n+v,0);
  if (refused) out.push(`${refused} job(s) were refused before start; the pre-run hook catches writer problems earlier (claudex hooks --install).`);
  if (r.causes['timeout: termination unconfirmed']) out.push('A timed-out provider process was not confirmed terminated; check for leftovers before new work.');
  if (r.criteria.unknownShare >= 0.25) out.push(`${Math.round(r.criteria.unknownShare*100)}% of criterion verdicts were UNKNOWN: give reviewers CURRENT check runs through a task contract, or narrow the criteria.`);
  if (r.criteria.gapJobs) out.push(`${r.criteria.gapJobs} completed job(s) left criteria unanswered (resultGaps).`);
  if (r.staleEvidence) out.push(`${r.staleEvidence} completed job(s) finished STALE: source or configuration changed while they ran, so their verdict describes no single snapshot.`);
  return out;
}
