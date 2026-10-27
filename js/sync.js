// 전송 대기열: 제출한 조사를 서버에 보내고, 이어서 사진을 올린다.
// 같은 조사를 여러 번 보내도 서버가 clientId로 중복을 막으므로, 실패하면 그냥 다시 보내면 된다.
import { drafts, photos, kv } from './store.js';
import { applySubmitResult, restAfterDuplicate, prepareConfig, canCompact, receiptOf, receiptExpired, joinedExpired } from './logic.js';
import { call } from './api.js';
import { blobToBase64 } from './photo.js';

const RETRY_MS = 60000;
// 서버가 다른 저장을 처리하느라 바쁘다는 답: 실패가 아니라 '잠시 뒤 다시'. 보내는 중으로 두고 곧 다시 보낸다
const BUSY_RE = /다른 저장이 진행 중|서버 응답이 너무 늦습니다/;
let busyTimer = null;
let running = false;
const listeners = new Set();

export const onSyncChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* 무시 */ } });

export const SENDABLE = ['queued', 'sending', 'photos', 'failed'];

/** 조사 값(제출·보완·나머지 값)만 보낸다. 사진은 sendPhotos가 따로 올린다 */
async function sendValues(d) {
  if (d.mode === 'supplement') {
    // 보완: 화장실번호·공간번호를 이미 알고 있으므로 빈칸 채우기만 보내고 사진으로 넘어간다
    if (!d.supplementDone) {
      d.status = 'sending'; d.error = '';
      await drafts.put(d); emit();
      const res = await call('supplement', d.submission);
      d.result = { filled: res.filled, edited: res.edited || 0, conflicts: res.conflicts || [], skipped: res.skipped || [] };
      // 예전 서버(Code.gs 갱신 전)는 고친 칸을 모른 채 무시한다 → 반영 안 됐다고 알려 준다
      const sentEdits = Object.keys(d.submission.edits || {}).length + (d.submission.spaces || []).reduce((n, s) => n + Object.keys(s.edits || {}).length, 0);
      if (sentEdits && res.edited === undefined) d.result.editsIgnored = sentEdits;
      d.warnings = res.warnings || [];
      d.supplementDone = true;
      d.status = 'photos';
      await drafts.put(d); emit();
    }
  } else if (!d.serverId) {
    d.status = 'sending'; d.error = '';
    await drafts.put(d); emit();
    const res = await call('submit', d.submission);
    applySubmitResult(d, res);
    // '나눠서 조사'를 눌렀다가 응답을 못 받은 조사: 서버에는 그때 것이 이미 있으니 그 뒤 입력한 값은 보완으로 보낸다
    if (res.duplicate && d.splitTried) d.restPending = true;
    d.status = 'photos';
    await drafts.put(d); emit();
  }
  if (d.restPending) {
    const cached = await kv.get('config');
    if (!Array.isArray(cached?.data?.items)) throw new Error('조사 항목 정보가 없어 나머지 값을 보내지 못했습니다. 인터넷이 되는 곳에서 앱을 다시 열어 주세요.');
    // 서버에 이미 들어간 값과 비교해서 아직 없는 값만 보낸다 (같은 값을 보내 '저장 안 됨'으로 잘못 알리지 않도록)
    const prev = await call('getToilet', { id: d.serverId });
    const payload = restAfterDuplicate(prepareConfig(structuredClone(cached.data)), d, d.submission.meta?.['입력시각'] || '', prev);
    if (payload) {
      const res = await call('supplement', payload);
      // 보완 결과처럼 첫 화면 카드에 보이게 한다 (groupSummary의 lastSupp)
      d.result = { filled: res.filled, edited: 0, conflicts: res.conflicts || [], skipped: res.skipped || [] };
      d.restSent = true;
    }
    d.restPending = false;
    await drafts.put(d); emit();
  }
}

async function sendPhotos(d) {
  if (!d.serverId) return;
  const list = (await photos.byDraft(d.localId)).filter((p) => p.status !== 'done' && p.status !== 'lost');
  let failed = 0;
  for (const p of list) {
    try {
      const blob = await photos.blob(p.photoId);
      if (!blob) { Object.assign(p, { status: 'lost', error: '휴대폰에서 사진 파일을 찾지 못했습니다.' }); await photos.put(p); continue; }
      const res = await call('uploadPhoto', {
        clientId: p.photoId, toiletId: d.serverId, spaceId: p.spaceKey ? (d.spaceIds[p.spaceKey] || '') : '',
        itemCode: p.itemCode, takenAt: p.takenAt, surveyor: d.surveyor, description: p.description,
        mimeType: 'image/jpeg', data: await blobToBase64(blob),
      });
      Object.assign(p, { status: 'done', url: res.url, fileName: res.fileName, photoNo: res.photoNo, error: '' });
    } catch (e) {
      failed++;
      Object.assign(p, { status: 'failed', error: e.message });
    }
    await photos.put(p); emit();
  }
  if (failed) throw new Error(`사진 ${failed}장을 보내지 못했습니다.`);
  d.status = 'done'; d.sentAt = Date.now(); d.error = '';
  await drafts.put(d); emit();
}

/**
 * 다 보낸 조사 정리: 서버가 모두 받은 조사는 사진(이미 올린 것)부터 지우고, 그다음 조사 기록을 작은 보냄 기록으로 줄인다.
 * 중간에 앱이 꺼져도: 사진만 지워진 채 남은 기록은 다음 정리 때 다시 줄이고, 기록 없이 남은 사진은 지운다.
 * 아직 서버가 받았다고 확인하지 않은 것(대기·실패·보내는 중·사진 올리는 중·나머지 값)은 절대 지우지 않는다.
 */
