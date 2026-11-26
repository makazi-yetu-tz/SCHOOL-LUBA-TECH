'use strict';
/**
 * SCHOOL LUBA TECH - mfumo wa shule (hakuna dependencies; inahitaji Node 18+)
 *
 * Shule inajisajili, inaongeza madarasa, ratiba, wanafunzi, walimu (majina + simu), matokeo,
 * na inatuma SMS kupitia mfumo. SMS zinanunuliwa na mmiliki wa mfumo (akaunti moja ya mtoa huduma);
 * kila shule ina ukomo wa SMS kwa mwezi. Wazazi wanalipa TSh 1,000/mwezi; shule inapata 35%.
 *
 * Hifadhi: faili la JSON (data/db.json).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PHOTO_DIR = path.join(path.dirname(DATA_FILE), 'photos');
const GATEWAY = process.env.GATEWAY || 'mock';
const SMS_PROVIDER = process.env.SMS_PROVIDER || 'console';
const NEXTSMS_URL = process.env.NEXTSMS_URL || 'https://messaging-service.co.tz/api/sms/v1/text/single';
const DALIPAY_BASE = (process.env.DALIPAY_BASE || 'https://app.dalipay.co.tz/api/v1').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const APP_URL = (process.env.APP_URL || 'http://localhost:' + PORT).replace(/\/$/, ''); // kiungo kinachotumwa kwenye SMS za mwaliko

const PRICE = 1000;              // TSh kwa mwezi kwa kila mwanafunzi
const COMMISSION_RATE = 0.35;    // sehemu ya shule
const SMS_PER_PHONE_DAY = Math.max(1, parseInt(process.env.SMS_PER_PHONE_DAY, 10) || 3); // SMS za shule kwa namba moja kwa saa 24 (kuzuia spam)
const REG_PER_HOUR = Math.max(1, parseInt(process.env.REG_PER_HOUR, 10) || 10); // usajili kwa saa kwa IP
const MIN_WITHDRAW = 3500;       // TSh
const SMS_QUOTA_DEFAULT = Number.isFinite(parseInt(process.env.SMS_QUOTA_DEFAULT, 10)) ? parseInt(process.env.SMS_QUOTA_DEFAULT, 10) : 1000; // kikomo cha usalama cha SMS (wapokeaji) kwa shule kwa mwezi; mmiliki anaweza kubadilisha kwa kila shule
const BROADCASTS_PER_WEEK = Math.max(1, parseInt(process.env.BROADCASTS_PER_WEEK, 10) || 2);   // ujumbe kwa wazazi wote kwa wiki
const BROADCASTS_PER_MONTH = Math.max(1, parseInt(process.env.BROADCASTS_PER_MONTH, 10) || 8); // na kwa mwezi (siku 30)
const TRIAL_MS = 24 * 3600e3;
const PAID_DAYS = 30;
const DAY = 24 * 3600e3;
const HOUR = 3600e3;
const DAYS_SW = ['', 'Jumatatu', 'Jumanne', 'Jumatano', 'Alhamisi', 'Ijumaa', 'Jumamosi', 'Jumapili'];

// ---------------------------------------------------------------- storage
let db = { meta: {}, users: [], classes: [], students: [], staff: [], timetable: [], results: [], payments: [], withdrawals: [], otps: [], sms: [] };

function loadDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  if (!db.meta.secret) { db.meta.secret = crypto.randomBytes(32).toString('hex'); saveDb(); }
}
function saveDb() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE); // atomic
}
loadDb();
const SECRET = process.env.SESSION_SECRET || db.meta.secret;
const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------- safety checks
if (!['console', 'beem', 'nextsms'].includes(SMS_PROVIDER)) { console.error(`SMS_PROVIDER="${SMS_PROVIDER}" haijulikani (console, beem, nextsms).`); process.exit(1); }
if (SMS_PROVIDER === 'nextsms' && !(process.env.NEXTSMS_API_KEY || (process.env.NEXTSMS_USERNAME && process.env.NEXTSMS_PASSWORD))) { console.error('NextSMS inahitaji NEXTSMS_USERNAME + NEXTSMS_PASSWORD (au NEXTSMS_API_KEY).'); process.exit(1); }
if (GATEWAY === 'dalipay' && !(process.env.DALIPAY_PUBLIC_KEY && process.env.DALIPAY_SECRET_KEY)) { console.error('DaliPay inahitaji DALIPAY_PUBLIC_KEY na DALIPAY_SECRET_KEY.'); process.exit(1); }
if (!(GATEWAY in gateways())) { console.error(`GATEWAY="${GATEWAY}" haijulikani.`); process.exit(1); }
const DEV = process.env.ALLOW_MOCK === '1'; // ruhusa ya wazi ya hali ya majaribio (gateway bandia, OTP kwenye logi)
if (!PROD && !DEV && (GATEWAY === 'mock' || SMS_PROVIDER === 'console')) { console.error('Hali ya majaribio (GATEWAY=mock au SMS_PROVIDER=console) inahitaji ALLOW_MOCK=1. Kwa uzalishaji weka NODE_ENV=production na gateway/SMS halisi.'); process.exit(1); }
if (PROD && SMS_PROVIDER === 'console') { console.error('Production inahitaji SMS_PROVIDER halisi (OTP isiandikwe kwenye logi).'); process.exit(1); }
if (PROD && GATEWAY === 'mock') { console.error('Haiwezekani kutumia GATEWAY=mock kwenye production (hakuna pesa halisi).'); process.exit(1); }
if (PROD && !process.env.APP_URL) console.warn('ONYO: weka APP_URL (kiungo cha mfumo) ili SMS za mwaliko zifanye kazi.');
if (PROD && (process.env.SESSION_SECRET || '').length < 32) { console.error('Production inahitaji SESSION_SECRET ya angalau herufi 32 (openssl rand -hex 32).'); process.exit(1); }
if (ADMIN_KEY && ADMIN_KEY.length < 16) { console.error('ADMIN_KEY iwe angalau herufi 16.'); process.exit(1); }

// ---------------------------------------------------------------- helpers
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const LINKISH = /(https?:|www\.|:\/\/|@\w|\.(com|net|org|co|tz|io|me|ly|info|biz|xyz|top|site|link|app|dev|cc|ru|cn)\b|\b\d{9,}\b)/i;
function str(v, min, max, label, allowLinks = false) {
  if (typeof v !== 'string') throw bad(`${label} inahitajika`);
  v = v.trim().replace(/\s+/g, ' ');
  if (v.length < min || v.length > max) throw bad(`${label} si sahihi`);
  // Majina hayaruhusiwi kuwa na kiungo, barua pepe au namba ndefu: yanaingia kwenye SMS za mfumo (kuzuia ujumbe wa kuhadaa)
  if (!allowLinks && LINKISH.test(v)) throw bad(`${label} lisiwe na kiungo (link), barua pepe au namba ndefu`);
  return v;
}
function phoneNorm(v) {
  if (typeof v !== 'string') throw bad('Namba ya simu si sahihi');
  let p = v.replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^0[67]\d{8}$/.test(p)) p = '255' + p.slice(1);
  if (!/^255[67]\d{8}$/.test(p)) throw bad('Namba ya simu si sahihi (mfano 07XXXXXXXX)');
  return p;
}
const phoneShow = (p) => '0' + p.slice(3);
function password(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 100) throw bad('Nenosiri liwe angalau herufi 8');
  return v;
}
const schoolKey = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function dob(dd, yy) {
  const m = typeof dd === 'string' && dd.trim().match(/^(\d{1,2})\s*[\/\-.]\s*(\d{1,2})$/);
  const y = Number(yy);
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) throw bad('Tarehe ya kuzaliwa si sahihi (mfano 15/03)');
  if (!Number.isInteger(y) || y < 2000 || y > new Date().getFullYear()) throw bad('Mwaka wa kuzaliwa si sahihi');
  return `${String(+m[1]).padStart(2, '0')}/${String(+m[2]).padStart(2, '0')}/${y}`;
}
const monthKey = (ts) => new Date(ts + 3 * HOUR).toISOString().slice(0, 7); // saa za Tanzania (UTC+3)
function grade(score) {
  return score >= 90 ? 'A' : score >= 80 ? 'B+' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'E';
}
function hhmm(v, label) {
  const m = typeof v === 'string' && v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw bad(`${label} si sahihi (mfano 08:00)`);
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

// password hashing (scrypt)
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt)).toString('hex');
}
const DUMMY_HASH = hashPassword('dummy-password'); // huzuia timing attack
async function verifyPassword(pw, stored) {
  const [s, k] = (stored || (await DUMMY_HASH)).split(':');
  const key = await scrypt(pw, Buffer.from(s, 'hex'));
  return stored ? crypto.timingSafeEqual(key, Buffer.from(k, 'hex')) : false;
}

// sessions (token iliyosainiwa, siku 7)
const pwVersion = (user) => hmac('pv:' + user.passHash).slice(0, 16); // nenosiri likibadilika, tokeni zote za zamani zinakufa
function signToken(user) {
  const p = Buffer.from(JSON.stringify({ u: user.id, v: pwVersion(user), exp: Date.now() + 7 * DAY })).toString('base64url');
  return p + '.' + hmac(p);
}
function readToken(h) {
  const m = /^Bearer (.+)$/.exec(h || '');
  if (!m) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig || !safeEq(sig, hmac(p))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.exp < Date.now()) return null;
    const u = db.users.find((x) => x.id === d.u);
    return u && safeEq(d.v || '', pwVersion(u)) ? u : null;
  } catch { return null; }
}

// rate limiting (kwenye memory)
const hits = new Map();
function rate(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
  h.n++; hits.set(key, h);
  if (hits.size > 100000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  if (h.n > max) throw new HttpError(429, 'Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.');
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 10 * 60e3).unref();

// ---------------------------------------------------------------- SMS
// Kutuma SMS moja kupitia mtoa huduma (akaunti moja ya mmiliki wa mfumo).
async function sendSms(to, message, kind) {
  db.sms.push({ id: uid(), to, kind, len: message.length, at: Date.now(), provider: SMS_PROVIDER }); // ujumbe wenyewe hauhifadhiwi
  if (db.sms.length > 2000) db.sms = db.sms.slice(-1000);
  saveDb();
  if (SMS_PROVIDER === 'beem') {
    // Hakiki muundo dhidi ya nyaraka za Beem Africa kabla ya production.
    const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET}`).toString('base64');
    const r = await fetch('https://apisms.beem.africa/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify({
        source_addr: process.env.BEEM_SENDER || 'INFO', schedule_time: '', encoding: 0, message,
        recipients: [{ recipient_id: 1, dest_addr: to }],
      }),
    });
    if (!r.ok) throw new Error('Beem SMS imeshindwa: ' + r.status);
    return;
  }
  if (SMS_PROVIDER === 'nextsms') {
    // NextSMS (messaging-service.co.tz): POST /api/sms/v1/text/single, Basic auth. Hakiki dhidi ya nyaraka zao kabla ya production.
    const auth = process.env.NEXTSMS_API_KEY || Buffer.from(`${process.env.NEXTSMS_USERNAME}:${process.env.NEXTSMS_PASSWORD}`).toString('base64');
    const r = await fetch(NEXTSMS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify({ from: process.env.NEXTSMS_SENDER || 'NEXTSMS', to: to, text: message, reference: uid().slice(0, 16) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('NextSMS imeshindwa: ' + r.status);
    const j = await r.json().catch(() => ({}));
    const g = j && j.messages && j.messages[0] && j.messages[0].status && j.messages[0].status.groupId;
    if (g !== undefined && ![1, 3].includes(Number(g))) throw new Error('NextSMS ilikataa ujumbe: ' + g); // 1=inasubiri, 3=imefika
    return;
  }
  if (SMS_PROVIDER !== 'console') throw new Error('SMS_PROVIDER haijulikani');
  console.log(`[SMS:console] kwenda ${to}: ${message}`); // kwa maendeleo tu
}

// Ukomo wa SMS kwa shule kwa mwezi (kinalinda gharama za mmiliki).
const segments = (m) => Math.max(1, Math.ceil(m.length / 160));
function smsQuota(school) {
  const mk = monthKey(Date.now());
  if (!school.smsUse || school.smsUse.month !== mk) school.smsUse = { month: mk, used: 0 };
  const quota = school.smsQuota ?? SMS_QUOTA_DEFAULT;
  return { quota, used: school.smsUse.used, left: Math.max(0, quota - school.smsUse.used) };
}
function broadcastUse(school) {
  db.meta.broadcasts = db.meta.broadcasts || {};
  const now = Date.now();
  const arr = (db.meta.broadcasts[school.id] || []).filter((t) => now - t < 30 * DAY);
  db.meta.broadcasts[school.id] = arr;
  const week = arr.filter((t) => now - t < 7 * DAY);
  const weekLeft = Math.max(0, BROADCASTS_PER_WEEK - week.length), monthLeft = Math.max(0, BROADCASTS_PER_MONTH - arr.length);
  const nextAt = weekLeft && monthLeft ? null : Math.max(weekLeft ? 0 : Math.min(...week) + 7 * DAY, monthLeft ? 0 : Math.min(...arr) + 30 * DAY);
  return { weekLimit: BROADCASTS_PER_WEEK, monthLimit: BROADCASTS_PER_MONTH, weekLeft, monthLeft, nextAt };
}
function phoneSmsCount(phone) {
  const m = (db.meta.phoneSms = db.meta.phoneSms || {}); const t = Date.now() - DAY;
  const a = (m[phone] || []).filter((x) => x > t);
  if (a.length) m[phone] = a; else delete m[phone];
  return a.length;
}
function notePhoneSms(phone) {
  const m = (db.meta.phoneSms = db.meta.phoneSms || {});
  if (Object.keys(m).length > 20000) for (const k of Object.keys(m)) phoneSmsCount(k); // safisha zilizoisha
  (m[phone] = m[phone] || []).push(Date.now());
}
/** Hutuma SMS moja kwa kila namba. Huacha kutuma ukomo ukiisha. Hurudisha {sent, failed, skipped}. */
async function schoolSms(school, phones, message, kind) {
  const per = segments(message);
  let sent = 0, failed = 0, skipped = 0;
  for (const p of [...new Set(phones)]) {
    if (smsQuota(school).left < per) { skipped++; continue; }
    if (phoneSmsCount(p) >= SMS_PER_PHONE_DAY) { skipped++; continue; } // namba moja haipokei zaidi ya SMS 3 kwa saa 24 kutoka shule zote
    school.smsUse.used += per; notePhoneSms(p); // hesabu kabla ya kutuma; saveDb inaitwa ndani ya sendSms
    try { await sendSms(p, message, kind); sent++; }
    catch (e) { failed++; school.smsUse.used -= per; console.error(e.message); }
  }
  saveDb();
  return { sent, failed, skipped };
}

// ---------------------------------------------------------------- payment gateways
function gateways() {
  return {
    // Mock: hakuna pesa halisi. Inaruhusiwa nje ya production tu.
    mock: {
      async initiate() { return { instructions: 'HALI YA MAJARIBIO: hakuna pesa halisi. Bonyeza "Thibitisha malipo (majaribio)".' }; },
    },
    // DaliPay (USSD push). Njia (paths) na majina ya headers vinaweza kubadilishwa kwa env kulingana na nyaraka zako za DaliPay.
    dalipay: {
      async initiate(p, phone) {
        const r = await dalipayCall('POST', process.env.DALIPAY_COLLECT_PATH || '/collections',
          { account_number: phoneShow(phone), amount: p.amount, external_id: p.ref, currency: 'TZS' });
        const gid = r.uuid || r.id; if (gid) { p.gwIds = [...new Set([...(p.gwIds || []), gid])].slice(-5); } saveDb();
        return { instructions: 'Angalia simu yako na uweke PIN kuthibitisha malipo.' };
      },
      // Uthibitisho UNATOKA KWA DALIPAY MOJA KWA MOJA (seva-hadi-seva), hauaminiki kutoka kwa mtumiaji wala body ya webhook.
      async check(p) {
        let anyPending = false;
        for (const gid of p.gwIds || []) { // kila ombi la kulipa lililotumwa kwa malipo haya (mzazi anaweza kujaribu mara mbili)
          const r = await dalipayCall('GET', (process.env.DALIPAY_STATUS_PATH || '/collections/').replace(/\/?$/, '/') + encodeURIComponent(gid));
          const st = String(r.status || '').toLowerCase();
          if (st === 'success') {
            if (r.amount !== undefined && Number(r.amount) !== p.amount) continue; // kiasi hakilingani: usiamini
            if (r.external_id !== undefined && r.external_id !== p.ref) continue;
            return 'paid';
          }
          if (st !== 'failed') anyPending = true;
        }
        return !(p.gwIds || []).length || anyPending ? 'pending' : 'failed';
      },
    },
  };
}
const gateway = gateways()[GATEWAY];
async function dalipayCall(method, path_, body) {
  const r = await fetch(DALIPAY_BASE + (path_.startsWith('/') ? '' : '/') + path_, {
    method,
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      [process.env.DALIPAY_HEADER_PUBLIC || 'X-Public-Key']: process.env.DALIPAY_PUBLIC_KEY,
      [process.env.DALIPAY_HEADER_SECRET || 'X-Secret-Key']: process.env.DALIPAY_SECRET_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('DaliPay', method, path_, r.status); throw new HttpError(502, 'Malipo hayajaanza. Jaribu tena baadaye.'); }
  return j && j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? { ...j, ...j.data } : j;
}
// Inauliza gateway kama malipo yamekamilika; inathibitisha tu kama DaliPay imesema "success".
const lastCheck = new Map();
async function verifyPayment(p) {
  if (p.status !== 'pending' || typeof gateway.check !== 'function') return p.status;
  if (Date.now() - (lastCheck.get(p.id) || 0) < 3000) return p.status;
  lastCheck.set(p.id, Date.now());
  if (lastCheck.size > 5000) lastCheck.clear();
  try {
    const st = await gateway.check(p);
    if (st === 'paid') confirmPayment(p);
    else if (st === 'failed') { p.status = 'failed'; saveDb(); }
  } catch (e) { console.error('verifyPayment:', e.message); }
  return p.status;
}

function confirmPayment(p) {
  if (p.status === 'paid') return false; // idempotent: kamisheni haitolewi mara mbili
  const st = db.students.find((s) => s.id === p.studentId);
  p.status = 'paid';
  p.paidAt = Date.now();
  p.commission = Math.round(p.amount * COMMISSION_RATE);
  st.paidUntil = Math.max(Date.now(), st.paidUntil || 0) + PAID_DAYS * DAY;
  saveDb();
  const parent = db.users.find((u) => u.id === p.parentId);
  if (parent) sendSms(parent.phone, 'Hongera mzazi kwa ushirikiano wako. Walimu wetu wataweka juhudi kubwa ili kupata matokeo bora kwa mtoto wako.', 'paid')
    .catch((e) => console.error('SMS ya shukrani imeshindwa:', e.message));
  return true;
}
const balanceOf = (schoolId) =>
  db.payments.filter((p) => p.schoolId === schoolId && p.status === 'paid').reduce((a, p) => a + p.commission, 0) -
  db.withdrawals.filter((w) => w.schoolId === schoolId && w.status !== 'rejected').reduce((a, w) => a + w.amount, 0);

// ---- Akaunti zisizotumika kwa miezi 2 (siku 60) zinafutwa zenyewe
const INACTIVE_MS = Math.max(1, Number(process.env.INACTIVE_DAYS) || 60) * DAY;
function touchSeen(u) { const n = Date.now(); if (n - (u.lastSeen || 0) > HOUR) { u.lastSeen = n; saveDb(); } }
function sweepInactive() {
  const now = Date.now();
  const idle = (u) => now - (u.lastSeen || u.createdAt || 0) > INACTIVE_MS;
  const dropParents = new Set(db.users.filter((u) => u.role === 'parent' && idle(u)).map((u) => u.id));
  // Shule yenye salio la kamisheni au ombi la kutoa pesa linalosubiri HAIFUTWI (pesa ya shule isipotee)
  const dropSchools = new Set(db.users.filter((u) => u.role === 'school' && idle(u) && balanceOf(u.id) <= 0 && !db.withdrawals.some((w) => w.schoolId === u.id && w.status === 'pending')).map((u) => u.id));
  if (!dropParents.size && !dropSchools.size) return { schools: 0, parents: 0 };
  for (const u of db.users.filter((x) => dropSchools.has(x.id))) { const f = schoolPhotoFile(u); if (f) try { fs.rmSync(f, { force: true }); } catch {} }
  const stuIds = new Set(db.students.filter((st) => dropSchools.has(st.schoolId)).map((st) => st.id));
  for (const st of db.students.filter((x) => stuIds.has(x.id))) for (const e of Object.keys(PHOTO_TYPES)) { try { fs.rmSync(path.join(PHOTO_DIR, st.id + '.' + e), { force: true }); } catch {} }
  for (const u of db.users) if (u.role === 'parent' && stuIds.has(u.studentId)) dropParents.add(u.id);
  db.users = db.users.filter((u) => !dropParents.has(u.id) && !dropSchools.has(u.id));
  db.classes = db.classes.filter((c) => !dropSchools.has(c.schoolId));
  db.students = db.students.filter((st) => !stuIds.has(st.id));
  db.staff = db.staff.filter((x) => !dropSchools.has(x.schoolId));
  db.timetable = db.timetable.filter((x) => !dropSchools.has(x.schoolId));
  db.results = db.results.filter((x) => !stuIds.has(x.studentId));
  saveDb();
  console.log(`Imefuta akaunti zisizotumika: shule ${dropSchools.size}, wazazi ${dropParents.size}`);
  return { schools: dropSchools.size, parents: dropParents.size };
}
const parentsOfStudent = (studentId) => db.users.filter((u) => u.role === 'parent' && u.studentId === studentId);
const parentLocked = (parent, st) => !((st.paidUntil || 0) > Date.now()) && Date.now() > parent.createdAt + TRIAL_MS;
// ---- picha za wanafunzi (zinahifadhiwa kwenye diski, zinaonekana kwa shule na mzazi wa mwanafunzi huyo tu)
const PHOTO_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
function parseImage(dataUrl) {
  const m = typeof dataUrl === 'string' && /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('Picha si sahihi (tumia JPG, PNG au WEBP)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > 400e3) throw bad('Picha ni kubwa mno (kiwango cha juu 400KB)');
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ext = 'webp';
  if (!ext) throw bad('Faili hili si picha halali');
  return { buf, ext };
}
function savePhoto(st, dataUrl) {
  const { buf, ext } = parseImage(dataUrl);
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  for (const e of Object.keys(PHOTO_TYPES)) fs.rmSync(path.join(PHOTO_DIR, st.id + '.' + e), { force: true });
  fs.writeFileSync(path.join(PHOTO_DIR, st.id + '.' + ext), buf, { mode: 0o600 });
  st.photoExt = ext; saveDb();
}
const ownClass = (school, id) => db.classes.find((c) => c.id === id && c.schoolId === school.id);

// ---------------------------------------------------------------- routes
const routes = [];
function route(method, p, opts, fn) {
  routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opts, fn });
}

