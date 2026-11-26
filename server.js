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
const INDEX_EMBED = /*__INDEX_HTML__*/ null;
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
