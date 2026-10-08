// 전송 대기열: 제출한 조사를 서버에 보내고, 이어서 사진을 올린다.
// 같은 조사를 여러 번 보내도 서버가 clientId로 중복을 막으므로, 실패하면 그냥 다시 보내면 된다.
import { drafts, photos } from './store.js';
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

async function sendDraft(d) {
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
    d.serverId = res.id;
    d.round = res.round;
    d.spaceIds = Object.fromEntries(d.spaceKeys.map((k, i) => [k, res.spaceIds[i]]));
    d.warnings = res.warnings || [];
    d.status = 'photos';
    await drafts.put(d); emit();
  }
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

export async function processQueue() {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const list = (await drafts.all()).filter((d) => SENDABLE.includes(d.status)).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const d of list) {
      try { await sendDraft(d); } catch (e) {
        if (BUSY_RE.test(e.message)) {
          // 사진 단계였으면 사진부터 이어서, 아니면 처음부터 (서버가 같은 조사를 두 번 저장하지 않음)
          d.status = d.serverId ? 'photos' : 'queued'; d.error = '';
          await drafts.put(d); emit();
          clearTimeout(busyTimer);
          busyTimer = setTimeout(() => processQueue(), 5000 + Math.random() * 15000); // 여럿이 한꺼번에 다시 몰리지 않게 흩어서
          break;
        }
        d.status = 'failed'; d.error = e.message;
        await drafts.put(d); emit();
        if (/비밀번호/.test(e.message)) break;
      }
    }
  } finally {
    running = false;
  }
}

export function startSync() {
  window.addEventListener('online', () => processQueue());
  setInterval(() => processQueue(), RETRY_MS);
  processQueue();
}
