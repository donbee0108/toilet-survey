// 조사 로직 (화면·저장과 무관한 순수 함수). 브라우저와 Node 테스트에서 함께 쓴다.
import { parseSkip, shouldSkip, ruleList, isSharedRule } from './skip.js';

// 요청서에 이름이 나온 항목코드만 여기 둔다. 기준 숫자는 모두 항목정의에서 읽는다.
export const MULTI_COUNT_CODES = { C1a: 'MALE', C1b: 'FEMALE', C1c: 'SHARED' };
const SIDE_ONLY_TOILET_ITEMS = { F3a: 'MALE', F3b: 'FEMALE' }; // 그 쪽 화장실이 없으면 NA
const SIDE_LABEL = { MALE: '남자 쪽', FEMALE: '여자 쪽', SHARED: '남녀 공용' };
const MAX_MULTI_PER_SIDE = 10;
const PAGE_MAX = 8;   // 한 화면 최대 문항 수
const PAGE_SPLIT = 7; // 나눌 때 목표 문항 수

export const TOILET = 't';
export const PHOTO = '사진'; // 답 형식 '사진': 그 문항에 찍은 사진 장수가 답(사진이 있어야 답한 것)
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

/** 건너뛰기 조건이 참인가. 앞 항목도 건너뛰어졌으면 그 값은 NA로 본다(연쇄). '; '로 이은 조건은 하나라도 맞으면 건너뜀 */
export function isSkipped(cfg, draft, ctx, code, depth = 0) {
  const item = cfg.byCode[code];
  if (!item?.rule || item.rule.error || depth > 10) return false;
  return ruleList(item.rule).some((r) => ruleSkips(cfg, draft, ctx, r, depth));
}

/** 이 칸이 남녀 공용 장애인 화장실 칸인가 (v6 '공용 장애인 화장실이면/아니면' 조건) */
function isSharedSpace(draft, ctx) {
  const info = spaceInfo(draft, ctx);
  return info?.kind === 'MULTI' && info.side === 'SHARED';
}
// sharedEq·sharedFill 은 공용 칸이면 묻지 않음, sharedNeq 는 공용 칸이 아니면 묻지 않음
const sharedSkips = (draft, ctx, rule) => (rule.op === 'sharedNeq' ? !isSharedSpace(draft, ctx) : isSharedSpace(draft, ctx));

/** '공용 장애인 화장실이면 …로 채움': 공용 칸이면 묻지 않고 저장할 값. 아니면 undefined */
export function autoFillValue(cfg, draft, ctx, code) {
  const rule = ruleList(cfg.byCode[code]?.rule).find((r) => r.op === 'sharedFill');
  return rule && isSharedSpace(draft, ctx) ? rule.value : undefined;
}

function ruleSkips(cfg, draft, ctx, rule, depth) {
  // '공용 장애인 화장실이면/아니면': 앞 답이 아니라 칸의 쪽으로 정해짐
  if (isSharedRule(rule)) return sharedSkips(draft, ctx, rule);
  const refItem = cfg.byCode[rule.ref];
  if (!refItem) return false;
  // '이 쪽 장애인 화장실 …': 남자·여자화장실 화면에서만. 같은 쪽(공용 포함) 장애인 칸 중 그 답인 칸이 없으면 건너뜀
  if (rule.op === 'sideNeq') {
    if (ctx !== MA && ctx !== FE) return false;
    const side = ctx === MA ? 'MALE' : 'FEMALE';
    const values = multiSpaces(draft).filter((sp) => sp.side === side || sp.side === 'SHARED')
      .map((sp) => finalValue(cfg, draft, sp.key, refItem.code, depth + 1));
    return !values.some((v) => !shouldSkip({ op: 'neq', value: rule.value }, v));
  }
  // 공간 항목의 조건은 같은 공간의 답을 먼저 보고, 화장실 항목이면 화장실 답을 본다.
  const refCtx = refItem.tab === '화장실' ? TOILET : ctx;
  // 앞 항목이 이 공간에 묻지 않는 항목이면(예: 장애인 칸에서 남녀용 '비상벨 칸 수') 그 조건은 따지지 않는다
  if (refCtx !== TOILET) {
    const info = spaceInfo(draft, ctx);
    if (info && info.kind !== TOILET && !appliesTo(refItem, info.kind)) return false;
  }
  const refValue = finalValue(cfg, draft, refCtx, refItem.code, depth + 1);
  return shouldSkip(rule, refValue);
}

/** 시트에 저장될 값. 지금 보기에 없는 선택 답(예: 문항이 바뀌기 전에 고른 값)은 보내지 않는다 — 저장된(잠긴) 시트 값은 그대로 */
export function finalValue(cfg, draft, ctx, code, depth = 0) {
  const item = cfg.byCode[code];
  if (forcedNA(cfg, draft, ctx, code)) return 'NA';
  const raw = getRaw(draft, ctx, code);
  const fill = autoFillValue(cfg, draft, ctx, code);
  if (fill !== undefined) {
    // 묻지 않고 정해진 값으로 저장 (NA 아님). 보완에서 시트에 이미 진짜 답이 있으면 그 값을 그대로 둔다(빈칸·NA일 때만 채움)
    if (isLocked(draft, ctx, code) && !blank(raw) && raw !== 'NA') return normalize(item, raw);
    return fill;
  }
  if (isSkipped(cfg, draft, ctx, code, depth)) return 'NA';
  return normalize(item, isLocked(draft, ctx, code) ? raw : fitChoiceValue(cfg, item, raw));
}

