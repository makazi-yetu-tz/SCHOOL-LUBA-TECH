'use strict';
// Majaribio ya ziada: node test-extra.js  (video/wimbo wa admin, aina ya shule, kufuta akaunti zisizotumika)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const ADMIN = 'test-admin-key-123456';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0; const ok = (n) => { passed++; console.log('  ✓ ' + n); };

function start(dataFile, extra = {}) {
  const PORT = 3700 + Math.floor(Math.random() * 300);
  const p = spawn('node', [process.env.SERVER_FILE || 'server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: dataFile, GATEWAY: 'mock', SMS_PROVIDER: 'console', ALLOW_MOCK: '1', ADMIN_KEY: ADMIN, OTP_COOLDOWN_MS: '0', ...extra } });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return { p, base: `http://127.0.0.1:${PORT}`, log: () => log };
}
async function up(s) { for (let i = 0; i < 50; i++) { try { await fetch(s.base + '/api/health'); return; } catch { await sleep(100); } } throw new Error('seva haikuwaka'); }
const adm = { 'x-admin-key': ADMIN };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-extra-'));
  // ---------- media + aina ya shule
  const s = start(path.join(dir, 'db.json')); await up(s);
  try {
    let r = await fetch(s.base + '/api/public/media'); let m = await r.json(); assert.deepEqual(m, { videos: [], anthem: null }); ok('bila video/wimbo: ukurasa unapata null');
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]);
    r = await fetch(s.base + '/api/admin/media/v2', { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: mp4 }); assert.equal(r.status, 401); ok('bila ufunguo wa admin, kupakia video kunakataliwa');
    r = await fetch(s.base + '/api/admin/media/v2', { method: 'POST', headers: { ...adm, 'Content-Type': 'video/mp4' }, body: Buffer.alloc(3000, 1) }); assert.equal(r.status, 400); ok('faili isiyo video halali inakataliwa');
    r = await fetch(s.base + '/api/admin/media/v2', { method: 'POST', headers: { ...adm, 'Content-Type': 'video/mp4' }, body: mp4 }); assert.equal(r.status, 200); ok('admin anapakia video (MP4)');
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 9)]);
    r = await fetch(s.base + '/api/admin/media/anthem', { method: 'POST', headers: { ...adm, 'Content-Type': 'audio/mpeg' }, body: mp3 }); assert.equal(r.status, 200); ok('admin anapakia Wimbo wa Taifa (MP3)');
    m = await (await fetch(s.base + '/api/public/media')).json(); assert.ok(m.videos.length === 1 && m.videos[0].slot === 'v2' && m.videos[0].url.startsWith('/media/v2?v=') && m.anthem.url.startsWith('/media/anthem?v=')); ok('kila mtu anapata viungo vya video na wimbo');
    r = await fetch(s.base + '/media/v2'); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'video/mp4'); assert.equal((await r.arrayBuffer()).byteLength, mp4.length); ok('video inatolewa kwa kila mtu bila kuingia');
    r = await fetch(s.base + '/media/v2', { headers: { Range: 'bytes=0-99' } }); assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 100); ok('video inasaidia Range (kucheza haraka na kurudia)');
    r = await fetch(s.base + '/media/anthem'); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); ok('wimbo unatolewa kama sauti');
    r = await fetch(s.base + '/api/admin/media/v2/delete', { method: 'POST', headers: { ...adm, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 200);
    assert.equal((await fetch(s.base + '/media/v2')).status, 404); ok('admin anaondoa video');
    assert.equal((await fetch(s.base + '/api/admin/media/hack', { method: 'POST', headers: { ...adm, 'Content-Type': 'video/mp4' }, body: mp4 })).status, 404); ok('aina ya faili isiyojulikana inakataliwa');
    // shule ya chekechea
    r = await fetch(s.base + '/api/otp/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '0712000111' }) }); await sleep(30);
    const code = [...s.log().matchAll(/namba yako ya uthibitisho ni (\d{6})/g)].pop()[1];
    r = await fetch(s.base + '/api/register/school', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ school: 'Chekechea Jua', type: 'chekechea', name: 'Mkuu', phone: '0712000111', password: 'secret123', otp: code }) });
    const tok = (await r.json()).token; r = await fetch(s.base + '/api/school/me', { headers: { Authorization: 'Bearer ' + tok } });
    assert.equal((await r.json()).type, 'chekechea'); ok('shule ya chekechea inasajiliwa');
    // picha ya mwalimu mkuu wakati wa usajili
    const jpg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]).toString('base64');
    const reg = async (phone, school, photo) => {
      await fetch(s.base + '/api/otp/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) }); await sleep(30);
      const c = [...s.log().matchAll(/namba yako ya uthibitisho ni (\d{6})/g)].pop()[1];
      return fetch(s.base + '/api/register/school', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ school, type: 'msingi', name: 'Mkuu Picha', phone, password: 'secret123', otp: c, photo }) });
    };
    r = await reg('0712000222', 'Shule Picha Mbaya', 'data:image/jpeg;base64,AAAA'); assert.equal(r.status, 400); ok('picha mbaya wakati wa usajili inakataliwa');
    r = await reg('0712000222', 'Shule Picha', jpg); assert.equal(r.status, 200);
    const t2 = (await r.json()).token;
    assert.equal((await (await fetch(s.base + '/api/school/me', { headers: { Authorization: 'Bearer ' + t2 } })).json()).hasPhoto, true);
    r = await fetch(s.base + '/api/school/photo', { headers: { Authorization: 'Bearer ' + t2 } }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg'); ok('picha ya mwalimu mkuu inahifadhiwa na kuonekana kwake');
    assert.equal((await fetch(s.base + '/api/school/photo', { headers: { Authorization: 'Bearer ' + tok } })).status, 404); ok('shule isiyo na picha haipati ya mwingine');
    assert.equal((await fetch(s.base + '/api/school/photo')).status, 401); ok('bila kuingia picha haionekani');
    const ov = await (await fetch(s.base + '/api/admin/overview', { headers: adm })).json(); const sid = ov.schools.find((x) => x.school === 'Shule Picha').id;
    assert.equal((await fetch(s.base + '/api/admin/school/' + sid + '/photo', { headers: adm })).status, 200); ok('admin anaona picha ya mwalimu mkuu');
  } finally { s.p.kill(); }

  // ---------- kufuta akaunti zisizotumika (siku 60)
  const old = Date.now() - 70 * 86400e3, fresh = Date.now() - 5 * 86400e3;
  const mk = (id, role, extra) => ({ id, role, name: id, phone: '255' + String(700000000 + Math.floor(Math.random() * 99999999)), passHash: 'x', createdAt: old, lastSeen: old, ...extra });
  const db = {
    meta: {}, classes: [], staff: [], timetable: [], results: [], otps: [], sms: [], withdrawals: [],
    users: [
      mk('S_OLD', 'school', { schoolName: 'Shule Kuukuu', schoolKey: 'a' }), mk('P_OLD1', 'parent', { studentId: 'ST1' }),
      mk('S_MONEY', 'school', { schoolName: 'Shule Ina Pesa', schoolKey: 'b' }), mk('P_OLD2', 'parent', { studentId: 'ST2' }),
      mk('S_NEW', 'school', { schoolName: 'Shule Hai', schoolKey: 'c', lastSeen: fresh }), mk('P_NEW', 'parent', { studentId: 'ST3', lastSeen: fresh }),
      mk('P_STALE_OF_ACTIVE', 'parent', { studentId: 'ST3' }),
    ],
    students: [{ id: 'ST1', schoolId: 'S_OLD', studentNo: '1', name: 'A' }, { id: 'ST2', schoolId: 'S_MONEY', studentNo: '1', name: 'B' }, { id: 'ST3', schoolId: 'S_NEW', studentNo: '1', name: 'C' }],
    payments: [{ id: 'PAY1', ref: 'SLX', parentId: 'P_OLD2', studentId: 'ST2', schoolId: 'S_MONEY', amount: 1000, status: 'paid', commission: 350, paidAt: old }],
  };
  fs.writeFileSync(path.join(dir, 'db2.json'), JSON.stringify(db));
  const s2 = start(path.join(dir, 'db2.json'), { INACTIVE_DAYS: '60' }); await up(s2);
  try {
    const ov = await (await fetch(s2.base + '/api/admin/overview', { headers: adm })).json();
    assert.equal(ov.totals.schools, 2); ok('shule isiyotumika miezi 2 (na bila salio) inafutwa; yenye kamisheni na ile hai zinabaki');
    const left = JSON.parse(fs.readFileSync(path.join(dir, 'db2.json'), 'utf8')).users.map((u) => u.id).sort();
    assert.deepEqual(left, ['P_NEW', 'S_MONEY', 'S_NEW']); ok('wazazi wasiotumia mfumo miezi 2 wanafutwa (na wa shule iliyofutwa); wanaotumia wanabaki');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'db2.json'), 'utf8')).students.map((x) => x.id).sort(); assert.deepEqual(st, ['ST2', 'ST3']); ok('wanafunzi wa shule iliyofutwa wanafutwa pia');
  } finally { s2.p.kill(); }
  console.log(`\nMajaribio ya ziada ${passed} yamepita ✅`);
})().catch((e) => { console.error('\n❌ IMESHINDWA:', e); process.exit(1); });
