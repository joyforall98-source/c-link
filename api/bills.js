// 의안: 목록·상세, 접수, 처리 단계 바꾸기(경과 기록), 철회
const db = require('../lib/db');
const { newId, now, fail, need, handler, text, count, schoolYear } = require('../lib/auth');

const CATEGORIES = ['시설·환경', '행사', '규칙·생활', '급식', '학습', '기타'];
const MAX_BILLS = 3000; // ponytail: 공간 하나의 의안을 통째로 받아 서버에서 거름. 수천 건을 넘으면 DB 검색으로 바꿀 것

// 단계: received 접수 → review 심사 → tabled 상정 → decided 의결 → proposed 건의 → answered 답변 → done 이행 완료
//      끝난 상태: withdrawn 철회, returned 반려, decided+rejected 부결, done
const NEXT = {
    received: ['review', 'tabled', 'returned', 'withdrawn'],
    review: ['tabled', 'returned', 'withdrawn'],
    tabled: ['decided'],
    decided: ['proposed'],
    proposed: ['answered'],
    answered: ['done']
};
const RESULTS = ['passed', 'amended', 'rejected'];
const officerName = space => space.kind === 'class' ? '학급 임원' : '학생회 임원';

async function findBill(ctx, id) {
    const [bill] = await db.select('bills', { id: String(id || ''), space_id: ctx.space.id });
    if (!bill) fail(404, '그런 안건이 없어요.');
    return bill;
}
const event = (bill, stage, note, by) =>
    db.insert('bill_events', { id: newId(), bill_id: bill.id, space_id: bill.space_id, stage, note, by_role: by, at: now() });

async function moveBill(bill, patch, note, by) {
    const [saved] = await db.update('bills', { id: bill.id }, Object.assign(patch, { updated_at: now() }));
    await event(saved, saved.stage, note, by);
    return saved;
}

module.exports = handler({
    GET: async ctx => {
        need(ctx, 'view');
        if (ctx.q.id) {
            const bill = await findBill(ctx, ctx.q.id);
            const [events, meetings, votes] = await Promise.all([
                db.select('bill_events', { bill_id: bill.id }, 'at.asc'),
                db.select('meetings', { space_id: ctx.space.id }, 'held_on.asc'),
                db.select('votes', { bill_id: bill.id }, 'created_at.asc')
            ]);
            return {
                bill, events,
                meetings: meetings.filter(m => m.items.some(i => i.bill_id === bill.id)).map(m => ({ id: m.id, title: m.title, held_on: m.held_on })),
                votes: votes.map(v => ({ id: v.id, title: v.title, kind: v.kind, open: v.open, revealed: v.revealed, applied: v.applied }))
            };
        }
        const [bills, openVotes] = await Promise.all([
            db.select('bills', { space_id: ctx.space.id }, 'created_at.desc'),
            db.select('votes', { space_id: ctx.space.id, open: true }, 'created_at.asc')
        ]);
        return { bills, categories: CATEGORIES, openVotes: openVotes.map(v => ({ id: v.id, title: v.title })) };
    },
    POST: {
        create: async ctx => {
            need(ctx, 'view');
            // 학급(모둠) 대표는 자기 학급 이름으로, 임원은 '학생회 임원'(학급 공간은 '학급 임원') 이름으로 냄
            const by = ctx.sess.r;
            if (by !== 'unit' && by !== 'officer') fail(403, '안건은 학급(모둠) 대표나 임원이 낼 수 있어요.');
            const b = ctx.body;
            const bill = {
                id: newId(), space_id: ctx.space.id, year: schoolYear(),
                title: text(b.title, 80, '제목', true),
                reason: text(b.reason, 1000, '필요한 까닭', true),
                content: text(b.content, 2000, '바라는 내용', true),
                category: CATEGORIES.includes(b.category) ? b.category : '기타',
                unit: by === 'unit' ? ctx.sess.u : officerName(ctx.space),
                role: ctx.space.roles.includes(b.role) ? b.role : fail(400, '역할을 골라 주세요.'),
                stage: 'received', result: null, yes_count: null, no_count: null, abstain_count: null, reply: null,
                created_at: now(), updated_at: now()
            };
            const all = await db.select('bills', { space_id: ctx.space.id });
            if (all.length >= MAX_BILLS) fail(400, '안건 수가 너무 많아요. 선생님께 알려 주세요.');
            // 일련번호: 같은 학년도 안에서 1부터. 동시에 접수되면 다시 매김
            let seq = Math.max(0, ...all.filter(x => x.year === bill.year).map(x => x.seq));
            for (let i = 0; ; i++) {
                try { bill.seq = ++seq; await db.insert('bills', bill); break; }
                catch (e) { if (!(e instanceof db.Conflict) || i > 5) throw e; }
            }
            await event(bill, 'received', '안건 제안', by);
            return { bill };
        },
        advance: async ctx => {
            need(ctx, 'view');
            const b = ctx.body, bill = await findBill(ctx, b.id), to = b.to;
            if (!(NEXT[bill.stage] || []).includes(to)) fail(400, '지금 단계에서는 그 단계로 바꿀 수 없어요.');
            // 제안 취소는 낸 학급(모둠)도, 학교 답변은 교사만
            if (to === 'withdrawn' && ctx.sess && ctx.sess.r === 'unit') {
                if (ctx.sess.u !== bill.unit) fail(403, '우리 학급(모둠)이 낸 안건만 제안을 취소할 수 있어요.');
            } else need(ctx, to === 'answered' ? 'admin' : 'officer');

            const note = text(b.note, 500, '메모') || (to === 'answered' ? '답변 등록' : '');
            const patch = { stage: to };
            if (to === 'returned' && !note) fail(400, '돌려보내는 까닭을 적어 주세요.');
            if (to === 'decided') {
                if (!RESULTS.includes(b.result)) fail(400, '결정(통과·고쳐서 통과·통과 못 함)을 골라 주세요.');
                Object.assign(patch, { result: b.result, yes_count: count(b.yes, '찬성'), no_count: count(b.no, '반대'), abstain_count: count(b.abstain, '기권') });
            }
            if (to === 'proposed' && bill.result === 'rejected') fail(400, '통과하지 못한 안건은 학교에 전달할 수 없어요.');
            if (to === 'answered') patch.reply = text(b.reply, 1000, '답변', true);
            const saved = await moveBill(bill, patch, note, ctx.sess.r);
            return { bill: saved };
        }
    }
});
// 회의록·표결에서도 의안 단계와 경과를 남김
Object.assign(module.exports, { findBill, moveBill, event });
