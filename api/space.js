// 공간(학교 학생회 또는 학급) 만들기, 코드로 들어오기, 설정, 코드 새로 만들기
const db = require('../lib/db');
const { makeCode, newId, now, fail, sign, roleFor, need, handler, text, count } = require('../lib/auth');

const KINDS = { council: '대의원회', class: '학급회의' };

const publicSpace = s => ({
    code: s.code, name: s.name, kind: s.kind, body_name: s.body_name,
    units: s.units.map(u => u.name), roles: s.roles, pass_rule: s.pass_rule, enrolled: s.enrolled
});
const codes = s => ({ code: s.code, admin_code: s.admin_code, officer_code: s.officer_code, units: s.units });
const me = (role, unit) => ({ role, unit: unit || null });

// 이름 목록 확인 (제안 단위, 직책)
function names(list, max, each, label) {
    const out = (Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(Boolean);
    if (!out.length) fail(400, label + '을(를) 하나 이상 넣어 주세요.');
    if (out.length > max) fail(400, `${label}은(는) ${max}개까지 넣을 수 있어요.`);
    if (out.some(x => x.length > each)) fail(400, `${label} 이름은 ${each}자까지예요.`);
    if (new Set(out).size !== out.length) fail(400, `${label}에 같은 이름이 두 번 있어요.`);
    return out;
}
// 공간 안의 모든 역할 코드가 서로 다르게
function freshCode(space) {
    const used = new Set([space.admin_code, space.officer_code, ...(space.units || []).map(u => u.code)]);
    let c; do { c = makeCode(6); } while (used.has(c));
    return c;
}
function settingsFrom(b, old) {
    const kind = old ? old.kind : (KINDS[b.kind] ? b.kind : 'council');
    const unitNames = names(b.units, 80, 20, '안건을 내는 곳');
    const s = {
        kind,
        name: text(b.name, 40, '이름', true),
        body_name: text(b.body_name, 20, '회의 모임 이름') || KINDS[kind],
        roles: names(b.roles, 15, 12, '역할'),
        pass_rule: b.pass_rule === 'two_thirds' ? 'two_thirds' : 'majority',
        enrolled: count(b.enrolled, '전체 인원') || 0,
        admin_code: old ? old.admin_code : makeCode(6),
        officer_code: old ? old.officer_code : '',
        units: []
    };
    if (!old) s.officer_code = freshCode(s);
    // 이름이 같은 제안 단위는 코드를 그대로 둔다
    for (const name of unitNames) {
        const prev = old && old.units.find(u => u.name === name);
        s.units.push({ name, code: prev ? prev.code : freshCode(s) });
    }
    return s;
}

module.exports = handler({
    GET: async ctx => {
        need(ctx, 'view');
        const out = { space: publicSpace(ctx.space), me: me(ctx.sess.r, ctx.sess.u) };
        if (ctx.sess.r === 'admin') out.codes = codes(ctx.space);
        return out;
    },
    POST: {
        create: async ({ body }) => {
            const s = Object.assign({ id: newId(), created_at: now() }, settingsFrom(body));
            for (let i = 0; ; i++) {
                try { s.code = makeCode(8); await db.insert('spaces', s); break; }
                catch (e) { if (!(e instanceof db.Conflict) || i > 5) throw e; }
            }
            return { token: sign(s, 'admin'), space: publicSpace(s), me: me('admin'), codes: codes(s) };
        },
        login: async ({ body }) => {
            const code = String(body.code || '').trim().toUpperCase();
            if (!/^[A-Z0-9]{8}$/.test(code)) fail(400, '공간 코드는 영문·숫자 8자리예요.');
            const [space] = await db.select('spaces', { code });
            if (!space) fail(404, '그런 공간이 없어요. 코드를 다시 확인해 주세요.');
            if (!body.key) return { token: sign(space, 'view'), space: publicSpace(space), me: me('view') };
            const found = roleFor(space, body.key);
            if (!found) fail(403, '권한 코드가 맞지 않아요.');
            return { token: sign(space, found.role, found.unit), space: publicSpace(space), me: me(found.role, found.unit) };
        },
        settings: async ctx => {
            need(ctx, 'admin');
            const s = settingsFrom(ctx.body, ctx.space);
            delete s.kind;
            const [saved] = await db.update('spaces', { id: ctx.space.id }, s);
            return { space: publicSpace(saved), codes: codes(saved) };
        },
        // which: space | admin | officer | unit (+ unit 이름). 예전 코드로 받은 입장권은 더 이상 쓰지 못함
        regen: async ctx => {
            need(ctx, 'admin');
            const s = ctx.space, which = ctx.body.which, patch = {};
            if (which === 'admin') patch.admin_code = freshCode(s);
            else if (which === 'officer') patch.officer_code = freshCode(s);
            else if (which === 'unit') {
                if (!s.units.some(u => u.name === ctx.body.unit)) fail(400, '그런 학급(모둠)이 없어요.');
                patch.units = s.units.map(u => u.name === ctx.body.unit ? { name: u.name, code: freshCode(s) } : u);
            } else if (which !== 'space') fail(400, '무엇을 새로 만들지 골라 주세요.');
            for (let i = 0; ; i++) {
                try {
                    if (which === 'space') patch.code = makeCode(8);
                    const [saved] = await db.update('spaces', { id: s.id }, patch);
                    return { space: publicSpace(saved), codes: codes(saved), token: sign(saved, 'admin') };
                } catch (e) { if (!(e instanceof db.Conflict) || i > 5) throw e; }
            }
        },
        remove: async ctx => {
            need(ctx, 'admin');
            if (String(ctx.body.confirm || '').trim() !== ctx.space.name) fail(400, '확인을 위해 공간 이름을 똑같이 입력해 주세요.');
            await db.remove('spaces', { id: ctx.space.id });
            // 메모리 저장소는 연결 삭제(cascade)를 하지 않으므로 직접 지움 (Supabase 에서는 이미 지워짐)
            for (const t of ['bills', 'bill_events', 'meetings', 'votes']) await db.remove(t, { space_id: ctx.space.id });
            return { ok: true };
        }
    }
});
