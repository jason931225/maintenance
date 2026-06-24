export const meta = {
  name: 'review-gate',
  description: 'Per-story quality gate: fan out correctness + RLS-as-mnt_rt security + a codex cross-model review of a diff (and web a11y/perf when relevant), then synthesize one GO/NO-GO with ranked must-fix findings. Reusable for every ultragoal story before checkpoint.',
  phases: [
    { title: 'Review', detail: 'parallel lanes: correctness · security/RLS · codex cross-model · (web a11y/perf)' },
    { title: 'Synthesize', detail: 'GO/NO-GO verdict + ranked must-fix' },
  ],
}

// args: { commit?, base?, head?, kind?: "backend"|"web"|"mixed"|"design", context?: string }
// Single commit: pass `commit`. Multi-commit story: pass `base` + `head` (reviews base..head).
const COMMIT = (args && args.commit) || 'HEAD'
const HEAD = (args && args.head) || COMMIT
const BASE_REF = (args && args.base) || `${HEAD}~1`
const DIFF = `git diff ${BASE_REF} ${HEAD}`
const RANGE = `${BASE_REF}..${HEAD}`
const KIND = (args && args.kind) || 'mixed'
const CTX = (args && args.context) || ''
const REPO = '/Users/jasonlee/Developer/maintenance'
const BASE = `Repo: ${REPO}. Multi-tenant Rust(axum)+Postgres RLS platform; runtime role mnt_rt is NOBYPASSRLS + FORCE ROW LEVEL SECURITY; EVERY tenant read/write MUST arm app.current_org (with_org_conn/with_audit + current_org()); tests must run as REAL mnt_rt (seed via the armed path, NOT the BYPASSRLS owner pool). Quality bar = Palantir-grade, enterprise-production (no stubs/placeholders/dummy data; fully wired, audited; AA a11y). Review the diff of \`${DIFF}\` (\`git log --oneline ${RANGE}\` lists the commits in scope).${CTX ? '\nStory context: ' + CTX : ''}`

const FINDINGS = {
  type: 'object', additionalProperties: false,
  properties: {
    lane: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          location: { type: 'string', description: 'file:line' },
          why: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'title', 'fix'],
      },
    },
    verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
  },
  required: ['lane', 'findings', 'verdict'],
}

phase('Review')
const lanes = [
  () => agent(
    `${BASE}\n\nLANE: CORRECTNESS. Find logic bugs, edge cases, error-handling gaps, broken contracts, missed states, and any "looks done but isn't fully wired" issue. Be concrete (file:line + fix).`,
    { label: 'correctness', phase: 'Review', schema: FINDINGS },
  ),
  () => agent(
    `${BASE}\n\nLANE: SECURITY + MULTI-TENANT RLS. Adversarially check: is every new tenant read/write RLS-armed (app.current_org)? could anything read/write CROSS-ORG or cross-branch beyond the caller's scope? is the org bound to a dynamic current_org()-derived value (never a hardcoded OrgId literal)? are mnt_rt tests genuine (not BYPASSRLS-masked)? authz gating correct? secrets/PII not logged? injection? Rank by severity; treat any tenant-isolation hole as critical/high.`,
    { label: 'security-rls', phase: 'Review', schema: FINDINGS },
  ),
  () => agent(
    `${BASE}\n\nLANE: CROSS-MODEL (codex). Run a DIFFERENT model over the same diff for blind-spot diversity. Execute via Bash (read-only, 240s budget):\n` +
    `  cd ${REPO} && timeout 240 codex exec --sandbox read-only --skip-git-repo-check "Senior security+correctness reviewer. Review ONLY the diff of \`${DIFF}\` in this repo (multi-tenant Postgres RLS; mnt_rt NOBYPASSRLS+FORCE RLS; every tenant read/write must arm app.current_org). Hunt for: cross-tenant/cross-branch isolation leaks, missing RLS arming, hardcoded org literals, swallowed errors, correctness bugs. Output findings ranked critical/high/medium/low with file:line + fix. Review only; do not modify files." 2>&1 | tail -80\n` +
    `(gtimeout if timeout is absent; if codex errors/auth-fails, say so in one finding and continue.) Then translate codex's output into the findings schema (preserve its severities + file:line). lane="codex-xmodel".`,
    { label: 'codex-xmodel', phase: 'Review', schema: FINDINGS },
  ),
]
if (KIND === 'web' || KIND === 'mixed') {
  lanes.push(() => agent(
    `${BASE}\n\nLANE: WEB QUALITY. For the web changes: AA accessibility (labels, focus, roles, keyboard), Korean copy only in ko.ts (no inline Hangul), no raw UUIDs shown (safeLabel), loading/empty/error states, KST datetime, and whether each touched path would clear visual-verdict ≥90 (note specific gaps). Flag perf anti-patterns (unbounded lists, refetch storms).`,
    { label: 'web-quality', phase: 'Review', schema: FINDINGS },
  ))
}
const results = (await parallel(lanes)).filter(Boolean)
const all = results.flatMap((r) => (r.findings || []).map((f) => ({ ...f, lane: r.lane })))
const crit = all.filter((f) => f.severity === 'critical').length
const high = all.filter((f) => f.severity === 'high').length
log(`${results.length} lanes; findings: ${crit} critical, ${high} high, ${all.length} total`)

phase('Synthesize')
const verdict = await agent(
  `You are the gate keeper. Below are per-lane review findings (correctness, security/RLS, codex cross-model${KIND !== 'backend' ? ', web-quality' : ''}) for \`${DIFF}\` (${RANGE}).\n\n` +
  JSON.stringify(results) +
  `\n\nDedupe across lanes (same issue found by multiple = higher confidence). Then issue a GO/NO-GO:\n` +
  `- NO-GO if any CRITICAL, or any tenant-isolation/security HIGH, or a correctness HIGH that breaks the feature.\n` +
  `- GO-WITH-FIXES if only medium/low.\n` +
  `Output: (1) the verdict (GO / GO-WITH-FIXES / NO-GO); (2) the MUST-FIX-BEFORE-CHECKPOINT list (critical+high, deduped, each with file:line + the fix); (3) the should-fix (medium) + nice (low) lists; (4) which findings the codex cross-model lane caught that the same-model lanes missed (the value of cross-model). Concise + decisive — this gates the ultragoal checkpoint.`,
  { label: 'verdict', phase: 'Synthesize', effort: 'high' },
)
return { range: RANGE, kind: KIND, critical: crit, high, total: all.length, verdict }
