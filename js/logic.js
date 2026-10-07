// 조사 로직 (화면·저장과 무관한 순수 함수). 브라우저와 Node 테스트에서 함께 쓴다.
import { parseSkip, shouldSkip } from './skip.js';

// 요청서에 이름이 나온 항목코드만 여기 둔다. 기준 숫자는 모두 항목정의에서 읽는다.
export const MULTI_COUNT_CODES = { C1a: 'MALE', C1b: 'FEMALE', C1c: 'SHARED' };
const SIDE_ONLY_TOILET_ITEMS = { F3a: 'MALE', F3b: 'FEMALE' }; // 그 쪽 화장실이 없으면 NA
const SIDE_LABEL = { MALE: '남자 쪽', FEMALE: '여자 쪽', SHARED: '남녀 공용' };
const MAX_MULTI_PER_SIDE = 10;
const PAGE_MAX = 8;   // 한 화면 최대 문항 수
const PAGE_SPLIT = 7; // 나눌 때 목표 문항 수

export const TOILET = 't';
export const MA = 'MA';
export const FE = 'FE';

const blank = (v) => v === undefined || v === null || v === '';

/** 서버 config → 앱에서 쓰기 좋은 형태 */
export function prepareConfig(raw) {
  const ord = (x) => (x.order == null ? Infinity : x.order); // 순서가 비면 맨 뒤 (서버와 같게)
  const items = [...raw.items].sort((a, b) => ord(a) - ord(b));
  const byCode = {};
  const byVar = {};
  for (const it of items) {
    it.rule = parseSkip(it.skip);
    byCode[it.code] = it;
    byVar[it.var] = it;
  }
  return { ...raw, items, byCode, byVar };
}

/** 이 항목이 이 공간 종류에 해당하는가 */
export function appliesTo(item, kind) {
  if (item.tab === '화장실') return kind === TOILET;
  switch (item.scope) {
    case '장애인화장실': return kind === 'MULTI';
    case '남·여': return kind === 'MALE' || kind === 'FEMALE';
    case '장애인·남·여': return kind === 'MULTI' || kind === 'MALE' || kind === 'FEMALE';
    case '남': return kind === 'MALE';
    case '여': return kind === 'FEMALE';
    default: return false;
  }
}

