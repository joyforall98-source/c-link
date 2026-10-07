// 서버 흐름 점검: node check.js (환경 변수 없이 메모리 저장소로 실행, 배포에는 포함하지 않음)
const assert = require('assert');
const api = { space: require('./api/space'), bills: require('./api/bills'), meetings: require('./api/meetings'), votes: require('./api/votes'), room: require('./api/room') };

async function call(name, token, body, query) {
    const req = { method: body ? 'POST' : 'GET', headers: { 'x-token': token || '' }, body, query: query || {} };
    let status = 200, json;
    const res = { setHeader() {}, status(c) { status = c; return res; }, json(o) { json = o; } };
    await api[name](req, res);
    return Object.assign({ status }, json);
}

(async () => {
    const { passResult } = api.votes;
    assert.deepStrictEqual([passResult(11, 9, 0, 'majority').passed, passResult(10, 9, 1, 'majority').passed], [true, false]);
    assert.deepStrictEqual([passResult(14, 6, 0, 'two_thirds').passed, passResult(13, 6, 1, 'two_thirds').passed], [true, false]);

    // 공간 만들기 (교사)
    const made = await call('space', '', { action: 'create', kind: 'council', name: '테스트초 학생회', units: ['1학년 1반', '1학년 2반'], roles: ['회장', '부회장'], enrolled: 4 });
    assert.strictEqual(made.status, 200, made.error);
    const admin = made.token, code = made.space.code, C = made.codes;
    const login = async key => (await call('space', '', { action: 'login', code, key })).token;
    const viewer = await login(), u1 = await login(C.units[0].code), u2 = await login(C.units[1].code), officer = await login(C.officer_code);

    // 접수: 제안 단위만
    assert.strictEqual((await call('bills', viewer, { action: 'create', title: 'x', reason: 'y', content: 'z', role: '회장' })).status, 403);
    const b1 = (await call('bills', u1, { action: 'create', title: '복도에 정수기 설치', reason: '물 마시기 불편', content: '2층 복도에 한 대', role: '회장', category: '시설·환경' })).bill;
    const b2 = (await call('bills', u2, { action: 'create', title: '점심시간 축구장 순번제', reason: '자리 다툼', content: '요일별 순번', role: '부회장' })).bill;
    assert.deepStrictEqual([b1.seq, b2.seq, b1.unit], [1, 2, '1학년 1반']);
    // 임원도 안건을 냄 ('학생회 임원' 이름으로), 선생님(관리 코드)은 내지 않음
    const ob = (await call('bills', officer, { action: 'create', title: '학생회 게시판 새로 꾸미기', reason: '낡았어요', content: '새 게시판', role: '회장' })).bill;
    assert.deepStrictEqual([ob.unit, ob.seq], ['학생회 임원', 3]);
    assert.strictEqual((await call('bills', admin, { action: 'create', title: 't', reason: 'r', content: 'c', role: '회장' })).status, 403);
    const obEvents = (await call('bills', viewer, null, { id: ob.id })).events;
    assert.deepStrictEqual([obEvents[0].by_role, obEvents[0].note], ['officer', '안건 제안']);

    // 단계 바꾸기 권한
    assert.strictEqual((await call('bills', viewer, { action: 'advance', id: b1.id, to: 'review' })).status, 403);
    assert.strictEqual((await call('bills', u2, { action: 'advance', id: b1.id, to: 'withdrawn' })).status, 403);
    assert.strictEqual((await call('bills', officer, { action: 'advance', id: b1.id, to: 'review', note: '시설부 검토' })).status, 200);
    assert.strictEqual((await call('bills', officer, { action: 'advance', id: b1.id, to: 'decided' })).status, 400);

    // 회의록에 올리면 상정
    const m = await call('meetings', officer, { action: 'save', title: '제1차 대의원회', held_on: '2026-10-05', present: 4, enrolled: 4, items: [{ bill_id: b1.id, summary: '찬성 의견 많음' }, { bill_id: b2.id }] });
    assert.strictEqual(m.status, 200, m.error);
    assert.strictEqual((await call('bills', viewer, null, { id: b1.id })).bill.stage, 'tabled');

    // 찬반 표결 → 의안 반영
    const v = (await call('votes', officer, { action: 'start', kind: 'yesno', bill_id: b1.id })).vote;
    assert.strictEqual((await call('votes', viewer, { action: 'cast', id: v.id, voter: 'aaaaaaaa1', choice: [0] })).status, 403);
    for (const [tok, voter, c] of [[u1, 'dev00001', 0], [u2, 'dev00002', 0], [officer, 'dev00003', 1], [u1, 'dev00004', 0]])
        assert.strictEqual((await call('votes', tok, { action: 'cast', id: v.id, voter, choice: [c] })).status, 200);
    assert.strictEqual((await call('votes', officer, { action: 'apply', id: v.id })).status, 400); // 아직 열림
    await call('votes', officer, { action: 'update', id: v.id, open: false, revealed: true });
    const viewed = await call('votes', viewer, null, { id: v.id });
    assert.deepStrictEqual([viewed.result.yes, viewed.result.no, viewed.result.passed], [3, 1, true]);
    const applied = await call('votes', officer, { action: 'apply', id: v.id });
    assert.deepStrictEqual([applied.bill.stage, applied.bill.result, applied.bill.yes_count], ['decided', 'passed', 3]);

    // 건의 → 답변(교사만) → 이행 완료
    await call('bills', officer, { action: 'advance', id: b1.id, to: 'proposed' });
    assert.strictEqual((await call('bills', officer, { action: 'advance', id: b1.id, to: 'answered', reply: '예산 확보' })).status, 403);
    assert.strictEqual((await call('bills', admin, { action: 'advance', id: b1.id, to: 'answered', reply: '2학기 안에 설치' })).status, 200);
    assert.strictEqual((await call('bills', officer, { action: 'advance', id: b1.id, to: 'done' })).bill.stage, 'done');
    const detail = await call('bills', viewer, null, { id: b1.id });
    assert.deepStrictEqual(detail.events.map(e => e.stage), ['received', 'review', 'tabled', 'decided', 'proposed', 'answered', 'done']);
    assert.strictEqual(detail.meetings.length, 1);

    // 선택 표결 (결선투표)
    const cv = (await call('votes', officer, { action: 'start', kind: 'choice', title: '체육대회 종목', options: ['피구', '줄다리기', '계주'], method: 'runoff' })).vote;
    assert.strictEqual((await call('votes', u1, { action: 'cast', id: cv.id, voter: 'dev00001', choice: [0] })).status, 400); // 순위가 아님
    assert.strictEqual((await call('votes', u1, { action: 'cast', id: cv.id, voter: 'dev00001', choice: [2, 0, 1] })).status, 200);

    // 코드 새로 만들면 예전 입장권 막힘
    await call('space', admin, { action: 'regen', which: 'unit', unit: '1학년 1반' });
    assert.strictEqual((await call('bills', u1, null)).status, 401);
    assert.strictEqual((await call('bills', u2, null)).status, 200);

    // 철회: 자기 단위 의안만
    const b3 = (await call('bills', u2, { action: 'create', title: '청소 당번표', reason: 'r', content: 'c', role: '회장' })).bill;
    assert.strictEqual((await call('bills', u2, { action: 'advance', id: b3.id, to: 'withdrawn' })).bill.stage, 'withdrawn');

    // 투표 방식 실험실의 투표방
    const room = await call('room', '', { action: 'create', q: '학급 행사', cands: ['영화', '체육', '보드게임'], method: 'approval' });
    assert.ok(/^\d{6}$/.test(room.code), room.error);
    assert.strictEqual((await call('room', '', { action: 'vote', code: room.code, voter: 'roomdev1', order: [2, 0] })).status, 200);
    assert.strictEqual((await call('room', '', { action: 'vote', code: room.code, voter: 'roomdev1', order: [1] })).status, 200); // 다시 고르기
    assert.strictEqual((await call('room', '', { action: 'vote', code: room.code, voter: 'roomdev2', order: [0, 0] })).status, 400);
    assert.strictEqual((await call('room', '', null, { code: room.code })).groups, undefined); // 공개 전
    assert.strictEqual((await call('room', '', { action: 'update', code: room.code, key: 'wrong', revealed: true })).status, 403);
    const shown = await call('room', '', { action: 'update', code: room.code, key: room.key, open: false, revealed: true });
    assert.deepStrictEqual([shown.count, shown.groups], [1, [{ order: [1], n: 1 }]]);
    assert.strictEqual((await call('room', '', { action: 'vote', code: room.code, voter: 'roomdev3', order: [1] })).status, 409);
    assert.strictEqual((await call('room', '', null, { code: '000000' })).status, 404);

    console.log('모든 점검 통과');
})().catch(e => { console.error(e); process.exit(1); });
