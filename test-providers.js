'use strict';
// Jaribio la NextSMS + DaliPay kwa seva bandia za ndani: node test-providers.js
const { spawn } = require('node:child_process'); const http = require('node:http'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert/strict');
const PORT = 3700 + Math.floor(Math.random() * 200), FAKE = PORT + 300, BASE = `http://127.0.0.1:${PORT}`;
const seen = { sms: [], dali: [], aliStatus: 'processing' };
const fake = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
    s.setHeader('Content-Type', 'application/json');
    if (q.url === '/sms') { seen.sms.push({ auth: q.headers.authorization, body: JSON.parse(b) }); return s.end(JSON.stringify({ messages: [{ to: '255', status: { groupId: 1, groupName: 'PENDING' }, messageId: 1 }] })); }
    if (q.method === 'POST' && q.url === '/api/v1/collections') { seen.dali.push({ pk: q.headers['x-public-key'], sk: q.headers['x-secret-key'], body: JSON.parse(b) }); return s.end(JSON.stringify({ uuid: 'u-1', reference: 'R1', status: 'processing' })); }
    if (q.method === 'GET' && q.url === '/api/v1/collections/u-1') return s.end(JSON.stringify({ uuid: 'u-1', status: seen.aliStatus }));
    s.statusCode = 404; s.end('{}');
  });
}).listen(FAKE);
const srv = spawn('node', [process.env.SERVER_FILE || 'server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: path.join(os.tmpdir(), 'tp-' + Date.now() + '.json'), GATEWAY: 'dalipay', SMS_PROVIDER: 'nextsms',
  NEXTSMS_USERNAME: 'user1', NEXTSMS_PASSWORD: 'pw1', NEXTSMS_SENDER: 'SKULI', NEXTSMS_URL: `http://127.0.0.1:${FAKE}/sms`, DALIPAY_PUBLIC_KEY: 'gw_pk_test_x', DALIPAY_SECRET_KEY: 'gw_sk_test_y', DALIPAY_BASE: `http://127.0.0.1:${FAKE}/api/v1/`, ADMIN_KEY: 'test-admin-key-123456', OTP_COOLDOWN_MS: '0', OTP_IP_PER_HOUR: '500', OTP_IP_PER_DAY: '5000', REG_PER_HOUR: '500', SESSION_SECRET: 'x'.repeat(40) } });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
