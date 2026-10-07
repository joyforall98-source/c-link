// 🔒 Supabase REST(PostgREST) 를 서버에서만 부르는 작은 도구.
// 조건은 "열 = 값" 만 씁니다. 검색·정렬처럼 복잡한 일은 공간 하나의 자료를 받아 서버에서 처리합니다.
// 환경 변수가 없으면(내 컴퓨터 시험) 메모리에 저장합니다. Vercel 위에서는 쓰지 않습니다.
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

class Conflict extends Error {}

// before: 이 열은 "같음" 대신 "보다 작음"으로 거름 (지난 투표방 지우기)
async function rest(method, table, { filter = {}, body, order, onConflict, before, prefer = 'return=representation' } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) q.append(k, k === before ? 'lt.' + v : 'eq.' + v);
    if (order) q.append('order', order);
    if (onConflict) q.append('on_conflict', onConflict);
    const r = await fetch(`${URL_}/rest/v1/${table}?${q}`, {
        method,
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: prefer },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (r.status === 409) throw new Conflict('이미 있는 값입니다.');
    if (!r.ok) throw new Error(`저장소 오류 (${r.status}) ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? [] : r.json();
}

const supabase = {
    select: (t, filter, order) => rest('GET', t, { filter, order }),
    insert: async (t, row) => (await rest('POST', t, { body: row }))[0],
    update: (t, filter, patch) => rest('PATCH', t, { filter, body: patch }),
    upsert: (t, row, onConflict) => rest('POST', t, { body: row, onConflict, prefer: 'return=representation,resolution=merge-duplicates' }),
    remove: (t, filter) => rest('DELETE', t, { filter }),
    removeBefore: (t, col, value) => rest('DELETE', t, { filter: { [col]: value }, before: col })
};

// ── 메모리 저장소 (시험용) ──
const mem = {};
const UNIQUE = { spaces: ['code'], bills: ['space_id', 'year', 'seq'], ballots: ['vote_id', 'voter'], rooms: ['code'], room_ballots: ['room_code', 'voter'] };
// Supabase 의 on delete cascade 흉내 (투표방을 지우면 그 방의 표도)
const CASCADE = { rooms: ['room_ballots', 'room_code', 'code'] };
function dropRows(t, gone) {
    mem[t] = rows(t).filter(r => !gone(r));
    const c = CASCADE[t];
    if (c) {
        const keys = new Set(rows(t).map(r => String(r[c[2]])));
        mem[c[0]] = rows(c[0]).filter(r => keys.has(String(r[c[1]])));
    }
    return [];
}
const rows = t => (mem[t] = mem[t] || []);
const match = (row, filter) => Object.entries(filter).every(([k, v]) => String(row[k]) === String(v));
const sameKey = (t, a, b) => UNIQUE[t] && UNIQUE[t].every(k => String(a[k]) === String(b[k]));
const copy = o => JSON.parse(JSON.stringify(o));
const memory = {
    async select(t, filter = {}, order) {
        const out = rows(t).filter(r => match(r, filter)).map(copy);
        if (order) {
            const [col, dir] = order.split('.');
            out.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        return out;
    },
    async insert(t, row) {
        if (rows(t).some(r => sameKey(t, r, row))) throw new Conflict('이미 있는 값입니다.');
        rows(t).push(copy(row));
        return copy(row);
    },
    async update(t, filter, patch) {
        return rows(t).filter(r => match(r, filter)).map(r => copy(Object.assign(r, copy(patch))));
    },
    async upsert(t, row) {
        const old = rows(t).find(r => sameKey(t, r, row));
        old ? Object.assign(old, copy(row)) : rows(t).push(copy(row));
        return [copy(row)];
    },
    async remove(t, filter) { return dropRows(t, r => match(r, filter)); },
    async removeBefore(t, col, value) { return dropRows(t, r => r[col] < value); }
};

// Vercel 위인데 환경 변수가 없으면 요청마다 안내 오류를 냄 (lib/auth.js handler)
module.exports = Object.assign(URL_ ? supabase : memory, { Conflict, ready: Boolean(URL_) || !process.env.VERCEL });
