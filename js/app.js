// 화면. 상태는 기기(IndexedDB)에 저장되어 앱을 닫아도 이어서 할 수 있다.
import * as L from './logic.js';
import { drafts, photos, kv, requestPersistence } from './store.js';
import { call, apiUrl } from './api.js';
import { resizePhoto } from './photo.js';
import { processQueue, startSync, onSyncChange } from './sync.js';
import { validateSkips } from './skip.js';

const $app = document.getElementById('app');
const state = { cfg: null, cfgInfo: null, draft: null, pages: [], view: 'home', toilets: null, search: '' };

// ---------- 도구 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blank = (v) => v === undefined || v === null || v === '';
const ls = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};
const pad = (n) => String(n).padStart(2, '0');
function nowText(t = new Date()) {
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
const dateText = (ms) => (ms ? nowText(new Date(ms)) : '');

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (state.draft && state.draft.status === 'editing') await drafts.put(state.draft);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('pagehide', saveNow);

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/** 확인 창. buttons: [{label, value, primary}] → 누른 버튼의 value */
function modal(title, bodyHtml, buttons) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
      <h2 id="mt">${esc(title)}</h2><div class="modal-body">${bodyHtml}</div>
      <div class="modal-buttons">${buttons.map((b, i) => `<button class="btn ${b.primary ? 'primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      wrap.remove();
      resolve(buttons[Number(b.dataset.i)].value);
    });
    document.body.appendChild(wrap);
    wrap.querySelector('button.primary, button')?.focus();
  });
}
const confirmBox = (title, body, yes = '예', no = '아니오') => modal(title, body, [{ label: no, value: false }, { label: yes, value: true, primary: true }]);

// ---------- 설정 불러오기 ----------
async function loadConfig({ force = false } = {}) {
  const cached = await kv.get('config');
  if (cached && !force && Array.isArray(cached.data?.items)) useConfig(cached.data, cached.fetchedAt, true);
  if (!navigator.onLine || !apiUrl()) { loadAssignments(); return; } // 인터넷이 없으면 저장된 배정 목록만
  try {
    const data = await call('config');
    if (!Array.isArray(data.items)) throw new Error('서버에서 조사 항목을 받지 못했습니다. 잠시 뒤 다시 열어 주세요.');
    state.needPw = false;
    await kv.set('config', { data, fetchedAt: Date.now() });
    useConfig(data, Date.now(), false);
    if (force) toast('조사 항목을 새로 불러왔습니다.');
  } catch (e) {
    // 서버에 비밀번호가 걸려 있을 때만 비밀번호 칸을 보여 준다 (경고 대신 안내)
    if (/비밀번호/.test(e.message)) { state.needPw = true; return; }
    if (!cached || force) state.cfgError = e.message;
  }
  loadAssignments();
}

// ---------- 배정 목록 ----------
async function loadAssignments() {
  const cached = await kv.get('assignments');
  if (Array.isArray(cached?.items)) { state.assignments = cached.items; state.assignmentsReady = true; }
  if (!navigator.onLine || !apiUrl()) { state.assignmentsReady = true; return; }
  try {
    const res = await call('assignments');
    state.assignments = res.items || [];
    await kv.set('assignments', { items: state.assignments, fetchedAt: Date.now() });
  } catch { /* 예전 서버(배정 기능 없음)거나 끊김 — 저장된 목록을 씀 */ }
  await loadToiletInfo();
  state.assignmentsReady = true;
  if (state.view === 'home') renderHome();
}

/** 제출된 화장실들의 빈 필수 칸 수 (서버가 셈). '마저 해야 할 화장실'에 씀. 끊겨 있으면 저장된 사본 */
async function loadToiletInfo() {
  const cached = await kv.get('toilets');
  if (Array.isArray(cached?.items)) state.toiletInfo = cached.items;
  if (!navigator.onLine || !apiUrl()) return;
  try {
    const items = (await call('listToilets')).toilets || [];
    state.toiletInfo = items;
    await kv.set('toilets', { items, fetchedAt: Date.now() });
  } catch { /* 저장된 사본을 씀 */ }
}
const toiletMissing = (tid) => {
  const t = (state.toiletInfo || []).find((x) => x.id === tid);
  return t && typeof t.missing === 'number' ? t.missing : null;
};

function todayText() {
  const t = new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function dateLabel(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return s || '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${Number(m[2])}월 ${Number(m[3])}일 (${DOW[d.getDay()]})${s === todayText() ? ' · 오늘' : ''}`;
}

const ASSIGN_TEXT = { todo: '조사 전', editing: '입력 중', queued: '제출 대기', done: '제출됨' };

// 조: '3' → '3조', 글자는 그대로. 고른 조가 조사자로 기록된다.
const teamLabel = (t) => (/^\d+$/.test(String(t || '')) ? `${t}조` : String(t || ''));
const currentTeam = () => ls.get('ts.lastTeam');

/** 조 버튼: 고르기 전엔 5칸씩 번호판, 고른 뒤엔 한 줄로 접힘("3조 · 조 바꾸기"). 오늘 배정 있는 조는 노랗게 */
function teamChipsHtml(teams, team, activeToday) {
  if (team && !state.pickTeam) {
    return `<div class="team-picked"><span class="team-now">${esc(teamLabel(team))}</span>
      <button class="btn" id="changeTeam">조 바꾸기</button></div>`;
  }
  return `<h2 class="sec">오늘 활동하는 조를 눌러 주세요</h2>
    <div class="team-chips">${teams.map((t) => `<button class="team-chip ${t === team ? 'on' : ''} ${activeToday.has(t) ? 'today' : ''}" data-team="${esc(t)}" aria-pressed="${t === team}">${esc(teamLabel(t))}</button>`).join('')}</div>
    <p class="hint cal-legend">${activeToday.size ? '노란 조 = 오늘 배정이 있는 조 · ' : ''}고른 조가 조사자로 기록됩니다</p>`;
}

/** 처음 화면: 조 버튼 → 그 조의 한 주 달력(배정된 날 표시, 오늘이 먼저 골라짐) → 고른 날의 화장실 목록. 배정이 없으면 1~10조 버튼만 */
function teamHtml(allDrafts) {
  const items = state.assignments || [];
  const team = currentTeam();
  if (!items.length && !state.assignmentsReady) return '<h2 class="sec">오늘 활동하는 조</h2><p class="hint">배정 목록을 불러오는 중입니다…</p>';
  if (!items.length) {
    const teams = Array.from({ length: 10 }, (_, k) => String(k + 1));
    if (team && !teams.includes(team)) teams.push(team);
    return teamChipsHtml(teams, team, new Set());
  }
  const today = todayText();
  const teams = L.assignmentTeams(items);
  if (team && !teams.includes(team)) teams.push(team);
  const chips = teamChipsHtml(teams, team, new Set(items.filter((a) => a.date === today).map((a) => a.team)));
  if (!team) return chips;
  if (state.pickTeam) return chips;

  const teamItems = items.filter((a) => a.team === team);
  // 조를 새로 고르면: 오늘 → 없으면 가장 가까운 다음 배정일 → 없으면 마지막 배정일
  if (state.calTeam !== team || !state.assignDate) {
    state.calTeam = team;
    state.assignDate = L.assignmentDates(teamItems, today).pick;
    state.calWeek = state.assignDate;
  }
  const date = state.assignDate;
  const week = L.weekDays(state.calWeek || date);
  const byDate = new Map();
  for (const a of teamItems) {
    const s = byDate.get(a.date) || { n: 0, done: 0 };
    s.n++;
    if (L.assignmentStatus(a, allDrafts).kind === 'done') s.done++;
    byDate.set(a.date, s);
  }
  const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;
  const cal = `<div class="cal">
      <div class="date-nav">
        <button class="btn nav" id="wprev" aria-label="이전 주">◀</button>
        <div class="date-label week-label">${md(week[0])}~${week[0].slice(5, 7) === week[6].slice(5, 7) ? `${Number(week[6].slice(8))}일` : md(week[6])}</div>
        <button class="btn nav" id="wnext" aria-label="다음 주">▶</button>
      </div>
      <div class="cal-grid">${DOW.map((w) => `<div class="cal-dow">${w}</div>`).join('')}
      ${week.map((d) => {
        const s = byDate.get(d);
        const cls = ['cal-day', s ? 'has' : '', s && s.done === s.n ? 'all-done' : '', d === today ? 'today' : '', d === date ? 'on' : ''].filter(Boolean).join(' ');
        return `<button class="${cls}" data-day="${d}" aria-pressed="${d === date}" aria-label="${esc(dateLabel(d))}${s ? ` 배정 ${s.n}곳` : ''}"><span>${Number(d.slice(8))}</span>${s ? `<small>${s.done === s.n ? '✓' : `${s.n}곳`}</small>` : ''}</button>`;
      }).join('')}</div>
      <p class="hint cal-legend">노란 날 = ${esc(teamLabel(team))} 배정일 · 초록 ✓ = 모두 제출 · 굵은 테두리 = 오늘${week.includes(today) ? '' : ' <button class="linklike" id="wtoday">오늘로 돌아가기</button>'}</p>
    </div>`;
  const list = teamItems.filter((a) => a.date === date);
  const mine = list.length ? { list } : null;
  return `${chips}${cal}
    ${mine ? `<div class="team-group">
      <h3 class="team-title">${esc(dateLabel(date))} ${esc(teamLabel(team))} 목록 <span class="sub">${mine.list.length}곳</span></h3>
      ${mine.list.map((a) => assignCardHtml(a, allDrafts)).join('')}</div>`
      : `<p class="hint">${esc(dateLabel(date))}에는 ${esc(teamLabel(team))}에 배정된 화장실이 없습니다. 달력에서 노란 날을 눌러 보세요.</p>`}`;
}

/** 배정 카드 한 장: 이름·주소 + 상태 + 지금 할 일. 이 화장실의 휴대폰 기록(입력·보완·전송)은 모두 이 카드에만 */
function assignCardHtml(a, allDrafts) {
  state.shownKeys.add(`A:${a.id}`);
  const st = L.assignmentStatus(a, allDrafts);
  const g = state.groups?.get(`A:${a.id}`);
  const sum = g ? L.groupSummary(g) : null;
  let chip = `<span class="status s-a-${st.kind}">${ASSIGN_TEXT[st.kind]}${st.tid ? ` ${esc(st.tid)}` : ''}</span>`;
  let todo = '';
  if (sum?.kind === 'failed') {
    chip = '<span class="status s-failed">전송 실패</span>';
    todo = `<div class="err">${esc(sum.failed.error || '보내지 못했습니다')} — 위 "지금 다시 보내기"를 눌러 주세요.</div>`;
  } else if (st.kind === 'editing') {
    const left = state.cfg ? L.missingAll(state.cfg, st.draft).length : 0;
    todo = `<div class="todo">▶ 눌러서 이어서 하기${left ? ` · 필수 ${left}개 남음` : ' · 필수 모두 입력함'}</div>`;
  } else if (sum?.kind === 'supp') {
    chip = `<span class="status s-a-editing">보완 중${st.tid ? ` ${esc(st.tid)}` : ''}</span>`;
    todo = '<div class="todo">▶ 눌러서 보완 이어서 하기</div>';
  } else if (sum?.kind === 'sending') {
    chip = `<span class="status s-${sum.sending.status}">${STATUS_TEXT[sum.sending.status]}</span>`;
    todo = `<div class="sub">${navigator.onLine ? '보내는 중입니다.' : '인터넷이 연결되면 자동으로 보냅니다.'}</div>`;
  } else if (st.kind === 'done') {
    const miss = st.missing ?? toiletMissing(st.tid);
    if (miss > 0) {
      chip = `<span class="status s-a-editing">빈칸 ${miss}개</span>`;
      todo = '<div class="todo">▶ 눌러서 빈칸 채우기</div>';
    }
  }
  return `<button class="card pick assign" data-assign="${esc(a.id)}">
    <div class="row"><b class="grow">${esc(a.name)}</b>${chip}</div>
    <div class="sub">${esc((a.road && a.road !== '-') ? a.road : (a.lot || ''))}${a.memo ? ` · ${esc(a.memo)}` : ''}</div>${todo}</button>`;
}

/** 조 목록에 안 나온 화장실 한 곳 (이 휴대폰의 기록을 묶어 카드 한 장) */
function otherCardHtml(g) {
  const m = L.groupSummary(g);
  const chipText = m.kind === 'sending' ? STATUS_TEXT[m.sending.status] : { failed: '전송 실패', editing: '입력 중', supp: '보완 중', done: '보냄' }[m.kind];
  const chipCls = { failed: 's-failed', editing: 's-a-editing', supp: 's-a-editing', sending: 's-queued', done: 's-a-done' }[m.kind];
  const lines = [];
  if (m.sent) lines.push(`${dateText(m.sent.queuedAt)} 보냄`);
  if (m.lastSupp?.result) {
    const r = m.lastSupp.result;
    lines.push(`최근 보완: ${r.filled}칸 채움${r.edited ? ` · ${r.edited}칸 고침` : ''}`);
  }
  const errs = [];
  if (m.failed) errs.push(`${esc(m.failed.error || '보내지 못했습니다')} — 위 "지금 다시 보내기"를 눌러 주세요.`);
  if (m.lastSupp?.result?.conflicts?.length) errs.push(`다른 기기가 먼저 고쳐서 못 고친 칸 ${m.lastSupp.result.conflicts.length}개 — 보완을 다시 열어 확인해 주세요.`);
  if (m.lastSupp?.result?.editsIgnored) errs.push(`고친 칸 ${m.lastSupp.result.editsIgnored}개가 반영되지 않았습니다 — 관리자에게 알려 주세요.`);
  for (const d of g.drafts) if (d.warnings?.length) errs.push(`시트에 열이 없어 저장되지 않은 값: ${esc(d.warnings.join(', '))} — 관리자에게 알려 주세요.`);
  let actions = '';
  if (m.editing) {
    lines.push(`${m.editing.resurveyOf ? '다시 조사' : '조사'} 입력 중 · ${dateText(m.editing.updatedAt)} 저장 — 끝나면 "제출하기"를 눌러 주세요`);
    actions = `<button class="btn primary" data-open="${m.editing.localId}">이어서</button><button class="btn danger small" data-del="${m.editing.localId}">삭제</button>`;
  } else if (m.supp) {
    lines.push(`보완 입력 중 · ${dateText(m.supp.updatedAt)} 저장 — 끝나면 "보완 제출"을 눌러 주세요`);
    actions = `<button class="btn primary" data-open="${m.supp.localId}">보완 이어서</button><button class="btn danger small" data-del="${m.supp.localId}">삭제</button>`;
  } else if (m.kind === 'done' && m.sent?.submission) {
    actions = `<button class="btn" data-supp="${m.sent.localId}">보완하기</button>`;
  }
  return `<div class="card other">
    <div class="row"><b class="grow">${esc(m.name)}</b><span class="status ${chipCls}">${chipText}</span></div>
    ${lines.map((t) => `<div class="sub">${t}</div>`).join('')}
    ${errs.map((t) => `<div class="err">${t}</div>`).join('')}
    ${actions ? `<div class="row gap actions">${actions}</div>` : ''}</div>`;
}

/**
 * 첫 화면 '마저 해야 할 화장실': 오늘 목록에 안 나온 화장실 중
 * - 이 휴대폰에서 하다 만 조사·보완, 전송 실패
 * - 이 조에 배정돼 다녀왔는데 빈칸이 남은 곳 (서버가 센 빈칸 수)
 * - 이 휴대폰으로 보낸 목록 밖 화장실 중 빈칸이 남은 곳
 * 한 화장실은 한 번만.
 */
function todoListHtml() {
  const cards = [];
  const seen = new Set(state.shownKeys);
  const team = currentTeam();
  const fillCard = (name, sub, tid, miss) => `<button class="card pick assign" data-fill="${esc(tid)}">
    <div class="row"><b class="grow">${esc(name)}</b><span class="status s-a-editing">빈칸 ${miss}개</span></div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}<div class="todo">▶ 눌러서 빈칸 채우기</div></button>`;
  // 1) 이 휴대폰에서 하다 만 것·전송 실패
  for (const g of state.groups.values()) {
    if (seen.has(g.key)) continue;
    const sm = L.groupSummary(g);
    // 마지막 보완이 다 반영되지 못했으면(다른 기기와 겹침·서버 갱신 전) 확인하도록 남겨 둔다
    const suppTrouble = sm.kind === 'done' && sm.lastSupp === g.drafts[0] && (sm.lastSupp.result?.conflicts?.length || sm.lastSupp.result?.editsIgnored);
    if (!['failed', 'editing', 'supp'].includes(sm.kind) && !suppTrouble) continue;
    seen.add(g.key);
    const a = g.assignId && (state.assignments || []).find((x) => x.id === g.assignId);
    cards.push(a ? assignCardHtml(a, g.drafts) : otherCardHtml(g));
  }
  // 2) 이 조 배정 중 다녀왔는데 빈칸 남은 곳
  for (const a of state.assignments || []) {
    const key = `A:${a.id}`;
    if (seen.has(key) || a.team !== team) continue;
    const st = L.assignmentStatus(a, state.groups.get(key)?.drafts || []);
    const miss = st.kind === 'done' ? (st.missing ?? toiletMissing(st.tid)) : null;
    if (!(miss > 0)) continue;
    seen.add(key);
    cards.push(fillCard(a.name, `${esc(dateLabel(a.date))} 조사`, st.tid, miss));
  }
  // 3) 이 휴대폰으로 보낸 목록 밖 화장실 중 빈칸 남은 곳
  for (const g of state.groups.values()) {
    if (seen.has(g.key)) continue;
    const m = L.groupSummary(g);
    const miss = m.kind === 'done' && m.tid ? toiletMissing(m.tid) : null;
    if (!(miss > 0)) continue;
    seen.add(g.key);
    cards.push(fillCard(m.name, '', m.tid, miss));
  }
  return cards.join('');
}

async function openAssignment(id) {
  const a = (state.assignments || []).find((x) => x.id === id);
  if (!a) return;
  const st = L.assignmentStatus(a, await drafts.all());
  if (st.kind === 'editing') return openDraft(st.draft.localId);
  if (st.kind === 'queued') { toast('이 휴대폰에서 이미 제출해 전송을 기다리는 화장실입니다.'); return; }
  if (st.kind === 'done') {
    const supp = (await drafts.all()).find((d) => d.mode === 'supplement' && d.status === 'editing' && d.serverId === st.tid);
    if (supp) return openDraft(supp.localId);
    const choice = await modal('이미 보낸 화장실입니다', `<p><b>${esc(a.name)}</b></p><p>빈칸을 채우거나 답을 고치려면 <b>"빈칸 채우기·고치기"</b>를 누르세요.</p>`,
      [{ label: '취소', value: '' }, { label: '처음부터 다시 조사', value: 're' }, { label: '빈칸 채우기·고치기', value: 'supp', primary: true }]);
    if (choice === 'supp') return startSupplementFromServer(st.tid);
    if (choice === 're') {
      if (!(await confirmBox('다시 조사', '<p>기존에 입력된 답변이 모두 삭제됩니다. 다시 시작하시겠습니까?</p>', '다시 시작', '취소'))) return;
      // 처음부터 새로 (이름·주소만 배정 목록에서), 같은 화장실번호의 다음 차수로 저장
      const d = L.draftFromAssignment(a, { surveyor: teamLabel(currentTeam()) });
      d.resurveyOf = st.tid;
      return begin(d);
    }
    return;
  }
  await begin(L.draftFromAssignment(a, { surveyor: teamLabel(currentTeam()) }));
}
function useConfig(data, fetchedAt, fromCache) {
  state.cfg = L.prepareConfig(structuredClone(data));
  state.cfgInfo = { fetchedAt, fromCache, count: data.items.length, version: data.version, problems: [...validateSkips(data.items, data.choices), ...L.headerProblems(state.cfg)] };
  state.cfgError = '';
}

// ---------- 홈 ----------
const STATUS_TEXT = { queued: '전송 대기', sending: '보내는 중', photos: '사진 보내는 중', done: '전송 완료', failed: '전송 실패' };

async function renderHome() {
  state.view = 'home';
  state.draft = null;
  const all = (await drafts.all()).sort((a, b) => b.updatedAt - a.updatedAt);
  const allPhotos = await photos.all();
  const photoStat = (id) => {
    const ps = allPhotos.filter((p) => p.localId === id);
    return { total: ps.length, done: ps.filter((p) => p.status === 'done').length };
  };
  const failedN = all.filter((d) => d.status === 'failed').length;
  const sendingN = all.filter((d) => ['queued', 'sending', 'photos'].includes(d.status)).length;
  // 한 화장실은 첫 화면에 한 번만: 기록을 화장실 단위로 묶고, 조 목록 카드에 나온 화장실은 아래에서 뺀다
  state.groups = L.groupByToilet(all, state.assignments || []);
  state.shownKeys = new Set();
  const teamPart = state.cfg ? teamHtml(all) : '';
  const todoCards = todoListHtml();
  const needsPw = !!state.needPw;
  const noUrl = !apiUrl() || apiUrl().includes('여기에');
  const info = state.cfgInfo;

  $app.innerHTML = `
  <header class="home-head"><h1>공중화장실 접근성 조사</h1>
    <div class="net ${navigator.onLine ? 'on' : 'off'}">${navigator.onLine ? '인터넷 연결됨' : '인터넷 끊김 — 입력은 계속할 수 있습니다'}</div></header>
  <main class="home">
    ${noUrl ? '<div class="alert">관리자 설정 필요: config.js에 웹앱 주소가 없습니다.</div>' : ''}
    ${state.cfgError && !needsPw ? `<div class="alert">${/비밀번호/.test(state.cfgError)
      ? '비밀번호가 바뀌었을 수 있습니다. 아래 "설정·정보 → 비밀번호 다시 입력"을 눌러 새 비밀번호를 넣어 주세요.'
      : `조사 항목을 불러오지 못했습니다: ${esc(state.cfgError)}`}</div>` : ''}
    ${needsPw ? '<div class="card welcome"><p class="big-text">조사자 이름과 비밀번호를 입력해 주세요.</p><p class="hint">비밀번호는 조사팀에서 안내받은 것을 넣고 "확인"을 누르면 됩니다. 처음 한 번만 넣으면 다음부터는 기억합니다.</p></div>'
      : ''}
    ${info?.problems?.length ? `<div class="alert">항목정의를 확인해 주세요 (관리자에게 알려 주세요): ${esc(info.problems.join(' / '))}</div>` : ''}

    ${needsPw ? `<section class="card">
      <label class="field-label" for="pw">조사팀 비밀번호</label>
      <div class="row"><input id="pw" class="text-input grow" type="password" autocomplete="current-password" placeholder="안내받은 비밀번호" enterkeyhint="done">
      <button class="btn primary" id="pwok">확인</button></div>
      ${state.pwWrong ? '<div class="warn">비밀번호가 맞지 않습니다. 다시 확인해 주세요.</div>' : ''}
    </section>` : ''}

    ${failedN ? `<div class="card warnbox row send-alert"><div class="grow"><b>보내지 못한 조사 ${failedN}건</b><div class="sub">인터넷이 되는 곳에서 다시 보내 주세요.</div></div><button class="btn primary" id="retry">지금 다시 보내기</button></div>`
      : sendingN ? `<div class="card row send-alert"><div class="grow"><b>보내는 중 ${sendingN}건</b><div class="sub">${navigator.onLine ? '앱을 닫지 말고 잠시 기다려 주세요.' : '인터넷이 연결되면 자동으로 보냅니다.'}</div></div></div>` : ''}

    ${teamPart}

    ${todoCards ? `<h2 class="sec">마저 해야 할 화장실</h2>
      <p class="hint">빈칸이 남았거나 하다 만 곳입니다. 누르면 이어서 할 수 있습니다.</p>${todoCards}` : ''}

    <div class="home-actions">
      <button class="btn big" id="new" ${state.cfg ? '' : 'disabled'}>➕ 목록에 없는 화장실 조사</button>
      <button class="btn big" id="supplement" ${state.cfg ? '' : 'disabled'}>📋 지난 조사 보기·고치기</button>
    </div>
    ${!state.cfg && !needsPw ? '<p class="hint">조사 항목을 불러와야 시작할 수 있습니다. 인터넷에 연결한 뒤 아래 "설정·정보 → 조사 항목 새로 불러오기"를 눌러 주세요.</p>' : ''}

    <details class="card"><summary>설정·정보</summary>
      <p>조사 항목: ${info ? `${esc(info.version)} · ${info.count}개 · ${dateText(info.fetchedAt)} 불러옴${info.fromCache ? ' (기기에 저장된 사본)' : ''}` : '없음'}</p>
      <button class="btn" id="reload">조사 항목 새로 불러오기</button>
      <button class="btn" id="resetpw">비밀번호 다시 입력</button>
      <button class="btn" id="clean">완료된 기록 정리</button>
      <p class="hint">"완료된 기록 정리"는 다 보낸 조사를 이 휴대폰에서만 지웁니다. 시트에는 그대로 남습니다.</p>
    </details>
  </main>`;

  const pwEl = document.getElementById('pw');
  const submitPw = async () => {
    if (!pwEl.value.trim()) { toast('비밀번호를 적어 주세요.'); return; }
    ls.set('ts.password', pwEl.value.trim());
    await loadConfig({ force: true });
    state.pwWrong = !!(state.cfgError && /비밀번호/.test(state.cfgError));
    if (state.pwWrong) { ls.set('ts.password', ''); state.cfgError = ''; }
    renderHome();
  };
  pwEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPw(); });
  document.getElementById('pwok')?.addEventListener('click', submitPw);
  // 조를 먼저 골라야 시작할 수 있다 (고른 조가 조사자로 기록됨)
  const needName = () => {
    if (currentTeam()) return false;
    toast('먼저 오늘 활동하는 조를 눌러 주세요.');
    document.querySelector('.team-chip')?.focus();
    return true;
  };
  $app.querySelectorAll('[data-team]').forEach((b) => { b.onclick = () => { ls.set('ts.lastTeam', b.dataset.team); state.pickTeam = false; renderHome(); }; });
  document.getElementById('changeTeam')?.addEventListener('click', () => { state.pickTeam = true; renderHome(); });
  document.getElementById('new').onclick = () => { if (!needName()) startNew(); };
  document.getElementById('supplement').onclick = () => { if (!needName()) renderResurvey('supplement'); };
  $app.querySelectorAll('[data-fill]').forEach((b) => { b.onclick = () => { if (!needName()) startSupplementFromServer(b.dataset.fill); }; });
  $app.querySelectorAll('[data-supp]').forEach((b) => { b.onclick = () => { if (!needName()) startSupplementFromLocal(b.dataset.supp); }; });
  $app.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => openDraft(b.dataset.open); });
  $app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const d = await drafts.get(b.dataset.del);
      if (!await confirmBox('조사 삭제', `<p><b>${esc(d.toilet.B0a || '(이름 없음)')}</b> 조사를 지울까요? 입력한 내용과 사진이 모두 사라집니다.</p>`, '지우기', '취소')) return;
      for (const p of await photos.byDraft(d.localId)) await photos.remove(p.photoId);
      await drafts.remove(d.localId);
      renderHome();
    };
  });
  document.getElementById('retry')?.addEventListener('click', async () => {
    for (const d of (await drafts.all()).filter((x) => x.status === 'failed')) { d.status = 'queued'; await drafts.put(d); }
    if (!navigator.onLine) toast('인터넷이 연결되면 자동으로 보냅니다.');
    processQueue();
    renderHome();
  });
  document.getElementById('clean')?.addEventListener('click', async () => {
    const done = (await drafts.all()).filter((d) => d.status === 'done');
    if (!done.length) { toast('정리할 완료 기록이 없습니다.'); return; }
    if (!await confirmBox('완료된 기록 정리', `<p>전송이 끝난 ${done.length}건을 이 휴대폰에서 지울까요? 시트에 저장된 내용은 그대로 남습니다.</p>`, '정리', '취소')) return;
    for (const d of done) {
      for (const p of await photos.byDraft(d.localId)) await photos.remove(p.photoId);
      await drafts.remove(d.localId);
    }
    renderHome();
  });
  document.getElementById('reload').onclick = async () => { await loadConfig({ force: true }); renderHome(); };
  document.getElementById('resetpw').onclick = () => { ls.set('ts.password', ''); state.needPw = true; renderHome(); };
  document.getElementById('wprev')?.addEventListener('click', () => { state.calWeek = L.shiftDays(state.calWeek, -7); renderHome(); });
  document.getElementById('wnext')?.addEventListener('click', () => { state.calWeek = L.shiftDays(state.calWeek, 7); renderHome(); });
  document.getElementById('wtoday')?.addEventListener('click', () => { state.calWeek = state.assignDate = todayText(); renderHome(); });
  $app.querySelectorAll('[data-day]').forEach((b) => { b.onclick = () => { state.assignDate = b.dataset.day; renderHome(); }; });
  $app.querySelectorAll('[data-assign]').forEach((b) => { b.onclick = () => { if (!needName()) openAssignment(b.dataset.assign); }; });
}

