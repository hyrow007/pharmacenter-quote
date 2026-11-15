// Run: node --experimental-strip-types src/app/api/ringcentral/sms/relay-core.test.mjs
import { verifyNotification, shouldForward, fireBody, fireHeaders } from './relay-core.ts';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS' : '**FAIL**').padEnd(10), n); };
const env = { RINGCENTRAL_VERIFICATION_TOKEN: 's3cret-token' };

// 1. verification
ok('match accepted', verifyNotification('s3cret-token', env).ok === true);
ok('mismatch is 401', verifyNotification('s3cret-tokeX', env).status === 401);
ok('wrong length is 401', verifyNotification('short', env).status === 401);
ok('missing header is 401', verifyNotification(null, env).status === 401);
ok('unset env is 500, not open', verifyNotification('anything', {}).status === 500);
ok('empty env is 500, not open', verifyNotification('', { RINGCENTRAL_VERIFICATION_TOKEN: '' }).status === 500);

// 2. filtering
const ev = (body, event = '/restapi/v1.0/account/1/extension/2/message-store/instant?type=SMS') =>
  ({ uuid: 'u1', event, body });
ok('inbound SMS forwarded', shouldForward(ev({ id: 9, type: 'SMS', direction: 'Inbound' })).forward === true);
ok('outbound SMS skipped (Olivia texting out)', shouldForward(ev({ id: 9, type: 'SMS', direction: 'Outbound' })).forward === false);
ok('voicemail skipped', shouldForward(ev({ id: 9, type: 'VoiceMail', direction: 'Inbound' })).forward === false);
ok('non-message event skipped', shouldForward(ev({}, '/restapi/v1.0/account/1/extension/2/presence')).forward === false);
ok('no body skipped', shouldForward({ event: '/message-store/instant' }).forward === false);
ok('garbage skipped', shouldForward(null).forward === false);

// 3. what Olivia receives
const mms = ev({ id: 77, type: 'SMS', direction: 'Inbound', subject: 'hola',
  from: { phoneNumber: '+13055550100' }, creationTime: '2026-11-15T17:00:00Z',
  attachments: [{ contentType: 'text/plain' }, { contentType: 'image/jpeg' }] });
const t = fireBody(mms).text;
ok('body is {text} only — /fire ignores other fields', Object.keys(fireBody(mms)).join() === 'text');
ok('text carries sender', t.includes('+13055550100'));
ok('text carries message', t.includes('Message: hola'));
ok('MMS counts non-text attachments only', t.includes('Attachments: 1'));
ok('raw event preserved unchanged', t.includes(JSON.stringify(mms)));
const h = fireHeaders('tok');
ok('all four /fire headers', h.Authorization === 'Bearer tok' && h['anthropic-version'] === '2023-06-01'
  && h['anthropic-beta'] === 'experimental-cc-routine-2026-04-01' && h['Content-Type'] === 'application/json');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
