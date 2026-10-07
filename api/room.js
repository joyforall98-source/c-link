// 🔒 투표 방식 실험실(/vote/)의 투표방: 만들기, 학생 투표, 마감·결과 공개
// 방과 표는 2일 동안만 보관하고, 새 방을 만들 때 기간이 지난 방을 지웁니다. 이름 같은 개인정보는 받지 않습니다.
const crypto = require('crypto');
const db = require('../lib/db');
const { fail, handler, text, now, safeEqual } = require('../lib/auth');

const TTL = 2 * 864e5; // 2일
// 세는 방법 → 학생 표 모양 (one: 한 명, many: 여러 명, rank: 전체 순위)
const BALLOT = { plurality: 'one', runoff: 'rank', borda: 'rank', approval: 'many', condorcet: 'rank' };

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const keyOk = (room, key) => typeof key === 'string' && key.length > 0 && safeEqual(hash(key), room.key_hash);
const codeOk = c => /^\d{6}$/.test(String(c || '')) || fail(400, '방 번호는 숫자 6자리예요.');

async function getRoom(code) {
    codeOk(code);
    const [room] = await db.select('rooms', { code: String(code) });
    if (!room || new Date(room.expires_at) < new Date()) fail(404, '그런 투표방이 없거나 기간(2일)이 지났어요. 번호를 다시 확인해 주세요.');
    return { room, votes: await db.select('room_ballots', { room_code: room.code }) };
}

// 같은 표끼리 묶어 [{order, n}]
function groupVotes(votes) {
    const count = {};
    votes.forEach(v => { const k = v.choice.join(','); count[k] = (count[k] || 0) + 1; });
    return Object.entries(count).map(([k, n]) => ({ order: k.split(',').map(Number), n }));
}
function publicState(room, votes, isTeacher) {
    const s = { q: room.q, cands: room.cands, method: room.method, open: room.open, revealed: room.revealed, count: votes.length };
    if (room.revealed || isTeacher) s.groups = groupVotes(votes);
    return s;
}

module.exports = handler({
    GET: async ({ q }) => {
        const { room, votes } = await getRoom(q.code);
        return publicState(room, votes, keyOk(room, q.key));
    },
    POST: {
        create: async ({ body }) => {
            const cands = Array.isArray(body.cands) ? body.cands.map(c => text(c, 20, '후보')).filter(Boolean) : [];
            if (cands.length < 2 || cands.length > 6) fail(400, '후보는 2~6개여야 해요.');
            const key = crypto.randomBytes(16).toString('hex');
            const room = {
                q: text(body.q, 80, '투표 주제'), cands,
                method: BALLOT[body.method] ? body.method : 'plurality',
                open: true, revealed: false, key_hash: hash(key),
                expires_at: new Date(Date.now() + TTL).toISOString(), created_at: now()
            };
            await db.removeBefore('rooms', 'expires_at', now());
            for (let i = 0; i < 8; i++) {
                try {
                    room.code = String(crypto.randomInt(100000, 1000000));
                    await db.insert('rooms', room);
                    return { code: room.code, key };
                } catch (e) { if (!(e instanceof db.Conflict)) throw e; }
            }
            fail(503, '방 번호를 만들지 못했어요. 다시 시도해 주세요.');
        },
        vote: async ({ body }) => {
            const { room } = await getRoom(body.code);
            // ponytail: 기기마다 임의 번호 하나로 한 표만 인정. 브라우저 기록을 지우면 다시 낼 수 있음 (로그인 없이 쓰는 대가)
            const voter = String(body.voter || '');
            const order = Array.isArray(body.order) ? body.order.map(Number) : [];
            const m = room.cands.length, kind = BALLOT[room.method];
            const size = kind === 'rank' ? order.length === m : kind === 'one' ? order.length === 1 : order.length >= 1 && order.length <= m;
            const valid = size && new Set(order).size === order.length && order.every(i => Number.isInteger(i) && i >= 0 && i < m);
            if (!/^[a-z0-9]{8,40}$/.test(voter) || !valid) fail(400, '표 형식이 올바르지 않아요.');
            if (!room.open) fail(409, '투표가 마감되었어요.');
            if (kind === 'many') order.sort((a, b) => a - b);
            await db.upsert('room_ballots', { room_code: room.code, voter, choice: order }, 'room_code,voter');
            return { ok: true };
        },
        update: async ({ body }) => {
            const { room, votes } = await getRoom(body.code);
            if (!keyOk(room, body.key)) fail(403, '이 투표방을 만든 선생님만 바꿀 수 있어요.');
            const patch = {};
            if (typeof body.open === 'boolean') patch.open = body.open;
            if (typeof body.revealed === 'boolean') patch.revealed = body.revealed;
            const [saved] = await db.update('rooms', { code: room.code }, patch);
            return publicState(saved, votes, true);
        }
    }
});