// ---------- 재조사 목록 ----------
function modeTag(d) {
  if (d.mode === 'supplement') return ` <span class="tag">보완 중 · ${esc(d.serverId)} ${d.round}차</span>`;
  if (d.resurveyOf) return ` <span class="tag">재조사 ${esc(d.resurveyOf)}</span>`;
  return '';
}

/** mode: 'resurvey'(새 차수로 다시 조사) | 'supplement'(제출한 조사의 빈칸 채우기) */
async function renderResurvey(mode = 'resurvey') {
  state.view = 'resurvey';
  const supp = mode === 'supplement';
  const all = await drafts.all();
  const unsent = all.filter((d) => ['queued', 'sending', 'photos', 'failed'].includes(d.status) && !d.serverId);
  $app.innerHTML = `<header class="bar"><button class="btn" id="back">← 처음으로</button><h1 class="bar-title">${supp ? '지난 조사 보기·고치기' : '다시 조사할 화장실'}</h1></header>
    <main class="home">${supp ? '<p class="hint">보낸 화장실 목록입니다. 화장실을 누르면 <b>빈칸을 채우거나 답을 고칠</b> 수 있습니다.</p>' : ''}
    ${supp && unsent.length ? `<h2 class="sec">아직 못 보낸 조사</h2>${unsent.map((d) => `<div class="card row"><b class="grow">${esc(d.toilet.B0a || '(이름 없음)')}</b><span class="status s-${d.status}">${STATUS_TEXT[d.status]}</span></div>`).join('')}
      <p class="hint">인터넷이 되는 곳에서 자동으로 보냅니다. 보낸 뒤에 고칠 수 있습니다.</p><h2 class="sec">보낸 화장실</h2>` : ''}
    <input id="q" class="text-input" placeholder="이름·주소로 찾기" value="${esc(state.search)}">
    <div id="list"><p class="hint">목록을 불러오는 중…</p></div></main>`;
  document.getElementById('back').onclick = renderHome;
  const listEl = document.getElementById('list');
  const draw = () => {
    const q = state.search.trim();
    const rows = (state.toilets || []).filter((t) => !q || [t.id, t.name, t.address].some((s) => String(s).includes(q)));
    const suppOpen = new Set(all.filter((d) => d.mode === 'supplement' && d.status === 'editing').map((d) => d.serverId));
    listEl.innerHTML = rows.length ? rows.map((t) => {
      const chip = suppOpen.has(t.id) ? '<span class="status s-a-editing">보완 중</span>'
        : t.missing > 0 ? `<span class="status s-a-editing">빈칸 ${t.missing}개</span>`
          : t.missing === 0 ? '<span class="status s-a-done">다 채움</span>' : '';
      return `<button class="card pick" data-id="${esc(t.id)}">
      <div class="row"><b class="grow">${esc(t.name)}</b>${chip}</div><div class="sub">${esc(t.address)} ${esc(t.floor)} · ${esc(String(t.time).slice(0, 10))} 조사</div></button>`;
    }).join('')
      : '<p class="hint">찾는 화장실이 없습니다.</p>';
    listEl.querySelectorAll('[data-id]').forEach((b) => { b.onclick = () => (supp ? startSupplementFromServer(b.dataset.id) : startResurvey(b.dataset.id)); });
  };
  document.getElementById('q').addEventListener('input', (e) => { state.search = e.target.value; draw(); });
  try {
    state.toilets = (await call('listToilets')).toilets;
    // 빈칸 남은 곳 먼저, 그다음 최근에 조사한 곳
    state.toilets.sort((x, y) => ((y.missing > 0) - (x.missing > 0)) || String(y.time).localeCompare(String(x.time)));
    draw();
  } catch (e) {
    // 인터넷이 없으면: 이 휴대폰으로 보낸 조사만 (그 기록으로 고치기 시작 가능)
    const mine = supp ? all.filter((d) => d.mode !== 'supplement' && d.status === 'done' && d.submission && d.serverId) : [];
    listEl.innerHTML = `<div class="warn">${esc(e.message)} — 전체 목록은 인터넷이 연결된 곳에서 볼 수 있습니다.${mine.length ? ' 아래는 이 휴대폰으로 보낸 조사입니다.' : ''}</div>
      ${mine.map((d) => `<button class="card pick" data-local="${esc(d.localId)}"><b>${esc(d.toilet.B0a || '(이름 없음)')}</b><div class="sub">${dateText(d.queuedAt)} 보냄</div></button>`).join('')}`;
    listEl.querySelectorAll('[data-local]').forEach((b) => { b.onclick = () => startSupplementFromLocal(b.dataset.local); });
  }
}

