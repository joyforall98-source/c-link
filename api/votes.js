// 표결: 찬반 표결(의안 의결) 또는 여러 선택지 표결(투표 방식 실험실의 다섯 방법)
// 임원이 시작·마감·공개하고, 제안 코드나 임원·관리 코드로 들어온 기기가 한 대에 한 표씩 냅니다.
const db = require('../lib/db');
const { newId, now, fail, need, handler, text } = require('../lib/auth');
const { findBill, moveBill } = require('./bills');

const BALLOT = { plurality: 'one', runoff: 'rank', borda: 'rank', approval: 'many', condorcet: 'rank' };
const YESNO = ['찬성', '반대', '기권'];

// 출석(투표한 사람) 기준. 기권도 출석에 들어감
function passResult(yes, no, abstain, rule) {
    const total = yes + no + abstain;
    const needed = rule === 'two_thirds' ? Math.ceil(total * 2 / 3) : Math.floor(total / 2) + 1;
    return { yes, no, abstain, total, needed, passed: total > 0 && yes >= needed };
}

async function findVote(ctx, id) {
    const [v] = await db.select('votes', { id: String(id || ''), space_id: ctx.space.id });
    if (!v) fail(404, '그런 투표가 없어요.');
    return v;
}
async function summary(ctx, v) {
    const ballots = await db.select('ballots', { vote_id: v.id });
    const out = { vote: v, count: ballots.length, pass_rule: ctx.space.pass_rule, enrolled: ctx.space.enrolled };
    if (v.revealed || ctx.sess.r === 'officer' || ctx.sess.r === 'admin') {
        if (v.kind === 'yesno') {
            const n = [0, 0, 0];
            ballots.forEach(b => n[b.choice[0]]++);
            out.result = passResult(n[0], n[1], n[2], ctx.space.pass_rule);
        } else {
            const groups = {};
            ballots.forEach(b => { const k = b.choice.join(','); groups[k] = (groups[k] || 0) + 1; });
            out.groups = Object.entries(groups).map(([k, n]) => ({ order: k.split(',').map(Number), n }));
        }
    }
    return out;
}

module.exports = handler({
    GET: async ctx => {
        need(ctx, 'view');
        if (ctx.q.id) {
            const v = await findVote(ctx, ctx.q.id);
            const out = await summary(ctx, v);
            if (v.bill_id) {
                const [bill] = await db.select('bills', { id: v.bill_id });
                if (bill) out.bill = { id: bill.id, year: bill.year, seq: bill.seq, title: bill.title, stage: bill.stage };
            }
            return out;
        }
        return { votes: await db.select('votes', { space_id: ctx.space.id }, 'created_at.desc') };
    },
    POST: {
        start: async ctx => {
            need(ctx, 'officer');
            const b = ctx.body, kind = b.kind === 'choice' ? 'choice' : 'yesno';
            const bill = b.bill_id ? await findBill(ctx, b.bill_id) : null;
            let options = YESNO, method = null;
            if (kind === 'choice') {
                options = (Array.isArray(b.options) ? b.options : []).map(o => text(o, 20, '선택지')).filter(Boolean);
                if (options.length < 2 || options.length > 6) fail(400, '선택지는 2~6개여야 해요.');
                method = BALLOT[b.method] ? b.method : 'plurality';
            } else if (!bill) fail(400, '찬반 투표는 안건을 골라야 해요.');
            const v = {
                id: newId(), space_id: ctx.space.id, bill_id: bill ? bill.id : null,
                title: text(b.title, 80, '투표 제목') || (bill ? bill.title : fail(400, '투표 제목을 입력해 주세요.')),
                kind, method, options, open: true, revealed: false, applied: false, created_at: now()
            };
            await db.insert('votes', v);
            return { vote: v };
        },
        cast: async ctx => {
            need(ctx, 'voter');
            const v = await findVote(ctx, ctx.body.id);
            if (!v.open) fail(409, '투표가 끝났어요.');
            const voter = String(ctx.body.voter || '');
            if (!/^[a-z0-9]{8,40}$/.test(voter)) fail(400, '기기 정보가 올바르지 않아요.');
            const c = Array.isArray(ctx.body.choice) ? ctx.body.choice.map(Number) : [];
            const m = v.options.length, shape = v.kind === 'yesno' ? 'one' : BALLOT[v.method];
            const sizeOk = shape === 'rank' ? c.length === m : shape === 'one' ? c.length === 1 : c.length >= 1 && c.length <= m;
            if (!sizeOk || new Set(c).size !== c.length || !c.every(i => Number.isInteger(i) && i >= 0 && i < m)) fail(400, '표 형식이 올바르지 않아요.');
            if (shape === 'many') c.sort((a, b) => a - b);
            // ponytail: 기기마다 임의 번호로 한 표. 코드를 아는 사람이 기록을 지우면 다시 낼 수 있음 (가입 없는 방식의 한계)
            await db.upsert('ballots', { vote_id: v.id, voter, choice: c }, 'vote_id,voter');
            return { ok: true };
        },
        update: async ctx => {
            need(ctx, 'officer');
            const v = await findVote(ctx, ctx.body.id), patch = {};
            if (typeof ctx.body.open === 'boolean') patch.open = ctx.body.open;
            if (typeof ctx.body.revealed === 'boolean') patch.revealed = ctx.body.revealed;
            const [saved] = await db.update('votes', { id: v.id }, patch);
            return summary(ctx, saved);
        },
        // 찬반 표결 결과를 의안의 의결 결과로 옮김
        apply: async ctx => {
            need(ctx, 'officer');
            const v = await findVote(ctx, ctx.body.id);
            if (v.kind !== 'yesno' || !v.bill_id) fail(400, '안건에 연결된 찬반 투표만 결과를 넣을 수 있어요.');
            if (v.open) fail(400, '먼저 투표를 마감해 주세요.');
            if (v.applied) fail(400, '이미 결과를 넣었어요.');
            const bill = await findBill(ctx, v.bill_id);
            if (!['received', 'review', 'tabled'].includes(bill.stage)) fail(400, '이미 결정했거나 끝난 안건이에요.');
            const { result: r } = await summary(ctx, v);
            const rule = ctx.space.pass_rule === 'two_thirds' ? '참석자 3분의 2 이상' : '참석자 절반보다 많이';
            const note = `투표: 찬성 ${r.yes}, 반대 ${r.no}, 기권 ${r.abstain} (${rule} 찬성해야 통과, ${r.needed}표 필요)`;
            const saved = await moveBill(bill, { stage: 'decided', result: r.passed ? 'passed' : 'rejected', yes_count: r.yes, no_count: r.no, abstain_count: r.abstain }, note, ctx.sess.r);
            await db.update('votes', { id: v.id }, { applied: true });
            return { bill: saved };
        }
    }
});
module.exports.passResult = passResult;
