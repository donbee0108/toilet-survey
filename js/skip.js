// 건너뛰기 조건 파서.
// 항목정의 '건너뛰기 조건' 열의 한글 문장을 규칙 객체로 바꾸고, 답을 넣어 참/거짓을 판단한다.
//
// 지원 문장 (세 가지):
//   {항목코드}의 답이 {코드}({문구})가 아니면 건너뜀   → { ref, op: 'neq', value }
//   {항목코드}의 답이 {코드}({문구})이면 건너뜀       → { ref, op: 'eq',  value }
//   {항목코드}이(가) {숫자} 미만이면 건너뜀          → { ref, op: 'lt',  value: number }
//
// 앞 항목이 빈칸(조사 안 함)일 때: 'neq'는 참(건너뜀), 'eq'는 거짓, 'lt'는 참(건너뜀).
// 즉 문장을 글자 그대로 적용한다 — 앞 답이 없으면 뒤 항목은 NA로 저장된다.
//
// v5 추가:
//   이 쪽 장애인 화장실 {항목코드}의 답이 {코드}({문구})가 아니면 건너뜀
//     → { ref, op: 'sideNeq', value } 남자·여자화장실 화면에서, 같은 쪽(또는 공용) 장애인 화장실 칸 중
//       그 답인 칸이 하나도 없으면 건너뜀. 다른 화면에서는 건너뛰지 않음.
//   문장 여러 개를 '; '로 이으면 하나라도 맞을 때 건너뜀 → { op: 'any', rules: [...] }

const PATTERNS = [
  { op: 'neq', re: /^\s*([A-Za-z0-9]+)의\s*답이\s*([A-Za-z0-9_]+)\s*\((.*?)\)\s*(?:가|이)\s*아니면\s*건너뜀\s*\.?\s*$/ },
  { op: 'eq', re: /^\s*([A-Za-z0-9]+)의\s*답이\s*([A-Za-z0-9_]+)\s*\((.*?)\)\s*이면\s*건너뜀\s*\.?\s*$/ },
  { op: 'lt', re: /^\s*([A-Za-z0-9]+)\s*이\(가\)\s*(-?\d+(?:\.\d+)?)\s*미만이면\s*건너뜀\s*\.?\s*$/ },
];

const SIDE_RE = /^\s*이\s*쪽\s*장애인\s*화장실\s*([A-Za-z0-9]+)의\s*답이\s*([A-Za-z0-9_]+)\s*\((.*?)\)\s*(?:가|이)\s*아니면\s*건너뜀\s*\.?\s*$/;

/** 문장 → 규칙. 빈 문장은 null, 해석 못 하면 { error } */
export function parseSkip(text) {
  const s = (text ?? '').toString().trim();
  if (!s) return null;
  const parts = s.split(/\s*;\s*/).filter(Boolean);
  if (parts.length > 1) {
    const rules = parts.map(parseOne);
    const bad = rules.find((r) => r.error);
    return bad ? { error: bad.error, text: s } : { op: 'any', rules, text: s };
  }
  return parseOne(s);
}

function parseOne(s) {
  const side = s.match(SIDE_RE);
  if (side) return { ref: side[1], op: 'sideNeq', value: side[2], label: side[3], text: s };
  for (const { op, re } of PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    if (op === 'lt') return { ref: m[1], op, value: Number(m[2]), text: s };
    return { ref: m[1], op, value: m[2], label: m[3], text: s };
  }
  return { error: `건너뛰기 조건을 해석할 수 없습니다: "${s}"`, text: s };
}

const isBlank = (v) => v === undefined || v === null || v === '';

// '선택(여러 개)' 답은 쉼표로 이어 저장한다(예: 'MALE,ACCESSIBLE'). 조건은 '그 값이 들어 있는가'로 본다.
const has = (refValue, value) => String(refValue).split(',').map((x) => x.trim()).includes(value);

/** 규칙과 앞 항목의 답으로 건너뛸지 판단. 해석 실패한 규칙은 건너뛰지 않는다(질문을 보여 줌). */
export function shouldSkip(rule, refValue) {
  if (!rule || rule.error) return false;
  switch (rule.op) {
    case 'neq': return isBlank(refValue) || !has(refValue, rule.value);
    case 'eq': return !isBlank(refValue) && has(refValue, rule.value);
    case 'lt': {
      if (isBlank(refValue) || refValue === 'NA') return true;
      const n = Number(refValue);
      return Number.isNaN(n) ? true : n < rule.value;
    }
    default: return false;
  }
}

/** 규칙 하나 또는 '; '로 이은 여러 개를 낱개 목록으로 */
export const ruleList = (rule) => (!rule || rule.error ? [] : rule.op === 'any' ? rule.rules : [rule]);

/** 전체 항목 검사: 해석 실패, 없는 항목코드, 선택지에 없는 코드를 모아 돌려준다. */
export function validateSkips(items, choices) {
  const byCode = new Map(items.map((it) => [it.code, it]));
  const problems = [];
  for (const it of items) {
    const parsed = parseSkip(it.skip);
    if (!parsed) continue;
    if (parsed.error) { problems.push(`${it.code}: ${parsed.error}`); continue; }
    for (const rule of ruleList(parsed)) {
    const ref = byCode.get(rule.ref);
    if (!ref) { problems.push(`${it.code}: 조건의 항목코드 ${rule.ref}가 항목정의에 없습니다`); continue; }
    if (rule.op === 'sideNeq' && (ref.tab !== '공간' || !['장애인화장실', '장애인·남·여'].includes(ref.scope))) {
      problems.push(`${it.code}: '이 쪽 장애인 화장실' 조건의 ${rule.ref}는 장애인 화장실 칸에서 묻는 항목이어야 합니다`); continue;
    }
    if (it.tab === '화장실' && ref.tab !== '화장실') {
      problems.push(`${it.code}: 화장실 항목이 공간 항목(${rule.ref})을 조건으로 쓸 수 없습니다`); continue;
    }
    if (rule.op !== 'lt') {
      const list = choices[ref.list] || [];
      if (!list.some((c) => c.value === rule.value)) {
        problems.push(`${it.code}: ${rule.ref}의 선택지(${ref.list || '없음'})에 ${rule.value}가 없습니다`);
      }
    } else if (!['숫자', '정수'].includes(ref.type)) {
      problems.push(`${it.code}: ${rule.ref}는 숫자 항목이 아닙니다`);
    }
    }
  }
  return problems;
}