async function startResurvey(id, extra = {}) {
  let prev;
  try { prev = await call('getToilet', { id }); } catch (e) { toast(e.message); return; }
  const d = L.newDraft({ surveyor: teamLabel(currentTeam()), resurveyOf: id });
  L.prefillFromPrevious(state.cfg, d, prev);
  d.prevRound = prev.round;
  Object.assign(d, extra); // 배정 목록에서 다시 조사하면 배정번호를 이어서 저장
  await begin(d);
}

// ---------- 함께 조사: 다른 기기가 제출한 값 불러오기 ----------
const FRESH_EVERY_MS = 30000;

let freshBusy = false;
const FRESH_AUTO_TIMEOUT_MS = 5000; // 자동 불러오기는 짧게 기다리고 포기

async function pullFresh({ manual }) {
  const d = state.draft;
  if (!d || d.mode !== 'supplement' || d.status !== 'editing') return;
  if (!navigator.onLine) { if (manual) toast('인터넷이 연결되면 불러올 수 있습니다.'); return; }
  if (freshBusy) { if (manual) toast('불러오는 중입니다.'); return; }
  freshBusy = true;
  const btn = document.getElementById('fresh');
  if (btn) btn.disabled = true;
  let prev;
  try {
    prev = await call('getToilet', { id: d.serverId }, manual ? {} : { timeoutMs: FRESH_AUTO_TIMEOUT_MS });
  } catch (e) {
    d.freshAt = Date.now(); // 실패해도 30초 동안은 다시 시도하지 않음
    if (manual) toast(e.message);
    return;
  } finally {
    freshBusy = false;
    if (btn && btn.isConnected) btn.disabled = false;
  }
  // 그사이 다른 조사를 열었거나 제출했으면 그만둠
  if (state.draft !== d || d.status !== 'editing') return;
  const pageBefore = d.pageId;
  const res = L.mergeFresh(state.cfg, d, prev);
  if (!res.ok) {
    d.freshAt = Date.now();
    if (manual || !d.freshWarned) { d.freshWarned = true; toast(res.reason + ' 이 보완은 제출해도 저장되지 않을 수 있습니다.'); }
    return;
  }
  await saveNow();
  if (res.conflicts.length) {
    const label = (c) => {
      const it = state.cfg.byCode[c.code];
      const name = (v) => (it.list ? (state.cfg.choices[it.list] || []).filter((o) => String(v).split(',').includes(o.value)).map((o) => o.label).join(', ') || v : v);
      const sp = L.spaceInfo(d, c.ctx);
      const theirs = c.theirs === 'NA' ? '건너뜀(해당 없음)' : name(c.theirs);
      return `<li>${sp?.label ? `[${esc(sp.label)}] ` : ''}${esc(it.question)}: 내 답 <b>${esc(name(c.mine))}</b> / 먼저 들어간 값 <b>${esc(theirs)}</b></li>`;
    };
    await modal('다른 사람이 먼저 채운 칸', `<p>같은 칸을 다른 기기에서 먼저 제출했습니다. 시트에는 먼저 들어간 값이 남습니다.</p><ul>${res.conflicts.map(label).join('')}</ul><p>값이 다르면 함께 조사한 분과 확인해 주세요.</p>`,
      [{ label: '확인', value: true, primary: true }]);
  } else if (manual || res.added) {
    toast(res.added ? `다른 기기에서 채운 칸 ${res.added}개를 불러왔습니다.` : '새로 채워진 칸이 없습니다.');
  }
  // 화면을 다시 그린다: 직접 눌렀거나, 새로 불러온 칸이 있을 때만 (입력 중인 화면을 괜히 흔들지 않게)
  if (state.view === 'survey' && state.draft === d && d.pageId === pageBefore && (manual || res.added || res.conflicts.length)) keepScroll(renderPage);
}