// ---- usajili
route('POST', '/api/register/school', { maxBody: 700e3 }, async ({ body, ip }) => {
  rate('reg:' + ip, REG_PER_HOUR, HOUR);
  const school = str(body.school, 2, 100, 'Jina la shule');
  const type = ['chekechea', 'msingi', 'sekondari'].includes(body.type) ? body.type : 'msingi';
  const name = str(body.name, 2, 80, 'Jina la msimamizi');
  const phone = phoneNorm(body.phone);
  const pw = password(body.password);
  const img = body.photo ? parseImage(body.photo) : null; // hakiki picha kabla ya kuunda akaunti
  const check = () => {
    if (db.users.some((u) => u.phone === phone)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
    if (db.users.some((u) => u.role === 'school' && u.schoolKey === schoolKey(school)))
      throw bad('Jina hili la shule tayari limesajiliwa. Ongeza mji au eneo kwenye jina (mfano: "Uhuru Primary - Mwanza").');
  };
  check();
  checkOtp('register', phone, '', body.otp);
  const passHash = await hashPassword(pw);
  check(); // hakiki tena: maombi mawili ya wakati mmoja yasipite yote mawili
  const user = { id: uid(), role: 'school', name, phone, schoolName: school, schoolKey: schoolKey(school), schoolType: type, passHash, createdAt: Date.now(), lastSeen: Date.now() };
  if (img) { fs.mkdirSync(PHOTO_DIR, { recursive: true }); fs.writeFileSync(path.join(PHOTO_DIR, 'school-' + user.id + '.' + img.ext), img.buf, { mode: 0o600 }); user.photoExt = img.ext; }
  db.users.push(user); saveDb();
  // Namba imethibitishwa kwa OTP, kwa hiyo ni salama kutuma ujumbe wa kukaribisha (haukatwi kwenye ukomo wa SMS)
  sendSms(phone, 'Hongera mwalimu! Umefanikiwa kuunganisha shule yako na mfumo wa SCHOOL LUBA TECH. Sasa weka taarifa za wanafunzi kwa usahihi na usubiri kamisheni ya 35% kwa kila mzazi atakayelipia shilingi elfu moja kwa mwezi. Ubarikiwe mwalimu kwa ushirikiano wako.', 'welcome')
    .catch((e) => console.error('SMS ya kukaribisha imeshindwa:', e.message));
  return { token: signToken(user), role: 'school', name: school };
});

route('POST', '/api/register/parent', {}, async ({ body, ip }) => {
  rate('reg:' + ip, REG_PER_HOUR, HOUR);
  const name = str(body.name, 2, 80, 'Jina la mzazi');
  const phone = phoneNorm(body.phone);
  const pw = password(body.password);
  const school = str(body.school, 2, 100, 'Jina la shule');
  const studentNo = str(body.studentNo, 1, 40, 'Namba ya mwanafunzi', true);
  const birth = dob(body.dobDay, body.dobYear);
  const check = () => {
    if (db.users.some((u) => u.phone === phone)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
    // Mwanafunzi anatafutwa kwa jina la shule + namba. Tarehe ya kuzaliwa haikatai usajili tena; ikitofautiana, shule inaonyeshwa alama.
    const st = db.students.find((s) => s.schoolKey === schoolKey(school) && s.studentNo.toLowerCase() === studentNo.toLowerCase());
    if (!st) { rate('nf:' + schoolKey(school), 60, HOUR); throw bad('Taarifa za mwanafunzi hazilingani. Hakikisha jina la shule na namba ya mwanafunzi, au wasiliana na shule.'); } // kikomo cha kubashiri namba za wanafunzi
    if (parentsOfStudent(st.id).length >= 3) throw bad('Mwanafunzi huyu ana wazazi wengi waliosajiliwa tayari. Wasiliana na shule.');
    return st;
  };
  check();
  checkOtp('register', phone, '', body.otp);
  const passHash = await hashPassword(pw);
  const st = check();
  const user = { id: uid(), role: 'parent', name, phone, studentId: st.id, passHash, createdAt: Date.now(), lastSeen: Date.now(), dobMismatch: st.dob !== birth };
  db.users.push(user); saveDb();
  return { token: signToken(user), role: 'parent', name };
});

// ---- login
route('POST', '/api/login', {}, async ({ body, ip }) => {
  rate('login-ip:' + ip, 30, 15 * 60e3);
  const phone = phoneNorm(body.phone);
  rate('login-ph:' + phone, 8, 15 * 60e3);
  const u = db.users.find((x) => x.phone === phone);
  const ok = await verifyPassword(typeof body.password === 'string' ? body.password : '', u && u.passHash);
  if (!u || !ok) throw new HttpError(401, 'Namba ya simu au nenosiri si sahihi');
  u.lastSeen = Date.now(); saveDb();
  return { token: signToken(u), role: u.role, name: u.role === 'school' ? u.schoolName : u.name };
});

// ---- OTP ya kusahau nenosiri (haihesabiwi kwenye ukomo wa shule)
// ---- OTP (uthibitisho wa namba): usajili, kubadilisha namba, namba ya malipo, kusahau nenosiri
const OTP_COOLDOWN = process.env.OTP_COOLDOWN_MS !== undefined ? Math.max(0, Number(process.env.OTP_COOLDOWN_MS) || 0) : 20e3; // sekunde 20 kati ya OTP mbili kwa namba ileile
const OTP_IP_PER_HOUR = Math.max(5, parseInt(process.env.OTP_IP_PER_HOUR, 10) || 20);
const OTP_IP_PER_DAY = Math.max(5, parseInt(process.env.OTP_IP_PER_DAY, 10) || 100);
const OTP_PER_DAY = Math.max(10, parseInt(process.env.OTP_PER_DAY, 10) || 3000); // kikomo cha OTP zote kwa siku (kuzuia gharama za SMS)
const otpMsg = (code) => `SCHOOL LUBA TECH: namba yako ya uthibitisho ni ${code}. Inaisha baada ya dakika 5. Usimpe mtu yeyote.`;
const otpKeyOf = (purpose, phone, who) => `${purpose}:${phone}:${who}`;
function otpLocked(key) {
  const f = (db.meta.otpFail || {})[key];
  if (f && f.reset < Date.now()) { delete db.meta.otpFail[key]; return false; }
  return !!f && f.n >= 10;
}
function otpHash(purpose, phone, who, code) { return hmac(`otp:${purpose}:${phone}:${who}:${code}`); }
/** Huunda OTP mpya na kuituma kwa haraka (bila kusubiri mtoa huduma wa SMS). */
function issueOtp(purpose, phone, who = '') {
  if (otpLocked(otpKeyOf(purpose, phone, who))) throw new HttpError(429, 'Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.');
  const old = db.otps.find((o) => o.phone === phone && o.purpose === purpose && o.who === who);
  if (old && Date.now() - old.sentAt < OTP_COOLDOWN) throw bad('Subiri sekunde chache kabla ya kuomba OTP nyingine.');
  const day = new Date().toISOString().slice(0, 10);
  if (!db.meta.otpDay || db.meta.otpDay.day !== day) db.meta.otpDay = { day, n: 0 };
  if (db.meta.otpDay.n >= OTP_PER_DAY) throw new HttpError(503, 'Huduma ya OTP imejaa leo. Jaribu kesho au wasiliana na Team Support.');
  db.meta.otpDay.n++;
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  db.otps = db.otps.filter((o) => !(o.phone === phone && o.purpose === purpose && o.who === who) && o.expires > Date.now());
  db.otps.push({ phone, purpose, who, hash: otpHash(purpose, phone, who, code), expires: Date.now() + 5 * 60e3, sentAt: Date.now(), attempts: 0 });
  saveDb();
  sendSms(phone, otpMsg(code), 'otp').catch((e) => console.error('OTP SMS imeshindwa:', e.message));
}
/** Hakiki OTP; ikiwa sahihi inatumika mara moja tu. */
function checkOtp(purpose, phone, who, codeIn) {
  const code = typeof codeIn === 'string' ? codeIn.trim() : '';
  const key = otpKeyOf(purpose, phone, who);
  if (otpLocked(key)) throw new HttpError(429, 'Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.');
  const fails = (db.meta.otpFail = db.meta.otpFail || {});
  const rec = db.otps.find((o) => o.phone === phone && o.purpose === purpose && o.who === who);
  if (!rec || rec.expires < Date.now() || rec.attempts >= 5) {
    db.otps = db.otps.filter((o) => o !== rec); saveDb();
    throw bad('OTP si sahihi au muda umeisha. Omba nyingine.');
  }
  if (!/^\d{6}$/.test(code) || !safeEq(rec.hash, otpHash(purpose, phone, who, code))) {
    rec.attempts++;
    const f = fails[key] || (fails[key] = { n: 0, reset: Date.now() + HOUR }); f.n++; // inabaki hata OTP mpya ikiombwa: makosa 10 = kufungwa saa 1
    saveDb(); throw bad('OTP si sahihi');
  }
  delete fails[key];
  db.otps = db.otps.filter((o) => o !== rec); saveDb(); // inatumika mara moja tu, hata maombi mawili yakija pamoja
}

// OTP ya usajili (kabla ya akaunti kuwepo): inathibitisha kuwa mtu anamiliki namba
route('POST', '/api/otp/register', {}, ({ body, ip }) => {
  rate('otp-ip:' + ip, OTP_IP_PER_HOUR, HOUR);
  const phone = phoneNorm(body.phone);
  rate('otp-ph:' + phone, 6, HOUR); rate('otp-ph-day:' + phone, 10, DAY); rate('otp-ip-day:' + ip, OTP_IP_PER_DAY, DAY);
  if (db.users.some((u) => u.phone === phone)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
  issueOtp('register', phone);
  return { ok: true, phone: phoneShow(phone) };
});

// OTP ya kubadilisha namba ya kuingia au namba ya malipo: inatumwa kwa NAMBA MPYA
route('POST', '/api/otp/change', { auth: ['school', 'parent'] }, ({ user, body, ip }) => {
  rate('otp-ip:' + ip, OTP_IP_PER_HOUR, HOUR);
  const phone = phoneNorm(body.phone);
  rate('otp-ph:' + phone, 6, HOUR); rate('otp-ph-day:' + phone, 10, DAY); rate('otp-ip-day:' + ip, OTP_IP_PER_DAY, DAY);
  const purpose = body.purpose === 'payout' ? 'payout' : 'phone';
  if (purpose === 'payout' && user.role !== 'school') throw new HttpError(403, 'Hauruhusiwi');
  if (purpose === 'phone' && db.users.some((u) => u.phone === phone && u.id !== user.id)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
  issueOtp(purpose, phone, user.id);
  return { ok: true, phone: phoneShow(phone) };
});

// Kusahau nenosiri: jibu ni lilelile iwe namba imesajiliwa au la
route('POST', '/api/otp/send', {}, ({ body, ip }) => {
  rate('otp-ip:' + ip, OTP_IP_PER_HOUR, HOUR);
  const phone = phoneNorm(body.phone);
  rate('otp-ph:' + phone, 6, HOUR); rate('otp-ph-day:' + phone, 10, DAY); rate('otp-ip-day:' + ip, OTP_IP_PER_DAY, DAY);
  if (db.users.some((u) => u.phone === phone)) { try { issueOtp('reset', phone); } catch (e) { if (e.status === 503) throw e; } }
  return { ok: true, phone: phoneShow(phone), message: 'Ikiwa namba imesajiliwa, OTP imetumwa kwa SMS.' };
});

route('POST', '/api/otp/reset', {}, async ({ body, ip }) => {
  rate('otpr-ip:' + ip, 20, HOUR);
  const phone = phoneNorm(body.phone);
  const pw = password(body.password);
  checkOtp('reset', phone, '', body.otp);
  const u = db.users.find((x) => x.phone === phone);
  if (!u) throw bad('OTP si sahihi au muda umeisha. Omba nyingine.');
  u.passHash = await hashPassword(pw);
  saveDb();
  return { ok: true };
});

// ================================================================ SHULE
route('GET', '/api/school/me', { auth: 'school' }, ({ user }) => {
  const sts = db.students.filter((s) => s.schoolId === user.id);
  const now = Date.now(), mk = monthKey(now);
  const q = smsQuota(user);
  return {
    school: user.schoolName, type: user.schoolType, hasPhoto: !!user.photoExt, contact: user.name, phone: phoneShow(user.phone),
    students: sts.length,
    classes: db.classes.filter((c) => c.schoolId === user.id).length,
    parentsRegistered: sts.reduce((a, s) => a + parentsOfStudent(s.id).length, 0),
    paidParents: sts.filter((s) => (s.paidUntil || 0) > now).length,
    paidThisMonth: db.payments.filter((p) => p.schoolId === user.id && p.status === 'paid' && monthKey(p.paidAt) === mk).length,
    balance: balanceOf(user.id), minWithdraw: MIN_WITHDRAW,
    sms: q, broadcasts: broadcastUse(user), payoutPhone: phoneShow(user.payoutPhone || user.phone),
    withdrawals: db.withdrawals.filter((w) => w.schoolId === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
      .map((w) => ({ amount: w.amount, status: w.status, at: w.createdAt, phone: phoneShow(w.phone) })),
  };
});

// ---- madarasa
route('GET', '/api/school/classes', { auth: 'school' }, ({ user }) =>
  db.classes.filter((c) => c.schoolId === user.id).map((c) => ({
    id: c.id, name: c.name, students: db.students.filter((s) => s.classId === c.id).length,
  })));

route('POST', '/api/school/classes', { auth: 'school' }, ({ user, body }) => {
  const name = str(body.name, 1, 40, 'Jina la darasa');
  if (db.classes.filter((c) => c.schoolId === user.id).length >= 100) throw bad('Umefikia kikomo cha madarasa (100)');
  if (db.classes.some((c) => c.schoolId === user.id && c.name.toLowerCase() === name.toLowerCase())) throw bad('Darasa hili tayari lipo');
  const c = { id: uid(), schoolId: user.id, name };
  db.classes.push(c); saveDb();
  return { id: c.id, name };
});

// ---- wanafunzi
route('GET', '/api/school/students', { auth: 'school' }, ({ user }) => {
  const now = Date.now();
  return db.students.filter((s) => s.schoolId === user.id).map((s) => ({
    studentNo: s.studentNo, name: s.name, className: (db.classes.find((c) => c.id === s.classId) || {}).name || '',
    id: s.id, paid: (s.paidUntil || 0) > now, hasParent: parentsOfStudent(s.id).length > 0,
    hasPhoto: !!s.photoExt, hasParentPhone: !!s.parentPhone, invited: !!s.invitedAt,
  }));
});

route('POST', '/api/school/students', { auth: 'school' }, ({ user, body }) => {
  if (db.students.filter((x) => x.schoolId === user.id).length >= 5000) throw bad('Umefikia kikomo cha wanafunzi (5000)');
  const studentNo = str(body.studentNo, 1, 40, 'Namba ya mwanafunzi', true);
  const name = str(body.name, 2, 80, 'Jina la mwanafunzi');
  const cls = ownClass(user, body.classId);
  if (!cls) throw bad('Chagua darasa. Ongeza darasa kwanza ikiwa hakuna.');
  const birth = dob(body.dobDay, body.dobYear);
  const parentPhone = body.parentPhone ? phoneNorm(body.parentPhone) : '';
  if (db.students.some((s) => s.schoolId === user.id && s.studentNo.toLowerCase() === studentNo.toLowerCase()))
    throw bad('Namba hii ya mwanafunzi tayari ipo kwenye shule hii');
  db.students.push({ id: uid(), schoolId: user.id, schoolKey: user.schoolKey, studentNo, name, classId: cls.id, dob: birth, parentPhone, paidUntil: 0, createdAt: Date.now() });
  saveDb();
  return { ok: true };
});

// ---- picha
route('POST', '/api/school/students/photo', { auth: 'school', maxBody: 700e3 }, ({ user, body }) => {
  rate('photo:' + user.id, 200, HOUR);
  const st = db.students.find((s) => s.id === body.id && s.schoolId === user.id);
  if (!st) throw bad('Mwanafunzi hayupo kwenye shule yako');
  savePhoto(st, body.image);
  return { ok: true };
});
route('POST', '/api/parent/photo', { auth: 'parent', maxBody: 700e3 }, ({ user, body }) => {
  rate('photo:' + user.id, 20, HOUR);
  savePhoto(db.students.find((s) => s.id === user.studentId), body.image);
  return { ok: true };
});
function schoolPhotoFile(u) { return u && u.photoExt && path.join(PHOTO_DIR, 'school-' + u.id + '.' + u.photoExt); }
route('POST', '/api/school/photo', { auth: 'school', maxBody: 700e3 }, ({ user, body }) => {
  rate('photo:' + user.id, 20, HOUR);
  const { buf, ext } = parseImage(body.image);
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const old = schoolPhotoFile(user); if (old) fs.rmSync(old, { force: true });
  fs.writeFileSync(path.join(PHOTO_DIR, 'school-' + user.id + '.' + ext), buf, { mode: 0o600 });
  user.photoExt = ext; saveDb();
  return { ok: true };
});
route('GET', '/api/school/photo', { auth: 'school' }, ({ user }) => {
  const f = schoolPhotoFile(user);
  if (!f || !fs.existsSync(f)) throw new HttpError(404, 'Picha haipo');
  return { __raw: fs.readFileSync(f), type: PHOTO_TYPES[user.photoExt] };
});
route('GET', '/api/admin/school/:id/photo', { admin: true }, ({ params }) => {
  const f = schoolPhotoFile(db.users.find((u) => u.id === params.id && u.role === 'school'));
  if (!f || !fs.existsSync(f)) throw new HttpError(404, 'Picha haipo');
  return { __raw: fs.readFileSync(f), type: PHOTO_TYPES[db.users.find((u) => u.id === params.id).photoExt] };
});
route('GET', '/api/photo/:id', { auth: ['school', 'parent'] }, ({ user, params }) => {
  const st = db.students.find((s) => s.id === params.id);
  const allowed = st && (user.role === 'school' ? st.schoolId === user.id : st.id === user.studentId);
  const file = allowed && st.photoExt && path.join(PHOTO_DIR, st.id + '.' + st.photoExt);
  if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Picha haipo');
  return { __raw: fs.readFileSync(file), type: PHOTO_TYPES[st.photoExt] };
});

// ---- miamala ya wazazi kwa shule hii
route('GET', '/api/school/payments', { auth: 'school' }, ({ user }) => {
  const all = db.payments.filter((p) => p.schoolId === user.id);
  const paid = all.filter((p) => p.status === 'paid');
  const payments = all.sort((a, b) => (b.paidAt || b.createdAt) - (a.paidAt || a.createdAt)).slice(0, 200).map((p) => {
    const st = db.students.find((s) => s.id === p.studentId) || {};
    const par = db.users.find((u) => u.id === p.parentId) || {};
    return { ref: p.ref, status: p.status, amount: p.amount, commission: p.commission || 0, student: st.name, studentNo: st.studentNo, parent: par.name, at: p.paidAt || p.createdAt };
  });
  return { payments, count: paid.length, totalPaid: paid.reduce((a, p) => a + p.amount, 0), totalCommission: paid.reduce((a, p) => a + p.commission, 0) };
});

// ---- mwaliko wa SMS kwa wazazi ambao bado hawajajisajili (wenye simu iliyowekwa na shule)
route('POST', '/api/school/invite', { auth: 'school' }, async ({ user }) => {
  rate('invite:' + user.id, 3, DAY);
  const now = Date.now();
  const todo = db.students.filter((s) => s.schoolId === user.id && s.parentPhone && !parentsOfStudent(s.id).length && !(s.invitedAt && now - s.invitedAt < DAY)).slice(0, 100);
  if (!todo.length) throw bad('Hakuna wazazi wa kualika: weka simu ya mzazi kwenye mwanafunzi, au wameshaalikwa ndani ya saa 24.');
  let sent = 0, failed = 0, skipped = 0, recent = 0;
  db.meta.invited = db.meta.invited || {};
  for (const [k, t] of Object.entries(db.meta.invited)) if (now - t > 7 * DAY) delete db.meta.invited[k];
  for (const st of todo) {
    // Namba moja haipokei mwaliko zaidi ya mmoja kwa siku 7, kutoka shule yoyote (kuzuia usumbufu na SMS za kuhadaa)
    if (db.meta.invited[st.parentPhone]) { recent++; continue; }
    const msg = `${user.schoolName}: Mzazi wa ${st.name}, jisajili ${APP_URL} kwa namba ya mwanafunzi ${st.studentNo} uone ratiba na matokeo.`;
    db.meta.invited[st.parentPhone] = now; // weka alama kabla ya kutuma (kuzuia maombi ya wakati mmoja)
    const r = await schoolSms(user, [st.parentPhone], msg, 'invite');
    if (r.sent) st.invitedAt = now; else delete db.meta.invited[st.parentPhone];
    sent += r.sent; failed += r.failed; skipped += r.skipped;
  }
  saveDb();
  return { sent, failed, skipped, recent, total: todo.length };
});

// ---- walimu (majina na simu tu; hawana akaunti)
route('GET', '/api/school/staff', { auth: 'school' }, ({ user }) =>
  db.staff.filter((s) => s.schoolId === user.id).map((s) => ({ id: s.id, name: s.name, phone: phoneShow(s.phone), subject: s.subject })));

route('POST', '/api/school/staff', { auth: 'school' }, ({ user, body }) => {
  const name = str(body.name, 2, 80, 'Jina la mwalimu');
  const phone = phoneNorm(body.phone);
  const subject = typeof body.subject === 'string' ? str(body.subject, 0, 60, 'Somo') : '';
  if (db.staff.some((s) => s.schoolId === user.id && s.phone === phone)) throw bad('Namba hii tayari ipo kwenye orodha ya walimu');
  if (db.staff.filter((s) => s.schoolId === user.id).length >= 300) throw bad('Umefikia kikomo cha walimu (300)');
  db.staff.push({ id: uid(), schoolId: user.id, name, phone, subject }); saveDb();
  return { ok: true };
});

route('POST', '/api/school/staff/delete', { auth: 'school' }, ({ user, body }) => {
  db.staff = db.staff.filter((s) => !(s.id === body.id && s.schoolId === user.id)); saveDb();
  return { ok: true };
});

// ---- ratiba za madarasa
route('GET', '/api/school/timetable/:classId', { auth: 'school' }, ({ user, params }) => {
  if (!ownClass(user, params.classId)) throw new HttpError(404, 'Darasa halipo');
  return timetableOf(params.classId);
});
function timetableOf(classId) {
  return db.timetable.filter((t) => t.classId === classId)
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))
    .map((t) => ({ id: t.id, day: t.day, dayName: DAYS_SW[t.day], start: t.start, end: t.end, subject: t.subject, teacher: t.teacher }));
}

route('POST', '/api/school/timetable', { auth: 'school' }, async ({ user, body }) => {
  const cls = ownClass(user, body.classId);
  if (!cls) throw bad('Chagua darasa');
  const day = Number(body.day);
  if (!Number.isInteger(day) || day < 1 || day > 7) throw bad('Siku si sahihi');
  const start = hhmm(body.start, 'Saa ya kuanza'), end = hhmm(body.end, 'Saa ya kumaliza');
  if (end <= start) throw bad('Saa ya kumaliza lazima iwe baada ya ya kuanza');
  const subject = str(body.subject, 2, 60, 'Somo');
  const teacher = typeof body.teacher === 'string' ? str(body.teacher, 0, 80, 'Mwalimu') : '';
  if (db.timetable.some((t) => t.classId === cls.id && t.day === day && start < t.end && end > t.start))
    throw bad('Muda huu unagongana na kipindi kingine cha darasa hili');
  db.timetable.push({ id: uid(), schoolId: user.id, classId: cls.id, day, start, end, subject, teacher });
  saveDb();
  // Hiari: arifu wazazi wa darasa hili
  let sms = null;
  if (body.notify === true) {
    const phones = db.students.filter((s) => s.classId === cls.id).flatMap((s) => parentsOfStudent(s.id).map((p) => p.phone));
    sms = await schoolSms(user, phones, `${user.schoolName}: ratiba ya ${cls.name} imebadilika. Angalia kwenye SCHOOL LUBA TECH.`, 'timetable');
  }
  return { ok: true, sms };
});

route('POST', '/api/school/timetable/delete', { auth: 'school' }, ({ user, body }) => {
  db.timetable = db.timetable.filter((t) => !(t.id === body.id && t.schoolId === user.id)); saveDb();
  return { ok: true };
});

// ---- matokeo (SMS otomatiki kwa mzazi)
route('POST', '/api/school/results', { auth: 'school' }, async ({ user, body }) => {
  const studentNo = str(body.studentNo, 1, 40, 'Namba ya mwanafunzi', true);
  const subject = str(body.subject, 2, 40, 'Somo');
  const score = Number(body.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw bad('Alama ziwe kati ya 0 na 100');
  const st = db.students.find((s) => s.schoolId === user.id && s.studentNo.toLowerCase() === studentNo.toLowerCase());
  if (!st) throw bad('Mwanafunzi huyu hayupo kwenye shule yako');
  db.results.push({ id: uid(), studentId: st.id, subject, score: Math.round(score), grade: grade(score), at: Date.now() });
  saveDb();
  let sms = { sent: 0, failed: 0, skipped: 0 };
  if (body.notify !== false) {
    // Mzazi ambaye jaribio limeisha bila kulipa hapati alama kwenye SMS (anaelekezwa kulipia)
    for (const p of parentsOfStudent(st.id)) {
      const msg = parentLocked(p, st)
        ? `${user.schoolName}: matokeo mapya ya ${st.name} yapo. Lipia kwenye SCHOOL LUBA TECH kuyaona.`
        : `${user.schoolName}: ${st.name} - ${subject}: ${Math.round(score)}% (${grade(score)}).`;
      const r = await schoolSms(user, [p.phone], msg, 'result');
      sms.sent += r.sent; sms.failed += r.failed; sms.skipped += r.skipped;
    }
  }
  return { ok: true, grade: grade(score), sms };
});

// ---- SMS: kwa wazazi wote, darasa moja, walimu, au wote
// Orodha ya wazazi waliojisajili kwenye shule hii (kwa kuchagua mzazi mmoja wa kumtumia ujumbe)
route('GET', '/api/school/parents', { auth: 'school' }, ({ user }) => {
  const now = Date.now();
  return db.students.filter((s) => s.schoolId === user.id).flatMap((s) => parentsOfStudent(s.id).map((p) => ({
    id: p.id, name: p.name, phone: phoneShow(p.phone), studentName: s.name, dobMismatch: !!p.dobMismatch,
    className: (db.classes.find((c) => c.id === s.classId) || {}).name || '', paid: (s.paidUntil || 0) > now,
  }))).sort((a, b) => a.name.localeCompare(b.name));
});

// Tuma SMS: 'parents' (wazazi wote; ukomo: mara 2 kwa wiki, 8 kwa mwezi) au 'parent:<id>' (mzazi mmoja; haihesabiwi kama ujumbe wa wote)
route('POST', '/api/school/sms', { auth: 'school' }, async ({ user, body }) => {
  rate('sms:' + user.id, 20, HOUR);
  const message = str(body.message, 2, 300, 'Ujumbe', true);
  const target = typeof body.target === 'string' ? body.target : 'parents';
  const parentsOf = (filter) => db.students.filter(filter).flatMap((s) => parentsOfStudent(s.id).map((p) => p.phone));
  let phones = [], single = false;
  if (target === 'parents') phones = parentsOf((s) => s.schoolId === user.id);
  else if (target.startsWith('parent:')) {
    single = true;
    const p = db.users.find((u) => u.role === 'parent' && u.id === target.slice(7));
    const st = p && db.students.find((s) => s.id === p.studentId);
    if (!st || st.schoolId !== user.id) throw bad('Mzazi huyu hayupo kwenye shule yako');
    rate('single:' + user.id, 100, DAY);
    phones = [p.phone];
  }
  else if (target.startsWith('class:')) {
    const cls = ownClass(user, target.slice(6));
    if (!cls) throw bad('Darasa halipo');
    phones = parentsOf((s) => s.classId === cls.id);
  } else throw bad('Lengo la SMS si sahihi');
  phones = [...new Set(phones)];
  if (!phones.length) throw bad('Hakuna wapokeaji waliosajiliwa bado');
  const full = `${user.schoolName}: ${message}`;
  const need = phones.length * segments(full);
  const q = smsQuota(user);
  if (need > q.left) throw bad(`SMS hazitoshi: zinahitajika ${need}, zimebaki ${q.left} mwezi huu. Wasiliana nasi kuongeza ukomo.`);
  let stamp = null;
  if (!single) {
    const bu = broadcastUse(user);
    if (!bu.weekLeft || !bu.monthLeft) throw bad(`Umefikia kikomo cha ujumbe kwa wazazi wote (${BROADCASTS_PER_WEEK} kwa wiki, ${BROADCASTS_PER_MONTH} kwa mwezi). Subiri hadi wiki ijayo. Unaweza bado kumtumia mzazi mmoja ujumbe.`);
    stamp = Date.now(); db.meta.broadcasts[user.id].push(stamp); saveDb(); // weka alama kabla ya kutuma (kuzuia maombi ya wakati mmoja)
  }
  const r = await schoolSms(user, phones, full, 'school');
  if (stamp && !r.sent) { db.meta.broadcasts[user.id] = db.meta.broadcasts[user.id].filter((t) => t !== stamp); saveDb(); }
  return { ...r, total: phones.length, single, broadcasts: broadcastUse(user) };
});

// ---- kutoa pesa
route('POST', '/api/school/withdraw', { auth: 'school' }, ({ user }) => {
  const bal = balanceOf(user.id);
  if (bal < MIN_WITHDRAW) throw bad(`Kiwango cha chini cha kutoa ni TSh ${MIN_WITHDRAW.toLocaleString('en-US')}`);
  if (db.withdrawals.some((w) => w.schoolId === user.id && w.status === 'pending')) throw bad('Una ombi lingine linalosubiri');
  db.withdrawals.push({ id: uid(), schoolId: user.id, amount: bal, phone: user.payoutPhone || user.phone, status: 'pending', createdAt: Date.now() });
  saveDb();
  return { ok: true, amount: bal };
});

// Namba ya kupokea malipo ya shule (inabadilika wakati wowote; inahitaji nenosiri ili mwizi wa kikao asielekeze pesa kwake)
route('POST', '/api/school/payout-phone', { auth: 'school' }, async ({ user, body, ip }) => {
  rate('chg:' + user.id, 10, HOUR);
  const phone = phoneNorm(body.phone);
  if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', user.passHash))) throw bad('Nenosiri si sahihi');
  checkOtp('payout', phone, user.id, body.otp);
  user.payoutPhone = phone; saveDb();
  return { ok: true, payoutPhone: phoneShow(phone) };
});

// Mkuu wa shule anabadilisha namba ya kuingia (nenosiri + OTP iliyotumwa kwa namba mpya)
route('POST', '/api/school/phone', { auth: 'school' }, async ({ user, body }) => {
  rate('chg:' + user.id, 10, HOUR);
  const phone = phoneNorm(body.phone);
  if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', user.passHash))) throw bad('Nenosiri si sahihi');
  if (db.users.some((u) => u.phone === phone && u.id !== user.id)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
  checkOtp('phone', phone, user.id, body.otp);
  user.phone = phone; saveDb();
  return { ok: true, phone: phoneShow(phone) };
});

// ================================================================ MZAZI
route('GET', '/api/parent/me', { auth: 'parent' }, ({ user }) => {
  const st = db.students.find((s) => s.id === user.studentId);
  const school = db.users.find((u) => u.id === st.schoolId);
  const cls = db.classes.find((c) => c.id === st.classId) || {};
  const now = Date.now();
  const trialEndsAt = user.createdAt + TRIAL_MS;
  const paid = (st.paidUntil || 0) > now;
  const locked = !paid && now > trialEndsAt;
  return {
    parent: { name: user.name, phone: phoneShow(user.phone) },
    student: { id: st.id, hasPhoto: !!st.photoExt, name: st.name, className: cls.name || '', studentNo: st.studentNo, school: school.schoolName },
    school: { name: school.schoolName, phone: phoneShow(school.phone), contact: school.name },
    status: { paid, paidUntil: st.paidUntil || 0, trialEndsAt, locked, price: PRICE },
    timetable: cls.id ? timetableOf(cls.id) : [], // ratiba haifungwi
    results: locked ? [] : db.results.filter((r) => r.studentId === st.id).sort((a, b) => b.at - a.at).slice(0, 30)
      .map((r) => ({ subject: r.subject, score: r.score, grade: r.grade, at: r.at })),
  };
});

route('POST', '/api/parent/phone', { auth: 'parent' }, async ({ user, body }) => {
  rate('chg:' + user.id, 10, HOUR);
  const phone = phoneNorm(body.phone);
  if (!(await verifyPassword(typeof body.password === 'string' ? body.password : '', user.passHash))) throw bad('Nenosiri si sahihi');
  if (db.users.some((u) => u.phone === phone && u.id !== user.id)) throw bad('Namba hii tayari imesajiliwa. Tafadhali ingia.');
  checkOtp('phone', phone, user.id, body.otp);
  user.phone = phone; saveDb();
  return { ok: true, phone: phoneShow(phone) };
});

route('POST', '/api/pay/initiate', { auth: 'parent' }, async ({ user, body }) => {
  rate('pay:' + user.id, 10, HOUR);
  const payPhone = body && body.phone ? phoneNorm(body.phone) : user.phone; // namba ya kulipia inaweza kuwa tofauti na ya kuingia
  // Hakuna OTP kwa malipo (haraka). Ulinzi: pesa haitoki bila mwenye namba kuweka PIN yake kwenye simu yake (USSD ya gateway).
  // Namba ya mtu mwingine: ukomo wa maombi kwa namba hiyo (kwa wazazi wote) na namba tofauti kwa mzazi mmoja.
  if (payPhone !== user.phone) {
    rate('push:' + payPhone, 3, DAY);
    rate('pushall:' + payPhone, 6, DAY);
    const seen = (db.meta.payPhones = db.meta.payPhones || {}); const k = user.id + ':' + new Date().toISOString().slice(0, 10);
    const set = seen[k] = seen[k] || [];
    if (!set.includes(payPhone)) { if (set.length >= 3) throw new HttpError(429, 'Umejaribu namba nyingi sana leo. Tumia namba yako au subiri kesho.'); set.push(payPhone); saveDb(); }
  }
  const st = db.students.find((s) => s.id === user.studentId);
  if ((st.paidUntil || 0) - Date.now() > 3 * DAY) throw bad('Tayari umelipia. Asante!');
  let p = db.payments.find((x) => x.parentId === user.id && x.status === 'pending' && Date.now() - x.createdAt < 15 * 60e3);
  if (!p) {
    p = { id: uid(), ref: 'SL' + crypto.randomBytes(6).toString('hex').toUpperCase(), parentId: user.id, studentId: st.id, schoolId: st.schoolId, amount: PRICE, status: 'pending', createdAt: Date.now() };
    db.payments.push(p); saveDb();
  }
  const r = await gateway.initiate(p, payPhone);
  return { paymentId: p.id, status: p.status, instructions: r.instructions, mock: GATEWAY === 'mock' };
});

route('GET', '/api/pay/status/:id', { auth: 'parent' }, async ({ user, params }) => {
  const p = db.payments.find((x) => x.id === params.id && x.parentId === user.id);
  if (!p) throw new HttpError(404, 'Malipo hayajapatikana');
  await verifyPayment(p);
  return { status: p.status };
});

// Majaribio tu (GATEWAY=mock, si production)
route('POST', '/api/pay/mock-confirm/:id', { auth: 'parent' }, ({ user, params }) => {
  if (GATEWAY !== 'mock' || PROD || !DEV) throw new HttpError(404, 'Haipatikani');
  const p = db.payments.find((x) => x.id === params.id && x.parentId === user.id);
  if (!p) throw new HttpError(404, 'Malipo hayajapatikana');
  confirmPayment(p);
  return { status: p.status };
});

// Webhook ya DaliPay: ni ishara tu. Hatuamini body; tunauliza DaliPay moja kwa moja (verifyPayment) kabla ya kuweka "paid".
route('POST', '/api/webhook/dalipay', {}, async ({ body, ip }) => {
  rate('wh:' + ip, 120, 60e3);
  if (GATEWAY !== 'dalipay') throw new HttpError(404, 'Haipatikani');
  const ext = body && body.data && typeof body.data.external_id === 'string' ? body.data.external_id : '';
  const p = db.payments.find((x) => x.ref === ext);
  if (p) await verifyPayment(p);
  return { ok: true };
});

// Webhook kutoka gateway. Saini: HMAC-SHA256 ya raw body kwa WEBHOOK_SECRET, kwenye header x-signature.
// Badilisha muundo huu ulingane na mtoa huduma utakayemchagua.
route('POST', '/api/webhook/payment', {}, ({ raw, req, body }) => {
  if (!WEBHOOK_SECRET) throw new HttpError(503, 'Webhook haijawashwa');
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  if (!safeEq(String(req.headers['x-signature'] || ''), sig)) throw new HttpError(401, 'Saini si sahihi');
  const p = db.payments.find((x) => x.ref === body.reference);
  if (!p) throw new HttpError(404, 'Malipo hayajapatikana');
  if (String(body.status).toUpperCase() === 'SUCCESS') {
    if (Number(body.amount) !== p.amount) throw bad('Kiasi hakilingani');
    confirmPayment(p);
  } else if (p.status === 'pending') { p.status = 'failed'; saveDb(); }
  return { ok: true };
});

// ================================================================ MMILIKI (admin)
// Header: x-admin-key = ADMIN_KEY. Inatumika kuongeza ukomo wa SMS na kuweka alama ya malipo ya kamisheni.
route('GET', '/api/admin/overview', { admin: true }, () => ({
  totals: {
    schools: db.users.filter((u) => u.role === 'school').length,
    parents: db.users.filter((u) => u.role === 'parent').length,
    students: db.students.length,
    paid: db.payments.filter((p) => p.status === 'paid').reduce((a, p) => a + p.amount, 0),
    pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').reduce((a, w) => a + w.amount, 0),
  },
  schools: db.users.filter((u) => u.role === 'school').map((u) => ({
    id: u.id, hasPhoto: !!u.photoExt, school: u.schoolName, contact: u.name, phone: phoneShow(u.phone), payoutPhone: phoneShow(u.payoutPhone || u.phone), sms: smsQuota(u), balance: balanceOf(u.id),
    students: db.students.filter((s) => s.schoolId === u.id).length,
    paidStudents: db.students.filter((s) => s.schoolId === u.id && (s.paidUntil || 0) > Date.now()).length,
    collected: db.payments.filter((p) => p.schoolId === u.id && p.status === 'paid').reduce((a, p) => a + p.amount, 0),
    commission: db.payments.filter((p) => p.schoolId === u.id && p.status === 'paid').reduce((a, p) => a + p.commission, 0),
    withdrawnPaid: db.withdrawals.filter((w) => w.schoolId === u.id && w.status === 'paid').reduce((a, w) => a + w.amount, 0),
  })),
  pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'pending').map((w) => ({
    id: w.id, school: (db.users.find((u) => u.id === w.schoolId) || {}).schoolName, amount: w.amount, phone: phoneShow(w.phone), at: w.createdAt,
  })),
}));
route('POST', '/api/admin/quota', { admin: true }, ({ body }) => {
  const u = db.users.find((x) => x.role === 'school' && x.id === body.schoolId);
  const q = Number(body.quota);
  if (!u || !Number.isInteger(q) || q < 0 || q > 1e6) throw bad('Data si sahihi');
  u.smsQuota = q; saveDb();
  return { ok: true };
});
// Wanafunzi wa shule moja na hali ya malipo (kwa mmiliki)
route('GET', '/api/admin/school/:id/students', { admin: true }, ({ params }) => {
  const now = Date.now();
  if (!db.users.some((u) => u.role === 'school' && u.id === params.id)) throw new HttpError(404, 'Haipo');
  return db.students.filter((s) => s.schoolId === params.id).map((s) => ({
    name: s.name, studentNo: s.studentNo, className: (db.classes.find((c) => c.id === s.classId) || {}).name || '',
    hasParent: parentsOfStudent(s.id).length > 0, paid: (s.paidUntil || 0) > now,
  }));
});
route('POST', '/api/admin/withdrawals/paid', { admin: true }, ({ body }) => {
  const w = db.withdrawals.find((x) => x.id === body.id && x.status === 'pending');
  if (!w) throw bad('Ombi halipo');
  w.status = 'paid'; w.paidAt = Date.now(); saveDb();
  return { ok: true };
});
route('POST', '/api/admin/withdrawals/reject', { admin: true }, ({ body }) => {
  const w = db.withdrawals.find((x) => x.id === body.id && x.status === 'pending');
  if (!w) throw bad('Ombi halipo');
  w.status = 'rejected'; saveDb(); // pesa inarudi kwenye salio la shule
  return { ok: true };
});

route('GET', '/api/health', {}, () => ({ ok: true }));

// ---- Video ya ukurasa wa mbele na Wimbo wa Taifa (admin anapakia; kila mtu anaona/anasikia)
const MEDIA_DIR = path.join(path.dirname(DATA_FILE), 'media');
const MEDIA_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav' };
const SLOTS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']; // sehemu sita za video, kila moja sekunde 5
const MEDIA_MAX = { v1: 15e6, v2: 15e6, v3: 15e6, v4: 15e6, v5: 15e6, v6: 15e6, anthem: 12e6 };
function mediaExt(kind, b) {
  const t = (o, str) => b.subarray(o, o + str.length).toString('latin1') === str;
  const mp4 = b.length > 12 && t(4, 'ftyp'), webm = b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  if (kind !== 'anthem') return mp4 ? 'mp4' : webm ? 'webm' : null;
  if (t(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'mp3';
  if (t(0, 'OggS')) return 'ogg';
  if (t(0, 'RIFF') && t(8, 'WAVE')) return 'wav';
  return mp4 ? 'm4a' : null;
}
route('GET', '/api/public/media', {}, () => {
  const m = db.meta.media || {}, o = {};
  o.videos = SLOTS.filter((k) => m[k]).map((k) => ({ slot: k, url: '/media/' + k + '?v=' + m[k].at }));
  o.anthem = m.anthem ? { url: '/media/anthem?v=' + m.anthem.at } : null;
  return o;
});
route('POST', '/api/admin/media/:kind', { admin: true, binary: true, maxBody: 16e6 }, ({ raw, params }) => {
  const kind = params.kind;
  if (!MEDIA_MAX[kind]) throw new HttpError(404, 'Haipo');
  if (!raw || raw.length < 100 || raw.length > MEDIA_MAX[kind]) throw bad('Faili ni kubwa mno');
  const ext = mediaExt(kind, raw);
  if (!ext) throw bad(kind !== 'anthem' ? 'Video lazima iwe MP4 au WEBM' : 'Wimbo lazima uwe MP3, M4A, OGG au WAV');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  for (const e of Object.keys(MEDIA_TYPES)) fs.rmSync(path.join(MEDIA_DIR, kind + '.' + e), { force: true });
  fs.writeFileSync(path.join(MEDIA_DIR, kind + '.' + ext), raw, { mode: 0o600 });
  (db.meta.media = db.meta.media || {})[kind] = { ext, size: raw.length, at: Date.now() };
  saveDb();
  return { ok: true };
});
route('POST', '/api/admin/media/:kind/delete', { admin: true }, ({ params }) => {
  const kind = params.kind;
  if (!MEDIA_MAX[kind]) throw new HttpError(404, 'Haipo');
  for (const e of Object.keys(MEDIA_TYPES)) fs.rmSync(path.join(MEDIA_DIR, kind + '.' + e), { force: true });
  if (db.meta.media) delete db.meta.media[kind];
  saveDb();
  return { ok: true };
});
function serveMedia(req, res, kind) {
  const m = (db.meta.media || {})[kind];
  const file = m && path.join(MEDIA_DIR, kind + '.' + m.ext);
  let st; try { st = file && fs.statSync(file); } catch {}
  if (!st) { res.writeHead(404); return res.end(); }
  let start = 0, end = st.size - 1, status = 200;
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (r && (r[1] !== '' || r[2] !== '')) {
    if (r[1] !== '') { start = Number(r[1]); if (r[2] !== '') end = Math.min(Number(r[2]), end); }
    else start = Math.max(0, st.size - Number(r[2]));
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    status = 206;
  }
  const hdr = { 'Content-Type': MEDIA_TYPES[m.ext], 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'public, max-age=86400' };
  if (status === 206) hdr['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(status, hdr);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

// ---------------------------------------------------------------- server
// Ukurasa wa mbele uko ndani ya faili hili (build.js inaweka HTML hapa). Wakati wa maendeleo unasomwa kutoka public/index.html.
const INDEX_EMBED = "<!DOCTYPE html>\n<html lang=\"sw\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <!-- Zoom kwa vidole imewezeshwa -->\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=5.0, user-scalable=yes\" />\n  <title>SCHOOL LUBA TECH - Mfumo wa Shule</title>\n  <link rel=\"preconnect\" href=\"https://cdn.tailwindcss.com\" crossorigin>\n  <link rel=\"preconnect\" href=\"https://cdn.jsdelivr.net\" crossorigin>\n  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n  <script src=\"https://cdn.tailwindcss.com\"></script>\n  <script defer src=\"https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.2/dist/confetti.browser.min.js\"></script>\n  <link href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Black+Ops+One&display=swap\" rel=\"stylesheet\">\n  <style>\n    :root {\n      --blue: #1d4ed8;      /* bluu ya shule */\n      --navy: #1e3a8a;\n      --board: #14532d;     /* kijani cha ubao */\n      --pencil: #facc15;    /* njano ya penseli */\n    }\n    * { font-family: 'Poppins', sans-serif; }\n    body { -webkit-tap-highlight-color: transparent; background: #eff6ff; touch-action: manipulation; }\n    /* touch-action: manipulation huruhusu pinch-zoom na kuzuia double-tap delay */\n\n    /* ===== Vitufe vyote vinacheza ===== */\n    button { animation: wiggle 2.6s ease-in-out infinite; cursor: pointer; }\n    button:nth-of-type(2n) { animation-delay: .4s; }\n    button:nth-of-type(3n) { animation-delay: .8s; }\n    button:active { transform: scale(0.95); animation: none; }\n    @keyframes wiggle {\n      0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }\n      20% { transform: translateY(-5px) rotate(-1.2deg) scale(1.02); }\n      40% { transform: translateY(0) rotate(1.2deg) scale(1); }\n      60% { transform: translateY(-3px) rotate(0deg) scale(1.02); }\n      80% { transform: translateY(0) rotate(-.6deg) scale(1); }\n    }\n\n    /* Kitufe cha Mwalimu: kijani cha ubao + maandishi meupe */\n    .btn-teacher {\n      background: linear-gradient(135deg, #22c55e, #16a34a, #166534);\n      color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,.35);\n      box-shadow: 0 8px 26px rgba(22,163,74,.45);\n      border: 3px solid #bbf7d0;\n    }\n    /* Kitufe cha Mzazi: chungwa linalong'aa + maandishi meupe */\n    .btn-parent {\n      background: linear-gradient(135deg, #fb923c, #f97316, #c2410c);\n      color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,.4);\n      box-shadow: 0 8px 26px rgba(249,115,22,.45);\n      border: 3px solid #fed7aa;\n    }\n    /* Kitufe cha kawaida (bluu) */\n    .btn-primary {\n      background: linear-gradient(135deg, #3b82f6, #1d4ed8, #1e3a8a);\n      color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,.35);\n      box-shadow: 0 8px 26px rgba(29,78,216,.4);\n    }\n    .btn-secondary {\n      background: linear-gradient(135deg, #22c55e, #15803d);\n      color: #fff; text-shadow: 0 2px 4px rgba(0,0,0,.35);\n      box-shadow: 0 8px 26px rgba(21,128,61,.4);\n    }\n\n    /* ===== Jina la SCHOOL LUBA TECH: herufi zinaruka moja moja mara moja, kisha zinasimama ~3s ===== */\n    .brand-pill {\n      background: linear-gradient(135deg, #0f172a, #1e293b);\n      border-radius: 18px; padding: 10px 18px 8px; box-shadow: inset 0 0 12px rgba(0,0,0,.6), 0 6px 18px rgba(15,23,42,.35);\n      display: inline-block; max-width: 100%;\n    }\n    .brand { font-family: 'Black Ops One', cursive; letter-spacing: .5px; white-space: nowrap; display: inline-flex; line-height: 1.2; color: #fde68a; text-shadow: 0 2px 6px rgba(0,0,0,.5); }\n    .brand .ch { display: inline-block; animation: jump 5s ease-in-out infinite; animation-delay: calc(var(--i) * .09s); }\n    .brand .sp { width: .45em; }\n    @keyframes jump { 0%, 9%, 100% { transform: translateY(0); } 4.5% { transform: translateY(-.55em); } }\n    /* Logo ya SL: inazunguka mara moja (1.5s), kisha inagandama sekunde 3 */\n    .logo-spin { animation: logoSpin 4.5s ease-in-out infinite; }\n    @keyframes logoSpin { 0% { transform: perspective(600px) rotateY(0deg); } 33% { transform: perspective(600px) rotateY(360deg); } 100% { transform: perspective(600px) rotateY(360deg); } }\n    @media (prefers-reduced-motion: reduce) { .logo-spin, .brand .ch { animation: none; } }\n\n    /* ===== Kompyuta (skrini kubwa): kila kitu kikubwa na pana ===== */\n    @media (min-width: 1024px) {\n      html { font-size: 19px; }\n      body header .max-w-lg, body main.max-w-lg { max-width: 72rem; }\n      body main.max-w-lg.py-8 { max-width: 42rem; }\n      .brand-pill { padding: 16px 32px 12px; border-radius: 24px; }\n    }\n\n    .video-slide { display: none !important; animation: fadeIn 0.7s ease; }\n    .video-slide.active { display: flex !important; }\n    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }\n\n    .card { background: white; border: 1px solid #dbeafe; box-shadow: 0 4px 20px rgba(30,58,138,0.08); }\n\n    .input-light { background: #fff; border: 2px solid #dbeafe; color: #1e293b; }\n    .input-light:focus { border-color: #1d4ed8; outline: none; box-shadow: 0 0 0 4px rgba(29,78,216,.15); }\n\n    .text-readable { font-size: 1.08rem; line-height: 1.65; }\n\n    /* ===== Noti za pesa zinaruka ===== */\n    #moneyLayer { position: fixed; inset: 0; pointer-events: none; z-index: 9999; overflow: hidden; }\n    .note {\n      position: absolute; top: -60px; font-size: 38px;\n      animation: noteFall linear forwards;\n      filter: drop-shadow(0 4px 4px rgba(0,0,0,.25));\n    }\n    @keyframes noteFall {\n      0% { transform: translate3d(0,-60px,0) rotate(0deg); opacity: 1; }\n      50% { transform: translate3d(var(--sway), 55vh, 0) rotate(var(--rot)); }\n      100% { transform: translate3d(calc(var(--sway) * -1), 115vh, 0) rotate(calc(var(--rot) * 2)); opacity: 1; }\n    }\n    .note.up { top: auto; bottom: -60px; animation-name: noteUp; }\n    @keyframes noteUp {\n      0% { transform: translate3d(0,0,0) rotate(0deg); }\n      100% { transform: translate3d(var(--sway), -115vh, 0) rotate(calc(var(--rot) * 2)); }\n    }\n  </style>\n</head>\n<body class=\"text-slate-800 min-h-screen\">\n\n  <div id=\"moneyLayer\"></div>\n\n  <!-- ====================== LANDING PAGE ====================== -->\n  <div id=\"landing\" class=\"min-h-screen flex flex-col\">\n    <header class=\"bg-white/95 backdrop-blur sticky top-0 z-50 border-b border-blue-100 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-3 flex flex-wrap lg:flex-nowrap gap-y-2 gap-x-4 items-center justify-between\">\n        <div class=\"flex items-center gap-3 lg:gap-6\">\n          <div class=\"logo-spin shrink-0 w-16 h-16 lg:w-32 lg:h-32 rounded-2xl lg:rounded-3xl bg-gradient-to-br from-blue-600 via-yellow-400 to-green-600 flex items-center justify-center shadow-lg shadow-blue-200\">\n            <span class=\"text-white font-black text-3xl lg:text-6xl leading-none\" data-no-i18n>SL</span>\n          </div>\n          <div>\n            <div class=\"brand-pill\"><div id=\"brand\" class=\"brand text-xl sm:text-3xl lg:text-5xl xl:text-6xl\" role=\"img\" aria-label=\"SCHOOL LUBA TECH\">SCHOOL LUBA TECH</div></div>\n            <p class=\"text-base sm:text-xl lg:text-3xl font-bold text-blue-900 mt-1\">Mfumo wa Shule</p>\n          </div>\n        </div>\n\n        <button onclick=\"toggleLang()\" class=\"lang-btn shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\">\n          <span>Change Language</span>\n        </button>\n      </div>\n    </header>\n\n    <main class=\"flex-1 max-w-lg mx-auto w-full px-4 py-6\">\n      <div class=\"grid lg:grid-cols-2 lg:gap-x-14 lg:items-center\">\n      <div class=\"text-center lg:text-left mb-6 lg:col-start-1 lg:row-start-1\">\n        <h1 id=\"heroTitle\" class=\"text-3xl lg:text-6xl font-extrabold text-blue-950 leading-snug\">\n          Karibu kwenye<br>\n          <span class=\"text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-green-600\">Mfumo wa Shule</span>\n        </h1>\n        <p id=\"heroSubtitle\" class=\"mt-4 lg:mt-6 lg:text-2xl text-slate-600 text-readable\">\n          Usajili rahisi, kumbukumbu salama za wanafunzi na ufuatiliaji wa wazazi\n        </p>\n      </div>\n\n      <div class=\"lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:self-center\">\n      <div class=\"text-center mb-5\">\n        <button id=\"anthemBtn\" onclick=\"toggleAnthem()\" class=\"btn-parent px-6 py-4 lg:px-10 lg:py-5 rounded-2xl font-bold text-lg lg:text-2xl\"><span id=\"anthemIcon\" data-no-i18n>🎵</span> <span id=\"anthemOn\">Sikiliza Wimbo wa Taifa</span><span id=\"anthemOff\" class=\"hidden\">Simamisha Wimbo wa Taifa</span></button>\n      </div>\n\n      <!-- Video inayoanza yenyewe + sauti -->\n      <div class=\"relative rounded-3xl overflow-hidden shadow-2xl mb-8 aspect-video bg-gradient-to-br from-blue-700 via-blue-500 to-green-600\">\n        <!-- Weka kiungo cha video yako kwenye VIDEO_SRC (script chini). Ikiwa tupu, slaidi zinaonekana. -->\n        <video id=\"introVideoB\" class=\"hidden absolute inset-0 w-full h-full object-cover z-20\" style=\"opacity:0;transition:opacity .35s\" playsinline preload=\"auto\"></video>\n        <video id=\"introVideo\" class=\"hidden absolute inset-0 w-full h-full object-cover z-20\" style=\"transition:opacity .35s\" autoplay playsinline preload=\"auto\"></video>\n\n        <div id=\"videoSlider\" class=\"absolute inset-0\">\n          <div class=\"video-slide active absolute inset-0 flex flex-col items-center justify-center text-white p-6 text-center\">\n            <div class=\"text-6xl mb-4\">👧👦🧒</div>\n            <p class=\"font-bold text-xl\">Watoto wanaimba kwa furaha</p>\n            <p class=\"text-sm opacity-90 mt-2\">Nyimbo wanazofundishwa darasani</p>\n          </div>\n          <div class=\"video-slide absolute inset-0 flex flex-col items-center justify-center text-white p-6 text-center\">\n            <div class=\"text-6xl mb-4\">🎈🎯🎨</div>\n            <p class=\"font-bold text-xl\">Wanacheza na kujifunza</p>\n            <p class=\"text-sm opacity-90 mt-2\">Shughuli za kufurahisha</p>\n          </div>\n          <div class=\"video-slide absolute inset-0 flex flex-col items-center justify-center text-white p-6 text-center\">\n            <div class=\"text-6xl mb-4\">🚶‍♂️🚶‍♀️👯‍♂️</div>\n            <p class=\"font-bold text-xl\">Wanatembea pamoja</p>\n            <p class=\"text-sm opacity-90 mt-2\">Ushirikiano na furaha</p>\n          </div>\n          <div class=\"video-slide absolute inset-0 flex flex-col items-center justify-center text-white p-6 text-center\">\n            <div class=\"text-6xl mb-4\">📖✏️🌟</div>\n            <p class=\"font-bold text-xl\">Wanajifunza kwa bidii</p>\n            <p class=\"text-sm opacity-90 mt-2\">Maendeleo yanayoonekana</p>\n          </div>\n        </div>\n        <div class=\"absolute bottom-4 left-0 right-0 flex justify-center gap-2 z-10\">\n          <div class=\"slide-dot w-2.5 h-2.5 rounded-full bg-white\"></div>\n          <div class=\"slide-dot w-2.5 h-2.5 rounded-full bg-white/40\"></div>\n          <div class=\"slide-dot w-2.5 h-2.5 rounded-full bg-white/40\"></div>\n          <div class=\"slide-dot w-2.5 h-2.5 rounded-full bg-white/40\"></div>\n        </div>\n      </div>\n\n      </div>\n\n      <div class=\"card rounded-3xl p-6 mb-8 lg:col-start-1 lg:row-start-2\">\n        <p id=\"attractMsg\" class=\"text-center text-slate-700 text-readable leading-relaxed\">\n          Weka ratiba za madarasa na matokeo, na wazazi wapate taarifa kwa SMS papo hapo bila shule kuhangaika.<br><br>\n          <strong class=\"text-blue-700 text-lg\">Sajili shule yako sasa!</strong>\n        </p>\n      </div>\n\n      <div class=\"space-y-5 lg:col-start-1 lg:row-start-3\">\n        <button onclick=\"showSchoolReg()\" class=\"btn-teacher confetti-btn w-full py-5 rounded-2xl font-bold text-xl\">\n          <span id=\"btnSchool\">Jisajili kama Mkuu wa Shule (Bure Kabisa)</span>\n        </button>\n        <button onclick=\"showParentReg()\" class=\"btn-parent confetti-btn w-full py-5 rounded-2xl font-bold text-xl\">\n          <span id=\"btnParent\">Jisajili kama Mzazi</span>\n        </button>\n        <button onclick=\"showLogin()\" class=\"btn-primary w-full py-4 rounded-2xl font-bold text-lg\">Nina akaunti • Ingia</button>\n      </div>\n      </div>\n\n      <p class=\"text-center text-sm text-slate-400 mt-10\">© 2026 SCHOOL LUBA TECH</p>\n      <p class=\"text-center mt-2\"><button onclick=\"showAdminLogin()\" class=\"text-xs text-slate-400 underline px-3 py-2\">Admin</button></p>\n    </main>\n  </div>\n\n  <div id=\"toast\" class=\"hidden fixed left-1/2 -translate-x-1/2 bottom-6 z-[10000] max-w-[92vw] px-5 py-3 rounded-2xl text-white font-semibold shadow-2xl text-center\"></div>\n\n  <!-- ====================== LOGIN ====================== -->\n  <div id=\"login\" class=\"hidden min-h-screen\">\n    <header class=\"bg-white border-b border-blue-100 sticky top-0 z-50 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-4 flex items-center gap-3\">\n        <button onclick=\"showLanding()\" class=\"text-blue-700 p-1\" aria-label=\"Rudi\">\n          <svg xmlns=\"http://www.w3.org/2000/svg\" class=\"w-7 h-7\" fill=\"none\" viewBox=\"0 0 24 24\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 19l-7-7 7-7\"/></svg>\n        </button>\n        <h2 class=\"font-bold text-xl text-slate-800\">Ingia kwenye Akaunti</h2>\n        <button onclick=\"toggleLang()\" class=\"lang-btn ml-auto shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\"><span>Change Language</span></button>\n      </div>\n    </header>\n    <main class=\"max-w-lg mx-auto px-4 py-8\">\n      <div class=\"card rounded-3xl p-6 space-y-6\">\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Simu</label>\n          <input id=\"lg-phone\" type=\"tel\" autocomplete=\"tel\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"07XXXXXXXX\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Nenosiri</label>\n          <input id=\"lg-pass\" type=\"password\" autocomplete=\"current-password\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\">\n        </div>\n        <button id=\"lg-btn\" onclick=\"doLogin()\" class=\"btn-primary w-full py-5 rounded-2xl font-bold text-xl\">Ingia</button>\n        <button onclick=\"showForgotPassword()\" class=\"w-full text-center text-blue-700 text-sm py-2 font-medium\">Umesahau nenosiri? (Forgot Password)</button>\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== ADMIN LOGIN ====================== -->\n  <div id=\"adminLogin\" class=\"hidden min-h-screen\">\n    <header class=\"bg-white border-b border-blue-100 sticky top-0 z-50 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-4 flex items-center gap-3\">\n        <button onclick=\"showLanding()\" class=\"text-blue-700 p-1\" aria-label=\"Rudi\">\n          <svg xmlns=\"http://www.w3.org/2000/svg\" class=\"w-7 h-7\" fill=\"none\" viewBox=\"0 0 24 24\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 19l-7-7 7-7\"/></svg>\n        </button>\n        <h2 class=\"font-bold text-xl text-slate-800\">Ingia kama Admin</h2>\n        <button onclick=\"toggleLang()\" class=\"lang-btn ml-auto shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\"><span>Change Language</span></button>\n      </div>\n    </header>\n    <main class=\"max-w-lg mx-auto px-4 py-8\">\n      <div class=\"card rounded-3xl p-6 space-y-6\">\n        <p class=\"text-slate-600 text-center\">Weka ufunguo wa admin. Haihifadhiwi kwenye kivinjari na utaombwa tena ukifunga ukurasa.</p>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Ufunguo wa Admin</label>\n          <input id=\"ad-key\" type=\"password\" autocomplete=\"off\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\">\n        </div>\n        <button id=\"ad-btn\" onclick=\"adminLogin()\" class=\"btn-primary w-full py-5 rounded-2xl font-bold text-xl\">Ingia</button>\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== ADMIN DASHBOARD ====================== -->\n  <div id=\"adminDash\" class=\"hidden min-h-screen\">\n    <header class=\"bg-gradient-to-r from-slate-800 to-blue-800 text-white sticky top-0 z-50 shadow-lg\">\n      <div class=\"max-w-lg mx-auto px-4 py-5 relative\">\n        <button onclick=\"toggleLang()\" class=\"lang-btn absolute right-4 top-4 text-sm font-semibold px-3 py-1.5 rounded-full bg-white/25 text-white border border-white/40\"><span>Change Language</span></button>\n        <div class=\"flex items-center gap-3\">\n          <div class=\"w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-xl\">🛡️</div>\n          <div>\n            <p class=\"text-blue-100 text-sm\">Msimamizi wa Mfumo</p>\n            <h2 class=\"font-bold text-xl\">Admin</h2>\n          </div>\n        </div>\n      </div>\n    </header>\n    <main class=\"max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <div class=\"grid grid-cols-2 gap-4\">\n        <div class=\"card rounded-2xl p-4 text-center\"><p id=\"ad-t-schools\" class=\"text-2xl font-bold text-blue-700\">0</p><p class=\"text-sm text-slate-500 mt-1\">Shule</p></div>\n        <div class=\"card rounded-2xl p-4 text-center\"><p id=\"ad-t-parents\" class=\"text-2xl font-bold text-orange-600\">0</p><p class=\"text-sm text-slate-500 mt-1\">Wazazi</p></div>\n        <div class=\"card rounded-2xl p-4 text-center\"><p id=\"ad-t-students\" class=\"text-2xl font-bold text-blue-700\">0</p><p class=\"text-sm text-slate-500 mt-1\">Wanafunzi</p></div>\n        <div class=\"card rounded-2xl p-4 text-center\"><p id=\"ad-t-paid\" class=\"text-2xl font-bold text-green-600\">TSh 0</p><p class=\"text-sm text-slate-500 mt-1\">Malipo yote</p></div>\n      </div>\n      <div class=\"card rounded-3xl p-5 space-y-5\">\n        <h3 class=\"font-bold text-lg\">Video na Wimbo wa Taifa</h3>\n        <div class=\"space-y-3\">\n          <p class=\"font-semibold text-slate-700\">Video za ukurasa wa mbele: sehemu 6, kila moja sekunde 5 (video ndefu inakatwa yenyewe)</p>\n          <p id=\"ad-cut-st\" class=\"text-sm text-blue-700\"></p>\n          <div id=\"ad-slots\" class=\"space-y-3\"></div>\n        </div>\n        <div class=\"space-y-2\">\n          <p class=\"font-semibold text-slate-700\">Wimbo wa Taifa (faili la sauti)</p>\n          <p id=\"ad-anthem-st\" class=\"text-sm text-slate-500\">Haijawekwa</p>\n          <input id=\"ad-anthem-file\" type=\"file\" accept=\"audio/mpeg,audio/mp4,audio/ogg,audio/wav\" class=\"block w-full text-sm\">\n          <div class=\"flex gap-3\">\n            <button id=\"ad-anthem-up\" onclick=\"uploadMedia('anthem')\" class=\"btn-teacher flex-1 py-3 rounded-xl font-bold\">Pakia</button>\n            <button onclick=\"removeMedia('anthem')\" class=\"px-4 py-3 rounded-xl font-bold bg-red-50 text-red-700 border border-red-200\">Ondoa</button>\n          </div>\n        </div>\n      </div>\n      <div>\n        <h3 class=\"font-bold text-lg mb-3\">Maombi ya Kutoa Pesa</h3>\n        <div id=\"ad-withdrawals\" class=\"card rounded-3xl overflow-hidden\"></div>\n      </div>\n      <div>\n        <h3 class=\"font-bold text-lg mb-3\">Shule</h3>\n        <div id=\"ad-schools\" class=\"space-y-3\"></div>\n      </div>\n      <button onclick=\"adminLogout()\" class=\"w-full py-4 text-blue-700 font-semibold\">Toka</button>\n    </main>\n  </div>\n\n  <!-- ====================== SCHOOL REGISTRATION ====================== -->\n  <div id=\"schoolReg\" class=\"hidden min-h-screen\">\n    <header class=\"bg-white border-b border-blue-100 sticky top-0 z-50 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-4 flex items-center gap-3\">\n        <button onclick=\"showLanding()\" class=\"text-blue-700 p-1\" aria-label=\"Rudi\">\n          <svg xmlns=\"http://www.w3.org/2000/svg\" class=\"w-7 h-7\" fill=\"none\" viewBox=\"0 0 24 24\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 19l-7-7 7-7\"/></svg>\n        </button>\n        <h2 class=\"font-bold text-xl text-slate-800\">Usajili wa Mkuu wa Shule</h2>\n        <button onclick=\"toggleLang()\" class=\"lang-btn ml-auto shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\"><span>Change Language</span></button>\n      </div>\n    </header>\n\n    <main class=\"max-w-lg mx-auto px-4 py-6\">\n      <div class=\"card rounded-3xl p-6 space-y-6\">\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Jina la Shule</label>\n          <input id=\"sc-school\" type=\"text\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"Mfano: Shule ya Msingi Uhuru - Mwanza\">\n          <p class=\"text-sm text-slate-500 mt-2\">Wazazi wataandika jina hili kujisajili, kwa hiyo liwe kamili na la kipekee.</p>\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Aina ya Shule</label>\n          <select id=\"sc-type\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\">\n            <option value=\"chekechea\">Shule ya Chekechea</option>\n            <option value=\"msingi\" selected>Shule ya Msingi</option>\n            <option value=\"sekondari\">Shule ya Sekondari</option>\n          </select>\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Jina la Msimamizi (Mkuu wa Shule / Ofisi)</label>\n          <input id=\"sc-name\" type=\"text\" autocomplete=\"name\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"Jina kamili\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Simu ya Shule</label>\n          <input id=\"sc-phone\" type=\"tel\" autocomplete=\"tel\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"07XXXXXXXX\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Uthibitisho (OTP)</label>\n          <div class=\"flex gap-2\">\n            <input id=\"sc-otp\" type=\"text\" inputmode=\"numeric\" maxlength=\"6\" autocomplete=\"one-time-code\" class=\"input-light flex-1 min-w-0 px-5 py-4 text-lg rounded-2xl text-center tracking-widest\" placeholder=\"• • • • • •\">\n            <button id=\"sc-otp-btn\" type=\"button\" onclick=\"requestOtp('register', 'sc-phone', 'sc-otp-btn', 'sc-otp-msg')\" class=\"btn-primary px-4 rounded-2xl font-bold shrink-0\">Tuma OTP<span></span></button>\n          </div>\n          <p id=\"sc-otp-msg\" class=\"text-sm text-slate-500 mt-2\">Bonyeza \"Tuma OTP\" upokee namba ya tarakimu 6 kwa SMS kwenye simu hiyo.</p>\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Nenosiri (angalau herufi 8)</label>\n          <input id=\"sc-pass\" type=\"password\" autocomplete=\"new-password\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"••••••••\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Picha yako (Mwalimu Mkuu)</label>\n          <input id=\"sc-photo\" type=\"file\" accept=\"image/*\" class=\"block w-full text-sm\">\n        </div>\n        <button id=\"sc-btn\" onclick=\"completeSchoolReg()\" class=\"btn-teacher w-full py-5 rounded-2xl font-bold text-xl\">Kamilisha Usajili</button>\n        <button onclick=\"showLogin()\" class=\"w-full text-center text-blue-700 text-sm py-2 font-medium\">Tayari una akaunti? Ingia</button>\n        <button onclick=\"showForgotPassword()\" class=\"w-full text-center text-blue-700 text-sm py-2 font-medium\">Umesahau nenosiri? (Forgot Password)</button>\n      </div>\n\n      <div class=\"mt-6 bg-yellow-50 border border-yellow-300 rounded-2xl p-5 text-base text-yellow-900\">\n        <strong class=\"text-lg\">🎁 Bonasi kwa Shule:</strong><br>\n        Shule yako itapata <strong>asilimia 35</strong> ya kila malipo ya <strong>TSh 1,000</strong> kwa mwezi yanayolipwa na kila mzazi.\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== PARENT REGISTRATION ====================== -->\n  <div id=\"parentReg\" class=\"hidden min-h-screen\">\n    <header class=\"bg-white border-b border-blue-100 sticky top-0 z-50 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-4 flex items-center gap-3\">\n        <button onclick=\"showLanding()\" class=\"text-orange-600 p-1\" aria-label=\"Rudi\">\n          <svg xmlns=\"http://www.w3.org/2000/svg\" class=\"w-7 h-7\" fill=\"none\" viewBox=\"0 0 24 24\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 19l-7-7 7-7\"/></svg>\n        </button>\n        <h2 class=\"font-bold text-xl text-slate-800\">Usajili wa Mzazi</h2>\n        <button onclick=\"toggleLang()\" class=\"lang-btn ml-auto shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\"><span>Change Language</span></button>\n      </div>\n    </header>\n\n    <main class=\"max-w-lg mx-auto px-4 py-6\">\n      <div class=\"bg-yellow-50 border-2 border-yellow-300 rounded-2xl p-5 mb-6 text-base text-yellow-900\">\n        <strong class=\"text-lg\">⚠️ Muhimu sana:</strong><br>\n        Hakikisha umeweka <u>jina la shule</u>, <u>namba ya mwanafunzi</u> na <u>tarehe ya kuzaliwa</u>.\n      </div>\n\n      <div class=\"card rounded-3xl p-6 space-y-6\">\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Jina la Mzazi</label>\n          <input id=\"pr-name\" type=\"text\" autocomplete=\"name\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"Andika jina lako\">\n        </div>\n        <div class=\"bg-blue-50 border border-blue-200 rounded-2xl p-4 text-base text-blue-900\">\n          📷 Baada ya kujisajili utaweza kuweka picha kwenye dashibodi yako.\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Simu</label>\n          <input id=\"pr-phone\" type=\"tel\" autocomplete=\"tel\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"07XXXXXXXX\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Uthibitisho (OTP)</label>\n          <div class=\"flex gap-2\">\n            <input id=\"pr-otp\" type=\"text\" inputmode=\"numeric\" maxlength=\"6\" autocomplete=\"one-time-code\" class=\"input-light flex-1 min-w-0 px-5 py-4 text-lg rounded-2xl text-center tracking-widest\" placeholder=\"• • • • • •\">\n            <button id=\"pr-otp-btn\" type=\"button\" onclick=\"requestOtp('register', 'pr-phone', 'pr-otp-btn', 'pr-otp-msg')\" class=\"btn-primary px-4 rounded-2xl font-bold shrink-0\">Tuma OTP<span></span></button>\n          </div>\n          <p id=\"pr-otp-msg\" class=\"text-sm text-slate-500 mt-2\">Bonyeza \"Tuma OTP\" upokee namba ya tarakimu 6 kwa SMS kwenye simu hiyo.</p>\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Nenosiri (angalau herufi 8)</label>\n          <input id=\"pr-pass\" type=\"password\" autocomplete=\"new-password\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Jina la Shule</label>\n          <input id=\"pr-school\" type=\"text\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"Andika jina kamili la shule\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Mwanafunzi</label>\n          <input id=\"pr-stno\" type=\"text\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"Namba ya usajili wa mwanafunzi\">\n        </div>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Tarehe na Mwaka wa Kuzaliwa wa Mtoto</label>\n          <div class=\"grid grid-cols-2 gap-3\">\n            <div>\n              <label class=\"block text-sm text-blue-700 font-medium mb-1\">Tarehe (Siku/Mwezi)</label>\n              <input id=\"pr-dd\" type=\"text\" inputmode=\"numeric\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Mfano: 15/03\">\n            </div>\n            <div>\n              <label class=\"block text-sm text-blue-700 font-medium mb-1\">Mwaka</label>\n              <input id=\"pr-yy\" type=\"text\" inputmode=\"numeric\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Mfano: 2018\">\n            </div>\n          </div>\n        </div>\n        <button id=\"pr-btn\" onclick=\"completeParentReg()\" class=\"btn-parent w-full py-5 rounded-2xl font-bold text-xl mt-3\">Kamilisha Usajili</button>\n        <button onclick=\"showLogin()\" class=\"w-full text-center text-orange-600 text-sm py-2 font-medium\">Tayari una akaunti? Ingia</button>\n        <button onclick=\"showForgotPassword()\" class=\"w-full text-center text-orange-600 text-sm py-2 font-medium\">Umesahau nenosiri? (Forgot Password)</button>\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== FORGOT PASSWORD ====================== -->\n  <div id=\"forgotPassword\" class=\"hidden min-h-screen\">\n    <header class=\"bg-white border-b border-blue-100 sticky top-0 z-50 shadow-sm\">\n      <div class=\"max-w-lg mx-auto px-4 py-4 flex items-center gap-3\">\n        <button onclick=\"showLogin()\" class=\"text-blue-700 p-1\" aria-label=\"Rudi\">\n          <svg xmlns=\"http://www.w3.org/2000/svg\" class=\"w-7 h-7\" fill=\"none\" viewBox=\"0 0 24 24\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 19l-7-7 7-7\"/></svg>\n        </button>\n        <h2 class=\"font-bold text-xl text-slate-800\">Umesahau Nenosiri</h2>\n        <button onclick=\"toggleLang()\" class=\"lang-btn ml-auto shrink-0 text-sm font-semibold px-3 py-2 rounded-full bg-blue-50 text-blue-700 border border-blue-200\"><span>Change Language</span></button>\n      </div>\n    </header>\n    <main class=\"max-w-lg mx-auto px-4 py-8\">\n      <div class=\"card rounded-3xl p-6 space-y-6\">\n        <p class=\"text-slate-600 text-center\">Weka namba ya simu uliyojisajilia nayo. Tutakutumia <strong class=\"text-blue-700\">OTP</strong> kwa SMS.</p>\n        <div>\n          <label class=\"block text-base font-semibold text-slate-700 mb-2\">Namba ya Simu</label>\n          <input id=\"fp-phone\" type=\"tel\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\" placeholder=\"07XXXXXXXX\">\n        </div>\n        <button id=\"fp-send\" onclick=\"requestOtp('reset', 'fp-phone', 'fp-send', 'fp-msg')\" class=\"btn-primary w-full py-4 rounded-2xl font-bold text-lg\">Tuma OTP<span></span></button>\n        <p id=\"fp-msg\" class=\"text-sm text-slate-500 -mt-3\"></p>\n        <div class=\"pt-4 border-t border-slate-200 space-y-4\">\n          <div>\n            <label class=\"block text-base font-semibold text-slate-700 mb-2\">Weka OTP uliyopokea</label>\n            <input id=\"fp-otp\" type=\"text\" inputmode=\"numeric\" maxlength=\"6\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl text-center tracking-widest\" placeholder=\"• • • • • •\">\n          </div>\n          <div>\n            <label class=\"block text-base font-semibold text-slate-700 mb-2\">Nenosiri jipya (angalau herufi 8)</label>\n            <input id=\"fp-pass\" type=\"password\" autocomplete=\"new-password\" class=\"input-light w-full px-5 py-4 text-lg rounded-2xl\">\n          </div>\n        </div>\n        <button id=\"fp-reset\" onclick=\"resetPassword()\" class=\"btn-secondary w-full py-4 rounded-2xl font-bold text-lg\">Thibitisha OTP & Badilisha Nenosiri</button>\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== SCHOOL DASHBOARD ====================== -->\n  <div id=\"schoolDash\" class=\"hidden min-h-screen\">\n    <header class=\"bg-gradient-to-r from-blue-700 to-green-700 text-white sticky top-0 z-50 shadow-lg\">\n      <div class=\"max-w-lg mx-auto px-4 py-5 relative\">\n        <button onclick=\"toggleLang()\" class=\"lang-btn absolute right-4 top-4 text-sm font-semibold px-3 py-1.5 rounded-full bg-white/25 text-white border border-white/40\"><span>Change Language</span></button>\n        <div class=\"flex items-center gap-3\">\n          <div id=\"sd-av\" class=\"w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-xl overflow-hidden shrink-0 cursor-pointer\" onclick=\"changeSchoolPhoto()\">🏫</div>\n          <div>\n            <p class=\"text-blue-100 text-sm\">Karibu Shule,</p>\n            <h2 id=\"sd-name\" class=\"font-bold text-xl\">…</h2>\n            <p id=\"sd-contact\" class=\"text-blue-100 text-xs\"></p>\n          </div>\n        </div>\n      </div>\n    </header>\n\n    <!-- Ukurasa mkuu -->\n    <main id=\"sd-main\" class=\"max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <div class=\"bg-gradient-to-r from-blue-700 to-green-700 rounded-3xl p-6 text-white shadow-xl\">\n        <p class=\"text-blue-100\">Kamisheni ya shule (35%)</p>\n        <h3 id=\"sd-balance\" class=\"text-4xl font-extrabold mt-1\">TSh 0</h3>\n        <p id=\"sd-paidmonth\" class=\"text-blue-100 mt-2\"></p>\n        <button onclick=\"withdraw()\" class=\"mt-5 w-full bg-yellow-400 text-blue-950 font-bold py-3.5 rounded-2xl text-lg\">Toa Pesa (kiwango cha chini TSh 3,500)</button>\n      </div>\n\n      <div class=\"grid grid-cols-2 gap-4\">\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"sd-students\" class=\"text-3xl font-bold text-blue-700\">0</p><p class=\"text-sm text-slate-500 mt-1\">Wanafunzi</p></div>\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"sd-classes\" class=\"text-3xl font-bold text-blue-700\">0</p><p class=\"text-sm text-slate-500 mt-1\">Madarasa</p></div>\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"sd-parents\" class=\"text-3xl font-bold text-orange-600\">0</p><p class=\"text-sm text-slate-500 mt-1\">Wazazi Waliojisajili</p></div>\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"sd-paid\" class=\"text-3xl font-bold text-green-600\">0</p><p class=\"text-sm text-slate-500 mt-1\">Wamelipa</p></div>\n      </div>\n\n      <div class=\"bg-blue-50 border border-blue-200 rounded-2xl p-4 text-center\">\n        <p class=\"text-sm text-slate-600\">SMS za mwezi huu</p>\n        <p id=\"sd-sms\" class=\"text-xl font-bold text-blue-700\"></p>\n      </div>\n\n      <div class=\"card rounded-3xl p-5 space-y-3\">\n        <h4 class=\"font-bold text-lg\">📱 Namba za Simu za Shule</h4>\n        <p class=\"text-sm text-slate-500\">Namba ya kuingia: <span id=\"sd-loginphone\" class=\"font-bold text-blue-700\"></span><br>Namba ya kupokea kamisheni ya 35%: <span id=\"sd-payout\" class=\"font-bold text-blue-700\"></span></p>\n        <select id=\"po-kind\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\">\n          <option value=\"login\">Badilisha namba ya kuingia</option>\n          <option value=\"payout\">Badilisha namba ya kupokea malipo</option>\n        </select>\n        <input id=\"po-phone\" type=\"tel\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Namba mpya 07XXXXXXXX\">\n        <div class=\"flex gap-2\">\n          <input id=\"po-otp\" type=\"text\" inputmode=\"numeric\" maxlength=\"6\" autocomplete=\"one-time-code\" class=\"input-light flex-1 min-w-0 px-4 py-3 text-lg rounded-xl text-center tracking-widest\" placeholder=\"OTP\">\n          <button id=\"po-otp-btn\" type=\"button\" onclick=\"requestOtp(val('po-kind') === 'payout' ? 'payout' : 'phone', 'po-phone', 'po-otp-btn', 'po-otp-msg')\" class=\"btn-primary px-4 rounded-xl font-bold shrink-0\">Tuma OTP<span></span></button>\n        </div>\n        <p id=\"po-otp-msg\" class=\"text-sm text-slate-500\"></p>\n        <input id=\"po-pass\" type=\"password\" autocomplete=\"current-password\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Nenosiri lako (kuthibitisha)\">\n        <button onclick=\"changePhone()\" class=\"btn-primary w-full py-3 rounded-2xl font-bold\">Badilisha Namba</button>\n        <div id=\"sd-wlist\" class=\"text-sm text-slate-600 space-y-1\"></div>\n      </div>\n\n      <div class=\"card rounded-3xl overflow-hidden\">\n        <button onclick=\"openPanel('students')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5 border-b border-slate-100\"><span class=\"text-2xl\">👨‍🎓</span><span class=\"font-semibold text-lg\">Madarasa na Wanafunzi</span></button>\n        <button onclick=\"openPanel('timetable')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5 border-b border-slate-100\"><span class=\"text-2xl\">🗓️</span><span class=\"font-semibold text-lg\">Ratiba za Madarasa</span></button>\n        <button onclick=\"openPanel('staff')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5 border-b border-slate-100\"><span class=\"text-2xl\">👩‍🏫</span><span class=\"font-semibold text-lg\">Walimu wa Shule</span></button>\n        <button onclick=\"openPanel('results')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5 border-b border-slate-100\"><span class=\"text-2xl\">📝</span><span class=\"font-semibold text-lg\">Weka Matokeo ya Mtihani</span></button>\n        <button onclick=\"openPanel('sms')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5 border-b border-slate-100\"><span class=\"text-2xl\">📨</span><span class=\"font-semibold text-lg\">Tuma SMS</span></button>\n        <button onclick=\"openPanel('payments')\" class=\"w-full text-left flex items-center gap-4 px-6 py-5\"><span class=\"text-2xl\">💳</span><span class=\"font-semibold text-lg\">Miamala ya Wazazi</span></button>\n      </div>\n\n      <button onclick=\"logout()\" class=\"w-full py-4 text-blue-700 font-semibold\">Toka kwenye Akaunti</button>\n    </main>\n\n    <!-- Paneli: Madarasa na Wanafunzi -->\n    <main id=\"sd-students-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Ongeza Darasa</h3>\n        <input id=\"cl-name\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Mfano: Darasa la 4 A, au Form 2\">\n        <button onclick=\"addClass()\" class=\"btn-teacher w-full py-4 rounded-2xl font-bold text-lg\">Ongeza Darasa</button>\n      </div>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Ongeza Mwanafunzi</h3>\n        <select id=\"st-class\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\"></select>\n        <input id=\"st-no\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Namba ya mwanafunzi\">\n        <input id=\"st-name\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Jina la mwanafunzi\">\n        <div class=\"grid grid-cols-2 gap-3\">\n          <input id=\"st-dd\" type=\"text\" inputmode=\"numeric\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Siku/Mwezi 15/03\">\n          <input id=\"st-yy\" type=\"text\" inputmode=\"numeric\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Mwaka 2018\">\n        </div>\n        <input id=\"st-pphone\" type=\"tel\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Simu ya mzazi (si lazima, kwa mwaliko wa SMS)\">\n        <button onclick=\"addStudent()\" class=\"btn-teacher w-full py-4 rounded-2xl font-bold text-lg\">Ongeza Mwanafunzi</button>\n        <p class=\"text-sm text-slate-500\">Mzazi atatumia namba hii, jina la shule na tarehe ya kuzaliwa kujisajili. Picha ya mwanafunzi unaiweka kwa kubonyeza 📷 kwenye orodha.</p>\n      </div>\n      <div class=\"card rounded-3xl p-6 space-y-3\">\n        <h3 class=\"font-bold text-lg\">Alika Wazazi kwa SMS</h3>\n        <p class=\"text-sm text-slate-500\">Inatuma SMS yenye kiungo cha mfumo na namba ya mwanafunzi kwa wazazi ambao bado hawajajisajili (wenye simu iliyowekwa). Hakuna anayetumiwa zaidi ya mara moja kwa saa 24.</p>\n        <button onclick=\"inviteParents()\" class=\"btn-primary w-full py-4 rounded-2xl font-bold text-lg\">Alika Wazazi Wasiojisajili</button>\n      </div>\n      <div id=\"st-list\" class=\"card rounded-3xl overflow-hidden\"></div>\n    </main>\n\n    <!-- Paneli: Ratiba -->\n    <main id=\"sd-timetable-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Ratiba ya Darasa</h3>\n        <select id=\"tt-class\" onchange=\"loadTimetable()\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\"></select>\n        <select id=\"tt-day\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\">\n          <option value=\"1\">Jumatatu</option><option value=\"2\">Jumanne</option><option value=\"3\">Jumatano</option>\n          <option value=\"4\">Alhamisi</option><option value=\"5\">Ijumaa</option><option value=\"6\">Jumamosi</option>\n        </select>\n        <div class=\"grid grid-cols-2 gap-3\">\n          <div><label class=\"block text-sm text-blue-700 font-medium mb-1\">Kuanza</label><input id=\"tt-start\" type=\"time\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\"></div>\n          <div><label class=\"block text-sm text-blue-700 font-medium mb-1\">Kumaliza</label><input id=\"tt-end\" type=\"time\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\"></div>\n        </div>\n        <input id=\"tt-subject\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Somo (mfano: Hisabati)\">\n        <input id=\"tt-teacher\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Mwalimu wa somo (si lazima)\">\n        <label class=\"flex items-center gap-3 text-base text-slate-700\"><input id=\"tt-notify\" type=\"checkbox\" class=\"w-5 h-5\"> Arifu wazazi wa darasa hili kwa SMS</label>\n        <button onclick=\"addTimetable()\" class=\"btn-teacher w-full py-4 rounded-2xl font-bold text-lg\">Ongeza Kipindi</button>\n      </div>\n      <div id=\"tt-list\" class=\"card rounded-3xl overflow-hidden\"></div>\n    </main>\n\n    <!-- Paneli: Walimu -->\n    <main id=\"sd-staff-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Ongeza Mwalimu</h3>\n        <input id=\"sf-name\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Jina la mwalimu\">\n        <input id=\"sf-phone\" type=\"tel\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"07XXXXXXXX\">\n        <input id=\"sf-subject\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Somo (si lazima)\">\n        <button onclick=\"addStaff()\" class=\"btn-teacher w-full py-4 rounded-2xl font-bold text-lg\">Ongeza</button>\n        <p class=\"text-sm text-slate-500\">Walimu hawahitaji akaunti. Wanapokea SMS za shule kupitia namba hii.</p>\n      </div>\n      <div id=\"sf-list\" class=\"card rounded-3xl overflow-hidden\"></div>\n    </main>\n\n    <!-- Paneli: Matokeo -->\n    <main id=\"sd-results-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Weka Matokeo</h3>\n        <input id=\"rs-no\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Namba ya mwanafunzi\">\n        <input id=\"rs-subject\" type=\"text\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Somo (mfano: Hisabati)\">\n        <input id=\"rs-score\" type=\"number\" min=\"0\" max=\"100\" inputmode=\"numeric\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Alama (0-100)\">\n        <label class=\"flex items-center gap-3 text-base text-slate-700\"><input id=\"rs-notify\" type=\"checkbox\" checked class=\"w-5 h-5\"> Tuma SMS kwa mzazi moja kwa moja</label>\n        <button onclick=\"saveResult()\" class=\"btn-teacher w-full py-4 rounded-2xl font-bold text-lg\">Hifadhi Matokeo</button>\n      </div>\n    </main>\n\n    <!-- Paneli: Miamala -->\n    <main id=\"sd-payments-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"grid grid-cols-2 gap-4\">\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"py-total\" class=\"text-2xl font-bold text-blue-700\">TSh 0</p><p class=\"text-sm text-slate-500 mt-1\">Zilizolipwa na wazazi</p></div>\n        <div class=\"card rounded-2xl p-5 text-center\"><p id=\"py-comm\" class=\"text-2xl font-bold text-green-600\">TSh 0</p><p class=\"text-sm text-slate-500 mt-1\">Kamisheni ya shule (35%)</p></div>\n      </div>\n      <div id=\"py-list\" class=\"card rounded-3xl overflow-hidden\"></div>\n    </main>\n\n    <!-- Paneli: SMS -->\n    <main id=\"sd-sms-panel\" class=\"hidden max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <button onclick=\"openPanel(null)\" class=\"text-blue-700 font-semibold\">← Rudi</button>\n      <div class=\"card rounded-3xl p-6 space-y-4\">\n        <h3 class=\"font-bold text-lg\">Tuma SMS</h3>\n        <div class=\"grid grid-cols-2 gap-3\">\n          <button id=\"smsm-all\" onclick=\"setSmsMode('all')\" class=\"py-3 rounded-2xl font-bold\">Wazazi Wote</button>\n          <button id=\"smsm-one\" onclick=\"setSmsMode('one')\" class=\"py-3 rounded-2xl font-bold\">Mzazi Mmoja</button>\n        </div>\n        <div id=\"sms-one-box\" class=\"hidden space-y-3\">\n          <input id=\"sms-search\" type=\"text\" oninput=\"filterParents()\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Tafuta mzazi au mwanafunzi\">\n          <select id=\"sms-parent\" size=\"6\" class=\"input-light w-full px-3 py-2 text-base rounded-xl\"></select>\n        </div>\n        <textarea id=\"sms-msg\" rows=\"4\" maxlength=\"300\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Andika ujumbe (hadi herufi 300). Jina la shule linaongezwa mwanzoni.\"></textarea>\n        <p id=\"sms-left\" class=\"text-sm text-slate-500\"></p>\n        <button id=\"sms-send-all\" onclick=\"sendSchoolSms()\" class=\"btn-primary w-full py-4 rounded-2xl font-bold text-lg\">Tuma kwa Wazazi Wote</button>\n        <button id=\"sms-send-one\" onclick=\"sendSchoolSms()\" class=\"hidden btn-primary w-full py-4 rounded-2xl font-bold text-lg\">Tuma kwa Mzazi Huyu</button>\n        <div id=\"sms-report\" class=\"hidden rounded-2xl p-4 text-base space-y-1\"></div>\n      </div>\n    </main>\n  </div>\n\n  <!-- ====================== PARENT DASHBOARD ====================== -->\n  <div id=\"parentDash\" class=\"hidden min-h-screen\">\n    <header class=\"bg-gradient-to-r from-blue-600 to-orange-500 text-white sticky top-0 z-50 shadow-lg\">\n      <div class=\"max-w-lg mx-auto px-4 py-5 relative\">\n        <button onclick=\"toggleLang()\" class=\"lang-btn absolute right-4 top-4 text-sm font-semibold px-3 py-1.5 rounded-full bg-white/25 text-white border border-white/40\"><span>Change Language</span></button>\n        <div class=\"flex items-center gap-3\">\n          <div class=\"w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-xl\">👩</div>\n          <div>\n            <p class=\"text-blue-100 text-sm\">Karibu Mzazi,</p>\n            <h2 id=\"pd-name\" class=\"font-bold text-xl\">…</h2>\n          </div>\n        </div>\n      </div>\n    </header>\n\n    <main class=\"max-w-lg mx-auto px-4 py-6 space-y-5\">\n      <div class=\"bg-green-50 border border-green-200 rounded-2xl p-5 text-center\">\n        <p class=\"text-green-800 font-semibold text-lg\">🌿 Ubarikiwe sana kwa kufuatilia taarifa za mtoto wako</p>\n      </div>\n\n      <div class=\"card rounded-3xl p-6\">\n        <div class=\"flex items-center gap-5\">\n          <div id=\"pd-avatar\" class=\"w-20 h-20 rounded-2xl bg-blue-50 flex items-center justify-center text-4xl overflow-hidden shrink-0\">🧒</div>\n          <div>\n            <h3 id=\"pd-child\" class=\"font-bold text-xl\"></h3>\n            <p id=\"pd-class\" class=\"text-base text-slate-500\"></p>\n            <p id=\"pd-school\" class=\"text-sm text-slate-400\"></p>\n          </div>\n        </div>\n        <button onclick=\"pickChildPhoto()\" class=\"btn-primary w-full py-3 rounded-2xl font-bold text-base mt-4\">📷 Weka / Badilisha Picha ya Mtoto</button>\n      </div>\n\n      <div class=\"card rounded-3xl p-6\">\n        <h4 class=\"font-bold text-lg mb-4\">🗓️ Ratiba ya Darasa</h4>\n        <div id=\"pd-timetable\" class=\"space-y-3 text-base\"></div>\n      </div>\n\n      <div class=\"card rounded-3xl p-6\">\n        <h4 class=\"font-bold text-lg mb-4\">📊 Matokeo ya Mtihani</h4>\n        <div id=\"pd-results\" class=\"space-y-3 text-base\"></div>\n      </div>\n\n      <div class=\"card rounded-3xl p-5 space-y-3\">\n        <h4 class=\"font-bold text-lg\">📞 Namba za Simu</h4>\n        <p class=\"text-sm text-slate-500\">Namba yako ya kuingia: <span id=\"pd-myphone\" class=\"font-bold text-blue-700\"></span></p>\n        <input id=\"pp-phone\" type=\"tel\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Namba mpya ya kuingia 07XXXXXXXX\">\n        <div class=\"flex gap-2\">\n          <input id=\"pp-otp\" type=\"text\" inputmode=\"numeric\" maxlength=\"6\" autocomplete=\"one-time-code\" class=\"input-light flex-1 min-w-0 px-4 py-3 text-lg rounded-xl text-center tracking-widest\" placeholder=\"OTP\">\n          <button id=\"pp-otp-btn\" type=\"button\" onclick=\"requestOtp('phone', 'pp-phone', 'pp-otp-btn', 'pp-otp-msg')\" class=\"btn-primary px-4 rounded-xl font-bold shrink-0\">Tuma OTP<span></span></button>\n        </div>\n        <p id=\"pp-otp-msg\" class=\"text-sm text-slate-500\"></p>\n        <input id=\"pp-pass\" type=\"password\" autocomplete=\"current-password\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl\" placeholder=\"Nenosiri lako (kuthibitisha)\">\n        <button onclick=\"changeMyPhone()\" class=\"btn-primary w-full py-3 rounded-2xl font-bold\">Badilisha Namba ya Kuingia</button>\n      </div>\n\n      <div class=\"card rounded-3xl p-6 text-center\">\n        <p id=\"payInfo\" class=\"text-base text-slate-500 mb-1\"></p>\n        <p id=\"payInfo2\" class=\"text-sm text-orange-600 font-medium mb-5\"></p>\n        <input id=\"pay-phone\" type=\"tel\" class=\"input-light w-full px-4 py-3 text-lg rounded-xl mb-2\" placeholder=\"Namba ya kulipia (acha tupu kutumia namba yako)\">\n        <p class=\"text-sm text-slate-500 mb-3\">Mwenye namba atapokea ombi kwenye simu yake; pesa haikatwi bila yeye kuweka PIN.</p>\n        <button id=\"payBtn\" onclick=\"payNow()\" class=\"btn-parent w-full py-5 rounded-2xl font-bold text-xl\">Lipia Sasa TSh 1,000</button>\n        <button id=\"mockBtn\" onclick=\"mockConfirm()\" class=\"hidden mt-4 w-full py-3 rounded-2xl font-bold bg-slate-800 text-white\">Thibitisha malipo (majaribio)</button>\n        <p class=\"text-sm text-slate-400 mt-4\">Baada ya kulipia kitaonekana \"Imeshalipwa\"</p>\n      </div>\n\n      <div class=\"bg-blue-50 border border-blue-200 rounded-2xl p-5 text-center\">\n        <p class=\"text-sm text-slate-500 mb-1\">Kwa msaada zaidi wasiliana na shule</p>\n        <p id=\"pd-tphone\" class=\"text-xl font-bold text-blue-700\"></p>\n        <p id=\"pd-tname\" class=\"text-sm text-slate-500 mt-1\"></p>\n      </div>\n\n      <button onclick=\"logout()\" class=\"w-full py-4 text-blue-700 font-semibold\">Toka kwenye Akaunti</button>\n    </main>\n  </div>\n\n  <footer class=\"text-center text-sm text-slate-500 py-6 px-4 bg-white/70\">\n    <p>Msaada (Team Support)</p>\n    <a href=\"tel:+255667061999\" class=\"font-bold text-blue-700 text-lg\" data-no-i18n>+255667061999</a>\n  </footer>\n\n  <script>\n    /* ================= MIPANGILIO YA VIDEO =================\n       Seva inaweka kiungo cha video kutoka kwenye VIDEO_URL (mazingira). Ikiwa tupu, slaidi za picha zinaonyeshwa pamoja na muziki mdogo. */\n    const VIDEO_SRC = \"\";\n\n    // Sherehe (confetti/sauti) hazipaswi kuvunja usajili au malipo mtandao ukiwa dhaifu\n    window.addEventListener('load', function () { if (typeof window.confetti !== 'function') window.confetti = function () {}; });\n\n    /* ================= LUGHA (Kiswahili / English) ================= */\n    const EN = Object.assign(Object.create(null), {\"Video za ukurasa wa mbele: sehemu 6, kila moja sekunde 5 (video ndefu inakatwa yenyewe)\": \"Front page videos: 6 slots, 5 seconds each (longer videos are cut automatically)\", \"Video haikukatwa. Jaribu faili lingine.\": \"Video could not be cut. Try another file.\", \"Video haiwezi kusomwa\": \"Video cannot be read\", \"Imepakiwa. Video imekatwa kuwa sekunde 5.\": \"Uploaded. Video cut to 5 seconds.\", \"Inakata video iwe sekunde 5… subiri\": \"Cutting video to 5 seconds… please wait\", \"Video\": \"Video\", \"Weka picha yako\": \"Please add your photo\", \"Picha yako (Mwalimu Mkuu)\": \"Your photo (Head Teacher)\", \"Mfumo wa Shule\": \"School System\", \"Change Language\": \"Badili Lugha\", \"Karibu Shule,\": \"Welcome School,\", \"Mnaleta Muangaza\": \"You Bring the Light\", \"kwa watoto wetu\": \"to our children\", \"Usajili rahisi, kumbukumbu salama za wanafunzi na ufuatiliaji wa wazazi\": \"Easy registration, secure student records and parent follow-up\", \"Karibu kwenye\": \"Welcome to\", \"Watoto wanaimba kwa furaha\": \"Children singing happily\", \"Nyimbo wanazofundishwa darasani\": \"Songs they learn in class\", \"Wanacheza na kujifunza\": \"Playing and learning\", \"Shughuli za kufurahisha\": \"Fun activities\", \"Wanatembea pamoja\": \"Walking together\", \"Ushirikiano na furaha\": \"Teamwork and joy\", \"Wanajifunza kwa bidii\": \"Learning hard\", \"Maendeleo yanayoonekana\": \"Visible progress\", \"Weka ratiba za madarasa na matokeo, na wazazi wapate taarifa kwa SMS papo hapo bila shule kuhangaika.\": \"Set class timetables and results, and parents get updates by SMS right away, without the school having to chase them.\", \"Sajili shule yako sasa!\": \"Register your school now!\", \"Jisajili kama Mkuu wa Shule (Bure Kabisa)\": \"Register as School Head (Completely Free)\", \"Jisajili kama Mzazi\": \"Register as Parent\", \"Nina akaunti • Ingia\": \"I have an account • Log in\", \"© 2026 SCHOOL LUBA TECH\": \"© 2026 SCHOOL LUBA TECH\", \"Ingia kwenye Akaunti\": \"Log in to your Account\", \"Namba ya Simu\": \"Phone Number\", \"Nenosiri\": \"Password\", \"Ingia\": \"Log in\", \"Umesahau nenosiri? (Forgot Password)\": \"Forgot your password?\", \"Ingia kama Admin\": \"Admin Login\", \"Weka ufunguo wa admin. Haihifadhiwi kwenye kivinjari na utaombwa tena ukifunga ukurasa.\": \"Enter the admin key. It is not stored in the browser and you will be asked again if you close the page.\", \"Ufunguo wa Admin\": \"Admin Key\", \"Msimamizi wa Mfumo\": \"System Administrator\", \"Shule\": \"Schools\", \"Wazazi\": \"Parents\", \"Wanafunzi\": \"Students\", \"Malipo yote\": \"All payments\", \"Maombi ya Kutoa Pesa\": \"Withdrawal Requests\", \"Toka\": \"Log out\", \"Usajili wa Mkuu wa Shule\": \"School Head Registration\", \"Jina la Shule\": \"School Name\", \"Wazazi wataandika jina hili kujisajili, kwa hiyo liwe kamili na la kipekee.\": \"Parents will type this name to register, so make it complete and unique.\", \"Aina ya Shule\": \"School Type\", \"Shule ya Msingi\": \"Primary School\", \"Shule ya Sekondari\": \"Secondary School\", \"Jina la Msimamizi (Mkuu wa Shule / Ofisi)\": \"Administrator Name (Head of School / Office)\", \"Namba ya Simu ya Shule\": \"School Phone Number\", \"Nenosiri (angalau herufi 8)\": \"Password (at least 8 characters)\", \"Kamilisha Usajili\": \"Complete Registration\", \"Tayari una akaunti? Ingia\": \"Already have an account? Log in\", \"🎁 Bonasi kwa Shule:\": \"🎁 Bonus for Schools:\", \"Shule yako itapata\": \"Your school will get\", \"asilimia 35\": \"35 percent\", \"ya kila malipo ya\": \"of every payment of\", \"kwa mwezi yanayolipwa na kila mzazi.\": \"per month paid by each parent.\", \"Shule ya Chekechea\": \"Kindergarten\", \"Sikiliza Wimbo wa Taifa\": \"Listen to the National Anthem\", \"Simamisha Wimbo wa Taifa\": \"Stop the National Anthem\", \"Wimbo wa Taifa bado haujawekwa na msimamizi\": \"The National Anthem has not been added by the administrator yet\", \"Video na Wimbo wa Taifa\": \"Video and National Anthem\", \"Video ya ukurasa wa mbele (itachezwa sekunde 30 za kwanza)\": \"Front page video (the first 30 seconds are played)\", \"Wimbo wa Taifa (faili la sauti)\": \"National Anthem (audio file)\", \"Pakia\": \"Upload\", \"Ondoa\": \"Remove\", \"Imepakiwa\": \"Uploaded\", \"Haijawekwa\": \"Not set\", \"Imepakiwa. Video itachezwa sekunde 30 za kwanza tu.\": \"Uploaded. Only the first 30 seconds of the video will be played.\", \"Imeondolewa\": \"Removed\", \"Chagua faili kwanza\": \"Choose a file first\", \"Tarehe haikulingana\": \"Date differs\", \"Faili ni kubwa mno\": \"The file is too large\", \"Tarehe haikulingana\": \"Date of birth differs\", \"Video lazima iwe MP4 au WEBM\": \"The video must be MP4 or WEBM\", \"Wimbo lazima uwe MP3, M4A, OGG au WAV\": \"The song must be MP3, M4A, OGG or WAV\", \"Taarifa za mwanafunzi hazilingani. Hakikisha jina la shule na namba ya mwanafunzi, au wasiliana na shule.\": \"The student details do not match. Check the school name and student number, or contact the school.\", \"Usajili wa Mzazi\": \"Parent Registration\", \"⚠️ Muhimu sana:\": \"⚠️ Very important:\", \"Hakikisha umeweka\": \"Make sure you entered\", \"jina la shule\": \"the school name\", \"namba ya mwanafunzi\": \"the student number\", \"na\": \"and\", \"tarehe ya kuzaliwa\": \"the date of birth\", \"kama alivyomsajili shule.\": \"as the school registered them.\", \"Jina la Mzazi\": \"Parent Name\", \"📷 Baada ya kujisajili utaweza kuweka picha kwenye dashibodi yako.\": \"📷 After registering you will be able to add a photo on your dashboard.\", \"Namba ya Mwanafunzi\": \"Student Number\", \"Tarehe na Mwaka wa Kuzaliwa wa Mtoto\": \"Child's Date and Year of Birth\", \"Tarehe (Siku/Mwezi)\": \"Date (Day/Month)\", \"Mwaka\": \"Year\", \"Umesahau Nenosiri\": \"Forgot Password\", \"Weka namba ya simu uliyojisajilia nayo. Tutakutumia\": \"Enter the phone number you registered with. We will send you an\", \"kwa SMS.\": \"by SMS.\", \"Tuma OTP\": \"Send OTP\", \"Weka OTP uliyopokea\": \"Enter the OTP you received\", \"Nenosiri jipya (angalau herufi 8)\": \"New password (at least 8 characters)\", \"Thibitisha OTP & Badilisha Nenosiri\": \"Verify OTP & Change Password\", \"Kamisheni ya shule (35%)\": \"School commission (35%)\", \"Toa Pesa (kiwango cha chini TSh 3,500)\": \"Withdraw (Min TSh 3,500)\", \"Madarasa\": \"Classes\", \"Wazazi Waliojisajili\": \"Registered Parents\", \"Wamelipa\": \"Paid\", \"SMS za mwezi huu\": \"SMS this month\", \"Madarasa na Wanafunzi\": \"Classes and Students\", \"Ratiba za Madarasa\": \"Class Timetables\", \"Walimu wa Shule\": \"School Teachers\", \"Weka Matokeo ya Mtihani\": \"Enter Exam Results\", \"Tuma SMS\": \"Send SMS\", \"Miamala ya Wazazi\": \"Parent Transactions\", \"Toka kwenye Akaunti\": \"Log out\", \"← Rudi\": \"← Back\", \"Ongeza Darasa\": \"Add Class\", \"Ongeza Mwanafunzi\": \"Add Student\", \"Mzazi atatumia namba hii, jina la shule na tarehe ya kuzaliwa kujisajili. Picha ya mwanafunzi unaiweka kwa kubonyeza 📷 kwenye orodha.\": \"The parent will use this number, the school name and the date of birth to register. Add the student's photo by tapping 📷 in the list.\", \"Alika Wazazi kwa SMS\": \"Invite Parents by SMS\", \"Inatuma SMS yenye kiungo cha mfumo na namba ya mwanafunzi kwa wazazi ambao bado hawajajisajili (wenye simu iliyowekwa). Hakuna anayetumiwa zaidi ya mara moja kwa saa 24.\": \"Sends an SMS with the system link and the student number to parents who have not registered yet (those with a phone number saved). No one is messaged more than once in 24 hours.\", \"Alika Wazazi Wasiojisajili\": \"Invite Unregistered Parents\", \"Ratiba ya Darasa\": \"Class Timetable\", \"Jumatatu\": \"Monday\", \"Jumanne\": \"Tuesday\", \"Jumatano\": \"Wednesday\", \"Alhamisi\": \"Thursday\", \"Ijumaa\": \"Friday\", \"Jumamosi\": \"Saturday\", \"Jumapili\": \"Sunday\", \"Kuanza\": \"Start\", \"Kumaliza\": \"End\", \"Arifu wazazi wa darasa hili kwa SMS\": \"Notify this class's parents by SMS\", \"Ongeza Kipindi\": \"Add Period\", \"Ongeza Mwalimu\": \"Add Teacher\", \"Ongeza\": \"Add\", \"Walimu hawahitaji akaunti. Wanapokea SMS za shule kupitia namba hii.\": \"Teachers do not need an account. They receive school SMS on this number.\", \"Weka Matokeo\": \"Enter Results\", \"Tuma SMS kwa mzazi moja kwa moja\": \"Send SMS to the parent automatically\", \"Hifadhi Matokeo\": \"Save Results\", \"Zilizolipwa na wazazi\": \"Paid by parents\", \"Karibu Mzazi,\": \"Welcome Parent,\", \"🌿 Ubarikiwe sana kwa kufuatilia taarifa za mtoto wako\": \"🌿 Blessings to you for following your child's progress\", \"📷 Weka / Badilisha Picha ya Mtoto\": \"📷 Add / Change Child's Photo\", \"🗓️ Ratiba ya Darasa\": \"🗓️ Class Timetable\", \"📊 Matokeo ya Mtihani\": \"📊 Exam Results\", \"Lipia Sasa TSh 1,000\": \"Pay Now TSh 1,000\", \"Thibitisha malipo (majaribio)\": \"Confirm payment (test mode)\", \"Baada ya kulipia kitaonekana \\\"Imeshalipwa\\\"\": \"After paying it will show \\\"Paid\\\"\", \"Kwa msaada zaidi wasiliana na shule\": \"For more help, contact the school\", \"Rudi\": \"Back\", \"Mfano: Shule ya Msingi Uhuru - Mwanza\": \"Example: Uhuru Primary School - Mwanza\", \"Jina kamili\": \"Full name\", \"Andika jina lako\": \"Enter your name\", \"Andika jina kamili la shule\": \"Enter the school's full name\", \"Namba ya usajili wa mwanafunzi\": \"Student registration number\", \"Mfano: 15/03\": \"Example: 15/03\", \"Mfano: 2018\": \"Example: 2018\", \"Mfano: Darasa la 4 A, au Form 2\": \"Example: Class 4 A, or Form 2\", \"Namba ya mwanafunzi\": \"Student number\", \"Jina la mwanafunzi\": \"Student name\", \"Siku/Mwezi 15/03\": \"Day/Month 15/03\", \"Mwaka 2018\": \"Year 2018\", \"Simu ya mzazi (si lazima, kwa mwaliko wa SMS)\": \"Parent's phone (optional, for SMS invitation)\", \"Somo (mfano: Hisabati)\": \"Subject (e.g. Mathematics)\", \"Mwalimu wa somo (si lazima)\": \"Subject teacher (optional)\", \"Jina la mwalimu\": \"Teacher name\", \"Somo (si lazima)\": \"Subject (optional)\", \"Alama (0-100)\": \"Score (0-100)\", \"Andika ujumbe (hadi herufi 300). Jina la shule linaongezwa mwanzoni.\": \"Write your message (max 300 characters). The school name is added at the start.\", \"Amelipiwa\": \"Paid\", \"Hajalipiwa\": \"Not paid\", \"Angalia simu yako, kisha weka PIN kuthibitisha malipo.\": \"Check your phone to confirm the payment.\", \"Asante! Malipo yamepokelewa 🎉\": \"Thank you! Payment received 🎉\", \"Bado hakuna matokeo.\": \"No results yet.\", \"Chagua faili la picha\": \"Choose an image file\", \"Darasa limeongezwa\": \"Class added\", \"Futa\": \"Delete\", \"Hadi {0}\": \"Until {0}\", \"Haikutumwa kwa {0}: ukomo wa SMS umeisha\": \"Not sent to {0}: SMS limit reached\", \"Hakuna maombi ya kutoa pesa.\": \"No withdrawal requests.\", \"Hakuna miamala bado.\": \"No transactions yet.\", \"Hakuna mtandao. Jaribu tena.\": \"No network connection. Try again.\", \"Hakuna shule bado.\": \"No schools yet.\", \"Hakuna simu ya mzazi\": \"No parent phone\", \"Hakuna vipindi kwenye ratiba bado.\": \"No periods in the timetable yet.\", \"Hakuna walimu kwenye orodha bado.\": \"No teachers in the list yet.\", \"Hakuna wanafunzi bado.\": \"No students yet.\", \"Hawakualikwa kwa kuwa walialikwa hivi karibuni: {0}\": \"Not invited because they were invited recently: {0}\", \"Hitilafu imetokea. Jaribu tena.\": \"Something went wrong. Please try again.\", \"Imebadilishwa\": \"Updated\", \"Imelipwa\": \"Paid\", \"Imeshindwa\": \"Failed\", \"Imeshindwa: {0}\": \"Failed: {0}\", \"Imewekwa kuwa imelipwa\": \"Marked as paid\", \"Inasubiri\": \"Pending\", \"Jaribio hili ni la bure\": \"This trial is free\", \"Jaribio la bure limeisha\": \"The free trial has ended\", \"Kamisheni {0}\": \"Commission {0}\", \"Kataa\": \"Reject\", \"Kataa ombi hili? Pesa inarudi kwenye salio la shule.\": \"Reject this request? The money returns to the school's balance.\", \"Kipindi kimeongezwa\": \"Period added\", \"Kipindi kimeongezwa. SMS zimetumwa: {0}\": \"Period added. SMS sent: {0}\", \"Lipia Sasa {0}\": \"Pay Now {0}\", \"Lipia ili uendelee kuona matokeo\": \"Pay to keep seeing results\", \"Litaisha {0}\": \"Ends {0}\", \"Malipo yameshindwa. Jaribu tena.\": \"Payment failed. Try again.\", \"Matokeo yamehifadhiwa (daraja {0})\": \"Results saved (grade {0})\", \"Mialiko imetumwa: {0}\": \"Invitations sent: {0}\", \"Mwalimu ameongezwa\": \"Teacher added\", \"Mwalimu hajatajwa\": \"Teacher not named\", \"Mwanafunzi ameongezwa\": \"Student added\", \"Mzazi amealikwa kwa SMS\": \"Parent invited by SMS\", \"Mzazi amejisajili\": \"Parent registered\", \"Mzazi hajaalikwa\": \"Parent not invited\", \"Mzazi: {0}\": \"Parent: {0}\", \"Namba: {0}\": \"No.: {0}\", \"Nenosiri limebadilishwa. Ingia sasa.\": \"Password changed. Log in now.\", \"Nimeshalipa\": \"I have paid\", \"Ombi la kutoa {0} limepokelewa\": \"Your withdrawal request for {0} was received\", \"Ombi limekataliwa\": \"Request rejected\", \"Ongeza darasa kwanza (kwenye Madarasa na Wanafunzi).\": \"Add a class first (under Classes and Students).\", \"Picha haiwezi kusomwa\": \"The image cannot be read\", \"Picha imehifadhiwa\": \"Photo saved\", \"Ratiba haijawekwa bado.\": \"The timetable has not been set yet.\", \"SMS haikutumwa: ukomo umeisha\": \"SMS not sent: limit reached\", \"SMS imetumwa kwa mzazi\": \"SMS sent to the parent\", \"SMS zilizobaki mwezi huu: {0}\": \"SMS left this month: {0}\", \"SMS zimetumwa: {0}\": \"SMS sent: {0}\", \"Salio: {0}\": \"Balance: {0}\", \"Subiri…\": \"Please wait…\", \"Thibitisha kuwa umeshalipa {0} kwa {1}?\": \"Confirm that you have paid {0} to {1}?\", \"Tunasubiri uthibitisho…\": \"Waiting for confirmation…\", \"Ukomo umebadilishwa\": \"Limit updated\", \"Ukomo wa SMS kwa mwezi\": \"Monthly SMS limit\", \"Walimu wote\": \"All teachers\", \"Wanafunzi {0} wamelipiwa mwezi huu\": \"{0} students paid this month\", \"Wanafunzi: {0}\": \"Students: {0}\", \"Wazazi na walimu wote\": \"All parents and teachers\", \"Wazazi wa {0}\": \"Parents of {0}\", \"Wazazi wote\": \"All parents\", \"Weka picha ya {0}\": \"Add a photo for {0}\", \"Weka ukomo\": \"Set limit\", \"Zimebaki {0} kati ya {1}\": \"{0} left of {1}\", \"zilizoshindwa: {0}\": \"failed: {0}\", \"— Ongeza darasa kwanza —\": \"— Add a class first —\", \"✅ Imeshalipwa\": \"✅ Paid\", \"🔒 Lipia ili kuona matokeo ya mtoto wako.\": \"🔒 Pay to see your child's results.\", \"Jina la shule\": \"School name\", \"Jina la msimamizi\": \"Administrator name\", \"Jina la mzazi\": \"Parent name\", \"Jina la darasa\": \"Class name\", \"Somo\": \"Subject\", \"Ujumbe\": \"Message\", \"Saa ya kuanza\": \"Start time\", \"Saa ya kumaliza\": \"End time\", \"Mwalimu\": \"Teacher\", \"Admin haijawashwa\": \"Admin is not enabled\", \"Alama ziwe kati ya 0 na 100\": \"Scores must be between 0 and 100\", \"Chagua darasa\": \"Choose a class\", \"Chagua darasa. Ongeza darasa kwanza ikiwa hakuna.\": \"Choose a class. Add a class first if there is none.\", \"Darasa halipo\": \"The class does not exist\", \"Darasa hili tayari lipo\": \"This class already exists\", \"Data si sahihi\": \"Invalid data\", \"Faili hili si picha halali\": \"This file is not a valid image\", \"Haipatikani\": \"Not available\", \"Haipo\": \"Not found\", \"Hakuna wapokeaji waliosajiliwa bado\": \"No registered recipients yet\", \"Hakuna wazazi wa kualika: weka simu ya mzazi kwenye mwanafunzi, au wameshaalikwa ndani ya saa 24.\": \"No parents to invite: add the parent's phone to a student, or they were already invited within the last 24 hours.\", \"Hauruhusiwi\": \"Not allowed\", \"Ikiwa namba imesajiliwa, OTP imetumwa kwa SMS.\": \"If the number is registered, an OTP has been sent by SMS.\", \"Jina hili la shule tayari limesajiliwa. Ongeza mji au eneo kwenye jina (mfano: \\\"Uhuru Primary - Mwanza\\\").\": \"This school name is already registered. Add a town or area to the name (e.g. \\\"Uhuru Primary - Mwanza\\\").\", \"Kiasi hakilingani\": \"Amount does not match\", \"Lengo la SMS si sahihi\": \"Invalid SMS target\", \"Malipo hayajapatikana\": \"Payment not found\", \"Muda huu unagongana na kipindi kingine cha darasa hili\": \"This time overlaps with another period of this class\", \"Mwaka wa kuzaliwa si sahihi\": \"Year of birth is invalid\", \"Mwanafunzi hayupo kwenye shule yako\": \"This student is not in your school\", \"Mwanafunzi huyu hayupo kwenye shule yako\": \"This student is not in your school\", \"Namba hii tayari imesajiliwa. Tafadhali ingia.\": \"This number is already registered. Please log in.\", \"Namba hii tayari ipo kwenye orodha ya walimu\": \"This number is already in the teachers list\", \"Namba hii ya mwanafunzi tayari ipo kwenye shule hii\": \"This student number already exists in this school\", \"Namba ya simu au nenosiri si sahihi\": \"Phone number or password is incorrect\", \"Namba ya simu si sahihi\": \"Phone number is invalid\", \"Namba ya simu si sahihi (mfano 07XXXXXXXX)\": \"Phone number is invalid (e.g. 07XXXXXXXX)\", \"Nenosiri liwe angalau herufi 8\": \"Password must be at least 8 characters\", \"OTP si sahihi\": \"Invalid OTP\", \"OTP si sahihi au muda umeisha. Omba nyingine.\": \"The OTP is invalid or has expired. Request another.\", \"Ombi halipo\": \"Request not found\", \"Ombi ni kubwa mno\": \"Request is too large\", \"Picha haipo\": \"Photo not found\", \"Picha ni kubwa mno (kiwango cha juu 400KB)\": \"The photo is too large (max 400KB)\", \"Picha si sahihi (tumia JPG, PNG au WEBP)\": \"Invalid photo (use JPG, PNG or WEBP)\", \"Saa ya kumaliza lazima iwe baada ya ya kuanza\": \"End time must be after start time\", \"Saini si sahihi\": \"Invalid signature\", \"Siku si sahihi\": \"Invalid day\", \"Taarifa za mwanafunzi hazilingani. Hakikisha jina la shule, namba na tarehe ya kuzaliwa, au wasiliana na shule.\": \"The student details do not match. Check the school name, number and date of birth, or contact the school.\", \"Tafadhali ingia tena\": \"Please log in again\", \"Tarehe ya kuzaliwa si sahihi (mfano 15/03)\": \"Date of birth is invalid (e.g. 15/03)\", \"Tayari umelipia. Asante!\": \"You have already paid. Thank you!\", \"Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.\": \"Too many attempts. Please wait a moment and try again.\", \"Una ombi lingine linalosubiri\": \"You already have a pending request\", \"Webhook haijawashwa\": \"Webhook is not enabled\", \"Hitilafu ya seva. Jaribu tena baadaye.\": \"Server error. Please try again later.\", \"Malipo hayajaanza. Jaribu tena baadaye.\": \"The payment could not start. Try again later.\", \"Mwanafunzi huyu ana wazazi wengi waliosajiliwa tayari. Wasiliana na shule.\": \"This student already has the maximum number of registered parents. Contact the school.\", \"Umefikia kikomo cha walimu (300)\": \"You have reached the teachers limit (300)\", \"Umefikia kikomo cha madarasa (100)\": \"You have reached the classes limit (100)\", \"Umefikia kikomo cha wanafunzi (5000)\": \"You have reached the students limit (5000)\", \"Namba imebadilishwa\": \"Number updated\", \"Imekataliwa\": \"Rejected\", \"Wamelipa: {0}\": \"Paid: {0}\", \"Hawajalipa: {0}\": \"Not paid: {0}\", \"Zilizokusanywa: {0}\": \"Collected: {0}\", \"Kamisheni 35%: {0}\": \"Commission 35%: {0}\", \"Walizolipwa: {0}\": \"Paid out: {0}\", \"Namba ya malipo: {0}\": \"Payout number: {0}\", \"Angalia wanafunzi\": \"View students\", \"📱 Namba ya Kupokea Malipo\": \"📱 Payout Number\", \"Kamisheni yako ya 35% inatumwa kwenye namba hii. Unaweza kuibadilisha wakati wowote.\": \"Your 35% commission is sent to this number. You can change it any time.\", \"Namba mpya 07XXXXXXXX\": \"New number 07XXXXXXXX\", \"Nenosiri lako (kuthibitisha)\": \"Your password (to confirm)\", \"Badilisha Namba\": \"Change Number\", \"📞 Namba za Simu\": \"📞 Phone Numbers\", \"Namba yako ya kuingia:\": \"Your login number:\", \"Namba mpya ya kuingia 07XXXXXXXX\": \"New login number 07XXXXXXXX\", \"Badilisha Namba ya Kuingia\": \"Change Login Number\", \"Namba ya kulipia (acha tupu kutumia namba yako)\": \"Number to pay with (leave empty to use your own)\", \"Nenosiri si sahihi\": \"Incorrect password\", \"Msaada (Team Support)\": \"Help (Team Support)\", \"Wazazi Wote\": \"All Parents\", \"Mzazi Mmoja\": \"One Parent\", \"Tafuta mzazi au mwanafunzi\": \"Search parent or student\", \"Tuma kwa Wazazi Wote\": \"Send to All Parents\", \"Tuma kwa Mzazi Huyu\": \"Send to This Parent\", \"Ujumbe kwa wazazi wote: umebaki {0} kati ya {1} wiki hii ({2} kati ya {3} mwezi huu)\": \"Messages to all parents: {0} of {1} left this week ({2} of {3} this month)\", \"Unaweza kumtumia mzazi mmoja ujumbe wakati wowote (SMS zilizobaki mwezi huu: {0})\": \"You can message one parent any time (SMS left this month: {0})\", \"Hakuna wazazi waliojisajili bado.\": \"No registered parents yet.\", \"Chagua mzazi kwanza\": \"Choose a parent first\", \"Ujumbe umetumwa kwa mzazi\": \"Message sent to the parent\", \"Ujumbe haukutumwa (huenda namba hii imefikia ukomo wa SMS za leo)\": \"Message not sent (this number may have reached today's SMS limit)\", \"Ujumbe umetumwa kwa wazazi wote\": \"Message sent to all parents\", \"Ripoti: wazazi {0} • waliotumiwa {1} • walioshindwa {2} • walioruka {3}\": \"Report: parents {0} • sent {1} • failed {2} • skipped {3}\", \"Mzazi huyu hayupo kwenye shule yako\": \"This parent is not in your school\", \"Umefikia kikomo cha ujumbe kwa wazazi wote (2 kwa wiki, 8 kwa mwezi). Subiri hadi wiki ijayo. Unaweza bado kumtumia mzazi mmoja ujumbe.\": \"You have reached the limit for messages to all parents (2 per week, 8 per month). Wait until next week. You can still message a single parent.\", \"Namba ya Uthibitisho (OTP)\": \"Verification Code (OTP)\", \"Bonyeza \\\"Tuma OTP\\\" upokee namba ya tarakimu 6 kwa SMS kwenye simu hiyo.\": \"Press \\\"Send OTP\\\" to receive a 6-digit code by SMS on that phone.\", \"OTP imetumwa kwa {0}. Weka namba ya tarakimu 6 uliyopokea.\": \"OTP sent to {0}. Enter the 6-digit code you received.\", \"OTP si sahihi au muda umeisha. Omba nyingine.\": \"The OTP is invalid or has expired. Request another.\", \"Subiri sekunde chache kabla ya kuomba OTP nyingine.\": \"Wait a few seconds before requesting another OTP.\", \"Huduma ya OTP imejaa leo. Jaribu kesho au wasiliana na Team Support.\": \"The OTP service is full today. Try tomorrow or contact Team Support.\", \"📱 Namba za Simu za Shule\": \"📱 School Phone Numbers\", \"Namba ya kuingia:\": \"Login number:\", \"Namba ya kupokea kamisheni ya 35%:\": \"Number that receives the 35% commission:\", \"Badilisha namba ya kuingia\": \"Change login number\", \"Badilisha namba ya kupokea malipo\": \"Change payout number\", \"Mwenye namba atapokea ombi kwenye simu yake; pesa haikatwi bila yeye kuweka PIN.\": \"The number's owner will get a request on their phone; no money is taken unless they enter their PIN.\", \"Umejaribu namba nyingi sana leo. Tumia namba yako au subiri kesho.\": \"You tried too many numbers today. Use your own number or wait until tomorrow.\", \"HALI YA MAJARIBIO: hakuna pesa halisi. Bonyeza \\\"Thibitisha malipo (majaribio)\\\".\": \"TEST MODE: no real money. Press \\\"Confirm payment (test mode)\\\".\"});\n    const EN_RE = [\n      [/^(.+) inahitajika$/, m => T(m[1]) + ' is required'],\n      [/^(.+) si sahihi \\(mfano 08:00\\)$/, m => T(m[1]) + ' is invalid (e.g. 08:00)'],\n      [/^(.+) si sahihi$/, m => T(m[1]) + ' is invalid'],\n      [/^(.+) lisiwe na kiungo \\(link\\), barua pepe au namba ndefu$/, m => T(m[1]) + ' must not contain a link, email or long number'],\n      [/^Umefikia kikomo cha ujumbe kwa wazazi wote \\((\\d+) kwa wiki, (\\d+) kwa mwezi\\)\\. Subiri hadi wiki ijayo\\. Unaweza bado kumtumia mzazi mmoja ujumbe\\.$/, m => 'You have reached the limit for messages to all parents (' + m[1] + ' per week, ' + m[2] + ' per month). Wait until next week. You can still message a single parent.'],\n      [/^SMS hazitoshi: zinahitajika (\\d+), zimebaki (\\d+) mwezi huu\\. Wasiliana nasi kuongeza ukomo\\.$/, m => 'Not enough SMS: ' + m[1] + ' needed, ' + m[2] + ' left this month. Contact us to raise the limit.'],\n      [/^Kiwango cha chini cha kutoa ni TSh (.+)$/, m => 'The minimum withdrawal is TSh ' + m[1]],\n    ];\n    const norm = (s) => String(s).replace(/\\s+/g, ' ').trim();\n    let LANG = 'sw';\n    try { if (localStorage.getItem('sl_lang') === 'en') LANG = 'en'; } catch (e) {}\n    function T(sw, ...a) {\n      let s = sw;\n      if (LANG === 'en') {\n        const k = norm(sw);\n        if (EN[k] !== undefined) s = EN[k];\n        else for (const [re, fn] of EN_RE) { const m = re.exec(k); if (m) { s = fn(m); break; } }\n      }\n      return a.length ? s.replace(/\\{(\\d+)\\}/g, (_, i) => a[+i]) : s;\n    }\n    const dateLocale = () => (LANG === 'en' ? 'en-GB' : 'sw-TZ');\n\n    // Maandishi yote yaliyo kwenye HTML (yanakusanywa mara moja) yanatafsiriwa kwa kutumia kamusi ileile\n    const I18N = [];\n    function collectI18n() {\n      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {\n        acceptNode(n) {\n          const p = n.parentElement;\n          if (!p || p.closest('script,style,[data-no-i18n]')) return NodeFilter.FILTER_REJECT;\n          return norm(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;\n        },\n      });\n      let n;\n      while ((n = w.nextNode())) {\n        const v = n.nodeValue;\n        I18N.push({ n, sw: norm(v), lead: /^\\s/.test(v) ? ' ' : '', trail: /\\s$/.test(v) ? ' ' : '' });\n      }\n      document.querySelectorAll('[placeholder],[aria-label]').forEach(e => {\n        if (e.closest('[data-no-i18n]')) return;\n        ['placeholder', 'aria-label'].forEach(a => { if (e.hasAttribute(a)) I18N.push({ e, a, sw: norm(e.getAttribute(a)) }); });\n      });\n    }\n    function applyI18n() {\n      for (const r of I18N) {\n        const txt = LANG === 'en' && EN[r.sw] !== undefined ? EN[r.sw] : r.sw;\n        if (r.n) { if (r.n.isConnected) r.n.nodeValue = r.lead + txt + r.trail; }\n        else r.e.setAttribute(r.a, txt);\n      }\n      document.documentElement.lang = LANG;\n      document.title = LANG === 'en' ? 'SCHOOL LUBA TECH - School System' : 'SCHOOL LUBA TECH - Mfumo wa Shule';\n    }\n    function toggleLang() {\n      LANG = LANG === 'sw' ? 'en' : 'sw';\n      try { localStorage.setItem('sl_lang', LANG); } catch (e) {}\n      applyI18n();\n      refreshView();\n    }\n\n    /* ================= JINA LA MOTO: herufi moja moja ================= */\n    function buildBrand() {\n      const b = document.getElementById('brand');\n      if (!b) return;\n      b.textContent = '';\n      [...'SCHOOL LUBA TECH'].forEach((c, i) => {\n        const o = document.createElement('span');\n        o.className = 'ch' + (c === ' ' ? ' sp' : '');\n        o.style.setProperty('--i', i); o.setAttribute('aria-hidden', 'true');\n        o.textContent = c === ' ' ? '\\u00a0' : c;\n        b.appendChild(o);\n      });\n      b.setAttribute('data-no-i18n', '');\n    }\n\n    /* ================= SLAIDI ================= */\n    let currentSlide = 0;\n    const slides = document.querySelectorAll('.video-slide');\n    const dots = document.querySelectorAll('.slide-dot');\n    function nextSlide() {\n      slides[currentSlide].classList.remove('active');\n      dots[currentSlide].classList.remove('bg-white');\n      dots[currentSlide].classList.add('bg-white/40');\n      currentSlide = (currentSlide + 1) % slides.length;\n      slides[currentSlide].classList.add('active');\n      dots[currentSlide].classList.remove('bg-white/40');\n      dots[currentSlide].classList.add('bg-white');\n    }\n    setInterval(nextSlide, 5000);\n\n    /* ================= SAUTI: sauti za mfumo zimeondolewa. Zinabaki: sauti ya video na Wimbo wa Taifa ================= */\n    function playVictory() {}\n    function playVuvuzela() {}\n    let videoSrc = VIDEO_SRC, anthemSrc = '';\n    const CLIP_SECONDS = 5; // kila video ya admin inachezwa sekunde 5 kisha inayofuata\n    let clips = VIDEO_SRC ? [{ url: VIDEO_SRC, max: 30 }] : [], clipIdx = 0, vidA = null, vidB = null, activeVid = null, advancing = false;\n    let introStarted = false, anthemAudio = null, anthemPlaying = false;\n    const curVid = () => activeVid || document.getElementById('introVideo');\n    function startIntroSound() {\n      if (introStarted || !videoSrc || anthemPlaying) return;\n      const v = curVid(); v.muted = false;\n      v.play().then(() => { introStarted = true; }).catch(() => {});\n    }\n    function stopIntroSound() { if (videoSrc) { vidA.pause(); vidB.pause(); } }\n    function loadClip(v, i) { v.src = clips[i].url; v.load(); }\n    function advanceClip() {\n      if (advancing) return; advancing = true;\n      const old = activeVid;\n      if (clips.length < 2) { old.currentTime = 0; old.play().catch(() => {}); advancing = false; return; }\n      const next = old === vidA ? vidB : vidA;\n      clipIdx = (clipIdx + 1) % clips.length;\n      next.muted = old.muted; next.currentTime = 0;\n      const go = () => {\n        next.style.opacity = 1; old.style.opacity = 0; activeVid = next; old.pause();\n        loadClip(old, (clipIdx + 1) % clips.length); // inayofuata inapakiwa mapema\n        advancing = false;\n      };\n      next.play().then(go).catch(() => { next.muted = true; next.play().then(go).catch(() => { advancing = false; }); });\n    }\n    function setupVideo() {\n      if (!clips.length) return;\n      videoSrc = clips[0].url;\n      vidA = document.getElementById('introVideo'); vidB = document.getElementById('introVideoB');\n      [vidA, vidB].forEach((v) => {\n        v.classList.remove('hidden');\n        v.addEventListener('timeupdate', () => { if (v === activeVid && v.currentTime >= clips[clipIdx].max) advanceClip(); });\n        v.addEventListener('ended', () => { if (v === activeVid) advanceClip(); });\n        v.addEventListener('error', () => { if (v === activeVid && clips.length > 1) advanceClip(); });\n      });\n      activeVid = vidA; vidA.style.opacity = 1; vidB.style.opacity = 0;\n      loadClip(vidA, 0); if (clips.length > 1) loadClip(vidB, 1);\n      vidA.muted = false;\n      vidA.play().then(() => { introStarted = true; }).catch(() => {\n        vidA.muted = true; vidA.play().catch(() => {}); // kivinjari kimezuia sauti: cheza kimya, sauti ianze kwa mguso wa kwanza\n      });\n    }\n    // Video na wimbo vilivyopakiwa na admin (vinasomwa mara moja ukurasa unapofunguka)\n    (async function initMedia() {\n      try {\n        const m = await (await fetch('/api/public/media')).json();\n        if (m.videos && m.videos.length) clips = m.videos.map((x) => ({ url: x.url, max: CLIP_SECONDS })); // video za admin zina kipaumbele juu ya VIDEO_URL\n        if (m.anthem) anthemSrc = m.anthem.url;\n      } catch (e) {}\n      setupVideo();\n    })();\n    // Wimbo wa Taifa: kitufe kinaanza kuimba mara moja; kikibonyezwa tena kinasimamisha\n    function setAnthemBtn() {\n      document.getElementById('anthemOn').classList.toggle('hidden', anthemPlaying);\n      document.getElementById('anthemOff').classList.toggle('hidden', !anthemPlaying);\n      document.getElementById('anthemIcon').textContent = anthemPlaying ? '⏸' : '🎵';\n    }\n    function resumeVideoSound() { const v = curVid(); if (videoSrc) { v.muted = false; v.play().catch(() => {}); } }\n    async function refreshMedia() { try { const m = await (await fetch('/api/public/media', { cache: 'no-store' })).json(); if (m.anthem) anthemSrc = m.anthem.url; return m; } catch (e) { return null; } }\n    async function toggleAnthem() {\n      if (anthemPlaying) { anthemAudio.pause(); anthemPlaying = false; resumeVideoSound(); setAnthemBtn(); return; }\n      if (!anthemSrc) await refreshMedia(); // admin huenda amepakia baada ya ukurasa kufunguka\n      if (!anthemSrc) { toast(T('Wimbo wa Taifa bado haujawekwa na msimamizi'), false); return; }\n      if (!anthemAudio) {\n        anthemAudio = new Audio(anthemSrc);\n        anthemAudio.addEventListener('ended', () => { anthemPlaying = false; resumeVideoSound(); setAnthemBtn(); });\n      }\n      if (videoSrc) curVid().muted = true; // video inanyamaza wimbo ukiimbwa\n      anthemAudio.currentTime = 0;\n      anthemAudio.play().then(() => { anthemPlaying = true; setAnthemBtn(); }).catch(() => toast(T('Hitilafu imetokea. Jaribu tena.'), false));\n    }\n    window.addEventListener('load', startIntroSound);\n    ['touchstart', 'pointerdown', 'click', 'keydown', 'scroll'].forEach(evt => {\n      window.addEventListener(evt, startIntroSound, { passive: true });\n    });\n\n    /* ================= NAVIGATION ================= */\n    const SCREENS = ['landing','login','schoolReg','parentReg','schoolDash','parentDash','forgotPassword','adminLogin','adminDash'];\n    function show(id) {\n      SCREENS.forEach(s => document.getElementById(s).classList.add('hidden'));\n      document.getElementById(id).classList.remove('hidden');\n      window.scrollTo(0, 0);\n    }\n    const visibleScreen = () => SCREENS.find(id => !document.getElementById(id).classList.contains('hidden'));\n    function showLanding() { show('landing'); }\n    function showLogin() { show('login'); }\n    function showSchoolReg() { show('schoolReg'); }\n    function showParentReg() { show('parentReg'); }\n    function showForgotPassword() { show('forgotPassword'); }\n    function showAdminLogin() { show('adminLogin'); }\n\n    // Lugha ikibadilishwa, sehemu zilizojengwa na JS (orodha, jumla) zinajengwa upya\n    function refreshView() {\n      const v = visibleScreen();\n      if (v === 'schoolDash') loadSchool(true).then(() => { if (currentPanel) openPanel(currentPanel, true); }).catch(() => {});\n      else if (v === 'parentDash') loadParent().catch(() => {});\n      else if (v === 'adminDash') loadAdmin().catch(() => {});\n    }\n\n    /* ================= API ================= */\n    let token = null, role = null;\n    try { token = localStorage.getItem('tl_token'); role = localStorage.getItem('tl_role'); } catch (e) {}\n\n    async function api(path, opts = {}) {\n      let r;\n      try {\n        r = await fetch('/api' + path, {\n          method: opts.method || (opts.body ? 'POST' : 'GET'),\n          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },\n          body: opts.body ? JSON.stringify(opts.body) : undefined,\n        });\n      } catch (e) { throw new Error(T('Hakuna mtandao. Jaribu tena.')); }\n      let data = {};\n      try { data = await r.json(); } catch (e) {}\n      if (!r.ok) {\n        if (r.status === 401 && token) { clearSession(); show('login'); }\n        throw new Error(T(data.error || 'Hitilafu imetokea. Jaribu tena.'));\n      }\n      return data;\n    }\n    function setSession(d) {\n      token = d.token; role = d.role;\n      try { localStorage.setItem('tl_token', token); localStorage.setItem('tl_role', role); } catch (e) {}\n    }\n    function clearSession() {\n      token = null; role = null; stopPolling();\n      try { localStorage.removeItem('tl_token'); localStorage.removeItem('tl_role'); } catch (e) {}\n    }\n    function logout() { clearSession(); showLanding(); }\n\n    let toastTimer;\n    function toast(msg, ok) {\n      const t = document.getElementById('toast');\n      t.textContent = msg;\n      t.className = 'fixed left-1/2 -translate-x-1/2 bottom-6 z-[10000] max-w-[92vw] px-5 py-3 rounded-2xl text-white font-semibold shadow-2xl text-center ' + (ok ? 'bg-green-700' : 'bg-red-600');\n      clearTimeout(toastTimer);\n      toastTimer = setTimeout(() => t.classList.add('hidden'), 4500);\n    }\n    async function busy(btnId, fn) {\n      const b = document.getElementById(btnId);\n      const label = b.textContent;\n      b.disabled = true; b.textContent = T('Subiri…'); b.style.opacity = .7;\n      try { return await fn(); }\n      catch (e) { toast(e.message, false); }\n      finally { b.disabled = false; b.textContent = label; b.style.opacity = 1; }\n    }\n    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };\n    const val = id => document.getElementById(id).value;\n    const setText = (id, t) => { document.getElementById(id).textContent = t; };\n    const tsh = n => 'TSh ' + Number(n).toLocaleString('en-US');\n\n    /* ================= LOGIN / USAJILI ================= */\n    async function enterApp() {\n      stopIntroSound();\n      if (role === 'school') { await loadSchool(); show('schoolDash'); }\n      else { await loadParent(); show('parentDash'); }\n    }\n    // Hakiki papo hapo kabla ya kutuma: mtumiaji anapata jibu sekunde hiyo hiyo, na alichoandika hakipotei\n    function quickCheck(rules) {\n      for (const [id, msg, min] of rules) {\n        const v = val(id).trim();\n        if (!v || (min && v.length < min)) { toast(T(msg), false); const e = document.getElementById(id); e.focus(); e.scrollIntoView({ block: 'center', behavior: 'smooth' }); return false; }\n      }\n      return true;\n    }\n    function doLogin() {\n      if (!quickCheck([['lg-phone', 'Namba ya Simu inahitajika'], ['lg-pass', 'Nenosiri inahitajika']])) return;\n      return busy('lg-btn', async () => {\n        setSession(await api('/login', { body: { phone: val('lg-phone'), password: val('lg-pass') } }));\n        document.getElementById('lg-pass').value = '';\n        await enterApp();\n      });\n    }\n    function completeSchoolReg() {\n      if (!quickCheck([['sc-school', 'Jina la Shule inahitajika'], ['sc-name', 'Jina la Msimamizi (Mkuu wa Shule / Ofisi) inahitajika'], ['sc-phone', 'Namba ya Simu ya Shule inahitajika'], ['sc-otp', 'Namba ya Uthibitisho (OTP) inahitajika'], ['sc-pass', 'Nenosiri liwe angalau herufi 8', 8], ['sc-photo', 'Weka picha yako']])) return;\n      return busy('sc-btn', async () => {\n        const photo = await resizeImage(document.getElementById('sc-photo').files[0]);\n        setSession(await api('/register/school', { body: {\n          photo, school: val('sc-school'), type: val('sc-type'), name: val('sc-name'), phone: val('sc-phone'), password: val('sc-pass'), otp: val('sc-otp') } }));\n        stopIntroSound(); playVictory();\n        confetti({ particleCount: 160, spread: 90, origin: { y: 0.6 }, colors: ['#1d4ed8','#facc15','#16a34a','#f97316'] });\n        await new Promise(r => setTimeout(r, 1200));\n        await enterApp();\n      });\n    }\n    function completeParentReg() {\n      if (!quickCheck([['pr-name', 'Jina la Mzazi inahitajika'], ['pr-phone', 'Namba ya Simu inahitajika'], ['pr-otp', 'Namba ya Uthibitisho (OTP) inahitajika'], ['pr-pass', 'Nenosiri liwe angalau herufi 8', 8], ['pr-school', 'Jina la Shule inahitajika'], ['pr-stno', 'Namba ya Mwanafunzi inahitajika'], ['pr-dd', 'Tarehe (Siku/Mwezi) inahitajika'], ['pr-yy', 'Mwaka inahitajika']])) return;\n      return busy('pr-btn', async () => {\n        setSession(await api('/register/parent', { body: {\n          name: val('pr-name'), phone: val('pr-phone'), password: val('pr-pass'), otp: val('pr-otp'),\n          school: val('pr-school'), studentNo: val('pr-stno'), dobDay: val('pr-dd'), dobYear: val('pr-yy') } }));\n        stopIntroSound(); playVictory();\n        confetti({ particleCount: 140, spread: 80, origin: { y: 0.6 }, colors: ['#f97316','#facc15','#16a34a','#1d4ed8'] });\n        await new Promise(r => setTimeout(r, 1200));\n        await enterApp();\n      });\n    }\n\n    /* ================= OTP ================= */\n    const otpTimers = {};\n    // Inatuma OTP mara moja, inaonyesha namba iliyotumiwa, na inaruhusu kutuma tena baada ya sekunde 30\n    async function requestOtp(kind, phoneId, btnId, msgId) {\n      const btn = document.getElementById(btnId), msg = document.getElementById(msgId), cd = btn.querySelector('span');\n      if (btn.disabled) return;\n      btn.disabled = true; btn.style.opacity = .7;\n      try {\n        const body = { phone: val(phoneId) };\n        let path = kind === 'register' ? '/otp/register' : kind === 'reset' ? '/otp/send' : '/otp/change';\n        if (path === '/otp/change') body.purpose = kind === 'payout' ? 'payout' : 'phone';\n        const d = await api(path, { body });\n        msg.textContent = '✅ ' + T('OTP imetumwa kwa {0}. Weka namba ya tarakimu 6 uliyopokea.', d.phone);\n        msg.className = 'text-sm font-semibold text-green-700 mt-2';\n        let left = 30; clearInterval(otpTimers[btnId]);\n        cd.textContent = ' (' + left + ')';\n        otpTimers[btnId] = setInterval(() => {\n          if (--left <= 0) { clearInterval(otpTimers[btnId]); cd.textContent = ''; btn.disabled = false; btn.style.opacity = 1; }\n          else cd.textContent = ' (' + left + ')';\n        }, 1000);\n      } catch (e) { toast(e.message, false); btn.disabled = false; btn.style.opacity = 1; }\n    }\n    function resetPassword() {\n      return busy('fp-reset', async () => {\n        await api('/otp/reset', { body: { phone: val('fp-phone'), otp: val('fp-otp'), password: val('fp-pass') } });\n        toast(T('Nenosiri limebadilishwa. Ingia sasa.'), true);\n        document.getElementById('fp-otp').value = ''; document.getElementById('fp-pass').value = '';\n        showLogin();\n      });\n    }\n\n    /* ================= SHULE ================= */\n    let classesCache = [], currentPanel = null;\n\n    async function loadSchool(keep) {\n      const d = await api('/school/me');\n      if (d.hasPhoto) showPhoto(document.getElementById('sd-av'), 'me', '/school/photo');\n      setText('sd-name', d.school); setText('sd-contact', d.contact + ' • ' + d.phone);\n      setText('sd-balance', tsh(d.balance));\n      setText('sd-paidmonth', T('Wanafunzi {0} wamelipiwa mwezi huu', d.paidThisMonth));\n      setText('sd-students', d.students); setText('sd-classes', d.classes);\n      setText('sd-parents', d.parentsRegistered); setText('sd-paid', d.paidParents);\n      setText('sd-sms', T('Zimebaki {0} kati ya {1}', d.sms.left, d.sms.quota));\n      setBroadcastInfo(d);\n      setText('sd-payout', d.payoutPhone); setText('sd-loginphone', d.phone);\n      const wl = document.getElementById('sd-wlist'); wl.replaceChildren();\n      (d.withdrawals || []).forEach(w => wl.appendChild(el('p', '', new Date(w.at).toLocaleDateString(dateLocale()) + ' • ' + tsh(w.amount) + ' → ' + w.phone + ' • ' + T(w.status === 'paid' ? 'Imelipwa' : w.status === 'rejected' ? 'Imekataliwa' : 'Inasubiri'))));\n      if (!keep) openPanel(null);\n    }\n    async function changePhone() {\n      const payout = val('po-kind') === 'payout';\n      try {\n        const d = await api(payout ? '/school/payout-phone' : '/school/phone', { body: { phone: val('po-phone'), password: val('po-pass'), otp: val('po-otp') } });\n        ['po-phone', 'po-pass', 'po-otp'].forEach(i => document.getElementById(i).value = '');\n        document.getElementById('po-otp-msg').textContent = '';\n        toast(T('Namba imebadilishwa'), true); loadSchool(true).catch(() => {});\n      } catch (e) { toast(e.message, false); }\n    }\n    async function changeMyPhone() {\n      try {\n        const d = await api('/parent/phone', { body: { phone: val('pp-phone'), password: val('pp-pass'), otp: val('pp-otp') } });\n        ['pp-phone', 'pp-pass', 'pp-otp'].forEach(i => document.getElementById(i).value = ''); document.getElementById('pp-otp-msg').textContent = '';\n        setText('pd-myphone', d.phone); toast(T('Namba imebadilishwa'), true);\n      } catch (e) { toast(e.message, false); }\n    }\n    function fillClassSelect(id) {\n      const s = document.getElementById(id); const keep = s.value;\n      s.replaceChildren();\n      if (!classesCache.length) s.appendChild(new Option(T('— Ongeza darasa kwanza —'), ''));\n      classesCache.forEach(c => s.appendChild(new Option(c.name, c.id)));\n      if (keep) s.value = keep;\n    }\n    async function refreshClasses() {\n      classesCache = await api('/school/classes');\n      fillClassSelect('st-class'); fillClassSelect('tt-class');\n    }\n    function openPanel(name, keepScroll) {\n      currentPanel = name;\n      ['main', 'students-panel', 'timetable-panel', 'staff-panel', 'results-panel', 'sms-panel', 'payments-panel'].forEach(p =>\n        document.getElementById('sd-' + p).classList.add('hidden'));\n      if (name === 'sms') { document.getElementById('sms-report').classList.add('hidden'); setSmsMode(smsMode); }\n      document.getElementById(name ? 'sd-' + name + '-panel' : 'sd-main').classList.remove('hidden');\n      if (name) refreshClasses().then(() => {\n        if (name === 'students') loadStudents();\n        if (name === 'payments') loadPayments();\n        if (name === 'timetable') loadTimetable();\n        if (name === 'staff') loadStaff();\n      }).catch(e => toast(e.message, false));\n      if (!keepScroll) window.scrollTo(0, 0);\n    }\n    function emptyNote(box, text) { box.replaceChildren(el('p', 'p-6 text-slate-500 text-center', T(text))); }\n\n    async function addClass() {\n      try {\n        await api('/school/classes', { body: { name: val('cl-name') } });\n        document.getElementById('cl-name').value = '';\n        toast(T('Darasa limeongezwa'), true); await refreshClasses(); loadStudents();\n      } catch (e) { toast(e.message, false); }\n    }\n\n    /* ---- picha ---- */\n    function resizeImage(file, max = 400) {\n      return new Promise((resolve, reject) => {\n        if (!file || !/^image\\//.test(file.type)) return reject(new Error(T('Chagua faili la picha')));\n        const url = URL.createObjectURL(file); const img = new Image();\n        img.onload = () => {\n          const k = Math.min(1, max / Math.max(img.width, img.height));\n          const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);\n          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);\n          URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82));\n        };\n        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(T('Picha haiwezi kusomwa'))); };\n        img.src = url;\n      });\n    }\n    function pickImage() {\n      return new Promise((resolve) => {\n        const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';\n        i.onchange = () => resolve(i.files[0] || null); i.click();\n      });\n    }\n    async function showPhoto(box, studentId, url, hdrs) {\n      try {\n        const r = await fetch('/api' + (url || '/photo/' + studentId) + '?t=' + Date.now(), { headers: hdrs || { Authorization: 'Bearer ' + token } });\n        if (!r.ok) return;\n        const img = el('img', 'w-full h-full object-cover'); img.alt = '';\n        img.src = URL.createObjectURL(await r.blob());\n        box.replaceChildren(img);\n      } catch (e) { /* picha ikishindwa, emoji inabaki */ }\n    }\n    async function uploadPhoto(path, extra) {\n      const f = await pickImage(); if (!f) return false;\n      try { const image = await resizeImage(f); await api(path, { body: { ...extra, image } }); toast(T('Picha imehifadhiwa'), true); return true; }\n      catch (e) { toast(e.message, false); return false; }\n    }\n    async function changeSchoolPhoto() { if (await uploadPhoto('/school/photo', {})) showPhoto(document.getElementById('sd-av'), 'me', '/school/photo'); }\n    async function pickChildPhoto() { if (await uploadPhoto('/parent/photo', {})) loadParent(); }\n\n    async function loadStudents() {\n      const box = document.getElementById('st-list');\n      try {\n        const list = await api('/school/students');\n        if (!list.length) return emptyNote(box, 'Hakuna wanafunzi bado.');\n        box.replaceChildren();\n        list.forEach(s => {\n          const row = el('div', 'px-4 py-4 border-b border-slate-100 flex items-center gap-3');\n          const av = el('div', 'w-14 h-14 rounded-xl bg-blue-50 flex items-center justify-center text-2xl overflow-hidden shrink-0', '🧒');\n          if (s.hasPhoto) showPhoto(av, s.id);\n          const info = el('div', 'flex-1 min-w-0');\n          const parentState = s.hasParent ? T('Mzazi amejisajili') : s.invited ? T('Mzazi amealikwa kwa SMS') : s.hasParentPhone ? T('Mzazi hajaalikwa') : T('Hakuna simu ya mzazi');\n          info.append(el('p', 'font-semibold truncate', s.name + ' (' + s.studentNo + ')'),\n            el('p', 'text-sm text-slate-500', s.className + ' • ' + parentState + ' • ' + (s.paid ? T('Amelipiwa') : T('Hajalipiwa'))));\n          const cam = el('button', 'text-2xl px-3 py-2', '📷'); cam.setAttribute('aria-label', T('Weka picha ya {0}', s.name));\n          cam.onclick = async () => { if (await uploadPhoto('/school/students/photo', { id: s.id })) loadStudents(); };\n          row.append(av, info, cam); box.appendChild(row);\n        });\n      } catch (e) { toast(e.message, false); }\n    }\n    async function addStudent() {\n      try {\n        await api('/school/students', { body: { classId: val('st-class'), studentNo: val('st-no'), name: val('st-name'), dobDay: val('st-dd'), dobYear: val('st-yy'), parentPhone: val('st-pphone') } });\n        ['st-no','st-name','st-dd','st-yy','st-pphone'].forEach(i => document.getElementById(i).value = '');\n        toast(T('Mwanafunzi ameongezwa'), true); loadStudents(); refreshClasses();\n      } catch (e) { toast(e.message, false); }\n    }\n    async function inviteParents() {\n      try {\n        const d = await api('/school/invite', { method: 'POST', body: {} });\n        let m = T('Mialiko imetumwa: {0}', d.sent);\n        if (d.recent) m += '. ' + T('Hawakualikwa kwa kuwa walialikwa hivi karibuni: {0}', d.recent);\n        if (d.skipped) m += '. ' + T('Haikutumwa kwa {0}: ukomo wa SMS umeisha', d.skipped);\n        if (d.failed) m += '. ' + T('Imeshindwa: {0}', d.failed);\n        toast(m, !d.failed && !d.skipped); loadStudents();\n      } catch (e) { toast(e.message, false); }\n    }\n    async function loadPayments() {\n      const box = document.getElementById('py-list');\n      try {\n        const d = await api('/school/payments');\n        setText('py-total', tsh(d.totalPaid)); setText('py-comm', tsh(d.totalCommission));\n        if (!d.payments.length) return emptyNote(box, 'Hakuna miamala bado.');\n        box.replaceChildren();\n        const label = { paid: T('Imelipwa'), pending: T('Inasubiri'), failed: T('Imeshindwa') };\n        d.payments.forEach(p => {\n          const row = el('div', 'px-6 py-4 border-b border-slate-100');\n          const top = el('div', 'flex justify-between gap-3');\n          top.append(el('p', 'font-semibold', p.student || '—'), el('p', 'font-bold ' + (p.status === 'paid' ? 'text-green-600' : 'text-slate-400'), tsh(p.amount)));\n          row.append(top, el('p', 'text-sm text-slate-500', T('Mzazi: {0}', p.parent || '—') + ' • ' + (label[p.status] || p.status)),\n            el('p', 'text-xs text-slate-400', new Date(p.at).toLocaleString(dateLocale()) + ' • ' + p.ref + (p.status === 'paid' ? ' • ' + T('Kamisheni {0}', tsh(p.commission)) : '')));\n          box.appendChild(row);\n        });\n      } catch (e) { toast(e.message, false); }\n    }\n\n    async function loadTimetable() {\n      const box = document.getElementById('tt-list'); const cid = val('tt-class');\n      if (!cid) return emptyNote(box, 'Ongeza darasa kwanza (kwenye Madarasa na Wanafunzi).');\n      try {\n        const list = await api('/school/timetable/' + cid);\n        if (!list.length) return emptyNote(box, 'Hakuna vipindi kwenye ratiba bado.');\n        box.replaceChildren();\n        list.forEach(t => {\n          const row = el('div', 'px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3');\n          const left = el('div');\n          left.append(el('p', 'font-semibold', T(t.dayName) + ' ' + t.start + '–' + t.end + ' • ' + t.subject),\n            el('p', 'text-sm text-slate-500', t.teacher || T('Mwalimu hajatajwa')));\n          const del = el('button', 'text-red-600 font-semibold px-3 py-2', T('Futa'));\n          del.onclick = async () => { try { await api('/school/timetable/delete', { body: { id: t.id } }); loadTimetable(); } catch (e) { toast(e.message, false); } };\n          row.append(left, del); box.appendChild(row);\n        });\n      } catch (e) { toast(e.message, false); }\n    }\n    async function addTimetable() {\n      try {\n        const d = await api('/school/timetable', { body: {\n          classId: val('tt-class'), day: val('tt-day'), start: val('tt-start'), end: val('tt-end'),\n          subject: val('tt-subject'), teacher: val('tt-teacher'), notify: document.getElementById('tt-notify').checked } });\n        ['tt-subject','tt-teacher'].forEach(i => document.getElementById(i).value = '');\n        toast(d.sms ? T('Kipindi kimeongezwa. SMS zimetumwa: {0}', d.sms.sent) : T('Kipindi kimeongezwa'), true);\n        loadTimetable();\n      } catch (e) { toast(e.message, false); }\n    }\n\n    async function loadStaff() {\n      const box = document.getElementById('sf-list');\n      try {\n        const list = await api('/school/staff');\n        if (!list.length) return emptyNote(box, 'Hakuna walimu kwenye orodha bado.');\n        box.replaceChildren();\n        list.forEach(s => {\n          const row = el('div', 'px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3');\n          const left = el('div');\n          left.append(el('p', 'font-semibold', s.name), el('p', 'text-sm text-slate-500', s.phone + (s.subject ? ' • ' + s.subject : '')));\n          const del = el('button', 'text-red-600 font-semibold px-3 py-2', T('Futa'));\n          del.onclick = async () => { try { await api('/school/staff/delete', { body: { id: s.id } }); loadStaff(); } catch (e) { toast(e.message, false); } };\n          row.append(left, del); box.appendChild(row);\n        });\n      } catch (e) { toast(e.message, false); }\n    }\n    async function addStaff() {\n      try {\n        await api('/school/staff', { body: { name: val('sf-name'), phone: val('sf-phone'), subject: val('sf-subject') } });\n        ['sf-name','sf-phone','sf-subject'].forEach(i => document.getElementById(i).value = '');\n        toast(T('Mwalimu ameongezwa'), true); loadStaff();\n      } catch (e) { toast(e.message, false); }\n    }\n\n    async function saveResult() {\n      try {\n        const d = await api('/school/results', { body: { studentNo: val('rs-no'), subject: val('rs-subject'), score: val('rs-score'), notify: document.getElementById('rs-notify').checked } });\n        document.getElementById('rs-subject').value = ''; document.getElementById('rs-score').value = '';\n        let m = T('Matokeo yamehifadhiwa (daraja {0})', d.grade);\n        if (d.sms.sent) m += '. ' + T('SMS imetumwa kwa mzazi');\n        if (d.sms.skipped) m += '. ' + T('SMS haikutumwa: ukomo umeisha');\n        toast(m, true);\n      } catch (e) { toast(e.message, false); }\n    }\n    let smsMode = 'all', parentsCache = [];\n    function setBroadcastInfo(d) {\n      const b = d.broadcasts; if (!b) return;\n      setText('sms-left', smsMode === 'all'\n        ? T('Ujumbe kwa wazazi wote: umebaki {0} kati ya {1} wiki hii ({2} kati ya {3} mwezi huu)', b.weekLeft, b.weekLimit, b.monthLeft, b.monthLimit)\n        : T('Unaweza kumtumia mzazi mmoja ujumbe wakati wowote (SMS zilizobaki mwezi huu: {0})', d.sms.left));\n    }\n    function setSmsMode(m) {\n      smsMode = m;\n      const on = 'btn-primary', off = 'bg-slate-100 text-slate-700';\n      document.getElementById('smsm-all').className = 'py-3 rounded-2xl font-bold ' + (m === 'all' ? on : off);\n      document.getElementById('smsm-one').className = 'py-3 rounded-2xl font-bold ' + (m === 'one' ? on : off);\n      document.getElementById('sms-one-box').classList.toggle('hidden', m !== 'one');\n      document.getElementById('sms-send-all').classList.toggle('hidden', m !== 'all');\n      document.getElementById('sms-send-one').classList.toggle('hidden', m !== 'one');\n      document.getElementById('sms-report').classList.add('hidden');\n      api('/school/me').then(setBroadcastInfo).catch(() => {});\n      if (m === 'one') api('/school/parents').then(l => { parentsCache = l; filterParents(); }).catch(e => toast(e.message, false));\n    }\n    function filterParents() {\n      const q = val('sms-search').trim().toLowerCase(); const s = document.getElementById('sms-parent'); const keep = s.value; s.replaceChildren();\n      const list = parentsCache.filter(p => !q || (p.name + ' ' + p.studentName + ' ' + p.phone).toLowerCase().includes(q));\n      if (!list.length) s.appendChild(new Option(T('Hakuna wazazi waliojisajili bado.'), ''));\n      list.forEach(p => s.appendChild(new Option(p.name + ' — ' + p.studentName + (p.className ? ' (' + p.className + ')' : '') + ' • ' + p.phone + (p.dobMismatch ? ' ⚠ ' + T('Tarehe haikulingana') : ''), p.id)));\n      if (keep) s.value = keep;\n    }\n    function showSmsReport(ok, lines) {\n      const r = document.getElementById('sms-report'); r.replaceChildren();\n      r.className = 'rounded-2xl p-4 text-base space-y-1 ' + (ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-yellow-50 border border-yellow-300 text-yellow-900');\n      lines.forEach((t, i) => r.appendChild(el('p', i === 0 ? 'font-bold text-lg' : 'text-sm', t)));\n    }\n    async function sendSchoolSms() {\n      const b = document.getElementById(smsMode === 'all' ? 'sms-send-all' : 'sms-send-one');\n      let target = 'parents';\n      if (smsMode === 'one') { target = val('sms-parent'); if (!target) return toast(T('Chagua mzazi kwanza'), false); target = 'parent:' + target; }\n      b.disabled = true;\n      try {\n        const d = await api('/school/sms', { body: { target, message: val('sms-msg') } });\n        document.getElementById('sms-msg').value = '';\n        if (d.single) showSmsReport(d.sent > 0, [d.sent > 0 ? '✅ ' + T('Ujumbe umetumwa kwa mzazi') : '⚠️ ' + T('Ujumbe haukutumwa (huenda namba hii imefikia ukomo wa SMS za leo)')]);\n        else showSmsReport(d.sent > 0 && !d.failed, [\n          (d.sent > 0 ? '✅ ' : '⚠️ ') + T('Ujumbe umetumwa kwa wazazi wote'),\n          T('Ripoti: wazazi {0} • waliotumiwa {1} • walioshindwa {2} • walioruka {3}', d.total, d.sent, d.failed, d.skipped)]);\n        api('/school/me').then(setBroadcastInfo).catch(() => {});\n      } catch (e) { toast(e.message, false); }\n      finally { b.disabled = false; }\n    }\n    async function withdraw() {\n      try {\n        const d = await api('/school/withdraw', { method: 'POST', body: {} });\n        toast(T('Ombi la kutoa {0} limepokelewa', tsh(d.amount)), true);\n        loadSchool(true);\n      } catch (e) { toast(e.message, false); }\n    }\n\n    /* ================= ADMIN ================= */\n    let adminKey = null; // inakaa kwenye kumbukumbu tu, haihifadhiwi popote\n    async function adminApi(path, body) {\n      let r;\n      try {\n        r = await fetch('/api/admin' + path, {\n          method: body ? 'POST' : 'GET',\n          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey || '' },\n          body: body ? JSON.stringify(body) : undefined,\n        });\n      } catch (e) { throw new Error(T('Hakuna mtandao. Jaribu tena.')); }\n      let data = {};\n      try { data = await r.json(); } catch (e) {}\n      if (!r.ok) {\n        if (r.status === 401 || r.status === 503) { adminKey = null; }\n        throw new Error(T(data.error || 'Hitilafu imetokea. Jaribu tena.'));\n      }\n      return data;\n    }\n    function adminLogin() {\n      return busy('ad-btn', async () => {\n        adminKey = val('ad-key');\n        try { await loadAdmin(); } catch (e) { adminKey = null; throw e; }\n        document.getElementById('ad-key').value = '';\n        show('adminDash');\n      });\n    }\n    function adminLogout() { adminKey = null; showLanding(); }\n    async function adminAct(path, body, okMsg) {\n      try { await adminApi(path, body); toast(T(okMsg), true); await loadAdmin(); }\n      catch (e) { toast(e.message, false); if (!adminKey) show('adminLogin'); }\n    }\n    const SLOT_IDS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'];\n    function buildSlots() {\n      const box = document.getElementById('ad-slots'); if (!box || box.children.length) return;\n      SLOT_IDS.forEach((k, n) => {\n        const w = el('div', 'rounded-2xl border border-slate-200 p-3 space-y-2');\n        const st = el('p', 'text-sm text-slate-500', T('Haijawekwa')); st.id = 'ad-' + k + '-st';\n        const f = document.createElement('input'); f.type = 'file'; f.accept = 'video/mp4,video/webm,video/*'; f.id = 'ad-' + k + '-file'; f.className = 'block w-full text-sm';\n        const up = el('button', 'btn-teacher flex-1 py-3 rounded-xl font-bold', T('Pakia')); up.id = 'ad-' + k + '-up'; up.onclick = () => uploadMedia(k);\n        const rm = el('button', 'px-4 py-3 rounded-xl font-bold bg-red-50 text-red-700 border border-red-200', T('Ondoa')); rm.onclick = () => removeMedia(k);\n        const row = el('div', 'flex gap-3'); row.append(up, rm);\n        w.append(el('p', 'font-semibold text-slate-700', T('Video') + ' ' + (n + 1)), st, f, row);\n        box.appendChild(w);\n      });\n    }\n    async function loadMediaStatus() {\n      buildSlots();\n      try {\n        const m = await (await fetch('/api/public/media', { cache: 'no-store' })).json();\n        const have = new Set((m.videos || []).map((x) => x.slot));\n        SLOT_IDS.forEach((k) => setText('ad-' + k + '-st', T(have.has(k) ? 'Imepakiwa' : 'Haijawekwa')));\n        setText('ad-anthem-st', T(m.anthem ? 'Imepakiwa' : 'Haijawekwa'));\n      } catch (e) {}\n    }\n    // Inakata video iwe sekunde 5 ndani ya kivinjari cha admin (captureStream + MediaRecorder). Isipowezekana, inatuma faili asilia.\n    async function trimClip(file, seconds) {\n      const canRec = typeof MediaRecorder !== 'undefined' && HTMLVideoElement.prototype.captureStream;\n      const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto';\n      const url = URL.createObjectURL(file); v.src = url;\n      try {\n        await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error(T('Video haiwezi kusomwa'))); });\n        if (v.duration <= seconds + 0.2 && file.size <= 15e6) return file; // tayari fupi\n        if (!canRec) { if (file.size > 15e6) throw new Error(T('Faili ni kubwa mno')); return file; }\n        let ctx = null, aud = null;\n        const cap = v.captureStream();\n        const tracks = cap.getVideoTracks();\n        try { // sauti inarekodiwa bila kusikika kwa admin\n          ctx = new (window.AudioContext || window.webkitAudioContext)();\n          const src = ctx.createMediaElementSource(v), dst = ctx.createMediaStreamDestination();\n          src.connect(dst); aud = dst.stream.getAudioTracks();\n        } catch (e) { aud = cap.getAudioTracks(); }\n        const stream = new MediaStream([...tracks, ...(aud || [])]);\n        const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));\n        if (!mime) return file.size <= 15e6 ? file : Promise.reject(new Error(T('Faili ni kubwa mno')));\n        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000 });\n        const parts = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };\n        const done = new Promise((ok) => { rec.onstop = ok; });\n        v.currentTime = 0; if (ctx && ctx.state === 'suspended') await ctx.resume();\n        rec.start(250); await v.play();\n        await new Promise((ok) => {\n          const t = setTimeout(ok, (seconds + 3) * 1000);\n          v.ontimeupdate = () => { if (v.currentTime >= seconds) { clearTimeout(t); ok(); } };\n          v.onended = () => { clearTimeout(t); ok(); };\n        });\n        v.pause(); rec.stop(); await done; if (ctx) ctx.close().catch(() => {});\n        const blob = new Blob(parts, { type: mime.split(';')[0] });\n        if (blob.size < 2000) { if (file.size <= 15e6) return file; throw new Error(T('Video haikukatwa. Jaribu faili lingine.')); }\n        return blob;\n      } finally { URL.revokeObjectURL(url); }\n    }\n    function uploadMedia(kind) {\n      const f = document.getElementById('ad-' + kind + '-file').files[0];\n      if (!f) { toast(T('Chagua faili kwanza'), false); return; }\n      const isAudio = kind === 'anthem';\n      if (f.size > (isAudio ? 12e6 : 300e6)) { toast(T('Faili ni kubwa mno'), false); return; }\n      return busy('ad-' + kind + '-up', async () => {\n        let body = f;\n        if (!isAudio) { setText('ad-cut-st', T('Inakata video iwe sekunde 5… subiri')); try { body = await trimClip(f, CLIP_SECONDS); } finally { setText('ad-cut-st', ''); } }\n        let r;\n        try { r = await fetch('/api/admin/media/' + kind, { method: 'POST', headers: { 'x-admin-key': adminKey || '', 'Content-Type': body.type || 'application/octet-stream' }, body }); }\n        catch (e) { throw new Error(T('Hakuna mtandao. Jaribu tena.')); }\n        let d = {}; try { d = await r.json(); } catch (e) {}\n        if (!r.ok) throw new Error(T(d.error || 'Hitilafu imetokea. Jaribu tena.'));\n        toast(T(isAudio ? 'Imepakiwa' : 'Imepakiwa. Video imekatwa kuwa sekunde 5.'), true);\n        await loadMediaStatus();\n      });\n    }\n    async function removeMedia(kind) {\n      try { await adminApi('/media/' + kind + '/delete', {}); toast(T('Imeondolewa'), true); await loadMediaStatus(); }\n      catch (e) { toast(e.message, false); }\n    }\n    async function loadAdmin() {\n      loadMediaStatus();\n      const d = await adminApi('/overview');\n      setText('ad-t-schools', d.totals.schools); setText('ad-t-parents', d.totals.parents);\n      setText('ad-t-students', d.totals.students); setText('ad-t-paid', tsh(d.totals.paid));\n\n      const wbox = document.getElementById('ad-withdrawals'); wbox.replaceChildren();\n      if (!d.pendingWithdrawals.length) emptyNote(wbox, 'Hakuna maombi ya kutoa pesa.');\n      d.pendingWithdrawals.forEach(w => {\n        const row = el('div', 'px-5 py-4 border-b border-slate-100 space-y-2');\n        row.append(el('p', 'font-semibold', (w.school || '—') + ' • ' + tsh(w.amount)),\n          el('p', 'text-sm text-slate-500', w.phone + ' • ' + new Date(w.at).toLocaleString(dateLocale())));\n        const acts = el('div', 'flex gap-3');\n        const paid = el('button', 'btn-teacher flex-1 py-2 rounded-xl font-bold', T('Nimeshalipa'));\n        paid.onclick = () => { if (confirm(T('Thibitisha kuwa umeshalipa {0} kwa {1}?', tsh(w.amount), w.school || ''))) adminAct('/withdrawals/paid', { id: w.id }, 'Imewekwa kuwa imelipwa'); };\n        const rej = el('button', 'flex-1 py-2 rounded-xl font-bold bg-red-100 text-red-700', T('Kataa'));\n        rej.onclick = () => { if (confirm(T('Kataa ombi hili? Pesa inarudi kwenye salio la shule.'))) adminAct('/withdrawals/reject', { id: w.id }, 'Ombi limekataliwa'); };\n        acts.append(paid, rej); row.appendChild(acts); wbox.appendChild(row);\n      });\n\n      const sbox = document.getElementById('ad-schools'); sbox.replaceChildren();\n      if (!d.schools.length) sbox.appendChild(el('div', 'card rounded-3xl p-6 text-center text-slate-500', T('Hakuna shule bado.')));\n      d.schools.forEach(sc => {\n        const card = el('div', 'card rounded-3xl p-5 space-y-3');\n        const top = el('div', 'flex justify-between gap-3 items-start');\n        const sav = el('div', 'w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center overflow-hidden shrink-0', '🏫');\n        if (sc.hasPhoto) showPhoto(sav, sc.id, '/admin/school/' + sc.id + '/photo', { 'x-admin-key': adminKey || '' });\n        top.append(sav, el('p', 'font-bold text-lg flex-1', sc.school));\n        card.append(top,\n          el('p', 'text-sm text-slate-500', sc.contact + ' • ' + sc.phone),\n          el('p', 'text-sm text-slate-600', T('Wanafunzi: {0}', sc.students) + ' • ' + T('Wamelipa: {0}', sc.paidStudents) + ' • ' + T('Hawajalipa: {0}', sc.students - sc.paidStudents)),\n          el('p', 'text-sm text-slate-600', T('Zilizokusanywa: {0}', tsh(sc.collected)) + ' • ' + T('Kamisheni 35%: {0}', tsh(sc.commission))),\n          el('p', 'text-sm text-slate-600', T('Walizolipwa: {0}', tsh(sc.withdrawnPaid)) + ' • ' + T('Salio: {0}', tsh(sc.balance)) + ' • ' + T('SMS: {0}/{1}', sc.sms.used, sc.sms.quota)),\n          el('p', 'text-sm text-slate-600', T('Namba ya malipo: {0}', sc.payoutPhone)));\n        const lb = el('button', 'bg-slate-100 text-slate-700 w-full py-2 rounded-xl font-bold', T('Angalia wanafunzi'));\n        const list = el('div', 'hidden text-sm border border-slate-100 rounded-xl max-h-64 overflow-y-auto');\n        lb.onclick = async () => {\n          if (!list.classList.contains('hidden')) { list.classList.add('hidden'); return; }\n          try {\n            const sts = await adminApi('/school/' + encodeURIComponent(sc.id) + '/students');\n            list.replaceChildren();\n            if (!sts.length) list.appendChild(el('p', 'p-3 text-slate-500', T('Hakuna wanafunzi bado.')));\n            sts.forEach(x => list.appendChild(el('p', 'px-3 py-2 border-b border-slate-100', x.name + ' (' + x.studentNo + ') • ' + x.className + ' • ' + (x.paid ? '✅ ' + T('Amelipiwa') : '⏳ ' + T('Hajalipiwa')))));\n            list.classList.remove('hidden');\n          } catch (e) { toast(e.message, false); }\n        };\n        const qrow = el('div', 'flex gap-2');\n        const qi = el('input', 'input-light flex-1 min-w-0 px-3 py-2 rounded-xl'); qi.type = 'number'; qi.min = '0'; qi.value = sc.sms.quota;\n        qi.setAttribute('aria-label', T('Ukomo wa SMS kwa mwezi'));\n        const qb = el('button', 'btn-primary px-4 py-2 rounded-xl font-bold', T('Weka ukomo'));\n        qb.onclick = () => adminAct('/quota', { schoolId: sc.id, quota: Number(qi.value) }, 'Ukomo umebadilishwa');\n        qrow.append(qi, qb);\n        card.append(lb, list, qrow); sbox.appendChild(card);\n      });\n    }\n\n    /* ================= MZAZI ================= */\n    let pollTimer = null, currentPaymentId = null;\n    function stopPolling() { clearInterval(pollTimer); pollTimer = null; }\n\n    async function loadParent() {\n      const d = await api('/parent/me');\n      setText('pd-name', d.parent.name); setText('pd-myphone', d.parent.phone || '');\n      setText('pd-child', d.student.name);\n      const av = document.getElementById('pd-avatar'); av.textContent = '🧒';\n      if (d.student.hasPhoto) showPhoto(av, d.student.id);\n      setText('pd-class', d.student.className + ' • ' + T('Namba: {0}', d.student.studentNo));\n      setText('pd-school', d.student.school);\n      setText('pd-tphone', '📞 ' + d.school.phone);\n      setText('pd-tname', d.school.name);\n      const tt = document.getElementById('pd-timetable'); tt.replaceChildren();\n      if (!d.timetable.length) tt.appendChild(el('p', 'text-slate-500 text-center', T('Ratiba haijawekwa bado.')));\n      else d.timetable.forEach(t => {\n        const row = el('div', 'flex justify-between gap-3 py-2 border-b border-slate-100');\n        row.append(el('span', '', T(t.dayName) + ' ' + t.start + '–' + t.end), el('span', 'font-semibold text-right', t.subject + (t.teacher ? ' (' + t.teacher + ')' : '')));\n        tt.appendChild(row);\n      });\n\n      const box = document.getElementById('pd-results'); box.replaceChildren();\n      const note = (t) => box.appendChild(el('p', 'text-slate-500 text-center', T(t)));\n      if (d.status.locked) note('🔒 Lipia ili kuona matokeo ya mtoto wako.');\n      else if (!d.results.length) note('Bado hakuna matokeo.');\n      else d.results.forEach(r => {\n        const row = el('div', 'flex justify-between py-2 border-b border-slate-100');\n        row.append(el('span', '', r.subject), el('span', 'font-bold text-lg ' + (r.score >= 80 ? 'text-green-600' : 'text-blue-600'), r.grade + ' (' + r.score + '%)'));\n        box.appendChild(row);\n      });\n\n      const btn = document.getElementById('payBtn');\n      document.getElementById('mockBtn').classList.add('hidden');\n      if (d.status.paid) {\n        btn.textContent = T('✅ Imeshalipwa'); btn.className = 'btn-teacher w-full py-5 rounded-2xl font-bold text-xl'; btn.disabled = true;\n        setText('payInfo', T('Asante! Malipo yamepokelewa 🎉'));\n        setText('payInfo2', T('Hadi {0}', new Date(d.status.paidUntil).toLocaleDateString(dateLocale())));\n      } else {\n        btn.textContent = T('Lipia Sasa {0}', tsh(d.status.price)); btn.className = 'btn-parent w-full py-5 rounded-2xl font-bold text-xl'; btn.disabled = false;\n        if (d.status.locked) { setText('payInfo', T('Jaribio la bure limeisha')); setText('payInfo2', T('Lipia ili uendelee kuona matokeo')); }\n        else { setText('payInfo', T('Jaribio hili ni la bure')); setText('payInfo2', T('Litaisha {0}', new Date(d.status.trialEndsAt).toLocaleString(dateLocale()))); }\n      }\n    }\n\n    async function payNow() {\n      const btn = document.getElementById('payBtn');\n      btn.disabled = true;\n      try {\n        const d = await api('/pay/initiate', { method: 'POST', body: { phone: val('pay-phone') || undefined } });\n        currentPaymentId = d.paymentId;\n        setText('payInfo', T(d.instructions || 'Angalia simu yako, kisha weka PIN kuthibitisha malipo.'));\n        setText('payInfo2', T('Tunasubiri uthibitisho…'));\n        if (d.mock) document.getElementById('mockBtn').classList.remove('hidden');\n        stopPolling();\n        let tries = 0;\n        pollTimer = setInterval(async () => {\n          if (++tries > 100) { stopPolling(); btn.disabled = false; return; }\n          try {\n            const s = await api('/pay/status/' + currentPaymentId);\n            if (s.status === 'paid') { stopPolling(); celebratePayment(); }\n            else if (s.status === 'failed') { stopPolling(); btn.disabled = false; toast(T('Malipo yameshindwa. Jaribu tena.'), false); }\n          } catch (e) { /* jaribu tena kwenye mzunguko unaofuata */ }\n        }, 3000);\n      } catch (e) { btn.disabled = false; toast(e.message, false); }\n    }\n    async function mockConfirm() {\n      try { await api('/pay/mock-confirm/' + currentPaymentId, { method: 'POST', body: {} }); } catch (e) { toast(e.message, false); }\n    }\n    // Sherehe zinaonekana TU baada ya seva kuthibitisha malipo\n    function celebratePayment() {\n      moneyRain(); playVuvuzela();\n      const end = Date.now() + 2500;\n      (function frame() {\n        confetti({ particleCount: 6, angle: 60, spread: 70, origin: { x: 0 }, colors: ['#16a34a','#facc15','#ffffff'] });\n        confetti({ particleCount: 6, angle: 120, spread: 70, origin: { x: 1 }, colors: ['#16a34a','#facc15','#ffffff'] });\n        if (Date.now() < end) requestAnimationFrame(frame);\n      })();\n      loadParent().catch(() => {});\n    }\n\n    /* ================= MALIPO: NOTI ZA PESA ================= */\n    function moneyRain() {\n      const layer = document.getElementById('moneyLayer');\n      const icons = ['💵', '💴', '💶', '💷', '💰'];\n      for (let i = 0; i < 90; i++) {\n        const n = document.createElement('div');\n        n.className = 'note' + (i % 3 === 0 ? ' up' : '');\n        n.textContent = icons[Math.floor(Math.random() * icons.length)];\n        n.style.left = Math.random() * 100 + 'vw';\n        n.style.fontSize = (28 + Math.random() * 30) + 'px';\n        n.style.setProperty('--sway', (Math.random() * 160 - 80) + 'px');\n        n.style.setProperty('--rot', (Math.random() * 360 - 180) + 'deg');\n        const dur = 2.8 + Math.random() * 2.5;\n        n.style.animationDuration = dur + 's';\n        n.style.animationDelay = (Math.random() * 1.8) + 's';\n        layer.appendChild(n);\n        setTimeout(() => n.remove(), (dur + 2) * 1000 + 500);\n      }\n    }\n    document.querySelectorAll('.confetti-btn').forEach(btn => {\n      btn.addEventListener('click', () => {\n        confetti({ particleCount: 70, spread: 55, origin: { y: 0.7 } });\n      });\n    });\n\n    /* ================= ANZA ================= */\n    buildBrand();\n    collectI18n();\n    applyI18n();\n    (async function restore() {\n      if (token && role) { try { await enterApp(); } catch (e) { clearSession(); showLanding(); } }\n    })();\n  </script>\n</body>\n</html>\n";
const VIDEO_URL = /^(https:\/\/|\/)[^\s"'<>\\]+$/.test(process.env.VIDEO_URL || '') ? process.env.VIDEO_URL : '';
const INDEX_HTML = (INDEX_EMBED !== null ? INDEX_EMBED : fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'))
  .replace('const VIDEO_SRC = "";', () => 'const VIDEO_SRC = ' + JSON.stringify(VIDEO_URL) + ';');

const INDEX_GZ = zlib.gzipSync(Buffer.from(INDEX_HTML), { level: 9 }); // ukurasa mdogo = unafunguka haraka kwenye simu
const INDEX_ETAG = '"' + crypto.createHash('sha256').update(INDEX_HTML).digest('hex').slice(0, 20) + '"';

function readBody(req, limit, binary) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Ombi ni kubwa mno')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function clientIp(req) {
  let ip = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress : req.socket.remoteAddress; // anwani ya mwisho (iliyoongezwa na proxy yako)
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (ip.includes(':')) ip = ip.split(':').slice(0, 4).join(':') + '::/64'; // IPv6: kikomo kwa kila mtandao wa /64, si kila anwani
  return ip;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; connect-src 'self'; img-src 'self' data: blob:");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      const mm = /^\/media\/(v[1-6]|anthem)$/.exec(pathname);
      if (mm) return serveMedia(req, res, mm[1]);
      if (pathname !== '/' && pathname !== '/index.html') { res.writeHead(404); return res.end('Haipo'); }
      const hdr = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: INDEX_ETAG, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === INDEX_ETAG) { res.writeHead(304, hdr); return res.end(); }
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      if (gz) hdr['Content-Encoding'] = 'gzip';
      res.writeHead(200, { ...hdr, 'Content-Length': gz ? INDEX_GZ.length : Buffer.byteLength(INDEX_HTML) });
      return res.end(req.method === 'HEAD' ? undefined : gz ? INDEX_GZ : INDEX_HTML);
    }
    let match = null, params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (m) { match = r; params = m.groups || {}; break; }
    }
    if (!match) throw new HttpError(404, 'Haipo');
    // Thibitisha mtumiaji KABLA ya kusoma mwili wa ombi (asiyeingia hawezi kutuma data kubwa)
    const ip = clientIp(req);
    let user = null;
    if (match.opts.admin) {
      rate('admin:' + ip, 60, 15 * 60e3); // inazuia kubashiri ufunguo
      if (!ADMIN_KEY) throw new HttpError(503, 'Admin haijawashwa');
      if (!safeEq(String(req.headers['x-admin-key'] || ''), ADMIN_KEY)) throw new HttpError(401, 'Hauruhusiwi');
    }
    if (match.opts.auth) {
      user = readToken(req.headers.authorization);
      if (!user) throw new HttpError(401, 'Tafadhali ingia tena');
      if (![].concat(match.opts.auth).includes(user.role)) throw new HttpError(403, 'Hauruhusiwi');
      touchSeen(user);
    }
    const raw = req.method === 'POST' ? await readBody(req, match.opts.maxBody || 100e3, match.opts.binary) : '';
    let body = {};
    if (raw && !match.opts.binary) { try { body = JSON.parse(raw); } catch { throw bad('Data si sahihi'); } }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Data si sahihi');
    const out = await match.fn({ req, raw, body, params, user, ip });
    if (out && out.__raw) {
      res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'private, max-age=300' });
      return res.end(out.__raw);
    }
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Hitilafu ya seva. Jaribu tena baadaye.' });
  }
});
server.requestTimeout = 30e3;
server.headersTimeout = 15e3;
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

sweepInactive(); setInterval(sweepInactive, 6 * HOUR).unref();
server.listen(PORT, () => console.log(`SCHOOL LUBA TECH inaendeshwa: http://localhost:${PORT}  (gateway=${GATEWAY}, sms=${SMS_PROVIDER})`));