/**
 * 선택 문항의 답을 지금 보기 목록에 맞춘다: 하나 고르기는 목록에 없으면 빈칸, 여러 개는 목록에 없는 것만 뺀다.
 * '해당 없음'(NA)은 그대로. 선택 문항이 아니거나 보기 목록을 못 찾으면(설정 문제) 그대로 둔다.
 */
export function fitChoiceValue(cfg, item, raw) {
  if (blank(raw) || !item || (item.type !== '선택(하나)' && item.type !== MULTI)) return raw;
  if (String(raw) === 'NA') return raw;
  const list = cfg.choices?.[item.list];
  if (!list?.length) return raw;
  const values = new Set(list.map((c) => c.value));
  if (item.type === '선택(하나)') return values.has(String(raw)) ? raw : '';
  const kept = splitMulti(raw).filter((x) => values.has(x));
  return kept.length === splitMulti(raw).length ? raw : kept.join(',');
}

/** 답이 있는가 (보기에 없는 선택 답은 답이 없는 것으로 봄) */
const answeredRaw = (cfg, draft, ctx, code) => !blank(fitChoiceValue(cfg, cfg.byCode[code], getRaw(draft, ctx, code)));

/**
 * 조사 항목이 바뀐 뒤: 입력 중인 조사에서 지금 보기에 없는 선택 답을 지운다(여러 개는 그 보기만).
 * 보완의 저장된(잠긴) 시트 값은 건드리지 않는다. 바꾼 칸 수를 돌려준다.
 */
export function cleanDraftChoices(cfg, draft) {
  let n = 0;
  const clean = (ctx, values) => {
    for (const [code, v] of Object.entries(values || {})) {
      const it = cfg.byCode[code];
      if (!it || isLocked(draft, ctx, code)) continue;
      const fit = fitChoiceValue(cfg, it, v);
      if (fit === v) continue;
      values[code] = fit;
      n++;
    }
  };
  clean(TOILET, draft.toilet);
  for (const [key, sp] of Object.entries(draft.spaces || {})) clean(key, sp.values);
  return n;
}