async function startSupplementFromServer(id) {
  let prev;
  try { prev = await call('getToilet', { id }); } catch (e) { toast(e.message); return; }
  await beginSupplement(prev, { fromServer: true });
}

async function startSupplementFromLocal(localId) {
  const d0 = await drafts.get(localId);
  if (!d0?.submission) { toast('이 조사의 제출 기록을 찾지 못했습니다.'); return; }
  // 인터넷이 되면 시트의 최신 값으로 시작한다 (다른 휴대폰에서 이미 보완했을 수 있으므로)
  if (navigator.onLine) {
    try {
      const prev = await call('getToilet', { id: d0.serverId });
      if (Number(prev.round) === Number(d0.round)) { await beginSupplement(prev, { fromServer: true }); return; }
    } catch { /* 아래 기기 기록으로 */ }
  }
  toast('인터넷이 없어 휴대폰에 남은 기록으로 시작합니다. 이미 채워진 칸은 시트에서 그대로 둡니다.');
  await beginSupplement(L.rowsFromSubmitted(d0));
}

async function beginSupplement(rows, { fromServer = false } = {}) {
  if (!(Number(rows.round) >= 1)) { toast('이 화장실의 조사차수를 알 수 없어 보완할 수 없습니다. 관리자에게 알려 주세요.'); return; }
  // 같은 화장실을 이미 보완하던 중이면 새로 만들지 않고 그걸 연다 (같은 보완이 두 개 생기지 않게)
  const open = (await drafts.all()).find((x) => x.mode === 'supplement' && x.status === 'editing' && x.serverId === rows.id);
  if (open) { toast('하던 보완을 이어서 엽니다.'); return openDraft(open.localId); }
  const d = L.supplementFromRows(state.cfg, L.newDraft({ surveyor: teamLabel(currentTeam()) }), rows);
  if (fromServer) d.freshAt = Date.now(); // 방금 시트에서 불러왔으니 바로 다시 불러오지 않음
  await drafts.put(d);
  state.draft = d;
  enterSurvey(); // 보완은 위치를 다시 잡지 않는다
}

