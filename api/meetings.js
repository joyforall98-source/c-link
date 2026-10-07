// 회의록: 목록·상세, 쓰기·고치기(임원), 지우기
// 회의에 안건을 처음 올리면 그 안건의 진행 기록에 남기고, 제안·검토 단계였다면 '회의에 올림'(tabled)으로 바꿉니다.
const db = require('../lib/db');
const { newId, now, fail, need, handler, text, count } = require('../lib/auth');
const { findBill, moveBill, event } = require('./bills');

async function findMeeting(ctx, id) {
    const [m] = await db.select('meetings', { id: String(id || ''), space_id: ctx.space.id });
    if (!m) fail(404, '그런 회의록이 없어요.');
    return m;
}

module.exports = handler({
    GET: async ctx => {
        need(ctx, 'view');
        if (ctx.q.id) return { meeting: await findMeeting(ctx, ctx.q.id) };
        return { meetings: await db.select('meetings', { space_id: ctx.space.id }, 'held_on.desc') };
    },
    POST: {
        save: async ctx => {
            need(ctx, 'officer');
            const b = ctx.body;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.held_on || ''))) fail(400, '회의 날짜를 골라 주세요.');
            const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(i => ({
                bill_id: String(i.bill_id || ''),
                summary: text(i.summary, 1000, '나온 의견'),
                result: text(i.result, 100, '결과')
            }));
            if (new Set(items.map(i => i.bill_id)).size !== items.length) fail(400, '같은 안건을 두 번 넣었어요.');
            const m = {
                title: text(b.title, 60, '회의 이름', true),
                held_on: b.held_on,
                present: count(b.present, '참석') || 0,
                enrolled: count(b.enrolled, '전체 인원') || 0,
                items,
                notes: text(b.notes, 3000, '기타 기록')
            };
            const old = b.id ? await findMeeting(ctx, b.id) : null;
            const before = new Set(old ? old.items.map(i => i.bill_id) : []);
            const bills = await Promise.all(items.map(i => findBill(ctx, i.bill_id)));

            const saved = old
                ? (await db.update('meetings', { id: old.id }, m))[0]
                : await db.insert('meetings', Object.assign({ id: newId(), space_id: ctx.space.id, created_at: now() }, m));
            for (const bill of bills.filter(x => !before.has(x.id))) {
                const note = `${m.title}(${m.held_on})에서 이야기함`;
                if (bill.stage === 'received' || bill.stage === 'review') await moveBill(bill, { stage: 'tabled' }, note, ctx.sess.r);
                else await event(bill, bill.stage, note, ctx.sess.r);
            }
            return { meeting: saved };
        },
        remove: async ctx => {
            need(ctx, 'officer');
            const m = await findMeeting(ctx, ctx.body.id);
            await db.remove('meetings', { id: m.id });
            return { ok: true };
        }
    }
});
