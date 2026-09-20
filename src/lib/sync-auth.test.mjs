// Tests for the per-scope bearer auth that replaced five inline copies of
// the same check (finding H4 — one token guarded five endpoints, four of
// them writes).
//
// The case that matters most is in section 4: a token leaked from one scope
// must be useless on every other scope. That is the whole point of the split,
// and it is the one thing a code review cannot confirm by reading.
//
// Run: node --experimental-strip-types src/lib/sync-auth.test.mjs
import { evaluateSyncAuth } from './sync-auth-core.ts';

let pass = 0, fail = 0;
const ok = (n, cond) => {
  if (cond) { pass++; console.log('PASS'.padEnd(10), n); }
  else { fail++; console.log('**FAIL**'.padEnd(10), n); }
};

// The header value a caller would send, or null for no Authorization at all.
const req = (token) => (token === undefined ? null : `Bearer ${token}`);

const ALL_ENV = [
  'PLAUD_SYNC_SECRET', 'CRON_SECRET', 'MONDAY_SYNC_SECRET',
  'PLAUD_WEBHOOK_SECRET', 'SO_SYNTHESIS_SECRET', 'MEETING_TRANSLATIONS_SECRET',
];
const clearEnv = () => { for (const k of ALL_ENV) delete process.env[k]; };

// The HTTP status the route would send. 200 means authorized, i.e. the
// handler gets to run.
const status = (authz, scope) => {
  const r = evaluateSyncAuth(authz, scope);
  return r.ok ? 200 : r.status;
};

// --- 1. nothing configured is a server fault, not a caller fault ----------
clearEnv();
ok('no secrets at all -> 500, not 401', status(req('anything'), 'monday') === 500);

// --- 2. legacy state: the shared token still opens everything -------------
clearEnv(); process.env.PLAUD_SYNC_SECRET = 'shared-abc';
for (const s of ['monday', 'plaud-webhook', 'so-synthesis', 'so-synthesis-inputs', 'meeting-translations']) {
  ok(`${s} accepts shared`, status(req('shared-abc'), s) === 200);
}
ok('wrong token rejected', status(req('nope'), 'monday') === 401);
ok('no bearer header rejected', status(req(), 'monday') === 401);

// --- 3. migration window: dedicated and shared both work ------------------
clearEnv();
process.env.PLAUD_SYNC_SECRET = 'shared-abc';
process.env.MONDAY_SYNC_SECRET = 'monday-xyz';
ok('dedicated accepted', status(req('monday-xyz'), 'monday') === 200);
ok('shared still accepted (caller not moved yet)', status(req('shared-abc'), 'monday') === 200);
ok('monday secret does NOT unlock plaud-webhook', status(req('monday-xyz'), 'plaud-webhook') === 401);

// --- 4. end state: shared deleted, blast radius contained -----------------
clearEnv();
process.env.MONDAY_SYNC_SECRET = 'monday-xyz';
process.env.PLAUD_WEBHOOK_SECRET = 'plaud-123';
ok('monday ok with its own', status(req('monday-xyz'), 'monday') === 200);
ok('plaud ok with its own', status(req('plaud-123'), 'plaud-webhook') === 200);
ok('LEAKED monday token useless on plaud', status(req('monday-xyz'), 'plaud-webhook') === 401);
ok('scope with no secret configured -> 500', status(req('x'), 'so-synthesis') === 500);

// --- 5. CRON_SECRET is only for scopes Vercel Cron actually invokes -------
clearEnv(); process.env.CRON_SECRET = 'cron-999';
ok('monday accepts CRON_SECRET', status(req('cron-999'), 'monday') === 200);
ok('plaud-webhook never accepts CRON_SECRET', status(req('cron-999'), 'plaud-webhook') === 500);

// --- 6. so-synthesis read and write deliberately share one secret ---------
clearEnv(); process.env.SO_SYNTHESIS_SECRET = 'syn-777';
ok('so-synthesis write side', status(req('syn-777'), 'so-synthesis') === 200);
ok('so-synthesis read side', status(req('syn-777'), 'so-synthesis-inputs') === 200);

// --- 7. edges the old `!==` check also handled, kept so the constant-time
//        compare cannot regress them -------------------------------------
clearEnv(); process.env.PLAUD_SYNC_SECRET = 'shared-abc';
ok('prefix of real token rejected', status(req('shared-ab'), 'monday') === 401);
ok('superstring of real token rejected', status(req('shared-abcd'), 'monday') === 401);
ok('empty bearer rejected', status(req(''), 'monday') === 401);
clearEnv(); process.env.PLAUD_SYNC_SECRET = '';
ok('empty-string secret counts as unset -> 500', status(req(''), 'monday') === 500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