// ---------- 조사 ----------
async function startNew() {
  await begin(L.newDraft({ surveyor: teamLabel(currentTeam()) }));
}

async function begin(d) {
  await drafts.put(d);
  state.draft = d;
  captureLocation();
  enterSurvey();
}

async function openDraft(id) {
  state.draft = await drafts.get(id);
  if (!state.draft) return renderHome();
  enterSurvey();
}

function captureLocation() {
  const d = state.draft;
  if (!navigator.geolocation) { d.gpsError = '이 휴대폰은 위치를 지원하지 않습니다.'; return; }
  d.gpsError = '위치를 찾는 중…';
  const id = d.localId;
  // 위치는 늦게 올 수 있다. 그 사이 조사를 다시 열었으면 지금 열린 것에, 아니면 저장된 최신본에 위치만 합친다.
  const apply = async (fields) => {
    if (state.draft?.localId === id) {
      Object.assign(state.draft, fields);
      saveSoon();
      if (currentPage()?.type === 'start') renderPage();
      return;
    }
    const latest = await drafts.get(id);
    if (latest && latest.status === 'editing') { Object.assign(latest, fields); await drafts.put(latest); }
  };
  navigator.geolocation.getCurrentPosition((pos) => apply({
    lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6),
    gpsAccuracy: Math.round(pos.coords.accuracy), gpsError: '',
  }), (err) => apply({
    gpsError: err.code === 1 ? '위치 권한이 꺼져 있습니다. 휴대폰 설정에서 위치를 허용해 주세요.' : '위치를 찾지 못했습니다.',
  }), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

function enterSurvey() {
  state.view = 'survey';
  history.pushState({ survey: true }, '');
  refreshPages();
  if (!state.draft.pageId || !state.pages.some((p) => p.id === state.draft.pageId)) state.draft.pageId = state.pages[0].id;
  renderPage();
}

window.addEventListener('popstate', () => {
  if (state.view !== 'survey') return;
  const i = L.pageIndex(state.pages, state.draft.pageId);
  if (i > 0) { history.pushState({ survey: true }, ''); goTo(i - 1, false); } else { saveNow().then(renderHome); }
});

function refreshPages() { state.pages = L.buildPages(state.cfg, state.draft); }
const currentPage = () => state.pages.find((p) => p.id === state.draft?.pageId);

/** 공간별 배너 색: 남자 장애인 파랑, 여자 장애인 분홍, 공용 장애인 보라, 남자 초록, 여자 주황 (그 밖은 노랑) */
function bannerClass(ctx) {
  if (ctx === L.MA) return 'sb-male';
  if (ctx === L.FE) return 'sb-female';
  const side = L.spaceInfo(state.draft, ctx)?.side;
  return { MALE: 'sb-multi-male', FEMALE: 'sb-multi-female', SHARED: 'sb-multi-shared' }[side] || '';
}

/** 그 문항으로 스크롤하고 잠깐 강조한다 */
function focusItem(ctx, code) {
  const el = document.querySelector(`.item[data-code="${CSS.escape(code)}"][data-ctx="${CSS.escape(ctx)}"]`)
    || (code.startsWith('_') ? document.querySelector(`[data-presence="${CSS.escape(code.slice(1))}"]`)?.closest('.card, section, div') : null);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // 다시 누를 때도 깜빡이도록
  el.classList.add('flash');
  el.querySelector('[data-input]:not([disabled])')?.focus({ preventScroll: true });
  return true;
}

async function goTo(i, check = true, focus = null) {
  const d = state.draft;
  const cur = currentPage();
  if (check && cur && i > L.pageIndex(state.pages, cur.id)) {
    const missing = L.missingOnPage(state.cfg, d, cur);
    const warns = numberWarningsOnPage(cur);
    if (missing.length || warns.length) {
      const body = `${missing.length ? `<p><b>비어 있는 필수 항목</b></p><ul>${missing.map((m) => `<li>${esc(m.question)}</li>`).join('')}</ul>` : ''}
        ${warns.length ? `<p><b>확인이 필요한 답</b></p><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <p>나중에 채워도 됩니다.</p>`;
      const go = await modal('확인해 주세요', body, [{ label: '돌아가서 입력', value: false }, { label: '그래도 다음으로', value: true, primary: true }]);
      if (!go) { if (missing[0]) focusItem(missing[0].ctx, missing[0].code); return; }
    }
  }
  refreshPages();
  const target = state.pages[Math.max(0, Math.min(state.pages.length - 1, i))];
  d.pageId = target.id;
  await saveNow();
  await renderPage();
  if (!(focus && focusItem(focus.ctx, focus.code))) window.scrollTo(0, 0);
  // 함께 조사: 화면을 넘긴 뒤 뒤에서 다른 기기 값을 불러온다 (신호가 약해도 화면 이동은 기다리지 않음)
  if (d.mode === 'supplement' && navigator.onLine && Date.now() - (d.freshAt || 0) > FRESH_EVERY_MS) pullFresh({ manual: false });
}

function numberWarningsOnPage(page) {
  if (page.type !== 'items') return [];
  const out = [];
  for (const code of page.codes) {
    const it = state.cfg.byCode[code];
    const mw = L.isVisible(state.cfg, state.draft, page.ctx, code) ? L.multiWarning(state.cfg, it, L.getRaw(state.draft, page.ctx, code)) : '';
    if (mw) { out.push(`${it.question}: ${mw}`); continue; }
    if (!['숫자', '정수'].includes(it.type) || L.isLocked(state.draft, page.ctx, code) || !L.isVisible(state.cfg, state.draft, page.ctx, code)) continue;
    const w = L.numberWarning(it, L.getRaw(state.draft, page.ctx, code));
    if (w) out.push(`${it.question}: ${w}`);
  }
  return out;
}

async function renderPage() {
  const d = state.draft;
  if (d.mode === 'supplement' && L.reopenSkipped(state.cfg, d)) saveSoon();
  refreshPages();
  let page = currentPage();
  if (!page) { d.pageId = state.pages[0].id; page = state.pages[0]; }
  const i = L.pageIndex(state.pages, page.id);
  const total = state.pages.length;
  const pct = Math.round((i / (total - 1)) * 100);
  const draftPhotos = await photos.byDraft(d.localId);

  let body = '';
  if (page.type === 'start') body = startHtml();
  else if (page.type === 'presence') body = presenceHtml();
  else if (page.type === 'review') body = reviewHtml(draftPhotos);
  else {
    // H 종합 요약 화면이면 자동 제안을 채운다
    let sug = L.suggestH(state.cfg, d);
    if (!page.codes.some((c) => c in sug)) sug = {};
    else if (d.mode !== 'supplement') { sug = L.applySuggestions(state.cfg, d); saveSoon(); }
    // 보완에서는 '조사자가 채운 것만 보낸다' — 제안은 안내만 하고 자동으로 채우지 않는다
    body = page.codes.filter((code) => L.isVisible(state.cfg, d, page.ctx, code))
      .map((code) => itemHtml(state.cfg.byCode[code], page.ctx, draftPhotos, sug[code])).join('')
      || '<p class="hint">이 화면은 앞의 답에 따라 모두 건너뜁니다. "다음"을 눌러 주세요.</p>';
  }

  $app.innerHTML = `
  <header class="bar">
    <div class="bar-row">
      <button class="btn nav" id="prev" ${i === 0 ? 'disabled' : ''}>← 이전</button>
      <button class="progress" id="toc" aria-label="목차 열기, 진행률 ${pct}%"><div class="progress-text">${i + 1} / ${total} · 목차 ☰</div><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div></button>
      ${page.type === 'review' ? '<span class="nav-spacer"></span>' : '<button class="btn nav primary" id="next">다음 →</button>'}
    </div>
    ${d.mode === 'supplement' ? `<div class="mode-banner">보완 중 · ${esc(d.serverId)} ${d.round}차 — 빈칸을 채우고, 저장된 값은 ✏️ 고치기로 고칩니다
      <button class="btn small" id="fresh">🔄 다른 기기 값 불러오기</button>
      <div class="sub">${d.freshAt ? `시트 값 확인: ${dateText(d.freshAt).slice(11)}` : ''}</div></div>` : ''}
    ${page.spaceLabel ? `<div class="space-banner ${bannerClass(page.ctx)}">${esc(page.spaceLabel)}</div>` : ''}
  </header>
  <main class="page">
    <h1 class="page-title">${esc(page.title)}</h1>
    ${copyFirstHtml(page)}
    ${body}
    <div class="bottom-nav">
      <button class="btn nav" id="prev2" ${i === 0 ? 'disabled' : ''}>← 이전</button>
      ${page.type === 'review' ? '' : '<button class="btn nav primary" id="next2">다음 →</button>'}
    </div>
    <button class="btn link" id="home">처음 화면으로 (저장됨)</button>
  </main>`;

  for (const id of ['prev', 'prev2']) document.getElementById(id)?.addEventListener('click', () => goTo(i - 1));
  for (const id of ['next', 'next2']) document.getElementById(id)?.addEventListener('click', () => goTo(i + 1));
  document.getElementById('home').onclick = async () => { await saveNow(); renderHome(); };
  document.getElementById('toc').onclick = openToc;
  document.getElementById('fresh')?.addEventListener('click', () => pullFresh({ manual: true }));
  document.getElementById('copyFirst')?.addEventListener('click', () => copyFromFirst(page));
  bindPage(page);
}

/** 장애인 화장실 둘째 칸부터: "첫 칸과 같게" 버튼 (이 화면 문항만) */
function copyFirstHtml(page) {
  if (page.type !== 'items') return '';
  const d = state.draft;
  const src = L.copySourceFor(d, page.ctx);
  if (!src) return '';
  const hasSrc = page.codes.some((c) => String(L.getRaw(d, src.key, c) ?? '') !== '');
  return `<div class="copy-first">
    <button class="btn" id="copyFirst" ${hasSrc ? '' : 'disabled'}>📋 첫 칸과 같게 채우기</button>
    <div class="hint">${hasSrc ? `'${esc(src.label)}'의 이 화면 답을 그대로 넣습니다. 다른 것만 고쳐 주세요. 사진은 따로 찍어 주세요.` : `'${esc(src.label)}'의 이 화면을 먼저 채우면 쓸 수 있습니다.`}</div>
  </div>`;
}

async function copyFromFirst(page) {
  const d = state.draft;
  const src = L.copySourceFor(d, page.ctx);
  if (!src) return;
  const { changed, overwritten } = L.copySpaceValues(d, src.key, page.ctx, page.codes, { dryRun: true });
  if (!changed.length) { toast('이미 첫 칸과 같습니다.'); return; }
  if (overwritten && !(await confirmBox('이미 적은 답이 있습니다', `<p>이 화면에서 이미 적은 답 ${overwritten}개도 첫 칸 값으로 바꿀까요?</p>`, '바꾸기', '취소'))) return;
  const res = L.copySpaceValues(d, src.key, page.ctx, page.codes);
  for (const code of res.changed) markTouched(page.ctx, code);
  saveSoon();
  toast(`${res.changed.length}개 문항을 첫 칸과 같게 넣었습니다.`);
  keepScroll(renderPage);
}

/** 목차: 모든 화면을 공간별로 묶어 보여 주고, 누르면 그 화면으로 바로 간다 */
function openToc() {
  const d = state.draft;
  const cur = currentPage();
  let group = null;
  const rows = state.pages.map((p) => {
    const g = p.spaceLabel || (p.type === 'items' || p.type === 'presence' ? '화장실 전체' : '');
    const head = g && g !== group ? `<h3 class="toc-group">${esc(g)}</h3>` : '';
    if (g) group = g;
    const st = L.pageStats(state.cfg, d, p);
    const stat = st ? `<span class="toc-stat ${st.answered === st.total ? 'done' : ''}">${st.answered}/${st.total}</span>${st.missingRequired ? `<span class="toc-req">필수 ${st.missingRequired}</span>` : ''}` : '';
    return `${head}<button class="toc-item ${p === cur ? 'current' : ''}" data-id="${esc(p.id)}"><span class="toc-title">${esc(p.title)}</span>${stat}</button>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal toc" role="dialog" aria-modal="true" aria-labelledby="toct">
    <div class="row"><h2 id="toct" class="grow">목차</h2><button class="btn" data-close>닫기</button></div>
    <p class="hint">숫자는 "답한 문항 / 보이는 문항"입니다. 순서와 상관없이 원하는 곳을 눌러 바로 가세요.</p>${rows}</div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) { wrap.remove(); return; }
    const b = e.target.closest('.toc-item');
    if (!b) return;
    wrap.remove();
    refreshPages();
    goTo(L.pageIndex(state.pages, b.dataset.id), false);
  });
  document.body.appendChild(wrap);
  wrap.querySelector('.toc-item.current')?.scrollIntoView({ block: 'center' });
}

