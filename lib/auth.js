// 🔒 코드 로그인, 서명된 입장권(토큰), 권한 확인, 요청 처리 틀.
// 가입 없이 코드로 들어옵니다: 공간 코드(열람) · 제안 코드(제안 단위별) · 임원 코드 · 관리 코드(교사).
// 입장권에는 들어올 때 쓴 코드의 지문이 들어 있어, 교사가 코드를 새로 만들면 예전 입장권은 바로 막힙니다.
const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.SESSION_SECRET || (process.env.VERCEL ? '' : 'local-dev-secret');
const DAYS = 180;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 I, O, 0, 1 제외 (32자)

const makeCode = n => Array.from(crypto.randomBytes(n), b => ALPHA[b % 32]).join('');
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const mac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const fingerprint = code => crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 12);
const safeEqual = (a, b) => {
    const A = Buffer.from(String(a)), B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
};

function sign(space, role, unit) {
    const p = { s: space.id, r: role, u: unit, k: fingerprint(codeOf(space, role, unit)), exp: Date.now() + DAYS * 864e5 };
    const body = Buffer.from(JSON.stringify(p)).toString('base64url');
    return body + '.' + mac(body);
}
function verify(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !safeEqual(sig, mac(body))) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.exp > Date.now() ? p : null;
    } catch (e) { return null; }
}

// 역할마다 지금 유효한 코드
function codeOf(space, role, unit) {
    if (role === 'admin') return space.admin_code;
    if (role === 'officer') return space.officer_code;
    if (role === 'unit') return (space.units.find(u => u.name === unit) || {}).code;
    return space.code;
}
// 입력한 코드가 어떤 역할인지 (공간 코드는 따로 확인)
function roleFor(space, code) {
    const c = String(code || '').trim().toUpperCase();
    if (safeEqual(c, space.admin_code)) return { role: 'admin' };
    if (safeEqual(c, space.officer_code)) return { role: 'officer' };
    const u = space.units.find(u => safeEqual(c, u.code));
    return u ? { role: 'unit', unit: u.name } : null;
}

const RANK = { view: 0, unit: 1, officer: 2, admin: 3 };
// role: view(누구나) | unit(제안 단위만) | voter(열람만 하는 사람 빼고) | officer | admin
function need(ctx, role) {
    if (!ctx.sess) fail(401, '다시 들어와 주세요. 코드가 바뀌었거나 기간이 지났어요.');
    const r = ctx.sess.r;
    const ok = role === 'unit' ? r === 'unit' : role === 'voter' ? r !== 'view' : RANK[r] >= RANK[role];
    if (!ok) fail(403, '이 일을 할 권한이 없어요.');
}

async function loadSession(ctx) {
    const p = verify(ctx.req.headers['x-token']);
    if (!p) return;
    const [space] = await db.select('spaces', { id: p.s });
    const code = space && codeOf(space, p.r, p.u);
    if (code && fingerprint(code) === p.k) { ctx.sess = p; ctx.space = space; }
}

// routes = { GET: fn, POST: { 동작이름: fn } }
function handler(routes) {
    return async function (req, res) {
        res.setHeader('Cache-Control', 'no-store');
        try {
            if (!db.ready || !SECRET) fail(500, '서버 환경 변수(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET)가 설정되지 않았습니다.');
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const ctx = { req, q: req.query || {}, body, sess: null, space: null };
            const fn = req.method === 'GET' ? routes.GET : req.method === 'POST' ? (routes.POST || {})[body.action] : null;
            if (!fn) fail(400, '알 수 없는 요청이에요.');
            await loadSession(ctx);
            return res.status(200).json(await fn(ctx));
        } catch (e) {
            if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
            if (e instanceof db.Conflict) return res.status(409).json({ error: e.message });
            console.error(e);
            return res.status(500).json({ error: '서버 오류: ' + e.message });
        }
    };
}

// 글자 입력 확인: 앞뒤 공백 제거, 길이 제한
function text(v, max, label, required) {
    const s = String(v == null ? '' : v).trim();
    if (required && !s) fail(400, label + '을(를) 입력해 주세요.');
    if (s.length > max) fail(400, `${label}은(는) ${max}자까지 쓸 수 있어요.`);
    return s;
}
function count(v, label) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 9999) fail(400, label + ' 수가 올바르지 않아요.');
    return n;
}

// 학년도: 3월에 시작 (한국 시간 기준)
function schoolYear(d = new Date()) {
    const k = new Date(d.getTime() + 9 * 3600e3);
    return k.getUTCMonth() < 2 ? k.getUTCFullYear() - 1 : k.getUTCFullYear();
}

module.exports = { makeCode, newId, now, fail, sign, roleFor, need, handler, text, count, schoolYear, safeEqual };