const call = async (m, u, b, t) => { const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let n = 0; const ok = (t) => { n++; console.log('  ✓ ' + t); };
// Inaomba OTP kwa endpoint, kisha inasoma msimbo kutoka kwenye ujumbe uliofika kwa seva bandia ya NextSMS
async function otp(path, body, token) {
  const n = seen.sms.length; const r = await call('POST', path, body, token); assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 40 && seen.sms.length === n; i++) await sleep(25);
  assert.equal(seen.sms.length, n + 1); const m = /ni (\d{6})\./.exec(seen.sms[n].body.text); assert.ok(m); return { code: m[1], to: seen.sms[n].body.to, shown: r.data.phone };
}
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); } }
  let o = await otp('/api/otp/register', { phone: '0712000001' }); assert.equal(o.to, '255712000001'); assert.equal(o.shown, '0712000001'); ok('OTP ya usajili inatumwa kwa NextSMS mara moja kwenda namba sahihi; jibu linaonyesha namba');
  let r = await call('POST', '/api/register/school', { school: 'Shule Dali', name: 'Mkuu', phone: '0712000001', password: 'secret123', otp: o.code }); const S = r.data.token;
  for (let i = 0; i < 40 && seen.sms.length < 2; i++) await sleep(25);
  assert.match(seen.sms[1].body.text, /^Hongera mwalimu!.*SCHOOL LUBA TECH.*35%.*shilingi elfu moja kwa mwezi\. Ubarikiwe mwalimu kwa ushirikiano wako\.$/); assert.equal(seen.sms[1].body.to, '255712000001'); ok('SMS ya kukaribisha shule inafika baada ya usajili');
  r = await call('POST', '/api/school/classes', { name: 'Darasa 1' }, S); const C = r.data.id;
  r = await call('POST', '/api/school/students', { classId: C, studentNo: 'D1', name: 'Mtoto D', dobDay: '10/05', dobYear: '2018' }, S); assert.equal(r.status, 200);
  o = await otp('/api/otp/register', { phone: '0655000001' });
  r = await call('POST', '/api/register/parent', { name: 'Mzazi D', phone: '0655000001', password: 'parent123', school: 'Shule Dali', studentNo: 'D1', dobDay: '10/05', dobYear: '2018', otp: o.code }); const P = r.data.token; assert.equal(r.status, 200);
  assert.equal(seen.sms.length, 3); assert.equal(seen.sms[2].auth, 'Basic ' + Buffer.from('user1:pw1').toString('base64')); assert.equal(seen.sms[2].body.from, 'SKULI'); assert.equal(seen.sms[2].body.to, '255655000001'); assert.ok(seen.sms[2].body.text.length > 5);
  ok('NextSMS: ombi lina Basic auth, from, to (255...) na text sahihi');
  r = await call('POST', '/api/pay/initiate', {}, P); assert.equal(r.status, 200); const pid = r.data.paymentId; assert.equal(r.data.mock, false);
  assert.equal(seen.dali[0].pk, 'gw_pk_test_x'); assert.equal(seen.dali[0].body.account_number, '0655000001'); assert.equal(seen.dali[0].body.amount, 1000); assert.ok(seen.dali[0].body.external_id.length <= 30);
  ok('DaliPay: ombi la collection lina namba, kiasi 1000 na external_id (<=30)');
  assert.equal((await call('GET', '/api/pay/status/' + pid, undefined, P)).data.status, 'pending'); ok('inasubiri DaliPay ikisema "processing"');
  assert.equal((await call('POST', '/api/pay/mock-confirm/' + pid, {}, P)).status, 404); ok('mock-confirm imezimwa kwenye gateway halisi');
  const wh = await call('POST', '/api/webhook/dalipay', { event: 'collection.success', data: { external_id: seen.dali[0].body.external_id } }); assert.equal(wh.status, 200);
  assert.equal((await call('GET', '/api/pay/status/' + pid, undefined, P)).data.status, 'pending'); ok('webhook ya uongo (DaliPay bado "processing") haithibitishi malipo');
  seen.aliStatus = 'success'; await sleep(3100);
  await call('POST', '/api/webhook/dalipay', { event: 'collection.success', data: { external_id: seen.dali[0].body.external_id } });
  assert.equal((await call('GET', '/api/pay/status/' + pid, undefined, P)).data.status, 'paid'); ok('DaliPay ikisema "success" malipo yanathibitishwa');
  await call('GET', '/api/pay/status/' + pid, undefined, P); r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.balance, 350); ok('shule inapata 35% (TSh 350) mara moja tu');
  assert.ok(!log.includes('gw_sk_test_y') && !log.includes('pw1')); ok('funguo za siri hazionekani kwenye logi');
  // namba ya kupokea malipo, namba ya mzazi, kikomo cha SMS kwa namba moja
  o = await otp('/api/otp/change', { phone: '0744111222', purpose: 'payout' }, S); assert.equal(o.to, '255744111222');
  assert.equal((await call('POST', '/api/school/payout-phone', { phone: '0744111222', password: 'wrong-pass1', otp: o.code }, S)).status, 400);
  assert.equal((await call('POST', '/api/school/payout-phone', { phone: '0744111222', password: 'secret123' }, S)).status, 400); ok('namba ya malipo haibadiliki bila OTP');
  assert.equal((await call('POST', '/api/school/payout-phone', { phone: '0744111222', password: 'secret123', otp: o.code }, S)).status, 200);
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.payoutPhone, '0744111222'); ok('shule inabadilisha namba ya kupokea malipo (inahitaji nenosiri)');
  r = await call('POST', '/api/school/withdraw', {}, S); assert.equal(r.status, 400); // salio 350 < 3,500
  assert.equal((await call('POST', '/api/otp/change', { phone: '0712000001', purpose: 'phone' }, P)).status, 400); ok('mzazi hawezi kuomba OTP kwa namba ya mtu mwingine');
  o = await otp('/api/otp/change', { phone: '0655999888', purpose: 'phone' }, P);
  assert.equal((await call('POST', '/api/parent/phone', { phone: '0655999888', password: 'wrong-pass1', otp: o.code }, P)).status, 400);
  assert.equal((await call('POST', '/api/parent/phone', { phone: '0655999888', password: 'parent123', otp: '000000' }, P)).status, 400); ok('namba ya mzazi haibadiliki kwa OTP isiyo sahihi');
  assert.equal((await call('POST', '/api/parent/phone', { phone: '0655999888', password: 'parent123', otp: o.code }, P)).status, 200);
  assert.equal((await call('POST', '/api/school/phone', { phone: '0712555666', password: 'secret123', otp: o.code }, S)).status, 400); ok('OTP ya mtu mmoja au namba nyingine haitumiki kwingine');
  o = await otp('/api/otp/change', { phone: '0712555666', purpose: 'phone' }, S);
  assert.equal((await call('POST', '/api/school/phone', { phone: '0712555666', password: 'secret123', otp: o.code }, S)).status, 200);
  assert.equal((await call('POST', '/api/login', { phone: '0712555666', password: 'secret123' })).status, 200); ok('mkuu wa shule anabadilisha namba ya kuingia kwa OTP + nenosiri');
  o = await otp('/api/otp/send', { phone: '0655999888' }); ok('OTP ya kusahau nenosiri inatumwa kwa namba iliyosajiliwa');
  assert.equal((await call('POST', '/api/login', { phone: '0655999888', password: 'parent123' })).status, 200); ok('mzazi anabadilisha namba ya kuingia na kuingia kwa namba mpya');
  r = await call('GET', '/api/school/parents', undefined, S); assert.equal(r.status, 200); assert.ok(r.data.some((x) => x.name === 'Mzazi D')); const pid1 = r.data.find((x) => x.name === 'Mzazi D').id;
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Mkutano Ijumaa' }, S); assert.equal(r.status, 200); assert.equal(r.data.total, 1); assert.equal(r.data.sent, 1); assert.equal(r.data.broadcasts.weekLeft, 1); ok('ujumbe kwa wazazi wote unarudisha ripoti (jumla, zilizotumwa) papo hapo');
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Kumbusho' }, S); assert.equal(r.data.sent, 1);
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Wa tatu' }, S); assert.equal(r.status, 400); assert.match(r.data.error, /2 kwa wiki/); ok('ujumbe kwa wazazi wote unazuiwa baada ya mara 2 kwa wiki');
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.broadcasts.weekLeft, 0);
  let sent = []; for (let i = 0; i < 2; i++) { r = await call('POST', '/api/school/sms', { target: 'parent:' + pid1, message: 'Binafsi ' + i }, S); sent.push(r.data.sent); }
  assert.deepEqual(sent, [1, 0]); ok('mzazi mmoja anaweza kutumiwa ujumbe hata ukomo wa wiki ukiisha; namba moja ina ukomo wa SMS 3 kwa saa 24');
  assert.equal((await call('POST', '/api/school/sms', { target: 'parent:haipo', message: 'x y' }, S)).status, 400); ok('mzazi asiye wa shule hii anakataliwa');
  seen.dali.length = 0; r = await call('POST', '/api/school/students', { classId: C, studentNo: 'D2', name: 'Mtoto D2', dobDay: '11/05', dobYear: '2018' }, S);
  o = await otp('/api/otp/register', { phone: '0655000002' });
  r = await call('POST', '/api/register/parent', { name: 'Mzazi D2', phone: '0655000002', password: 'parent123', school: 'Shule Dali', studentNo: 'D2', dobDay: '11/05', dobYear: '2018', otp: o.code }); const P2 = r.data.token;
  await call('POST', '/api/pay/initiate', { phone: '0688777666' }, P2); assert.equal(seen.dali[0].body.account_number, '0688777666'); ok('mzazi anaweza kulipia kwa namba tofauti bila OTP (PIN ya mwenye namba ndiyo ulinzi)');
  r = await call('GET', '/api/admin/overview', undefined, null); assert.equal(r.status, 401);
  console.log(`\nMajaribio ya watoa huduma ${n} yamepita ✅`); srv.kill(); fake.close(); process.exit(0);
})().catch((e) => { console.error('❌ IMESHINDWA:', e.stack, '\n', log.slice(-600)); srv.kill(); process.exit(1); });
