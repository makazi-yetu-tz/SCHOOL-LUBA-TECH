'use strict';
// Jaribio la mwisho-hadi-mwisho: node test.js
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-webhook-secret';
const ADMIN = 'test-admin-key-123456';
const dataFile = path.join(os.tmpdir(), `tl-test-${Date.now()}.json`);
let log = '';

const srv = spawn('node', [process.env.SERVER_FILE || 'server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT, DATA_FILE: dataFile, GATEWAY: 'mock', SMS_PROVIDER: 'console', WEBHOOK_SECRET: SECRET, ADMIN_KEY: ADMIN, SMS_QUOTA_DEFAULT: '6', VIDEO_URL: 'https://example.com/intro.mp4', REG_PER_HOUR: '500', OTP_IP_PER_HOUR: '2000', OTP_IP_PER_DAY: '5000', OTP_COOLDOWN_MS: '0', BROADCASTS_PER_WEEK: '100', BROADCASTS_PER_MONTH: '100', SMS_PER_PHONE_DAY: '50', ALLOW_MOCK: '1', NODE_ENV: 'test' },
});
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));

const lastOtp = () => { const m = [...log.matchAll(/namba yako ya uthibitisho ni (\d{6})/g)]; return m.length ? m[m.length - 1][1] : null; };
async function call(method, url, body, token, headers = {}) {
  if (/^\/api\/register\/(school|parent)$/.test(url) && body && typeof body === 'object' && body.otp === undefined && !body.noOtp) {
    const rr = await fetch(BASE + '/api/otp/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: body.phone }) });
    if (rr.status === 200) { await sleep(5); body = { ...body, otp: lastOtp() }; }
  }
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: raw });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const smsCount = () => (log.match(/\[SMS:console\]/g) || []).length;
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); } }

  const page = await fetch(BASE + '/');
  assert.equal(page.status, 200); assert.match(await page.text(), /Jisajili kama Mkuu wa Shule/); ok('ukurasa wa mbele unatolewa');
  const pg2 = await fetch(BASE + '/'); const html2 = await pg2.text();
  assert.match(pg2.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(pg2.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(html2.includes('const VIDEO_SRC = "https://example.com/intro.mp4";')); assert.ok(html2.includes('"Change Language": "Badili Lugha"')); assert.ok(!html2.includes('/*__EN__*/'));
  ok('headers za usalama, kiungo cha video na kamusi ya lugha vipo kwenye ukurasa');
  assert.notEqual((await fetch(BASE + '/..%2fserver.js')).status, 200); ok('path traversal imezuiwa');

  let r;
  // --- OTP ya usajili
  r = await call('POST', '/api/register/school', { school: 'Shule Bila Otp', name: 'Mkuu', phone: '0713888001', password: 'secret123', noOtp: true, otp: '' }); assert.equal(r.status, 400); ok('usajili wa shule bila OTP unakataliwa');
  r = await call('POST', '/api/otp/register', { phone: '0713888001' }); assert.equal(r.status, 200); assert.equal(r.data.phone, '0713888001'); ok('OTP inatumwa na mfumo unarudisha namba iliyotumiwa');
  const goodOtp = lastOtp(); assert.match(goodOtp, /^\d{6}$/);
  r = await call('POST', '/api/register/school', { school: 'Shule Bila Otp', name: 'Mkuu', phone: '0713888001', password: 'secret123', otp: goodOtp === '000000' ? '111111' : '000000' }); assert.equal(r.status, 400); ok('OTP isiyo sahihi inakataliwa');
  r = await call('POST', '/api/register/school', { school: 'Shule Bila Otp', name: 'Mkuu', phone: '0713888002', password: 'secret123', otp: goodOtp }); assert.equal(r.status, 400); ok('OTP ya namba nyingine haitumiki kwa namba hii');
  let wlog = log.length; r = await call('POST', '/api/register/school', { school: 'Shule Bila Otp', name: 'Mkuu', phone: '0713888001', password: 'secret123', otp: goodOtp }); assert.equal(r.status, 200); await sleep(30);
  assert.match(log.slice(wlog), /Hongera mwalimu! Umefanikiwa kuunganisha shule yako na mfumo wa SCHOOL LUBA TECH[\s\S]*kamisheni ya 35%[\s\S]*Ubarikiwe mwalimu kwa ushirikiano wako/); ok('shule mpya inapokea SMS ya hongera');
  r = await call('POST', '/api/register/school', { school: 'Shule Bila Otp 2', name: 'Mkuu', phone: '0713888001', password: 'secret123', otp: goodOtp }); assert.equal(r.status, 400); ok('OTP inatumika mara moja tu');
  assert.equal((await call('POST', '/api/otp/register', { phone: '0713888001' })).status, 400); ok('OTP ya usajili haitumwi kwa namba iliyosajiliwa tayari');
  // --- shule
  r = await call('POST', '/api/register/school', { school: 'Shule ya Msingi Uhuru', name: 'Mkuu', phone: '0712345678', password: '123' });
  assert.equal(r.status, 400); ok('nenosiri fupi linakataliwa');
  r = await call('POST', '/api/register/school', { school: 'Shule Fupi', name: 'Mkuu', phone: '0714000000', password: '1234567' });
  assert.equal(r.status, 400); ok('nenosiri la herufi 7 linakataliwa (kima cha chini ni 8)');
  let race = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/api/register/school', { school: 'Race Phone ' + i, name: 'Racer', phone: '0713999999', password: 'secret123' })));
  assert.equal(race.filter((x) => x.status === 200).length, 1); ok('usajili 6 wa wakati mmoja wa namba ileile: mmoja tu unapita');
  race = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/api/register/school', { school: 'Race Name', name: 'Racer', phone: '07139999' + (10 + i), password: 'secret123' })));
  assert.equal(race.filter((x) => x.status === 200).length, 1); ok('usajili 6 wa wakati mmoja wa jina la shule lilelile: mmoja tu unapita');
  r = await call('POST', '/api/register/school', { school: 'Shule ya Msingi Uhuru', type: 'msingi', name: 'Juma Hamisi', phone: '0712345678', password: 'secret123' });
  assert.equal(r.status, 200); assert.equal(r.data.role, 'school'); const S = r.data.token; ok('shule inajisajili');
  r = await call('POST', '/api/register/school', { school: 'SHULE ya msingi uhuru!', name: 'Mwingine', phone: '0713000000', password: 'secret123' });
  assert.equal(r.status, 400); ok('jina la shule linalofanana linakataliwa');
  r = await call('POST', '/api/register/school', { school: 'Nyingine', name: 'X Y', phone: '+255712345678', password: 'secret123' });
  assert.equal(r.status, 400); ok('namba iliyosajiliwa inakataliwa (hata +255)');
  r = await call('POST', '/api/register/school', { school: 'Shule B Dodoma', name: 'Bi B', phone: '0713111111', password: 'secret123' });
  const S2 = r.data.token;

  // --- madarasa
  r = await call('POST', '/api/school/students', { classId: 'x', studentNo: '1', name: 'Hana Darasa', dobDay: '1/1', dobYear: '2018' }, S);
  assert.equal(r.status, 400); ok('mwanafunzi bila darasa anakataliwa');
  r = await call('POST', '/api/school/classes', { name: 'Darasa la 4' }, S); const C4 = r.data.id; assert.ok(C4); ok('shule inaongeza darasa');
  r = await call('POST', '/api/school/classes', { name: 'darasa la 4' }, S); assert.equal(r.status, 400); ok('darasa lililopo linakataliwa');
  r = await call('POST', '/api/school/classes', { name: 'Darasa la 4' }, S2); const C4b = r.data.id; assert.ok(C4b); ok('shule nyingine inaweza kutumia jina lilelile la darasa');

  // --- ratiba
  const tt = { classId: C4, day: 1, start: '08:00', end: '08:40', subject: 'Hisabati', teacher: 'Bi Neema' };
  r = await call('POST', '/api/school/timetable', tt, S); assert.equal(r.status, 200); ok('kipindi kinaongezwa kwenye ratiba');
  r = await call('POST', '/api/school/timetable', { ...tt, start: '08:30', end: '09:10', subject: 'Kiswahili' }, S);
  assert.equal(r.status, 400); ok('vipindi vinavyogongana vinakataliwa');
  r = await call('POST', '/api/school/timetable', { ...tt, start: '09:00', end: '08:00' }, S); assert.equal(r.status, 400); ok('muda usio sahihi unakataliwa');
  r = await call('POST', '/api/school/timetable', { ...tt, start: '08:40', end: '09:20', subject: 'Kiswahili' }, S); assert.equal(r.status, 200);
  r = await call('POST', '/api/school/timetable', { ...tt, classId: C4 }, S2); assert.equal(r.status, 400); ok('shule haiwezi kutumia darasa la shule nyingine');
  r = await call('GET', '/api/school/timetable/' + C4, undefined, S);
  assert.equal(r.data.length, 2); assert.equal(r.data[0].dayName, 'Jumatatu'); assert.equal(r.data[0].start, '08:00'); ok('ratiba inapangwa kwa siku na saa');
  r = await call('GET', '/api/school/timetable/' + C4, undefined, S2); assert.equal(r.status, 404); ok('shule nyingine haioni ratiba hii');

  // --- walimu
  r = await call('POST', '/api/school/staff', { name: 'Bi Neema', phone: '0788000111', subject: 'Hisabati' }, S); assert.equal(r.status, 200);
  r = await call('POST', '/api/school/staff', { name: 'Dup', phone: '0788000111' }, S); assert.equal(r.status, 400); ok('walimu wanaongezwa (majina + simu), namba mbili zinakataliwa');

  // --- wanafunzi
  r = await call('POST', '/api/school/students', { classId: C4, studentNo: '2024-042', name: 'Fatuma Juma', dobDay: '15/03', dobYear: '2018' }, S);
  assert.equal(r.status, 200); ok('shule inaongeza mwanafunzi kwenye darasa');
  r = await call('POST', '/api/school/students', { classId: C4, studentNo: '2024-042', name: 'Dup', dobDay: '1/1', dobYear: '2018' }, S);
  assert.equal(r.status, 400); ok('namba ya mwanafunzi mara mbili inakataliwa');

  // --- mzazi
  const parentBody = { name: 'Amina Hassan', phone: '0655111222', password: 'parent123', school: 'shule ya msingi UHURU', studentNo: '2024-042', dobDay: '15/03', dobYear: '2018' };
  assert.equal((await call('POST', '/api/register/parent', { ...parentBody, dobYear: '2017' })).status, 400); ok('tarehe ya kuzaliwa isiyolingana inakataliwa');
  assert.equal((await call('POST', '/api/register/parent', { ...parentBody, studentNo: '999' })).status, 400); ok('mwanafunzi asiyekuwepo anakataliwa');
  r = await call('POST', '/api/register/parent', parentBody); assert.equal(r.status, 200); const P = r.data.token; ok('mzazi anajisajili');
  assert.equal((await call('GET', '/api/school/me', undefined, P)).status, 403); ok('mzazi hawezi kufikia API ya shule');
  assert.equal((await call('GET', '/api/parent/me')).status, 401); ok('bila token inakataliwa');
  assert.equal((await call('GET', '/api/parent/me', undefined, P.slice(0, -2) + 'xx')).status, 401); ok('token ghushi inakataliwa');

  // --- matokeo + SMS otomatiki
  let before = smsCount();
  r = await call('POST', '/api/school/results', { studentNo: '2024-042', subject: 'Hisabati', score: 92 }, S);
  assert.equal(r.data.grade, 'A'); assert.equal(r.data.sms.sent, 1); await sleep(50);
  assert.equal(smsCount(), before + 1); assert.match(log, /Fatuma Juma - Hisabati: 92% \(A\)/); ok('matokeo yanahifadhiwa na SMS inakwenda kwa mzazi otomatiki');
  before = smsCount();
  r = await call('POST', '/api/school/results', { studentNo: '2024-042', subject: 'Sayansi', score: 85, notify: false }, S);
  assert.equal(smsCount(), before); ok('notify:false haitumi SMS');
  r = await call('GET', '/api/parent/me', undefined, P);
  assert.equal(r.data.results.length, 2); assert.equal(r.data.timetable.length, 2); assert.equal(r.data.timetable[0].subject, 'Hisabati');
  assert.equal(r.data.school.name, 'Shule ya Msingi Uhuru'); ok('mzazi anaona matokeo na ratiba ya darasa la mtoto');

  // --- SMS za shule + ukomo (ukomo wa jaribio = 6)
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.sms.used, 1); assert.equal(r.data.sms.left, 5); ok('SMS imehesabiwa kwenye ukomo wa shule');
  
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Mkutano wa wazazi Ijumaa' }, S);
  assert.equal(r.data.sent, 1); assert.equal(r.data.total, 1); ok('SMS kwa wazazi wote waliosajiliwa inatumwa na ripoti inarudi');
  r = await call('POST', '/api/school/sms', { target: 'class:' + C4, message: 'Kumbusho' }, S); assert.equal(r.data.sent, 1); ok('SMS kwa wazazi wa darasa moja inatumwa');
  r = await call('POST', '/api/school/sms', { target: 'class:' + C4b, message: 'Haihusu' }, S); assert.equal(r.status, 400); ok('darasa la shule nyingine linakataliwa');
  for (const tg of ['staff', 'everyone', '255712000000']) { r = await call('POST', '/api/school/sms', { target: tg, message: 'Jaribio' }, S); assert.equal(r.status, 400); }
  ok('SMS za kuandika mwenyewe hazitumwi kwa namba zisizothibitishwa (walimu/namba holela) — wazazi waliothibitishwa kwa OTP tu');
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Ujumbe wa tatu' }, S); assert.equal(r.data.sent, 1);
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Ujumbe wa nne' }, S); assert.equal(r.data.sent, 1);
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.sms.left, 1);
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'x'.repeat(200) }, S);
  assert.equal(r.status, 400); assert.match(r.data.error, /hazitoshi/); ok('ukomo ukiisha SMS kubwa inakataliwa kabla ya kutuma');
  before = smsCount();
  r = await call('POST', '/api/school/results', { studentNo: '2024-042', subject: 'Kiswahili', score: 70 }, S);
  assert.equal(r.status, 200); assert.equal(r.data.sms.sent, 1); // ilibaki 1
  r = await call('POST', '/api/school/results', { studentNo: '2024-042', subject: 'Kiingereza', score: 71 }, S);
  assert.equal(r.status, 200); assert.equal(r.data.sms.sent, 0); assert.equal(r.data.sms.skipped, 1); ok('ukomo umeisha: matokeo yanahifadhiwa lakini SMS inarukwa');

  // --- admin
  assert.equal((await call('GET', '/api/admin/overview', undefined, null, { 'x-admin-key': 'wrong' })).status, 401); ok('admin bila ufunguo sahihi inakataliwa');
  r = await call('GET', '/api/admin/overview', undefined, null, { 'x-admin-key': ADMIN });
  const sch = r.data.schools.find((x) => x.school === 'Shule ya Msingi Uhuru'); assert.equal(sch.sms.left, 0); const sch2 = r.data.schools.find((x) => x.school === 'Shule B Dodoma');
  assert.equal(typeof sch.paidStudents, 'number'); assert.equal(sch.collected, sch.commission / 0.35); ok('admin anaona wanafunzi waliolipa, makusanyo na 35% ya kila shule');
  r = await call('GET', '/api/admin/school/' + sch.id + '/students', undefined, null, { 'x-admin-key': ADMIN }); assert.equal(r.status, 200); assert.ok(r.data.length >= 1 && 'paid' in r.data[0]);
  assert.equal((await call('GET', '/api/admin/school/' + sch.id + '/students')).status, 401); assert.equal((await call('GET', '/api/admin/school/haipo/students', undefined, null, { 'x-admin-key': ADMIN })).status, 404); ok('orodha ya wanafunzi ya shule ni ya admin tu');
  r = await call('POST', '/api/admin/quota', { schoolId: sch.id, quota: 100 }, null, { 'x-admin-key': ADMIN }); assert.equal(r.status, 200);
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.sms.left, 94); ok('mmiliki anaongeza ukomo wa SMS wa shule');
  r = await call('GET', '/api/school/me', undefined, S2); assert.equal(r.data.sms.quota, 6); assert.equal(r.data.verified, undefined); ok('shule mpya inapata ukomo wa chaguo-msingi mara moja (hakuna uthibitisho)');
  r = await call('POST', '/api/school/sms', { target: 'parents', message: 'Jaribio' }, S2); assert.equal(r.status, 400); assert.match(r.data.error, /Hakuna wapokeaji/); ok('shule bila uthibitisho inaweza kutuma SMS (imefika hatua ya wapokeaji)');
  assert.equal((await call('POST', '/api/admin/withdrawals/reject', { id: 'haipo' }, null, { 'x-admin-key': ADMIN })).status, 400); ok('admin hawezi kukataa ombi lisilokuwepo');

  // --- malipo
  r = await call('POST', '/api/pay/initiate', {}, P); assert.equal(r.status, 200); const pid = r.data.paymentId; assert.equal(r.data.status, 'pending'); ok('malipo yanaanzishwa (pending)');
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.balance, 0); ok('kamisheni haijaongezeka kabla ya malipo kuthibitishwa');
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const ref = db.payments[0].ref;
  const wb = JSON.stringify({ reference: ref, status: 'SUCCESS', amount: 1000 });
  assert.equal((await call('POST', '/api/webhook/payment', wb, null, { 'x-signature': 'deadbeef' })).status, 401); ok('webhook yenye saini mbaya inakataliwa');
  const wrongAmt = JSON.stringify({ reference: ref, status: 'SUCCESS', amount: 1 });
  r = await call('POST', '/api/webhook/payment', wrongAmt, null, { 'x-signature': crypto.createHmac('sha256', SECRET).update(wrongAmt).digest('hex') });
  assert.equal(r.status, 400); ok('kiasi kisicholingana kinakataliwa');
  const sig = crypto.createHmac('sha256', SECRET).update(wb).digest('hex');
  assert.equal((await call('POST', '/api/webhook/payment', wb, null, { 'x-signature': sig })).status, 200);
  assert.equal((await call('POST', '/api/webhook/payment', wb, null, { 'x-signature': sig })).status, 200); // marudio
  r = await call('GET', '/api/pay/status/' + pid, undefined, P); assert.equal(r.data.status, 'paid'); ok('webhook halali inathibitisha malipo');
  r = await call('GET', '/api/school/me', undefined, S);
  assert.equal(r.data.balance, 350); assert.equal(r.data.paidParents, 1); ok('shule inapata 35% = TSh 350 (mara moja tu hata webhook ikirudiwa)');
  assert.equal((await call('POST', '/api/pay/initiate', {}, P)).status, 400); ok('hawezi kulipa tena akiwa amelipia');

  // --- kutoa pesa
  assert.equal((await call('POST', '/api/school/withdraw', {}, S)).status, 400); ok('kutoa chini ya TSh 3,500 kunakataliwa');
  const d2 = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(d2.payments[0].schoolId, sch.id); ok('kamisheni imerekodiwa kwa shule sahihi');

  // --- miamala kwa shule
  r = await call('GET', '/api/school/payments', undefined, S);
  assert.equal(r.data.count, 1); assert.equal(r.data.totalPaid, 1000); assert.equal(r.data.totalCommission, 350);
  assert.equal(r.data.payments[0].parent, 'Amina Hassan'); assert.equal(r.data.payments[0].student, 'Fatuma Juma'); assert.equal(r.data.payments[0].status, 'paid'); ok('shule inaona miamala ya wazazi wake (jumla na kamisheni)');
  r = await call('GET', '/api/school/payments', undefined, S2); assert.equal(r.data.payments.length, 0); ok('shule nyingine haioni miamala hii');
  assert.equal((await call('GET', '/api/school/payments', undefined, P)).status, 403); ok('mzazi hawezi kuona miamala ya shule');

  // --- picha
  const png = (n = 200) => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n)]).toString('base64');
  r = await call('GET', '/api/school/students', undefined, S); const st1 = r.data.find((x) => x.studentNo === '2024-042'); assert.equal(st1.hasPhoto, false);
  r = await call('POST', '/api/school/students/photo', { id: st1.id, image: png() }, S); assert.equal(r.status, 200); ok('shule inapakia picha ya mwanafunzi');
  const getPhoto = (id, tok) => fetch(BASE + '/api/photo/' + id, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
  let ph = await getPhoto(st1.id, S); assert.equal(ph.status, 200); assert.equal(ph.headers.get('content-type'), 'image/png'); assert.equal((await ph.arrayBuffer()).byteLength, 208); ok('shule inapata picha yenyewe (bytes zilezile)');
  ph = await getPhoto(st1.id, P); assert.equal(ph.status, 200); ok('mzazi wa mwanafunzi huyo anaona picha');
  ph = await getPhoto(st1.id, S2); assert.equal(ph.status, 404); ok('shule nyingine haioni picha');
  ph = await getPhoto(st1.id); assert.equal(ph.status, 401); ok('bila kuingia picha haipatikani');
  r = await call('POST', '/api/school/students/photo', { id: st1.id, image: png() }, S2); assert.equal(r.status, 400); ok('shule nyingine haiwezi kubadilisha picha');
  r = await call('POST', '/api/school/students/photo', { id: st1.id, image: 'data:image/png;base64,' + Buffer.from('<svg><script>alert(1)</script></svg>'.repeat(10)).toString('base64') }, S);
  assert.equal(r.status, 400); ok('faili lisilo picha (hata likidai PNG) linakataliwa');
  r = await call('POST', '/api/school/students/photo', { id: st1.id, image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, S); assert.equal(r.status, 400); ok('SVG inakataliwa');
  r = await call('POST', '/api/school/students/photo', { id: st1.id, image: png(450e3) }, S); assert.equal(r.status, 400); ok('picha kubwa kuliko 400KB inakataliwa');
  r = await call('POST', '/api/parent/photo', { image: png(300) }, P); assert.equal(r.status, 200);
  r = await call('GET', '/api/parent/me', undefined, P); assert.equal(r.data.student.hasPhoto, true); assert.equal(r.data.student.id, st1.id);
  ph = await getPhoto(st1.id, P); assert.equal((await ph.arrayBuffer()).byteLength, 308); ok('mzazi anabadilisha picha ya mtoto wake (inachukua nafasi ya ya zamani)');

  // mwanafunzi wa pili + mzazi wa pili: hawezi kuona picha ya mtoto wa mwingine
  r = await call('POST', '/api/school/students', { classId: C4, studentNo: '2024-050', name: 'Hamisi Ali', dobDay: '02/05', dobYear: '2017', parentPhone: '0677000222' }, S); assert.equal(r.status, 200);
  r = await call('POST', '/api/register/parent', { name: 'Baba Hamisi', phone: '0677000222', password: 'parent234', school: 'Shule ya Msingi Uhuru', studentNo: '2024-050', dobDay: '02/05', dobYear: '2017' }); const P2 = r.data.token;
  ph = await getPhoto(st1.id, P2); assert.equal(ph.status, 404); ok('mzazi hawezi kuona picha ya mtoto wa mzazi mwingine');
  r = await call('POST', '/api/school/students', { classId: C4, studentNo: '9', name: 'X Y', dobDay: '1/1', dobYear: '2018', parentPhone: '123' }, S); assert.equal(r.status, 400); ok('simu ya mzazi isiyo sahihi inakataliwa');

  // --- mwaliko wa SMS
  r = await call('POST', '/api/school/students', { classId: C4, studentNo: '2024-060', name: 'Zawadi Omari', dobDay: '09/09', dobYear: '2016', parentPhone: '0766000111' }, S); assert.equal(r.status, 200);
  before = smsCount();
  r = await call('POST', '/api/school/invite', {}, S);
  assert.equal(r.data.sent, 1); assert.equal(r.data.total, 1); await sleep(50);
  assert.equal(smsCount(), before + 1); assert.match(log, /255766000111: .*Mzazi wa Zawadi Omari, jisajili http:\/\/localhost:\d+ kwa namba ya mwanafunzi 2024-060/); ok('mwaliko wa SMS unatumwa kwa mzazi ambaye hajajisajili tu (wa pili amesajiliwa, hakualikwa)');
  r = await call('POST', '/api/school/invite', {}, S); assert.equal(r.status, 400); ok('mwaliko hautumwi tena ndani ya saa 24');
  r = await call('POST', '/api/school/invite', {}, S2); assert.equal(r.status, 400); ok('shule nyingine haina wa kualika (haioni wanafunzi wa shule hii)');
  r = await call('POST', '/api/school/students', { classId: C4b, studentNo: 'S2-1', name: 'Mtoto S2', dobDay: '01/01', dobYear: '2018', parentPhone: '0766000111' }, S2); assert.equal(r.status, 200);
  r = await call('POST', '/api/school/invite', {}, S2); assert.equal(r.status, 200); assert.equal(r.data.sent, 0); assert.equal(r.data.recent, 1);
  ok('namba iliyoalikwa na shule moja haialikwi na shule nyingine ndani ya siku 7 (kuzuia SMS za kuhadaa)');
  r = await call('GET', '/api/school/students', undefined, S); assert.equal(r.data.find((x) => x.studentNo === '2024-060').invited, true);
  r = await call('GET', '/api/school/me', undefined, S); const usedMark = r.data.sms.used;

  // --- login + OTP
  assert.equal((await call('POST', '/api/login', { phone: '0655111222', password: 'wrong' })).status, 401);
  r = await call('POST', '/api/login', { phone: '0712345678', password: 'secret123' }); assert.equal(r.status, 200); assert.equal(r.data.role, 'school'); ok('shule inaingia; nenosiri baya linakataliwa');
  r = await call('POST', '/api/otp/send', { phone: '0655111222' }); assert.equal(r.status, 200); await sleep(150);
  const code = [...log.matchAll(/namba yako ya uthibitisho ni (\d{6})/g)].pop()[1];
  r = await call('POST', '/api/otp/reset', { phone: '0655111222', otp: code === '000000' ? '111111' : '000000', password: 'newpass12' }); assert.equal(r.status, 400); ok('OTP mbaya inakataliwa');
  r = await call('POST', '/api/otp/reset', { phone: '0655111222', otp: code, password: 'newpass12' }); assert.equal(r.status, 200); ok('OTP sahihi inabadilisha nenosiri');
  assert.equal((await call('GET', '/api/parent/me', undefined, P)).status, 401); ok('tokeni ya zamani inakufa nenosiri likibadilishwa');
  assert.equal((await call('POST', '/api/otp/reset', { phone: '0655111222', otp: code, password: 'again123' })).status, 400); ok('OTP haitumiki mara ya pili');
  assert.equal((await call('POST', '/api/login', { phone: '0655111222', password: 'newpass12' })).status, 200);
  assert.equal((await call('POST', '/api/otp/send', { phone: '0799999999' })).status, 200); ok('OTP kwa namba isiyosajiliwa: jibu lilelile');
  r = await call('GET', '/api/school/me', undefined, S); assert.equal(r.data.sms.used, usedMark); ok('OTP haikatwi kwenye ukomo wa SMS wa shule');
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(dataFile, 'utf8')).sms).includes(code), false); ok('OTP haihifadhiwi wazi kwenye hifadhidata');

  const guess = [];
  for (let i = 0; i < 10; i++) guess.push((await call('POST', '/api/register/parent', { name: 'Mgeni Mbaya', phone: '07880000' + (10 + i), password: 'secret123', school: 'Shule ya Msingi Uhuru', studentNo: '2024-042', dobDay: '0' + (1 + (i % 9)) + '/01', dobYear: '2018' })).status);
  assert.ok(guess.includes(429), 'kubashiri tarehe lazima kuzuiwe: ' + guess.join(',')); ok('kubashiri tarehe ya kuzaliwa ya mwanafunzi kunazuiwa baada ya makosa 8');

  // --- ulinzi wa ziada
  for (const bad of ['Shule www.bet.com', 'Shule http://x.co', 'Shule bet@gmail', 'Shule 0712345678901']) {
    r = await call('POST', '/api/register/school', { school: bad, name: 'Mkuu', phone: '0715000001', password: 'secret123', noOtp: true }); assert.equal(r.status, 400); assert.match(r.data.error, /kiungo/);
  }
  r = await call('POST', '/api/register/school', { school: 'Shule Nzuri', name: 'Mkuu', phone: '0715000001', password: 'secret123', noOtp: true }); assert.match(r.data.error, /OTP/); ok('majina yenye kiungo/barua pepe/namba ndefu yanakataliwa (kuzuia SMS za kuhadaa); jina la kawaida linapita');
  const wrong = (otp) => call('POST', '/api/register/school', { school: 'Shule Lock', name: 'Mkuu', phone: '0715000077', password: 'secret123', otp });
  let seenLock = false;
  for (let round = 0; round < 3; round++) {
    r = await call('POST', '/api/otp/register', { phone: '0715000077' });
    if (r.status === 429) { seenLock = true; break; }
    for (let i = 0; i < 6; i++) await wrong('000000');
  }
  assert.ok(seenLock); ok('makosa 10 ya OTP kwa namba moja yanafunga kwa saa 1 hata OTP mpya ikiombwa (kuzuia kubashiri)');

  console.log(`\nMajaribio yote ${passed} yamepita ✅`);
})().catch((e) => { console.error('\n❌ IMESHINDWA:', e.message, '\n', e.stack); process.exitCode = 1; })
  .finally(() => { srv.kill(); });