function startHtml() {
  const d = state.draft;
  const gps = d.lat != null ? `위도 ${d.lat}, 경도 ${d.lng}${d.gpsAccuracy ? ` (오차 약 ${d.gpsAccuracy}m)` : ''}` : (d.gpsError || '위치 없음');
  return `<div class="card">
    <p class="big-text">조사한 조: <b>${esc(d.surveyor)}</b></p>
    ${d.resurveyOf ? `<p class="big-text">재조사: <b>${esc(d.resurveyOf)}</b> ${d.prevRound ? `(이전 ${d.prevRound}차 조사 값이 미리 채워져 있습니다. 하나씩 확인하고 바뀐 것만 고쳐 주세요.)` : '— 처음부터 새로 조사합니다.'}</p>` : ''}
    ${d.mode === 'supplement' ? `<p class="big-text">보완: <b>${esc(d.serverId)} ${d.round}차</b> — ${esc(d.toilet.B0a || '')}</p>
      <p>이미 저장된 칸은 <b>"저장됨"</b>으로 잠겨 있고, <b>빈칸만</b> 채울 수 있습니다. 위의 "목차"를 누르면 빈칸이 있는 곳으로 바로 갈 수 있습니다.</p></div>`
    : `<p class="big-text">현재 위치: ${esc(gps)}</p>
    <button class="btn" id="gps">위치 다시 잡기</button>
    <p class="hint">화장실 입구 앞에서 위치를 잡으면 좋습니다.</p></div>`}
    <div class="card"><p>답을 누르면 바로 휴대폰에 저장됩니다. 앱을 닫아도 처음 화면의 "이어서 하기"에서 계속할 수 있습니다.</p>
    <p>어느 질문에서든 <b>📷 사진</b> 버튼으로 사진을 찍을 수 있습니다.</p>
    <p>순서대로 하기 어려우면 화면 위 <b>"목차"</b>를 눌러 원하는 곳으로 바로 갈 수 있습니다.</p></div>`;
}

function presenceHtml() {
  const d = state.draft;
  if (d.mode === 'supplement') {
    const t = (v) => (v === false ? '없음' : v ? '있음' : '미입력');
    return `<div class="card"><p class="big-text">남자화장실: <b>${t(d.hasMale)}</b> · 여자화장실: <b>${t(d.hasFemale)}</b></p>
      <p class="hint">보완에서는 화장실 구성을 바꿀 수 없습니다. 바꾸려면 "다시 조사"를 해 주세요.</p></div>`;
  }
  const q = (key, label) => `<div class="item"><div class="q">${label}</div>
    <div class="choices two">${[[true, '있음'], [false, '없음']].map(([v, t]) => `<button class="choice ${d[key] === v ? 'on' : ''}" data-presence="${key}" data-v="${v}" aria-pressed="${d[key] === v}">${t}</button>`).join('')}</div></div>`;
  return `<p class="hint">없다고 하면 그쪽 질문은 건너뛰고 '해당 없음(NA)'으로 저장합니다.</p>${q('hasMale', '남자화장실 있음?')}${q('hasFemale', '여자화장실 있음?')}`;
}

function photoStrip(list) {
  if (!list.length) return '';
  return `<div class="thumbs">${list.map((p) => `<span class="thumb"><img alt="사진" data-blob="${p.photoId}"><button class="thumb-del" data-delphoto="${p.photoId}" aria-label="사진 지우기">×</button></span>`).join('')}</div>`;
}