export function normalize(item, raw) {
  if (blank(raw)) return '';
  if (raw === 'NA') return 'NA';
  if (item && (item.type === '숫자' || item.type === '정수' || item.type === PHOTO)) {
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
    .filter((code) => cfg.byCode[code].required && !isLocked(draft, page.ctx, code) && isVisible(cfg, draft, page.ctx, code) && !answeredRaw(cfg, draft, page.ctx, code))
    .map((code) => ({ ctx: page.ctx, code, question: cfg.byCode[code].question }));
}

export function missingAll(cfg, draft) {
  return buildPages(cfg, draft).flatMap((p) => missingOnPage(cfg, draft, p).map((m) => ({ ...m, pageId: p.id, pageTitle: p.title, spaceLabel: p.spaceLabel || '' })));
}

export const MULTI = '선택(여러 개)';
// 이 저장값은 '단독 보기'(없음·둘 다 없음·알 수 없음·해당 없음) — 다른 보기와 함께 고를 수 없다
const SOLO_VALUES = new Set(['NONE', 'UNKNOWN', 'NA']);
export const isSoloValue = (v) => SOLO_VALUES.has(v);
export const splitMulti = (raw) => (blank(raw) ? [] : String(raw).split(',').map((x) => x.trim()).filter(Boolean));

/**
 * 여러 개 고르기에서 보기 하나를 눌렀을 때의 새 답 목록.
 * 단독 보기를 켜면 나머지를 끄고, 다른 보기를 켜면 단독 보기를 끈다. 이미 켜진 보기를 누르면 그것만 끈다.
 */
export function toggleMulti(cur, v) {
  if (cur.includes(v)) return cur.filter((x) => x !== v);
  return isSoloValue(v) ? [v] : [...cur.filter((x) => !isSoloValue(x)), v];
}

// 보기 글이 이만큼(띄어쓰기 뺀 글자 수) 이하로 모두 짧으면 2열 작은 버튼 (예: 요일 월~일·알 수 없음).
// 좁은 휴대폰(320px)에서도 '✓ 알 수 없음'이 한 줄에 들어가는 길이. 더 길면(예: 남자 화장실) 한 줄에 하나
const COMPACT_LABEL_MAX = 4;
/** 여러 개 고르기 중 보기가 3개 이상이고 보기 글이 모두 짧은 질문인가 → 2열 작은 버튼 */
export function isCompactChoices(item, opts) {
  return item.type === MULTI && opts.length >= 3 && opts.every((o) => [...String(o.label ?? '').replace(/\s/g, '')].length <= COMPACT_LABEL_MAX);
}

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
  const sizeCodes = ['C7', 'C10a', 'C10b', 'C11', 'C12c', 'C12d'].filter((c) => cfg.byCode[c] && ['숫자', '정수'].includes(cfg.byCode[c].type));
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
    if (!cfg.byCode[target] || !cfg.byCode[src]) continue;
    let v = fv(TOILET, src);
    // v6: 점자 표지(B2a)는 여러 개 고르기(남자 화장실·여자 화장실·둘 다 없음) — 하나라도 있으면 '있음', '둘 다 없음'이면 '없음'
    if (target === 'H3a' && cfg.byCode.B2a.type === MULTI) {
      const vals = splitMulti(v);
      v = vals.some((x) => x === 'MALE' || x === 'FEMALE' || x === 'Y') ? 'Y' : vals.some((x) => x === 'NONE' || x === 'N') ? 'N' : '';
    }
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
    // v5: 장애인 칸은 위(F1)·아래(F2) 비상벨이 둘 다 '없음'이어야 비상벨 없음
    const multiBells = cfg.byCode.F1 && cfg.byCode.F1.list === '있음없음2' && cfg.byCode.F2
      ? multis.map((sp) => [fv(sp.key, 'F1'), fv(sp.key, 'F2')]).filter(([a, b]) => a !== 'NA' || b !== 'NA')
      : [];
    const noBells = (f3s.length > 0 || multiBells.length > 0) && f3s.every((v) => num(v) === 0)
      && multiBells.every(([a, b]) => a === 'N' && b === 'N');
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
  // 보기가 바뀐 선택 문항(예: v6 점자 표지 있음/없음 → 남자·여자 화장실)은 지금 보기에 없는 예전 답을 옮기지 않는다
  // ('해당 없음'으로 직접 고른 NA는 옮김 — 건너뛰기로 생긴 NA는 위 autoNA 에서 이미 뺌)
  readRows(cfg, draft, prev, (ctx, it, v) => {
    if (blank(v) || autoNA(it, v) || it.type === PHOTO) return; // 사진 장수는 옮기지 않음(사진은 새로 찍음)
    if ((ctx === MA && draft.hasMale === false) || (ctx === FE && draft.hasFemale === false)) return;
    v = fitChoiceValue(cfg, it, String(v));
    if (blank(v)) return;
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
  // 여러 조건('; ')이면: 앞 답을 아는 조건 중 건너뛰게 하는 것이 없고, 앞 답을 몰라서 건너뛴 조건이 있을 때만
  for (let pass = 0; pass <= cfg.items.length; pass++) {
    let changed = false;
    for (const [key, v] of Object.entries(draft.orig)) {
      if (v !== 'NA' || draft.replaceable[key]) continue;
      const [ctx, code] = key.split(':');
      const states = ruleList(cfg.byCode[code]?.rule).map((r) => origRuleState(cfg, draft, ctx, r));
      if (!states.includes('skip') && states.includes('blank')) {
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

/**
 * 시트에 저장된 원래 값으로 건너뛰기 조건 하나를 판단한다.
 * 'skip' = 앞 답이 있고 그 답 때문에 건너뜀 · 'blank' = 앞 답이 비어(또는 자동 NA) 건너뜀 · 'show' = 건너뛰지 않음
 */
function origRuleState(cfg, draft, ctx, rule) {
  if (isSharedRule(rule)) return sharedSkips(draft, ctx, rule) ? 'skip' : 'show'; // 칸의 쪽은 답이 아니라 늘 알고 있음
  const refItem = cfg.byCode[rule.ref];
  if (!refItem) return 'show';
  const unknown = (k) => (draft.orig[k] ?? '') === '' || !!draft.replaceable[k];
  if (rule.op === 'sideNeq') {
    if (ctx !== MA && ctx !== FE) return 'show';
    const side = ctx === MA ? 'MALE' : 'FEMALE';
    const keys = multiSpaces(draft).filter((sp) => sp.side === side || sp.side === 'SHARED').map((sp) => `${sp.key}:${rule.ref}`);
    if (keys.some((k) => !unknown(k) && !shouldSkip({ op: 'neq', value: rule.value }, draft.orig[k]))) return 'show';
    return keys.some(unknown) || !keys.length ? (keys.length ? 'blank' : 'skip') : 'skip';
  }
  const refCtx = refItem.tab === '화장실' ? TOILET : ctx;
  if (refCtx !== TOILET) {
    const info = spaceInfo(draft, ctx);
    if (info && info.kind !== TOILET && !appliesTo(refItem, info.kind)) return 'show';
  }
  const k = `${refCtx}:${rule.ref}`;
  if (unknown(k)) return shouldSkip(rule, '') ? 'blank' : 'show';
  return shouldSkip(rule, normalize(refItem, draft.orig[k])) ? 'skip' : 'show';
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
    const states = ruleList(cfg.byCode[code]?.rule).map((r) => origRuleState(cfg, draft, ctx, r));
    if (!states.some((st) => st === 'skip' || st === 'blank')) continue; // 원래도 건너뛴 NA가 아니면 직접 고른 NA
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
export function copySpaceValues(draft, srcKey, ctx, codes, { dryRun = false, cfg = null } = {}) {
  const changed = [];
  let overwritten = 0;
  for (const code of codes) {
    if (isLocked(draft, ctx, code)) continue;
    if (cfg?.byCode?.[code]?.type === PHOTO) continue; // 사진은 칸마다 따로
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
  // 서버가 읽지 못하는 조건('; ' 여러 조건, '이 쪽 장애인 화장실')의 자동 NA를 푼 칸은 빈칸 채우기 대신
  // '고친 칸'(NA → 새 값, auto)으로 보낸다 — 서버는 그런 칸의 NA를 스스로 풀지 못하므로
  const serverReads = (rule) => !!rule && !rule.error && rule.op !== 'any' && rule.op !== 'sideNeq';
  const viaEdit = (key, it) => !!draft.replaceable[key] && !serverReads(it.rule);
  const changed = (ctx, it) => {
    const key = `${ctx}:${it.code}`;
    if (draft.locked[key] || viaEdit(key, it)) return undefined;
    const v = finalValue(cfg, draft, ctx, it.code);
    if (blank(v) || String(v) === (draft.orig[key] ?? '')) return undefined;
    return v;
  };
  // 고친 칸: 시트에 값이 있던 칸이 달라짐 ('고치기'로 고쳤거나, 앞 질문을 고쳐 건너뛰게/안 건너뛰게 됨).
  // 서버는 시트 값이 from 그대로일 때만 바꾼다 (그사이 다른 기기가 고쳤으면 겹친 칸으로 알려 줌)
  const edited = (ctx, it) => {
    const key = `${ctx}:${it.code}`;
    const special = viaEdit(key, it);
    if (!draft.locked[key] && !special) return undefined;
    if (ctx === TOILET && STRUCTURE_CODES.includes(it.code)) return undefined;
    const from = draft.orig[key] ?? '';
    const v = finalValue(cfg, draft, ctx, it.code);
    const to = blank(v) ? '' : v; // 숫자는 숫자로 (시트에 글자로 들어가지 않도록)
    if (String(to) === String(normalize(it, from) ?? '') || String(to) === from) return undefined;
    // 묻지 않고 정해진 값(공용 칸 위치 등)이 시트와 다르면(예: 예전 NA) 그 값으로 맞춘다
    if (autoFillValue(cfg, draft, ctx, it.code) !== undefined && (from === '' || from === 'NA')) return { from, to, auto: true };
    // 직접 고친 칸이 아니면, 앞 질문이 이번에 바뀌어 건너뛰기가 달라진 경우에만 보낸다
    // (시트에 원래 어긋난 값이 있어도 보완할 때마다 몰래 NA로 바꾸지 않도록)
    if (!special && !draft.unlocked?.[key] && !parentChanged(ctx, it)) return undefined;
    // auto = 앞 답 때문에 같이 바뀐 칸: 서버는 앞 답이 실제로 그렇게 바뀌었을 때만 쓴다
    const auto = special || !draft.unlocked?.[key] || !!draft.reopened?.[key] || isSkipped(cfg, draft, ctx, it.code);
    return auto ? { from, to, auto } : { from, to };
  };
  const parentChanged = (ctx, it, depth = 0) => {
    if (!it?.rule || it.rule.error || depth > 10) return false;
    return ruleList(it.rule).some((rule) => {
      if (!cfg.byCode[rule.ref]) return false;
      if (rule.op === 'sideNeq') {
        if (ctx !== MA && ctx !== FE) return false;
        const side = ctx === MA ? 'MALE' : 'FEMALE';
        return multiSpaces(draft).filter((sp) => sp.side === side || sp.side === 'SHARED').some((sp) => {
          const now = finalValue(cfg, draft, sp.key, rule.ref);
          return String(blank(now) ? '' : now) !== String(draft.orig[`${sp.key}:${rule.ref}`] ?? '');
        });
      }
      const refCtx = cfg.byCode[rule.ref].tab === '화장실' ? TOILET : ctx;
      const refKey = `${refCtx}:${rule.ref}`;
      const now = finalValue(cfg, draft, refCtx, rule.ref);
      return String(blank(now) ? '' : now) !== String(normalize(cfg.byCode[rule.ref], draft.orig[refKey] ?? '') ?? '') || parentChanged(refCtx, cfg.byCode[rule.ref], depth + 1);
    });
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
  // 화면에 보일 '고친 칸' = 조사원이 ✏️ 고치기로 바꾼 칸만 (앞 답 때문에 앱이 같이 바꾼 칸(auto)은 빼고)
  const manual = (e) => Object.values(e).filter((x) => !x?.auto).length;
  const userEditCount = manual(edits) + spaces.reduce((n, s) => n + manual(s.edits), 0);
  return {
    payload: {
      action: 'supplement', clientId: draft.localId, id: draft.serverId, round: draft.round,
      meta: { 입력시각: nowText, 조사자: draft.surveyor }, toilet, edits, replaceNA: replaceNA(TOILET), spaces,
    },
    count, filledCount, editCount, userEditCount,
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
  const answered = visible.filter((code) => (isLocked(draft, page.ctx, code) ? !blank(getRaw(draft, page.ctx, code)) : answeredRaw(cfg, draft, page.ctx, code))).length;
  return { total: visible.length, answered, missingRequired: missingOnPage(cfg, draft, page).length };
}

// ---------- 배정 목록 ----------
/** 배정 목록에서 고른 화장실로 새 조사를 만든다: 이름·주소만 미리 채움 */
export function draftFromAssignment(a, { surveyor = '' } = {}) {
  const d = newDraft({ surveyor });
  d.assignId = a.id;
  d.assignTeam = a.team;
  d.assignDate = a.date;
  d.prefillLabel = '활동 목록 값';
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
    .map(([team, list]) => ({ team, list: sortByOrder(list) }));
}

/** 배정에 나오는 모든 조 (숫자는 번호순, 글자는 뒤에) */
export function assignmentTeams(items) {
  const num = (t) => (/^\d+$/.test(t) ? Number(t) : Infinity);
  return [...new Set(items.map((a) => a.team).filter(Boolean))]
    .sort((x, y) => (num(x) - num(y)) || String(x).localeCompare(String(y)));
}

/**
 * 배정 탭 '순서' 열대로 정렬: 숫자인 것 먼저(작은 수부터), 빈칸·글자는 그 뒤에 시트 줄 순서대로.
 * 같은 순서끼리도 시트 줄 순서 유지 (안정 정렬). 원래 배열은 바꾸지 않음.
 */
export function sortByOrder(list) {
  const num = (a) => {
    const s = String(a?.order ?? '').trim();
    const n = s === '' ? NaN : Number(s);
    return Number.isFinite(n) ? n : Infinity;
  };
  return list.map((a, i) => ({ a, i, n: num(a) }))
    .sort((x, y) => (x.n === y.n ? 0 : x.n - y.n) || (x.i - y.i))
    .map((x) => x.a);
}

/** 배정 카드에 보일 주소: 도로명, 지번(도로명과 다를 때만). '-'는 빈칸으로 */
export function assignAddress(a) {
  const clean = (v) => { const s = String(v ?? '').trim(); return s === '-' ? '' : s; };
  const road = fullAddress(clean(a?.road));
  const lot = fullAddress(clean(a?.lot));
  return { road, lot: lot && lot !== road ? lot : '' };
}

/** 조사 지역(서울 은평구)이 빠진 주소는 앞에 붙임: '응암동 200-5' → '서울 은평구 응암동 200-5' */
export function fullAddress(s) {
  if (!s) return '';
  if (/^서울/.test(s)) return s;
  return s.includes('은평구') ? `서울 ${s}` : `서울 은평구 ${s}`;
}

/** 배정 카드에 보일 순서 번호 (배정 탭 '순서'가 숫자일 때만, 아니면 '') */
export function orderLabel(a) {
  const s = String(a?.order ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? String(n) : '';
}

/**
 * 네이버 지도 검색 주소: 도로명 → 없으면 지번. 화장실 이름으로는 찾지 않음 — 주소가 없으면 '' (지도 버튼 안 보임).
 * 주소는 assignAddress 가 이미 '서울 은평구 …'까지 채워 둠 (다른 동네가 안 나오게)
 */
export function naverMapUrl(a) {
  const { road, lot } = assignAddress(a);
  const q = road || lot;
  if (!q) return '';
  return `https://map.naver.com/p/search/${encodeURIComponent(q)}`;
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

/**
 * 이 휴대폰의 조사 기록(처음 조사·다시 조사·보완)을 화장실 하나당 한 묶음으로.
 * 키: 배정에서 시작했으면 'A:배정번호', 아니면 'T:화장실번호'(제출·재조사·보완), 아직 번호가 없으면 'L:기록번호'.
 * 보완·재조사도 그 화장실번호가 배정에서 나온 것이면 그 배정 묶음으로 들어간다.
 */
export function groupByToilet(allDrafts, assignments = []) {
  const tidToAssign = {};
  for (const a of assignments) for (const x of a.done || []) tidToAssign[x.tid] = a.id;
  for (const d of allDrafts) if (d.assignId && d.serverId && !tidToAssign[d.serverId]) tidToAssign[d.serverId] = d.assignId;
  const groups = new Map();
  for (const d of allDrafts) {
    const tid = d.serverId || d.resurveyOf || '';
    const aid = d.assignId || (tid && tidToAssign[tid]) || '';
    const key = aid ? `A:${aid}` : tid ? `T:${tid}` : `L:${d.localId}`;
    if (!groups.has(key)) groups.set(key, { key, assignId: aid, tid: '', drafts: [] });
    const g = groups.get(key);
    g.drafts.push(d);
    if (!g.tid && d.serverId) g.tid = d.serverId;
  }
  for (const g of groups.values()) g.drafts.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  return groups;
}

/**
 * 묶음 하나의 상태: 무엇을 해야 하는지 한 가지로.
 * failed(전송 실패) > editing(입력 중) > supp(보완 중) > sending(보내는 중) > done(보냄)
 */
export function groupSummary(g) {
  const ds = g.drafts;
  const failed = ds.find((d) => d.status === 'failed');
  const editing = ds.find((d) => d.status === 'editing' && d.mode !== 'supplement');
  const supp = ds.find((d) => d.status === 'editing' && d.mode === 'supplement');
  const sending = ds.find((d) => ['queued', 'sending', 'photos'].includes(d.status));
  const sent = ds.find((d) => d.mode !== 'supplement' && d.serverId && d.status === 'done');
  // 보완 결과 (나눠서 조사 뒤 '나머지 값'을 보낸 처음 조사 기록도 포함)
  const lastSupp = ds.find((d) => (d.mode === 'supplement' || d.restSent) && d.status === 'done' && d.result);
  const kind = failed ? 'failed' : editing ? 'editing' : supp ? 'supp' : sending ? 'sending' : 'done';
  const named = ds.find((d) => d.toilet?.B0a);
  return { kind, failed, editing, supp, sending, sent, lastSupp, name: named?.toilet.B0a || '(이름 없음)', tid: g.tid || sent?.serverId || '' };
}

/** 배정 항목 상태: 이 휴대폰의 조사 기록 + 서버의 제출 기록 */
/**
 * serverAt: 서버 활동 목록을 받기 시작한 시각(ms). 그 뒤에 받은 목록에 없는 '이 휴대폰에서 보낸 기록'은
 * 시트에서 지운 것으로 보고 제출됨으로 치지 않는다 (시험 기록을 시트에서 지웠을 때 휴대폰에 남는 문제).
 */
export function assignmentStatus(a, localDrafts, { serverAt = 0 } = {}) {
  const mine = localDrafts.filter((d) => d.assignId === a.id && d.mode !== 'supplement');
  const editing = mine.find((d) => d.status === 'editing');
  if (editing) return { kind: 'editing', draft: editing };
  // 여러 번(다시 조사) 제출됐으면 가장 최근 차수. missing = 서버가 센 빈 필수 칸 수(모르면 null)
  const done = [...(a.done || [])].sort((x, y) => (y.round || 0) - (x.round || 0))[0];
  const savedAt = (d) => d.savedAt || d.sentAt || d.queuedAt || 0;
  const sentLocal = mine.find((d) => d.serverId && !(serverAt && serverAt > savedAt(d)));
  if (done || sentLocal) return { kind: 'done', tid: done?.tid || sentLocal.serverId, round: done?.round || sentLocal.round, missing: done?.missing ?? null };
  if (mine.some((d) => ['queued', 'sending', 'photos', 'failed'].includes(d.status))) return { kind: 'queued' };
  return { kind: 'todo' };
}

// ---------- 다 보낸 조사 정리 (휴대폰 저장 공간) ----------
// 서버가 받았다고 확인한 조사(제출·사진·나머지 값까지 모두)는 휴대폰에서 입력 내용·사진을 지우고
// 첫 화면 카드에 필요한 작은 '보냄 기록'만 남긴다(화장실 이름·번호·배정번호·보완 결과 알림). 보냄 기록도 며칠 뒤 지운다.
export const RECEIPT_KEEP_MS = 7 * 24 * 3600 * 1000;
const RECEIPT_KEYS = ['localId', 'createdAt', 'updatedAt', 'status', 'mode', 'serverId', 'round', 'resurveyOf', 'assignId', 'assignTeam', 'assignDate',
  'surveyor', 'result', 'warnings', 'sentAt', 'savedAt', 'queuedAt', 'splitAt', 'restSent'];

/**
 * 이 조사 기록을 지워도(보냄 기록으로 줄여도) 되는가: 서버가 모두 받았을 때만.
 * - 상태가 '전송 완료'(제출 확인 + 사진 모두 올림)이고, 나머지 값(restPending)이 남지 않았고
 * - 사진이 모두 올라갔거나(done) 휴대폰에서 이미 없어진 것(lost)뿐이고
 * - 이 기록을 이어서 입력 중인 '나눠서 조사' 보완이 끝나지 않았을 때(그 화면에 보낸 사진을 보여 줌)는 기다림
 */
export function canCompact(d, allDrafts, draftPhotos) {
  if (!d || d.compact || d.status !== 'done' || d.restPending) return false;
  if (allDrafts.some((x) => x.splitFrom === d.localId && x.status !== 'done')) return false;
  return draftPhotos.every((p) => p.status === 'done' || p.status === 'lost');
}

/** 보냄 기록: 첫 화면 카드(제출됨·보완 결과 알림)에 필요한 것만 */
export function receiptOf(d) {
  const r = { compact: true, toilet: d.toilet?.B0a ? { B0a: d.toilet.B0a } : {}, spaces: {} };
  for (const k of RECEIPT_KEYS) if (d[k] !== undefined) r[k] = d[k];
  return r;
}

/** 보냄 기록을 지울 때가 됐는가 */
export const receiptExpired = (d, now = Date.now()) => !!d.compact && now - (d.sentAt || d.updatedAt || 0) > RECEIPT_KEEP_MS;

/** 진행률: 필수 항목 중 답한 비율 대신 화면 위치 기준 */
export function pageIndex(pages, pageId) {
  const i = pages.findIndex((p) => p.id === pageId);
  return i < 0 ? 0 : i;
}

// ---------- 나눠서 조사 (같은 조 두 사람이 한 화장실을 나눠 입력) ----------
/** 장애인 화장실 개수(C1a·C1b·C1c)를 묻는 화장실 화면인가 — '나눠서 조사 시작' 버튼을 여기에 둔다 */
export function isSplitPage(page) {
  return page?.type === 'items' && page.ctx === TOILET && page.codes.some((c) => c in MULTI_COUNT_CODES);
}

/** 나눠서 조사를 시작할 수 있는 조사인가: 아직 보내지 않은 새 조사(다시 조사 포함)만 */
export function canSplit(draft) {
  return !!draft && draft.mode !== 'supplement' && draft.status === 'editing' && !draft.serverId;
}

/**
 * '나눠서 조사 시작' 확인 창에서 적은 장애인 화장실 개수 확인 (칸 구성은 보낸 뒤 바꿀 수 없으므로 모두 필요).
 * raw: { C1a: '1', … } → { values: { C1a: '1', … }(숫자 글자로 정리), missing: [code], invalid: [code] }
 * 0 이상 정수만, 한 쪽에 MAX_MULTI_PER_SIDE 개까지 (화면도 그만큼만 만든다)
 */
export function checkSplitCounts(cfg, raw) {
  const values = {};
  const missing = [];
  const invalid = [];
  for (const code of Object.keys(MULTI_COUNT_CODES)) {
    if (!cfg.byCode[code]) continue;
    const s = String(raw?.[code] ?? '').trim();
    if (s === '') missing.push(code);
    else if (!/^\d+$/.test(s) || Number(s) > MAX_MULTI_PER_SIDE) invalid.push(code);
    else values[code] = String(Number(s));
  }
  return { values, missing, invalid };
}

/** 확인 창에 미리 넣을 개수: 조사에 적어 둔 0 이상 정수만 (그 밖은 빈칸) */
export function splitCountDefaults(draft) {
  const out = {};
  for (const code of Object.keys(MULTI_COUNT_CODES)) {
    const s = String(draft.toilet?.[code] ?? '').trim();
    out[code] = /^\d+$/.test(s) ? s : '';
  }
  return out;
}

/** 나누기 전에 꼭 적어야 하는 장애인 화장실 개수 중 빈 것 (칸 구성은 보낸 뒤 바꿀 수 없으므로) */
export function splitMissingCounts(cfg, draft) {
  return Object.keys(MULTI_COUNT_CODES)
    .filter((code) => cfg.byCode[code] && blank(draft.toilet[code]))
    .map((code) => ({ ctx: TOILET, code, question: cfg.byCode[code].question }));
}

/**
 * 서버의 submit 결과를 조사 기록에 적는다 (대기열 전송과 '나눠서 조사'가 함께 씀).
 * 같은 clientId로 이미 저장돼 있던 결과(duplicate)면 그때의 칸 구성과 지금 칸 구성이 다를 수 있어
 * 순서 대신 공간 종류(-M순번·-MA·-FE)로 공간번호를 맞춘다.
 */
export function applySubmitResult(draft, res, now = Date.now()) {
  draft.serverId = res.id;
  draft.savedAt = now; // 서버에 줄이 생긴 시각 (활동 목록과 비교용)
  draft.round = res.round;
  const ids = res.spaceIds || [];
  if (!res.duplicate) {
    draft.spaceIds = Object.fromEntries(draft.spaceKeys.map((k, i) => [k, ids[i]]));
  } else {
    let m = 0;
    draft.spaceIds = {};
    (draft.submission?.spaces || []).forEach((sp, i) => {
      const id = sp.kind === 'MULTI' ? `${res.id}-M${++m}` : sp.kind === 'MALE' ? `${res.id}-MA` : `${res.id}-FE`;
      if (ids.includes(id)) draft.spaceIds[draft.spaceKeys[i]] = id;
    });
  }
  draft.warnings = res.warnings || [];
  return draft;
}

/**
 * '나눠서 조사'로 먼저 보낸 뒤: 그 조사를 이어서 입력할 보완 기록을 만든다.
 * 보낸 칸은 '저장됨'으로 잠기고, 빈칸은 그대로 채울 수 있다. 보낸 기록(sent)은 사진을 올리러 대기열로 간다.
 */
export function supplementAfterSplit(cfg, sent, { rows = null, trustSubmission = true, current = sent, now = Date.now() } = {}) {
  // 기준 행: 서버에서 읽은 실제 행(rows)이 가장 정확하다. 못 읽었으면 보낸 값 —
  // 단, 같은 번호로 이미 저장돼 있던 경우(duplicate)는 서버 값이 보낸 값과 다를 수 있어 값은 비우고 칸 구성만 쓴다(모두 '빈칸'으로 열림)
  let base = rows;
  if (!base) {
    base = rowsFromSubmitted(sent);
    if (!trustSubmission) {
      const keepOnly = (o, keep) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, keep(k) ? v : '']));
      const structVars = new Set(STRUCTURE_CODES.map((c) => cfg.byCode[c]?.var).filter(Boolean));
      const meta = new Set(['공간번호', '공간종류', '장애인화장실구분', '순번']);
      base = { ...base, toilet: keepOnly(base.toilet, (k) => structVars.has(k)), spaces: base.spaces.map((sp) => keepOnly(sp, (k) => meta.has(k))) };
    }
  }
  const d = supplementFromRows(cfg, newDraft({ surveyor: sent.surveyor }), base);
  if (!rows && !trustSubmission) { d.hasMale = current.hasMale; d.hasFemale = current.hasFemale; }
  d.splitFrom = sent.localId;
  d.freshAt = now; // 방금 보낸 값이므로 바로 다시 불러오지 않음
  // 이 휴대폰에서 적었지만 서버에 아직 없는 답은 빈칸이 아니라 '입력한 값'(잠기지 않음)으로 옮긴다 → 보완 제출 때 보냄
  let carried = 0;
  let dropped = 0;
  const carry = (ctx, values) => {
    for (const [code, v] of Object.entries(values || {})) {
      if (blank(v) || !cfg.byCode[code]) continue;
      if (ctx !== TOILET && !d.spaceIds[ctx]) { dropped++; continue; } // 서버에 없는 칸
      const key = `${ctx}:${code}`;
      if (d.locked[key] || !blank(getRaw(d, ctx, code))) continue; // 서버에 이미 값이 있음
      setRaw(d, ctx, code, v);
      d.touched[key] = true;
      carried++;
    }
  };
  carry(TOILET, current.toilet);
  for (const [key, sp] of Object.entries(current.spaces || {})) carry(key, sp.values);
  return Object.assign(d, { splitCarried: carried, splitDropped: dropped });
}

/**
 * 나눠서 조사를 누른 뒤 응답을 못 받았는데(서버에는 저장됨) 나중에 '제출하기'로 다시 보낸 경우:
 * 서버는 같은 clientId라 처음 것만 돌려준다. 그 뒤에 입력한 값은 보완(빈칸 채우기)으로 보낸다. 보낼 것이 없으면 null
 */
export function restAfterDuplicate(cfg, draft, nowText, prev = null) {
  const sub = draft.submission;
  if (!sub || !draft.serverId) return null;
  // 서버에 이미 같은 값이 있는 칸은 보내지 않는다 (2.50 과 2.5 처럼 모양만 다른 값도 같은 값)
  const same = Number(prev?.round) === Number(draft.round) && prev?.id === draft.serverId;
  const serverSpace = (spaceId) => (same ? (prev.spaces || []).find((r) => String(r['공간번호']) === spaceId) || {} : {});
  const keep = (vars, applies, server) => Object.fromEntries(Object.entries(vars || {})
    .filter(([v, val]) => {
      const it = cfg.byVar[v];
      if (blank(val) || !it || !applies(it)) return false;
      const cur = server[v];
      return blank(cur) || String(normalize(it, cur)) !== String(normalize(it, val));
    }));
  const toilet = keep(sub.toilet, (it) => it.tab === '화장실', same ? prev.toilet || {} : {});
  const spaces = [];
  (sub.spaces || []).forEach((sp, i) => {
    const spaceId = draft.spaceIds[draft.spaceKeys[i]];
    if (!spaceId) return;
    const values = keep(sp.values, (it) => it.tab === '공간' && appliesTo(it, sp.kind), serverSpace(spaceId));
    if (Object.keys(values).length) spaces.push({ spaceId, values, edits: {}, replaceNA: [] });
  });
  if (!Object.keys(toilet).length && !spaces.length) return null;
  return {
    action: 'supplement', clientId: `${draft.localId}-rest`, id: draft.serverId, round: draft.round,
    meta: { 입력시각: nowText, 조사자: draft.surveyor }, toilet, edits: {}, replaceNA: [], spaces,
  };
}

/**
 * 첫 화면 '마저 해야 할 화장실'용: 같은 조가 (다른 휴대폰으로) 보낸 화장실 중 빈칸이 남은 곳.
 * listToilets 결과에서 조사자가 그 조이고, 최근 days일 안에 입력된 곳. skip(이미 다른 카드로 보이는 번호)은 뺀다.
 */
export function teamBlankToilets(toilets, { surveyor, today, days = 7, skip = new Set() }) {
  if (!surveyor) return [];
  const since = shiftDays(today, -(days - 1));
  return (toilets || []).filter((t) => {
    if (t.surveyor !== surveyor || !(t.missing > 0) || skip.has(t.id)) return false;
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(t.time || ''));
    return !m || m[1] >= since; // 날짜를 못 읽으면 보여 준다
  }).sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

/**
 * 첫 화면을 가볍게 새로 받을 때(listToilets만): 배정의 '제출됨'(done) 정보를 화장실 목록으로 맞춘다.
 * 배정번호가 있는 화장실의 최신 차수를 done에 넣고(없으면 추가), 빈칸 수를 새 값으로. assignments를 고쳐서 돌려준다.
 */
export function mergeToiletInfo(assignments, toilets) {
  const byId = new Map((assignments || []).map((a) => [a.id, a]));
  for (const t of toilets || []) {
    const a = t.assignId && byId.get(t.assignId);
    if (!a) continue;
    a.done = a.done || [];
    const ex = a.done.find((x) => x.tid === t.id && Number(x.round) === Number(t.round));
    if (ex) ex.missing = t.missing ?? ex.missing ?? null;
    else a.done.push({ tid: t.id, round: t.round, missing: t.missing ?? null });
  }
  return assignments;
}