export function newDraft({ surveyor = '', resurveyOf = null } = {}) {
  const now = Date.now();
  return {
    localId: `d-${now}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now, updatedAt: now,
    surveyor, resurveyOf, lat: null, lng: null,
    status: 'editing', // editing → queued → sending → photos → done | failed
    serverId: null, round: null, spaceIds: {}, error: '',
    toilet: {}, hasMale: null, hasFemale: null,
    spaces: {}, // key → { values: {code: raw} }
    pageId: null, touched: {}, prefilled: {}, suggested: {},
    mode: 'new', locked: {}, orig: {}, replaceable: {}, // mode: new | supplement
    unlocked: {}, // 보완: '고치기'를 눌러 저장된 값을 고칠 수 있게 연 칸
    reopened: {}, // 보완: 앞 답을 고쳐 건너뛰지 않게 돼 NA를 풀어 다시 연 칸
  };
}

/** 장애인 화장실 칸 목록 (C1a·C1b·C1c 개수 → 남 → 여 → 공용 순) */
export function multiSpaces(draft) {
  const list = [];
  for (const [code, side] of Object.entries(MULTI_COUNT_CODES)) {
    const n = Math.min(MAX_MULTI_PER_SIDE, Math.max(0, parseInt(draft.toilet[code], 10) || 0));
    for (let s = 1; s <= n; s++) {
      list.push({ key: `MULTI-${side}-${s}`, kind: 'MULTI', side, sideSeq: s, label: `${SIDE_LABEL[side]} 장애인 화장실 ${s}` });
    }
  }
  list.forEach((sp, i) => { sp.index = i + 1; });
  return list;
}

export function allSpaces(draft) {
  return [
    ...multiSpaces(draft),
    { key: MA, kind: 'MALE', side: '', label: '남자화장실', present: draft.hasMale },
    { key: FE, kind: 'FEMALE', side: '', label: '여자화장실', present: draft.hasFemale },
  ];
}

export function spaceInfo(draft, key) {
  if (key === TOILET) return { key, kind: TOILET, label: '' };
  return allSpaces(draft).find((s) => s.key === key) || null;
}

export function getRaw(draft, ctx, code) {
  if (ctx === TOILET) return draft.toilet[code];
  return draft.spaces[ctx]?.values?.[code];
}

export function setRaw(draft, ctx, code, value) {
  if (ctx === TOILET) { draft.toilet[code] = value; return; }
  if (!draft.spaces[ctx]) draft.spaces[ctx] = { values: {} };
  draft.spaces[ctx].values[code] = value;
}

/** 그 쪽 화장실이 없다고 답해서 강제로 NA가 되는가 */
function forcedNA(cfg, draft, ctx, code) {
  if (ctx === MA && draft.hasMale === false) return true;
  if (ctx === FE && draft.hasFemale === false) return true;
  if (ctx === TOILET) {
    const side = SIDE_ONLY_TOILET_ITEMS[code];
    if (side === 'MALE' && draft.hasMale === false) return true;
    if (side === 'FEMALE' && draft.hasFemale === false) return true;
  }
  return false;
}

/** 건너뛰기 조건이 참인가. 앞 항목도 건너뛰어졌으면 그 값은 NA로 본다(연쇄). */
export function isSkipped(cfg, draft, ctx, code, depth = 0) {
  const item = cfg.byCode[code];
  if (!item?.rule || item.rule.error || depth > 10) return false;
  const refItem = cfg.byCode[item.rule.ref];
  if (!refItem) return false;
  // 공간 항목의 조건은 같은 공간의 답을 먼저 보고, 화장실 항목이면 화장실 답을 본다.
  const refCtx = refItem.tab === '화장실' ? TOILET : ctx;
  const refValue = finalValue(cfg, draft, refCtx, refItem.code, depth + 1);
  return shouldSkip(item.rule, refValue);
}

/** 시트에 저장될 값 */
export function finalValue(cfg, draft, ctx, code, depth = 0) {
  const item = cfg.byCode[code];
  if (forcedNA(cfg, draft, ctx, code)) return 'NA';
  if (isSkipped(cfg, draft, ctx, code, depth)) return 'NA';
  return normalize(item, getRaw(draft, ctx, code));
}

export function normalize(item, raw) {
  if (blank(raw)) return '';
  if (raw === 'NA') return 'NA';
  if (item && (item.type === '숫자' || item.type === '정수')) {
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : String(raw).trim();
  }
  return typeof raw === 'string' ? raw.trim() : raw;
}

export function isVisible(cfg, draft, ctx, code) {
  return !forcedNA(cfg, draft, ctx, code) && !isSkipped(cfg, draft, ctx, code);
}

function chunk(codes) {
  if (codes.length <= PAGE_MAX) return [codes];
  const n = Math.ceil(codes.length / PAGE_SPLIT);
  const size = Math.ceil(codes.length / n);
  const out = [];
  for (let i = 0; i < codes.length; i += size) out.push(codes.slice(i, i + size));
  return out;
}

function sectionPages(items, ctx, spaceLabel) {
  const pages = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    // 항목정의 '새 화면'=예 인 질문부터 다음 쪽. 바로 앞 질문도 '새 화면'이면 한 번만 나눈다
    // (예: 남자화장실은 D10부터, D10이 없는 여자화장실은 E4a부터 2쪽). 한 쪽이 8문항을 넘으면 그 쪽은 다시 자동으로 나눔.
    const groups = [];
    let prevBreak = false;
    cur.items.forEach((it, i) => {
      const brk = !!it.pageBreak;
      if (i === 0 || (brk && !prevBreak)) groups.push([]);
      groups[groups.length - 1].push(it.code);
      prevBreak = brk;
    });
    const parts = groups.flatMap((g) => chunk(g));
    parts.forEach((codes, i) => pages.push({
      id: `${ctx}|${cur.section}|${codes[0]}`, type: 'items', ctx, spaceLabel,
      title: cur.section + (parts.length > 1 ? ` (${i + 1}/${parts.length})` : ''), codes,
    }));
    cur = null;
  };
  for (const it of items) {
    if (!cur || cur.section !== it.section) { flush(); cur = { section: it.section, items: [] }; }
    cur.items.push(it);
  }
  flush();
  return pages;
}

/**
 * 화면 목록. 항목정의 '순서'대로 화장실 항목을 늘어놓고,
 * 장애인 화장실 항목 묶음과 남·여 화장실 항목 묶음은 그 묶음의 가장 앞 순서 자리에 끼워 넣는다.
 */
export function buildPages(cfg, draft) {
  const items = cfg.items;
  const multiItems = items.filter((it) => appliesTo(it, 'MULTI'));
  const mfItems = items.filter((it) => appliesTo(it, 'MALE') || appliesTo(it, 'FEMALE'));
  const units = items.filter((it) => it.tab === '화장실').map((it) => ({ order: it.order, item: it }));
  if (multiItems.length) units.push({ order: multiItems[0].order, block: 'MULTI' });
  if (mfItems.length) units.push({ order: mfItems[0].order, block: 'MF' });
  const ord = (u) => (u.order == null ? Infinity : u.order);
  units.sort((a, b) => (ord(a) - ord(b)) || (a.block ? 1 : -1));

  const pages = [{ id: 'start', type: 'start', title: '조사 시작' }];
  let run = [];
  const flushRun = () => { pages.push(...sectionPages(run, TOILET, '')); run = []; };
  for (const u of units) {
    if (u.item) { run.push(u.item); continue; }
    flushRun();
    // 보완은 시트에 줄(공간번호)이 있는 칸만 보여 준다
    const hasRow = (key) => draft.mode !== 'supplement' || !!draft.spaceIds?.[key];
    if (u.block === 'MULTI') {
      for (const sp of multiSpaces(draft).filter((x) => hasRow(x.key))) pages.push(...sectionPages(multiItems, sp.key, sp.label));
    } else {
      pages.push({ id: 'presence', type: 'presence', title: '남자·여자 화장실', ctx: TOILET });
      if (draft.hasMale !== false && hasRow(MA)) {
        pages.push(...sectionPages(mfItems.filter((it) => appliesTo(it, 'MALE')), MA, '남자화장실'));
      }
      if (draft.hasFemale !== false && hasRow(FE)) {
        pages.push(...sectionPages(mfItems.filter((it) => appliesTo(it, 'FEMALE')), FE, '여자화장실'));
      }
    }
  }
  flushRun();
  pages.push({ id: 'review', type: 'review', title: '확인과 제출' });
  return pages;
}

/** 이 화면에서 비어 있는 필수 항목 */
export function missingOnPage(cfg, draft, page) {
  if (page.type === 'presence') {
    if (draft.mode === 'supplement') return []; // 보완에서는 바꿀 수 없음
    const out = [];
    if (draft.hasMale === null) out.push({ ctx: TOILET, code: '_hasMale', question: '남자화장실 있음?' });
    if (draft.hasFemale === null) out.push({ ctx: TOILET, code: '_hasFemale', question: '여자화장실 있음?' });
    return out;
  }
  if (page.type !== 'items') return [];
  return page.codes
    .filter((code) => cfg.byCode[code].required && !isLocked(draft, page.ctx, code) && isVisible(cfg, draft, page.ctx, code) && blank(getRaw(draft, page.ctx, code)))
    .map((code) => ({ ctx: page.ctx, code, question: cfg.byCode[code].question }));
}

export function missingAll(cfg, draft) {
  return buildPages(cfg, draft).flatMap((p) => missingOnPage(cfg, draft, p).map((m) => ({ ...m, pageId: p.id, pageTitle: p.title, spaceLabel: p.spaceLabel || '' })));
}

export const MULTI = '선택(여러 개)';
// 이 저장값은 '단독 보기' — 다른 보기와 함께 고르면 확인이 필요하다
const SOLO_VALUES = new Set(['NONE', 'UNKNOWN', 'NA']);
export const splitMulti = (raw) => (blank(raw) ? [] : String(raw).split(',').map((x) => x.trim()).filter(Boolean));

/** 여러 개 답을 고른 순서와 상관없이 선택지 순서대로 이어 붙인다 */
export function joinMulti(cfg, item, values) {
  const order = (cfg.choices[item.list] || []).map((c) => c.value);
  return [...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(',');
}

/** 여러 개 답에서 '없음·알 수 없음' 같은 단독 보기를 다른 보기와 함께 골랐으면 경고 문구 */
export function multiWarning(cfg, item, raw) {
  if (item.type !== MULTI) return '';
  const vals = splitMulti(raw);
  const solo = vals.filter((v) => SOLO_VALUES.has(v));
  if (!solo.length || vals.length < 2) return '';
  const label = (v) => (cfg.choices[item.list] || []).find((c) => c.value === v)?.label || v;
  return `'${solo.map(label).join("', '")}'와(과) 다른 답을 함께 골랐습니다. 맞는지 확인해 주세요.`;
}

/** 확인이 필요한 답(여러 개 답의 충돌) 목록 — 막지는 않는다 */
export function answerWarningsAll(cfg, draft) {
  return buildPages(cfg, draft).filter((p) => p.type === 'items').flatMap((p) => p.codes
    .filter((code) => isVisible(cfg, draft, p.ctx, code))
    .map((code) => ({ code, w: multiWarning(cfg, cfg.byCode[code], getRaw(draft, p.ctx, code)) }))
    .filter((x) => x.w)
    .map((x) => ({ ...x, ctx: p.ctx, question: cfg.byCode[x.code].question, pageId: p.id, spaceLabel: p.spaceLabel || '' })));
}

/** 숫자 값 이상 여부 → 경고 문구 또는 '' */
export function numberWarning(item, raw) {
  if (blank(raw) || raw === 'NA') return '';
  const s = String(raw).replace(/,/g, '').trim();
  const v = Number(s);
  if (!Number.isFinite(v)) return '숫자만 입력해 주세요.';
  const needsInt = item.type === '정수' || item.unit === 'cm';
  if (needsInt && !Number.isInteger(v)) return item.unit === 'cm' ? 'cm는 정수로 적습니다(소수점 없이).' : '정수로 입력해 주세요.';
  if (item.unit === 'cm' && (v < 0 || v > 500)) return `${v}cm가 맞나요? 보통 0~500cm 사이입니다.`;
  if (item.unit === '개' && (v < 0 || v > 100)) return `${v}개가 맞나요?`;
  if (v < 0) return '0보다 작은 값이 맞나요?';
  return '';
}

/** 숫자 칸에 숫자가 아닌 값, cm·정수 칸에 소수가 있으면 true (범위 밖 값은 경고만) */
export function invalidNumber(item, raw) {
  if (blank(raw) || raw === 'NA' || !['숫자', '정수'].includes(item.type)) return false;
  const v = Number(String(raw).replace(/,/g, '').trim());
  if (!Number.isFinite(v)) return true;
  return (item.type === '정수' || item.unit === 'cm') && !Number.isInteger(v);
}

/** 제출 전에 반드시 고쳐야 하는 숫자 목록 */
export function invalidAll(cfg, draft) {
  return buildPages(cfg, draft).filter((p) => p.type === 'items').flatMap((p) => p.codes
    .filter((code) => !isLocked(draft, p.ctx, code) && isVisible(cfg, draft, p.ctx, code) && invalidNumber(cfg.byCode[code], getRaw(draft, p.ctx, code)))
    .map((code) => ({ ctx: p.ctx, code, question: cfg.byCode[code].question, pageId: p.id, spaceLabel: p.spaceLabel || '' })));
}

/** 설정 점검: 변수명이 입력 탭 1행에 없으면 그 값은 저장되지 않는다 */
export function headerProblems(cfg) {
  const out = [];
  for (const it of cfg.items) {
    const h = cfg.headers?.[it.tab];
    if (h && !h.includes(it.var)) out.push(`${it.code}(${it.var})가 '${it.tab}' 탭 1행에 없습니다`);
  }
  return out;
}

/** 법·BF·UD 기준 충족 표시 (값이 없는 기준은 표시하지 않음) */
export function criteriaBadges(item, raw) {
  if (blank(raw) || raw === 'NA') return [];
  if (item.noneButton && Number(raw) === 0) return []; // '없음'(0)은 충족·미달 표시 안 함
  const v = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(v)) return [];
  const out = [];
  for (const [name, min, max] of [['법', item.lawMin, item.lawMax], ['BF', item.bfMin, item.bfMax], ['UD', item.udMin, item.udMax]]) {
    if (min == null && max == null) continue;
    const ok = (min == null || v >= min) && (max == null || v <= max);
    const range = min != null && max != null ? (min === max ? `${min}` : `${min}~${max}`) : min != null ? `${min} 이상` : `${max} 이하`;
    out.push({ name, ok, range });
  }
  return out;
}

const num = (v) => (blank(v) || v === 'NA' ? null : Number(v));

/** H 종합 요약 자동 제안. { code: { value, reason } } — value가 null이면 제안 없음 */
export function suggestH(cfg, draft) {
  const fv = (ctx, code) => (cfg.byCode[code] ? finalValue(cfg, draft, ctx, code) : '');
  const t = (code) => cfg.byCode[code]?.lawMin;
  const multis = multiSpaces(draft);
  const out = {};

  // 가는 길: 계단·턱 칸 수(숫자)면 0칸이어야, 예전 판(있음/없음)이면 '없음' 또는 경사로 '있음'
  const a3 = cfg.byCode.A3a;
  const numericA3 = a3 && (a3.type === '정수' || a3.type === '숫자');
  const accessOk = numericA3 ? num(fv(TOILET, 'A3a')) === 0 : (fv(TOILET, 'A3a') === 'N' || fv(TOILET, 'A4') === 'Y');
  // 칸 안 조건: 있는 항목만. 치수는 '법 최소' 이상, 변기 앞 공간이 선택형이면 '있음'
  const sizeCodes = ['C7', 'C10a', 'C10b', 'C11'].filter((c) => cfg.byCode[c] && ['숫자', '정수'].includes(cfg.byCode[c].type));
  const frontChoice = cfg.byCode.C12b && cfg.byCode.C12b.type === '선택(하나)';
  const wheel = (sp) => {
    const need = ['C4', ...sizeCodes, ...(frontChoice ? ['C12b'] : [])];
    const values = Object.fromEntries(need.map((c) => [c, fv(sp.key, c)]));
    const known = need.every((c) => !blank(values[c]));
    const ge = (c) => num(values[c]) != null && (t(c) == null || num(values[c]) >= t(c));
    const ok = values.C4 === 'OK' && sizeCodes.every(ge) && (!frontChoice || values.C12b === 'Y') && accessOk;
    return { ok, known };
  };
  if (cfg.byCode.H1a) {
    const res = multis.map((sp) => ({ sp, ...wheel(sp) }));
    const hit = res.filter((r) => r.ok);
    const accessKnown = !blank(fv(TOILET, 'A3a'));
    const sizeText = sizeCodes.map((c) => `${cfg.byCode[c].question} ${t(c) ?? ''}`.trim()).join('·');
    const std = `(지금 쓸 수 있음${sizeText ? `, ${sizeText}cm 이상` : ''}${frontChoice ? ', 변기 앞 빈 공간 충분' : ''}, ${numericA3 ? '가는 길 계단·턱 0칸' : '턱 없음 또는 경사로'})`;
    if (hit.length) out.H1a = { value: 'Y', reason: `조건을 모두 만족: ${hit.map((r) => r.sp.label).join(', ')} ${std}` };
    else if (!multis.length) out.H1a = { value: 'N', reason: '장애인 화장실이 없습니다.' };
    else if (res.every((r) => r.known) && accessKnown) out.H1a = { value: 'N', reason: `조건을 모두 만족하는 장애인 화장실이 없습니다 ${std}` };
    else out.H1a = { value: null, reason: '장애인 화장실 칸의 값이 비어 있어 제안하지 못했습니다.' };
  }
  if (cfg.byCode.H2) {
    const hit = multis.filter((sp) => fv(sp.key, 'C3') === 'Y' && fv(sp.key, 'C4') === 'OK');
    const known = multis.every((sp) => !blank(fv(sp.key, 'C3')) && !blank(fv(sp.key, 'C4')));
    if (hit.length) out.H2 = { value: 'Y', reason: `이성 동반 가능하고 쓸 수 있는 칸: ${hit.map((s) => s.label).join(', ')}` };
    else if (!multis.length) out.H2 = { value: 'N', reason: '장애인 화장실이 없습니다.' };
    else if (known) out.H2 = { value: 'N', reason: '이성 동반 가능하고 쓸 수 있는 장애인 화장실이 없습니다.' };
    else out.H2 = { value: null, reason: 'C3·C4 값이 비어 있어 제안하지 못했습니다.' };
  }
  for (const [target, src] of [['H3a', 'B2a'], ['H3b', 'B3'], ['H3c', 'B4a']]) {
    if (!cfg.byCode[target]) continue;
    const v = fv(TOILET, src);
    const allowed = (cfg.choices[cfg.byCode[target].list] || []).some((c) => c.value === v);
    out[target] = blank(v) || !allowed
      ? { value: null, reason: `${src} 답이 없어 제안하지 못했습니다.` }
      : { value: v, reason: `${src}(${cfg.byCode[src]?.question}) 답을 따랐습니다.` };
  }
  if (cfg.byCode.H4) {
    const hasF6 = !!cfg.byCode.F6;
    const f6 = hasF6 ? fv(TOILET, 'F6') : '';
    // F7이 공간 항목(v4)이면 장애인 칸·남녀 화장실의 답을 모두 모은다
    const f7Item = cfg.byCode.F7;
    const f7 = !f7Item ? [] : f7Item.tab === '화장실'
      ? splitMulti(fv(TOILET, 'F7'))
      : allSpaces(draft).filter((sp) => appliesTo(f7Item, sp.kind)).flatMap((sp) => splitMulti(fv(sp.key, 'F7')).filter((x) => x !== 'NA'));
    const f7Known = f7.length && !f7.includes('UNKNOWN') && !f7.includes('NA');
    // v4: 모든 칸의 '비상벨이 있는 변기 칸 수'가 0이면 비상벨 자체가 없음
    const f3Item = cfg.byCode.F3;
    const f3s = f3Item && f3Item.tab !== '화장실'
      ? allSpaces(draft).filter((sp) => appliesTo(f3Item, sp.kind)).map((sp) => fv(sp.key, 'F3')).filter((v) => v !== 'NA')
      : [];
    const noBells = f3s.length > 0 && f3s.every((v) => num(v) === 0);
    if (noBells) out.H4 = { value: 'N', reason: '비상벨이 있는 칸이 없습니다.' };
    else if (f6 === 'Y' || f7.includes('TEXT')) out.H4 = { value: 'Y', reason: f6 === 'Y' ? "'호출됨' 불빛이 있습니다." : '비상벨을 누른 뒤 문자·화상으로 소통할 수 있습니다.' };
    else if (f7Known && (!hasF6 || !blank(f6))) out.H4 = { value: 'N', reason: '비상벨을 누른 뒤 문자·화상으로 소통할 방법이 없습니다.' };
    else out.H4 = { value: null, reason: "'비상벨 누른 뒤 소통할 방법' 답이 없거나 '알 수 없음'이라 제안하지 못했습니다." };
  }
  return out;
}

/** 제안을 답에 채움: 비어 있거나, 이전 제안을 조사자가 손대지 않았을 때만 */
export function applySuggestions(cfg, draft) {
  const sug = suggestH(cfg, draft);
  for (const [code, s] of Object.entries(sug)) {
    const cur = draft.toilet[code];
    const untouchedSuggestion = draft.suggested[code] !== undefined && !draft.touched[`t:${code}`];
    if (blank(cur) || untouchedSuggestion) {
      if (s.value == null) {
        if (untouchedSuggestion) { delete draft.toilet[code]; delete draft.suggested[code]; }
      } else {
        draft.toilet[code] = s.value;
        draft.suggested[code] = s.value;
      }
    }
  }
  return sug;
}

/** 제출용 데이터 (docs/API.md submit) */
export function buildSubmission(cfg, draft, nowText) {
  const toilet = {};
  for (const it of cfg.items.filter((i) => i.tab === '화장실')) toilet[it.var] = finalValue(cfg, draft, TOILET, it.code);
  const spaces = [];
  const spaceKeys = [];
  // 공간 종류상 해당 없는 항목은 NA (빈칸 = 조사 안 함과 구분)
  const valuesFor = (kind, key) => {
    const v = {};
    for (const it of cfg.items.filter((i) => i.tab === '공간')) v[it.var] = appliesTo(it, kind) ? finalValue(cfg, draft, key, it.code) : 'NA';
    return v;
  };
  for (const sp of multiSpaces(draft)) {
    spaces.push({ kind: 'MULTI', side: sp.side, seq: sp.index, values: valuesFor('MULTI', sp.key) });
    spaceKeys.push(sp.key);
  }
  spaces.push({ kind: 'MALE', side: '', seq: 1, values: valuesFor('MALE', MA) });
  spaceKeys.push(MA);
  spaces.push({ kind: 'FEMALE', side: '', seq: 1, values: valuesFor('FEMALE', FE) });
  spaceKeys.push(FE);
  return {
    payload: {
      action: 'submit', clientId: draft.localId, resurveyOf: draft.resurveyOf || null,
      meta: { 입력시각: nowText, 조사자: draft.surveyor, 위도: draft.lat ?? '', 경도: draft.lng ?? '', ...(draft.assignId ? { 배정번호: draft.assignId } : {}) },
      toilet, spaces,
    },
    spaceKeys,
  };
}

/**
 * 시트 행(열이름→값)을 하나씩 돌려준다: visit(ctx, item, value).
 * 공간 행은 공간종류·장애인화장실구분·순번으로 칸(key)을 정하고, 남·여 화장실 있음 여부와 공간번호도 채운다.
 */
function readRows(cfg, draft, prev, visit) {
  for (const it of cfg.items.filter((i) => i.tab === '화장실')) visit(TOILET, it, prev.toilet?.[it.var]);
  const allNA = (row, kind) => cfg.items.filter((i) => appliesTo(i, kind)).every((i) => String(row[i.var] ?? '') === 'NA');
  const fill = (key, kind, row) => {
    if (!draft.spaces[key]) draft.spaces[key] = { values: {} };
    if (row['공간번호']) draft.spaceIds[key] = String(row['공간번호']);
    for (const it of cfg.items.filter((i) => appliesTo(i, kind))) visit(key, it, row[it.var]);
  };
  const sideCount = {};
  for (const row of [...(prev.spaces || [])].sort((a, b) => Number(a['순번']) - Number(b['순번']))) {
    const kind = row['공간종류'];
    if (kind === 'MULTI') {
      const side = row['장애인화장실구분'] || 'SHARED';
      sideCount[side] = (sideCount[side] || 0) + 1;
      fill(`MULTI-${side}-${sideCount[side]}`, 'MULTI', row);
    } else if (kind === 'MALE' || kind === 'FEMALE') {
      const has = !allNA(row, kind);
      if (kind === 'MALE') draft.hasMale = has; else draft.hasFemale = has;
      fill(kind === 'MALE' ? MA : FE, kind, row);
    }
  }
}

/** 재조사: 이전 조사 행(열이름→값)으로 새 조사를 전부 미리 채운다 */
export function prefillFromPrevious(cfg, draft, prev) {
  // 건너뛰기·없는 화장실 때문에 자동으로 들어간 NA는 옮기지 않는다 (이번에 조건이 바뀌면 새로 답해야 하므로).
  // 이번에도 건너뛰어지면 제출할 때 다시 NA가 된다.
  const autoNA = (it, v) => String(v) === 'NA' && (it.rule || SIDE_ONLY_TOILET_ITEMS[it.code]);
  readRows(cfg, draft, prev, (ctx, it, v) => {
    if (blank(v) || autoNA(it, v)) return;
    if ((ctx === MA && draft.hasMale === false) || (ctx === FE && draft.hasFemale === false)) return;
    setRaw(draft, ctx, it.code, String(v));
    draft.prefilled[`${ctx}:${it.code}`] = true;
  });
  draft.spaceIds = {}; // 재조사는 새 공간번호를 받는다
  return draft;
}

// 보완할 때 칸 구성을 바꾸는 항목은 잠근다 (칸을 새로 만들 수 없으므로)
const STRUCTURE_CODES = Object.keys(MULTI_COUNT_CODES);

/**
 * 보완: 제출한 조사(같은 조사차수)의 빈칸만 채운다.
 * 시트에 값이 있는 칸은 잠그고(locked), 빈칸만 입력받는다.
 * 앞 질문이 비어서 자동으로 들어간 NA는 풀어 준다(replaceable) — 앞 질문을 채우면 뒤 질문도 답할 수 있게.
 */
export function supplementFromRows(cfg, draft, prev) {
  draft.mode = 'supplement';
  draft.serverId = prev.id;
  draft.round = Number(prev.round);
  draft.locked = {};
  draft.orig = {};
  draft.replaceable = {};
  readRows(cfg, draft, prev, (ctx, it, v) => {
    const key = `${ctx}:${it.code}`;
    draft.orig[key] = blank(v) ? '' : String(v);
    if (!blank(v)) { setRaw(draft, ctx, it.code, String(v)); draft.locked[key] = true; }
  });
  for (const code of STRUCTURE_CODES) draft.locked[`${TOILET}:${code}`] = true;
  // 자동 NA 풀기: NA인데, 그 조건이 '앞 질문이 빈칸이면 건너뜀'으로 동작하는 규칙(아니면·미만)이고
  // 앞 질문이 빈칸(또는 그 역시 자동 NA)일 때. '…이면 건너뜀'(eq)은 빈칸이면 건너뛰지 않으므로 그 NA는 직접 고른 것.
  for (let pass = 0; pass <= cfg.items.length; pass++) {
    let changed = false;
    for (const [key, v] of Object.entries(draft.orig)) {
      if (v !== 'NA' || draft.replaceable[key]) continue;
      const [ctx, code] = key.split(':');
      const rule = cfg.byCode[code]?.rule;
      if (!rule || rule.error || !shouldSkip(rule, '')) continue;
      const refCtx = cfg.byCode[rule.ref]?.tab === '화장실' ? TOILET : ctx;
      const refKey = `${refCtx}:${rule.ref}`;
      if (draft.orig[refKey] === '' || draft.replaceable[refKey]) {
        draft.replaceable[key] = true;
        delete draft.locked[key];
        setRaw(draft, ctx, code, '');
        changed = true;
      }
    }
    if (!changed) break;
  }
  return draft;
}

export const isLocked = (draft, ctx, code) => !!draft.locked?.[`${ctx}:${code}`] && !draft.unlocked?.[`${ctx}:${code}`];

/** 보완: 저장된 값을 '고치기'로 열 수 있는 칸인가 (장애인 화장실 칸 수처럼 구조를 정하는 답은 못 고침) */
export function canUnlock(draft, ctx, code) {
  const key = `${ctx}:${code}`;
  return draft.mode === 'supplement' && !!draft.locked?.[key] && !draft.unlocked?.[key]
    && !(ctx === TOILET && STRUCTURE_CODES.includes(code));
}

export function unlock(draft, ctx, code) {
  if (!canUnlock(draft, ctx, code)) return false;
  draft.unlocked = draft.unlocked || {};
  draft.unlocked[`${ctx}:${code}`] = true;
  return true;
}

/** 보완에서 고친 칸인가 (시트 값과 달라짐) */
export function isEdited(cfg, draft, ctx, code) {
  const key = `${ctx}:${code}`;
  if (!draft.unlocked?.[key]) return false;
  return String(normalize(cfg.byCode[code], getRaw(draft, ctx, code)) ?? '') !== String(normalize(cfg.byCode[code], draft.orig[key]) ?? '');
}

/**
 * 보완에서 앞 질문을 고쳐 더 이상 건너뛰지 않게 된 질문: 시트의 NA는 건너뛰어서 생긴 것이므로
 * 빈칸으로 열어 다시 답하게 한다. (원래 값 기준으로도 건너뛰던 NA만 — 직접 고른 NA는 그대로)
 */
export function reopenSkipped(cfg, draft) {
  if (draft.mode !== 'supplement') return 0;
  let n = 0;
  for (const [key, o] of Object.entries(draft.orig || {})) {
    if (o !== 'NA' || !draft.locked?.[key] || draft.unlocked?.[key]) continue;
    const [ctx, code] = key.split(':');
    const rule = cfg.byCode[code]?.rule;
    if (!rule || rule.error) continue;
    const refCtx = cfg.byCode[rule.ref]?.tab === '화장실' ? TOILET : ctx;
    if (!shouldSkip(rule, normalize(cfg.byCode[rule.ref], draft.orig[`${refCtx}:${rule.ref}`] ?? ''))) continue;
    if (isSkipped(cfg, draft, ctx, code)) continue;
    draft.unlocked = draft.unlocked || {};
    draft.unlocked[key] = true;
    draft.reopened = draft.reopened || {};
    draft.reopened[key] = true;
    setRaw(draft, ctx, code, '');
    n++;
  }
  return n;
}

/** 장애인 화장실 둘째 칸부터: 값을 복사해 올 첫 칸. 첫 칸이거나 장애인 칸이 아니면 null */
export function copySourceFor(draft, ctx) {
  const list = multiSpaces(draft);
  return list.findIndex((s) => s.key === ctx) > 0 ? list[0] : null;
}

/**
 * codes(한 화면의 문항)에 대해 src 칸의 값을 ctx 칸에 넣는다.
 * 첫 칸이 비어 있는 문항과 잠긴(저장됨) 칸은 그대로 둔다. dryRun이면 세기만 한다.
 * 사진은 칸마다 따로라 복사하지 않는다.
 */
export function copySpaceValues(draft, srcKey, ctx, codes, { dryRun = false } = {}) {
  const changed = [];
  let overwritten = 0;
  for (const code of codes) {
    if (isLocked(draft, ctx, code)) continue;
    const v = getRaw(draft, srcKey, code);
    if (blank(v)) continue;
    const cur = getRaw(draft, ctx, code);
    if (cur === v) continue;
    if (!blank(cur)) overwritten++;
    changed.push(code);
    if (!dryRun) setRaw(draft, ctx, code, v);
  }
  return { changed, overwritten };
}

/**
 * 함께 조사: 보완 중에 시트의 최신 값을 다시 불러와 합친다(다른 기기가 그사이 제출한 칸).
 * - 시트에 새로 채워진 칸은 그 값으로 바꾸고 잠근다.
 * - 내가 입력한 칸은 그대로 둔다. 같은 칸을 시트가 이미 다른 값으로 채웠으면 '겹친 칸'으로 알려 준다
 *   (제출해도 시트에 먼저 들어간 값이 남는다).
 * 반환: { ok, added, conflicts: [{ctx, code, mine, theirs}] } — 조사차수가 달라졌으면 ok=false.
 */
export function mergeFresh(cfg, draft, prev) {
  if (Number(prev.round) !== Number(draft.round) || prev.id !== draft.serverId) {
    return { ok: false, reason: '시트의 최신 조사차수가 달라졌습니다(그사이 재조사됨).' };
  }
  const fresh = supplementFromRows(cfg, newDraft(), prev);
  // 내가 입력한 값 = 잠기지 않은 칸 중 비어 있지 않은 것
  const mine = [];
  const collect = (ctx, values) => {
    for (const [code, v] of Object.entries(values || {})) {
      if (!blank(v) && !draft.locked?.[`${ctx}:${code}`]) mine.push({ ctx, code, v });
    }
  };
  collect(TOILET, draft.toilet);
  for (const [key, sp] of Object.entries(draft.spaces || {})) collect(key, sp.values);

  const before = new Set(Object.keys(draft.locked || {}));
  const conflicts = [];
  // 내가 '고치기'로 연 칸: 그사이 시트 값이 바뀌지 않았으면 내 값을 유지, 바뀌었으면 겹친 칸
  for (const key of Object.keys(draft.unlocked || {})) {
    const [ctx, code] = key.split(':');
    if (!(key in fresh.orig)) continue;
    if ((fresh.orig[key] ?? '') === (draft.orig[key] ?? '')) {
      fresh.unlocked[key] = true;
      if (draft.reopened?.[key]) fresh.reopened[key] = true;
      setRaw(fresh, ctx, code, getRaw(draft, ctx, code) ?? '');
    } else if (isEdited(cfg, draft, ctx, code) && !(draft.reopened?.[key] && !draft.touched?.[key])) {
      conflicts.push({ ctx, code, mine: getRaw(draft, ctx, code) ?? '', theirs: getRaw(fresh, ctx, code) ?? '' });
    }
  }
  for (const { ctx, code, v } of mine) {
    const key = `${ctx}:${code}`;
    if (fresh.locked[key]) {
      const theirs = getRaw(fresh, ctx, code);
      // 숫자는 2.5 와 '2.50' 처럼 쓰는 모양만 다를 수 있어 값으로 비교
      const same = String(normalize(cfg.byCode[code], theirs)) === String(normalize(cfg.byCode[code], v));
      if (!same) conflicts.push({ ctx, code, mine: v, theirs });
    } else {
      setRaw(fresh, ctx, code, v);
    }
  }
  const added = Object.keys(fresh.locked).filter((k) => !before.has(k)).length;
  Object.assign(draft, {
    toilet: fresh.toilet, spaces: fresh.spaces, locked: fresh.locked, orig: fresh.orig,
    replaceable: fresh.replaceable, unlocked: fresh.unlocked, reopened: fresh.reopened, hasMale: fresh.hasMale, hasFemale: fresh.hasFemale, spaceIds: fresh.spaceIds,
    freshAt: Date.now(),
  });
  return { ok: true, added, conflicts };
}

/** 보완 제출용: 시트 값과 달라진(새로 채운) 칸만 보낸다 (docs/API.md supplement) */
export function buildSupplementPayload(cfg, draft, nowText) {
  reopenSkipped(cfg, draft);
  // 빈칸 채우기: 시트에서 비어 있던 칸(또는 자동 NA라 다시 연 칸)
  const changed = (ctx, it) => {
    const key = `${ctx}:${it.code}`;
    if (draft.locked[key]) return undefined;
    const v = finalValue(cfg, draft, ctx, it.code);
    if (blank(v) || String(v) === (draft.orig[key] ?? '')) return undefined;
    return v;
  };
  // 고친 칸: 시트에 값이 있던 칸이 달라짐 ('고치기'로 고쳤거나, 앞 질문을 고쳐 건너뛰게/안 건너뛰게 됨).
  // 서버는 시트 값이 from 그대로일 때만 바꾼다 (그사이 다른 기기가 고쳤으면 겹친 칸으로 알려 줌)
  const edited = (ctx, it) => {
    const key = `${ctx}:${it.code}`;
    if (!draft.locked[key]) return undefined;
    if (ctx === TOILET && STRUCTURE_CODES.includes(it.code)) return undefined;
    const from = draft.orig[key] ?? '';
    const v = finalValue(cfg, draft, ctx, it.code);
    const to = blank(v) ? '' : v; // 숫자는 숫자로 (시트에 글자로 들어가지 않도록)
    if (String(to) === String(normalize(it, from) ?? '') || String(to) === from) return undefined;
    // 직접 고친 칸이 아니면, 앞 질문이 이번에 바뀌어 건너뛰기가 달라진 경우에만 보낸다
    // (시트에 원래 어긋난 값이 있어도 보완할 때마다 몰래 NA로 바꾸지 않도록)
    if (!draft.unlocked?.[key] && !parentChanged(ctx, it)) return undefined;
    // auto = 앞 답 때문에 같이 바뀐 칸: 서버는 앞 답이 실제로 그렇게 바뀌었을 때만 쓴다
    const auto = !draft.unlocked?.[key] || !!draft.reopened?.[key] || isSkipped(cfg, draft, ctx, it.code);
    return auto ? { from, to, auto } : { from, to };
  };
  const parentChanged = (ctx, it, depth = 0) => {
    const rule = it.rule;
    if (!rule || rule.error || depth > 10) return false;
    const refCtx = cfg.byCode[rule.ref]?.tab === '화장실' ? TOILET : ctx;
    const refKey = `${refCtx}:${rule.ref}`;
    const now = finalValue(cfg, draft, refCtx, rule.ref);
    return String(blank(now) ? '' : now) !== String(normalize(cfg.byCode[rule.ref], draft.orig[refKey] ?? '') ?? '') || parentChanged(refCtx, cfg.byCode[rule.ref], depth + 1);
  };
  const replaceNA = (ctx) => cfg.items.filter((it) => draft.replaceable[`${ctx}:${it.code}`]).map((it) => it.var);
  const toilet = {};
  const edits = {};
  for (const it of cfg.items.filter((i) => i.tab === '화장실')) {
    const v = changed(TOILET, it);
    if (v !== undefined) toilet[it.var] = v;
    const e = edited(TOILET, it);
    if (e) edits[it.var] = e;
  }
  const spaces = [];
  for (const sp of allSpaces(draft)) {
    const spaceId = draft.spaceIds[sp.key];
    if (!spaceId) continue;
    const values = {};
    const spEdits = {};
    for (const it of cfg.items.filter((i) => appliesTo(i, sp.kind))) {
      const v = changed(sp.key, it);
      if (v !== undefined) values[it.var] = v;
      const e = edited(sp.key, it);
      if (e) spEdits[it.var] = e;
    }
    if (Object.keys(values).length || Object.keys(spEdits).length) spaces.push({ spaceId, values, edits: spEdits, replaceNA: replaceNA(sp.key) });
  }
  const filledCount = Object.keys(toilet).length + spaces.reduce((n, s) => n + Object.keys(s.values).length, 0);
  const editCount = Object.keys(edits).length + spaces.reduce((n, s) => n + Object.keys(s.edits).length, 0);
  const count = filledCount + editCount;
  return {
    payload: {
      action: 'supplement', clientId: draft.localId, id: draft.serverId, round: draft.round,
      meta: { 입력시각: nowText, 조사자: draft.surveyor }, toilet, edits, replaceNA: replaceNA(TOILET), spaces,
    },
    count, filledCount, editCount,
  };
}

/** 제출한 조사(기기에 남은 기록)를 시트 행 모양으로 — 인터넷 없이 보완을 시작할 때 쓴다 */
export function rowsFromSubmitted(d) {
  return {
    id: d.serverId, round: d.round, toilet: d.submission.toilet,
    spaces: d.submission.spaces.map((sp, i) => ({
      ...sp.values, 공간번호: d.spaceIds[d.spaceKeys[i]], 공간종류: sp.kind, 장애인화장실구분: sp.side, 순번: sp.seq,
    })),
  };
}

/** 목차용: 화면마다 보이는 문항 수와 답한 수, 빈 필수 수 */
export function pageStats(cfg, draft, page) {
  if (page.type === 'presence') {
    const answered = [draft.hasMale, draft.hasFemale].filter((v) => v !== null).length;
    return { total: 2, answered, missingRequired: 2 - answered };
  }
  if (page.type !== 'items') return null;
  const visible = page.codes.filter((code) => isVisible(cfg, draft, page.ctx, code));
  const answered = visible.filter((code) => !blank(getRaw(draft, page.ctx, code))).length;
  return { total: visible.length, answered, missingRequired: missingOnPage(cfg, draft, page).length };
}

// ---------- 배정 목록 ----------
/** 배정 목록에서 고른 화장실로 새 조사를 만든다: 이름·주소만 미리 채움 */
export function draftFromAssignment(a, { surveyor = '' } = {}) {
  const d = newDraft({ surveyor });
  d.assignId = a.id;
  d.assignTeam = a.team;
  d.assignDate = a.date;
  d.prefillLabel = '배정 목록 값';
  const addr = (a.road && a.road !== '-') ? a.road : (a.lot || '');
  if (a.name) { d.toilet.B0a = a.name; d.prefilled['t:B0a'] = true; }
  if (addr) { d.toilet.B0b = addr; d.prefilled['t:B0b'] = true; }
  return d;
}

/** 날짜 목록(정렬)과, 오늘 또는 가장 가까운 날짜 */
export function assignmentDates(items, today) {
  const dates = [...new Set(items.map((a) => a.date).filter(Boolean))].sort();
  const pick = dates.includes(today) ? today : (dates.find((x) => x > today) || dates[dates.length - 1] || today);
  return { dates, pick };
}

/** 그날의 배정을 조별로 묶음. lastTeam이 맨 앞, 나머지는 조 번호순 */
export function assignmentsByTeam(items, date, lastTeam) {
  const groups = new Map();
  for (const a of items.filter((x) => x.date === date)) {
    if (!groups.has(a.team)) groups.set(a.team, []);
    groups.get(a.team).push(a);
  }
  const num = (t) => (/^\d+$/.test(t) ? Number(t) : Infinity);
  return [...groups.entries()]
    .sort((x, y) => (x[0] === lastTeam ? -1 : y[0] === lastTeam ? 1 : (num(x[0]) - num(y[0])) || String(x[0]).localeCompare(String(y[0]))))
    .map(([team, list]) => ({ team, list }));
}

/** 배정에 나오는 모든 조 (숫자는 번호순, 글자는 뒤에) */
export function assignmentTeams(items) {
  const num = (t) => (/^\d+$/.test(t) ? Number(t) : Infinity);
  return [...new Set(items.map((a) => a.team).filter(Boolean))]
    .sort((x, y) => (num(x) - num(y)) || String(x).localeCompare(String(y)));
}

/** 'YYYY-MM-DD'에서 n일 이동 */
export function shiftDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 그 날짜가 든 주의 7일 (일요일부터) */
export function weekDays(date) {
  const [y, m, d] = date.split('-').map(Number);
  const sun = shiftDays(date, -new Date(y, m - 1, d).getDay());
  return Array.from({ length: 7 }, (_, i) => shiftDays(sun, i));
}

/** 배정 항목 상태: 이 휴대폰의 조사 기록 + 서버의 제출 기록 */
export function assignmentStatus(a, localDrafts) {
  const mine = localDrafts.filter((d) => d.assignId === a.id && d.mode !== 'supplement');
  const editing = mine.find((d) => d.status === 'editing');
  if (editing) return { kind: 'editing', draft: editing };
  const done = (a.done || [])[0];
  const sentLocal = mine.find((d) => d.serverId);
  if (done || sentLocal) return { kind: 'done', tid: done?.tid || sentLocal.serverId, round: done?.round || sentLocal.round };
  if (mine.some((d) => ['queued', 'sending', 'photos', 'failed'].includes(d.status))) return { kind: 'queued' };
  return { kind: 'todo' };
}

/** 진행률: 필수 항목 중 답한 비율 대신 화면 위치 기준 */
export function pageIndex(pages, pageId) {
  const i = pages.findIndex((p) => p.id === pageId);
  return i < 0 ? 0 : i;
}