function itemHtml(it, ctx, draftPhotos, sug) {
  const d = state.draft;
  const raw = L.getRaw(d, ctx, it.code);
  const key = `${ctx}:${it.code}`;
  const fid = `f-${ctx}-${it.code}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const prefilled = d.prefilled[key] && !d.touched[key];
  const suggested = ctx === L.TOILET && d.suggested[it.code] !== undefined && !d.touched[key] && raw === d.suggested[it.code];
  const myPhotos = draftPhotos.filter((p) => p.itemCode === it.code && (p.spaceKey || L.TOILET) === ctx);
  const locked = L.isLocked(d, ctx, it.code);
  if (locked) sug = null;
  const edited = L.isEdited(state.cfg, d, ctx, it.code);
  const origText = d.orig?.[key] === 'NA' ? '해당 없음' : (it.list ? String(d.orig?.[key] ?? '').split(',').map((v) => choiceLabel(it, v)).join(', ') : d.orig?.[key]);
  let input = '';
  if (it.type === L.MULTI) {
    const opts = state.cfg.choices[it.list] || [];
    const sel = L.splitMulti(raw);
    input = `<div class="hint">여러 개 고를 수 있습니다.</div><div class="choices multi ${locked ? 'locked' : ''}">${opts.map((o) => `<button class="choice ${sel.includes(o.value) ? 'on' : ''}" data-multi="${esc(o.value)}" aria-pressed="${sel.includes(o.value)}" ${locked ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`;
    if (!opts.length) input = `<div class="alert">선택지 목록 "${esc(it.list)}"이(가) 선택지 탭에 없습니다.</div>`;
  } else if (it.type === '선택(하나)') {
    const opts = state.cfg.choices[it.list] || [];
    input = `<div class="choices ${opts.length <= 2 ? 'two' : ''} ${locked ? 'locked' : ''}">${opts.map((o) => `<button class="choice ${raw === o.value ? 'on' : ''}" data-choice="${esc(o.value)}" aria-pressed="${raw === o.value}" ${locked ? 'disabled' : ''}>${esc(o.label)}</button>`).join('')}</div>`;
    if (!opts.length) input = `<div class="alert">선택지 목록 "${esc(it.list)}"이(가) 선택지 탭에 없습니다.</div>`;
  } else {
    const isNA = raw === 'NA';
    const common = `id="${fid}" data-input ${isNA || locked ? 'disabled' : ''}`;
    if (it.type === '숫자' || it.type === '정수') {
      input = `<div class="num-row"><input ${common} class="text-input num" type="text" inputmode="numeric" pattern="[0-9]*" value="${isNA ? '' : esc(raw)}" placeholder="숫자">${it.unit ? `<span class="unit">${esc(it.unit)}</span>` : ''}</div>`;
    } else if (it.type === '시각') {
      input = `<input ${common} class="text-input" type="time" value="${isNA ? '' : esc(raw)}">`;
    } else {
      input = `<textarea ${common} class="text-input" rows="${it.question.length > 12 ? 2 : 1}">${isNA ? '' : esc(raw)}</textarea>`;
    }
    if (locked) input += isNA ? '<div class="sub">해당 없음(NA)</div>' : '';
    else if (it.noneButton && !isNA) input += `<button class="btn small na ${raw === '0' ? 'on' : ''}" data-none aria-pressed="${raw === '0'}">없음</button>`;
    else if (it.naButton !== false || isNA) input += `<button class="btn small na ${isNA ? 'on' : ''}" data-na aria-pressed="${isNA}">해당 없음</button>`;
  }
  return `<div class="item ${it.required ? 'req' : ''} ${locked ? 'is-locked' : ''}" data-code="${esc(it.code)}" data-ctx="${esc(ctx)}">
    <div class="q"><label for="${fid}">${esc(it.question)}</label>${it.required ? ' <span class="req-mark">필수</span>' : ''}${prefilled ? ` <span class="tag">${esc(d.prefillLabel || '이전 조사 값')}</span>` : ''}${locked ? ' <span class="tag saved">저장됨</span>' : ''}${edited ? ` <span class="tag edited">고침 · 전: ${esc(origText || '빈칸')}</span>` : ''}${L.canUnlock(d, ctx, it.code) ? ' <button class="btn small" data-unlock>✏️ 고치기</button>' : ''}</div>
    ${it.how ? `<div class="how">${esc(it.how)}</div>` : ''}
    ${input}
    <div class="feedback">${feedbackHtml(it, raw)}${L.multiWarning(state.cfg, it, raw) ? `<div class="warn">${esc(L.multiWarning(state.cfg, it, raw))}</div>` : ''}</div>
    ${sug ? `<div class="suggest ${suggested ? 'on' : ''}">${suggested ? '<b>자동 제안</b> — 맞는지 확인하고, 다르면 고쳐 주세요. ' : ''}${!suggested && sug.value != null && blank(raw) ? `<b>제안: ${esc(choiceLabel(it, sug.value))}</b> — 맞으면 직접 눌러 주세요. ` : ''}${esc(sug.reason)}</div>` : ''}
    <div class="photo-row"><label class="btn small camera">📷 사진<input type="file" accept="image/*" capture="environment" data-photo hidden></label>${photoStrip(myPhotos)}</div>
  </div>`;
}

function choiceLabel(it, value) {
  return (state.cfg.choices[it.list] || []).find((o) => o.value === value)?.label || value;
}

function feedbackHtml(it, raw) {
  if (!['숫자', '정수'].includes(it.type)) return '';
  const w = L.numberWarning(it, raw);
  const badges = L.criteriaBadges(it, raw).map((b) => `<span class="badge ${b.ok ? 'ok' : 'no'}">${b.name} ${b.ok ? '충족' : '미달'} <small>(${esc(b.range)})</small></span>`).join('');
  return `${badges}${w ? `<div class="warn">${esc(w)}</div>` : ''}`;
}

function reviewHtml(draftPhotos) {
  const d = state.draft;
  const missing = L.missingAll(state.cfg, d);
  const invalid = L.invalidAll(state.cfg, d);
  const warns = state.pages.flatMap((p) => numberWarningsOnPage(p).map((w) => ({ w, p })));
  const spaces = L.multiSpaces(d);
  return `<div class="card">
      <p class="big-text"><b>${esc(d.toilet.B0a || '(이름 없음)')}</b> ${d.resurveyOf ? `· 재조사 ${esc(d.resurveyOf)}` : ''}</p>
      <p>장애인 화장실 ${spaces.length}칸${spaces.length ? ` (${spaces.map((s) => esc(s.label)).join(', ')})` : ''}<br>
      남자화장실 ${d.hasMale === false ? '없음' : d.hasMale ? '있음' : '미입력'} · 여자화장실 ${d.hasFemale === false ? '없음' : d.hasFemale ? '있음' : '미입력'}<br>
      사진 ${draftPhotos.length}장 · 위치 ${d.lat != null ? '있음' : '없음'}</p></div>
    ${missing.length ? `<div class="card warnbox"><h2>비어 있는 필수 항목 ${missing.length}개</h2>
      ${missing.map((m) => `<button class="btn list-btn" data-goto="${esc(m.pageId)}" data-ctx="${esc(m.ctx)}" data-code="${esc(m.code)}">${m.spaceLabel ? `[${esc(m.spaceLabel)}] ` : ''}${esc(m.question)}</button>`).join('')}</div>`
      : '<div class="card okbox">필수 항목을 모두 입력했습니다.</div>'}
    ${invalid.length ? `<div class="alert"><h2>꼭 고쳐야 하는 숫자 ${invalid.length}개</h2><p>숫자 칸에 글자나 소수점이 있으면 제출할 수 없습니다.</p>
      ${invalid.map((m) => `<button class="btn list-btn" data-goto="${esc(m.pageId)}" data-ctx="${esc(m.ctx)}" data-code="${esc(m.code)}">${m.spaceLabel ? `[${esc(m.spaceLabel)}] ` : ''}${esc(m.question)}</button>`).join('')}</div>` : ''}
    ${warns.length ? `<div class="card warnbox"><h2>확인이 필요한 답 ${warns.length}개</h2>
      ${warns.map(({ w, p }) => `<button class="btn list-btn" data-goto="${esc(p.id)}">${p.spaceLabel ? `[${esc(p.spaceLabel)}] ` : ''}${esc(w)}</button>`).join('')}</div>` : ''}
    ${d.mode === 'supplement'
    ? `<div class="card"><p class="big-text">${(() => { const b = L.buildSupplementPayload(state.cfg, d, ''); return `새로 채운 칸 <b>${b.filledCount}개</b> · 고친 칸 <b>${b.editCount}개</b>`; })()} · 새 사진 ${draftPhotos.length}장</p></div>
      <button class="btn primary big" id="submit">보완 제출</button>
      <p class="hint">빈칸은 채우고, ✏️ 고치기로 고친 칸은 새 값으로 바꿉니다. 그사이 다른 기기가 같은 칸을 먼저 고쳤으면 그 칸은 바꾸지 않고 알려 드립니다.</p>`
    : `<button class="btn primary big" id="submit">제출하기</button>
    <p class="hint">제출하면 전송 대기열에 들어가고, 인터넷이 연결되면 자동으로 보냅니다. 제출한 뒤에도 빈칸은 처음 화면의 "빈칸 보완하기"로 채울 수 있습니다.</p>`}`;
}

function markTouched(ctx, code) {
  const key = `${ctx}:${code}`;
  state.draft.touched[key] = true;
  if (ctx === L.TOILET) delete state.draft.suggested[code];
}

function bindPage(page) {
  const d = state.draft;
  if (page.type === 'start') {
    document.getElementById('gps')?.addEventListener('click', () => { captureLocation(); renderPage(); });
  }
  if (page.type === 'presence') {
    $app.querySelectorAll('[data-presence]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.presence;
        const v = b.dataset.v === 'true';
        d[k] = d[k] === v ? null : v;
        saveSoon(); renderPage();
      };
    });
  }
  if (page.type === 'review') {
    $app.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => { const i = L.pageIndex(state.pages, b.dataset.goto); goTo(i, false, b.dataset.code ? { ctx: b.dataset.ctx, code: b.dataset.code } : null); };
    });
    document.getElementById('submit').onclick = submit;
  }
  $app.querySelectorAll('.item[data-code]').forEach((el) => {
    const ctx = el.dataset.ctx;
    const code = el.dataset.code;
    const it = state.cfg.byCode[code];
    el.querySelectorAll('[data-multi]').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.multi;
        const cur = L.splitMulti(L.getRaw(d, ctx, code));
        let next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
        // '없음'은 다른 보기와 함께 고를 수 없다: 없음을 누르면 나머지를 끄고, 다른 보기를 누르면 없음을 끈다
        if (!cur.includes(v)) next = v === 'NONE' ? ['NONE'] : next.filter((x) => x !== 'NONE');
        L.setRaw(d, ctx, code, L.joinMulti(state.cfg, it, next));
        markTouched(ctx, code); saveSoon(); keepScroll(renderPage);
      };
    });
    el.querySelectorAll('[data-choice]').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.choice;
        L.setRaw(d, ctx, code, L.getRaw(d, ctx, code) === v ? '' : v);
        markTouched(ctx, code); saveSoon(); keepScroll(renderPage);
      };
    });
    const input = el.querySelector('[data-input]');
    if (input) {
      input.addEventListener('input', () => {
        L.setRaw(d, ctx, code, input.value);
        markTouched(ctx, code); saveSoon();
        el.querySelector('.feedback').innerHTML = feedbackHtml(it, input.value);
        el.querySelector('.q > .tag:not(.saved):not(.edited)')?.remove(); // '이전 조사 값' 표시만 지움
      });
      // 숫자는 뒤 항목 건너뛰기에 영향을 줄 수 있어, 보완에서 고친 칸은 '고침' 표시를 위해 입력을 마치면 다시 그린다
      if (it.type === '숫자' || it.type === '정수' || d.unlocked?.[`${ctx}:${code}`]) input.addEventListener('change', () => keepScroll(renderPage));
    }
    el.querySelector('[data-unlock]')?.addEventListener('click', () => {
      if (!L.unlock(d, ctx, code)) return;
      saveSoon();
      keepScroll(renderPage).then(() => document.querySelector(`.item[data-code="${CSS.escape(code)}"][data-ctx="${CSS.escape(ctx)}"] [data-input]`)?.focus());
    });
    // '없음' = 0개
    el.querySelector('[data-none]')?.addEventListener('click', () => {
      L.setRaw(d, ctx, code, L.getRaw(d, ctx, code) === '0' ? '' : '0');
      markTouched(ctx, code); saveSoon(); keepScroll(renderPage);
    });
    el.querySelector('[data-na]')?.addEventListener('click', () => {
      L.setRaw(d, ctx, code, L.getRaw(d, ctx, code) === 'NA' ? '' : 'NA');
      markTouched(ctx, code); saveSoon(); keepScroll(renderPage);
    });
    el.querySelector('[data-photo]')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const blob = await resizePhoto(file);
        const info = L.spaceInfo(d, ctx);
        await photos.put({
          photoId: `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, localId: d.localId,
          spaceKey: ctx === L.TOILET ? '' : ctx, itemCode: code, takenAt: nowText(), status: 'pending',
          description: `${info?.label ? `${info.label} · ` : ''}${it.question}`,
        }, blob);
        toast('사진을 저장했습니다.');
        keepScroll(renderPage);
      } catch (err) { toast(err.message); }
    });
  });
  const imgs = $app.querySelectorAll('img[data-blob]');
  if (imgs.length) {
    imgs.forEach((img) => photos.blob(img.dataset.blob).then((blob) => {
      if (blob) { img.src = URL.createObjectURL(blob); img.onload = () => URL.revokeObjectURL(img.src); }
    }));
  }
  $app.querySelectorAll('[data-delphoto]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmBox('사진 지우기', '<p>이 사진을 지울까요?</p>', '지우기', '취소')) return;
      await photos.remove(b.dataset.delphoto);
      keepScroll(renderPage);
    };
  });
}

async function keepScroll(fn) {
  const y = window.scrollY;
  await fn();
  window.scrollTo(0, y);
}

async function submit() {
  const d = state.draft;
  if (L.invalidAll(state.cfg, d).length) {
    await modal('제출할 수 없습니다', '<p>"꼭 고쳐야 하는 숫자"를 먼저 고쳐 주세요. 길이는 cm 정수(소수점 없이)로 적습니다.</p>', [{ label: '확인', value: true, primary: true }]);
    return;
  }
  if (d.mode === 'supplement') return submitSupplement(d);
  const missing = L.missingAll(state.cfg, d);
  const { payload, spaceKeys } = L.buildSubmission(state.cfg, d, nowText());
  // 장애인 화장실 개수를 줄여 없어진 칸의 사진은 올리지 않는다
  const orphan = (await photos.byDraft(d.localId)).filter((p) => p.spaceKey && !spaceKeys.includes(p.spaceKey));
  const ok = await confirmBox('제출할까요?', `${missing.length ? `<p>비어 있는 필수 항목이 <b>${missing.length}개</b> 있습니다. 비어 있는 채로 제출하면 '조사 안 함'으로 저장됩니다.</p>` : ''}
    ${orphan.length ? `<p>지금은 없는 칸에서 찍은 사진 ${orphan.length}장은 올리지 않고 지웁니다.</p>` : ''}<p>제출한 뒤에는 빈칸만 "빈칸 보완하기"로 채울 수 있습니다.</p>`, '제출', '취소');
  if (!ok) return;
  for (const p of orphan) await photos.remove(p.photoId);
  delete payload.password;
  Object.assign(d, { submission: payload, spaceKeys, status: 'queued', queuedAt: Date.now(), error: '' });
  await drafts.put(d);
  toast(navigator.onLine ? '제출했습니다. 보내는 중입니다.' : '제출했습니다. 인터넷이 연결되면 자동으로 보냅니다.');
  processQueue();
  renderHome();
}

async function submitSupplement(d) {
  const { payload, count, filledCount, editCount } = L.buildSupplementPayload(state.cfg, d, nowText());
  const newPhotos = (await photos.byDraft(d.localId)).length;
  if (!count && !newPhotos) { toast('새로 채우거나 고친 칸, 사진이 없습니다.'); return; }
  const ok = await confirmBox('보완 제출할까요?', `<p>새로 채운 칸 <b>${filledCount}개</b>${editCount ? `, 고친 칸 <b>${editCount}개</b>` : ''}, 사진 ${newPhotos}장을 ${esc(d.serverId)} ${d.round}차 조사에 반영합니다.</p>`, '보완 제출', '취소');
  if (!ok) return;
  Object.assign(d, { submission: payload, status: 'queued', queuedAt: Date.now(), error: '' });
  await drafts.put(d);
  toast(navigator.onLine ? '보완을 보내는 중입니다.' : '인터넷이 연결되면 자동으로 보냅니다.');
  processQueue();
  renderHome();
}

// ---------- 시작 ----------
async function main() {
  requestPersistence();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  // 다 보내고 나면 배정·빈칸 수를 새로 받아 '마저 해야 할 화장실'을 맞춘다
  let refreshTimer = null;
  onSyncChange(() => {
    if (state.view === 'home') renderHome();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      const pending = (await drafts.all()).some((d) => ['queued', 'sending', 'photos'].includes(d.status));
      if (!pending && navigator.onLine) loadAssignments();
    }, 3000);
  });
  window.addEventListener('online', () => { if (state.view === 'home') { loadConfig().then(renderHome); } });
  window.addEventListener('offline', () => { if (state.view === 'home') renderHome(); });
  await loadConfig();
  await renderHome();
  startSync();
}

// 시작 오류: 어디서 났는지(관리자용)와 다시 시도 버튼을 보여 준다. 조사 기록(drafts·사진)은 지우지 않는다.
main().catch((e) => {
  $app.innerHTML = `<div class="alert">앱을 시작하지 못했습니다: ${esc(e?.message || String(e))}</div>
    <button class="btn primary big" id="retry">다시 시도</button>
    <button class="btn big" id="softreset">조 선택·배정 목록을 지우고 다시 시도</button>
    <p class="hint">조사하던 내용과 사진은 지워지지 않습니다. 그래도 안 되면 이 화면을 캡처해서 관리자에게 보내 주세요.</p>
    <pre class="diag">${esc(String(e?.stack || '').split(/\r?\n/).slice(0, 8).join(' | '))}</pre>`;
  document.getElementById('retry').onclick = () => location.reload();
  document.getElementById('softreset').onclick = async () => {
    ls.set('ts.lastTeam', '');
    try { await kv.set('assignments', null); await kv.set('config', null); } catch { /* 무시 */ }
    location.reload();
  };
});