let cleaning = false;
export async function cleanSent() {
  if (cleaning) return 0;
  cleaning = true;
  let n = 0;
  try {
    const all = await drafts.all();
    const allPhotos = await photos.all();
    const ids = new Set(all.map((d) => d.localId));
    // 기록이 없는 사진: 조사를 지우다 멈춘 것 (사진 → 기록 순으로 지우므로 보낼 수 없는 사진)
    for (const p of allPhotos) if (!ids.has(p.localId)) { await photos.remove(p.photoId); n++; }
    for (const d of all) {
      const mine = allPhotos.filter((p) => p.localId === d.localId);
      if (canCompact(d, all, mine)) {
        for (const p of mine) await photos.remove(p.photoId); // 사진 먼저 (모두 올라간 것만)
        await drafts.putAsIs(receiptOf(d));
        n++;
      } else if (receiptExpired(d)) {
        await drafts.remove(d.localId);
        n++;
      } else if (joinedExpired(d)) { // 합치기 전 보관 기록: 보관 기간이 지나면 사진과 함께 지움
        for (const p of mine) await photos.remove(p.photoId);
        await drafts.remove(d.localId);
        n++;
      }
    }
  } finally {
    cleaning = false;
  }
  if (n) emit();
  return n;
}

/** 아직 서버에 값을 보내지 않은 조사 (retryFailed: 전에 실패한 것도 다시) */
const needsValues = (d, retryFailed) => SENDABLE.includes(d.status) && (retryFailed || d.status !== 'failed')
  && (d.mode === 'supplement' ? !d.supplementDone : (!d.serverId || d.restPending));

/** 보내다 실패: 서버가 바쁘면 잠시 뒤 다시, 아니면 '실패'로. 이번 차례를 이어 가도 되면 true */
async function onSendError(d, e) {
  if (BUSY_RE.test(e.message)) {
    // 사진 단계였으면 사진부터 이어서, 아니면 처음부터 (서버가 같은 조사를 두 번 저장하지 않음)
    d.status = d.serverId ? 'photos' : 'queued'; d.error = '';
    await drafts.put(d); emit();
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => processQueue(), 5000 + Math.random() * 15000); // 여럿이 한꺼번에 다시 몰리지 않게 흩어서
    return false;
  }
  d.status = 'failed'; d.error = e.message;
  await drafts.put(d); emit();
  return !/비밀번호/.test(e.message);
}

/**
 * 값 보내기 줄: 사진과 따로 돈다. 사진은 휴대폰 데이터로 몇 분씩 걸려, 그 뒤에 줄 선 보완 값이 늦게 들어가면
 * 나눠서 조사하는 분이 불러올 수 없다. 보내는 중에 또 부르면 끝난 뒤 한 번 더 돈다. 멈췄으면(바쁨·비밀번호) false
 */
let valuesJob = null;
let valuesAgain = false;
let valuesRetryFailed = false; // 도는 중에 '실패한 것도 다시'를 부탁받으면 다음 바퀴에서
function sendAllValues(retryFailed = false) {
  valuesRetryFailed ||= retryFailed;
  if (valuesJob) { valuesAgain = true; return valuesJob; }
  valuesJob = (async () => {
    try {
      do {
        valuesAgain = false;
        const retry = valuesRetryFailed;
        valuesRetryFailed = false;
        const list = (await drafts.all()).filter((d) => needsValues(d, retry)).sort((a, b) => a.queuedAt - b.queuedAt);
        for (const d of list) {
          try { await sendValues(d); } catch (e) { if (!(await onSendError(d, e))) return false; }
        }
      } while ((valuesAgain || valuesRetryFailed) && navigator.onLine);
      return true;
    } finally {
      valuesJob = null;
    }
  })();
  return valuesJob;
}

export async function processQueue() {
  if (!navigator.onLine) return;
  // 사진을 올리는 중이어도 새로 제출한 값은 바로. 사진 줄이 그새 끝났으면 그 조사의 사진도 이어서
  if (running) { sendAllValues().then((ok) => { if (ok && !running) processQueue(); }).catch(() => {}); return; }
  running = true;
  try {
    if (await sendAllValues(true)) {
      // 값을 다 보낸 조사의 사진 (값을 못 보낸 조사는 다음 차례에). 그사이 값을 보낸 조사도 이어서
      const tried = new Set();
      photoLoop: for (;;) {
        const list = (await drafts.all())
          .filter((d) => !tried.has(d.localId) && SENDABLE.includes(d.status) && d.serverId && !d.restPending && (d.mode !== 'supplement' || d.supplementDone))
          .sort((a, b) => a.queuedAt - b.queuedAt);
        if (!list.length) break;
        for (const d of list) {
          tried.add(d.localId);
          try { await sendPhotos(d); } catch (e) { if (!(await onSendError(d, e))) break photoLoop; }
        }
      }
    }
  } finally {
    running = false;
  }
  await cleanSent().catch(() => {});
}

export function startSync() {
  window.addEventListener('online', () => processQueue());
  setInterval(() => processQueue(), RETRY_MS);
  cleanSent().catch(() => {}); // 앱을 열 때 남은 것 정리 (인터넷이 없어도)
  processQueue();
}
