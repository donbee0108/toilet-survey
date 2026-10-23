// 기기 저장소 (IndexedDB). 입력 중인 조사, 사진, 설정 사본을 보관한다.
const DB_NAME = 'toilet-survey';
const DB_VERSION = 2;
let dbPromise = null;

// 사진 목록(photos)에는 정보만, 사진 파일은 blobs에 따로 둔다 — 목록을 볼 때 사진을 다 읽지 않도록.
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => reject(new Error('앱이 다른 창에서도 열려 있습니다. 다른 창을 닫고 다시 열어 주세요.'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'localId' });
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'photoId' });
        s.createIndex('localId', 'localId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; }); // 한 번 실패해도 다음에 다시 시도
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const s = t.objectStore(Array.isArray(stores) ? stores[0] : stores);
    let result;
    let failure = null;
    // fn이 실패하면 거래를 취소한다 (반쯤 저장되지 않게)
    Promise.resolve(fn(s)).then((r) => { result = r; }, (e) => { failure = e; try { t.abort(); } catch { /* 이미 끝남 */ } });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(failure || t.error);
    t.onabort = () => reject(failure || t.error || new Error('저장 취소됨'));
  });
}

const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const drafts = {
  get: (id) => tx('drafts', 'readonly', (s) => req2p(s.get(id))),
  all: () => tx('drafts', 'readonly', (s) => req2p(s.getAll())),
  // rev: 저장할 때마다 1씩 올라가는 판 번호. 같은 기록을 다른 창이 먼저 저장했는지(내 화면이 오래된 것인지) 알아보는 데 쓴다
  put: (d) => tx('drafts', 'readwrite', (s) => { d.updatedAt = Date.now(); d.rev = (d.rev || 0) + 1; s.put(structuredClone(d)); }),
  /**
   * 저장된 기록을 읽고 고쳐 쓰기를 한 거래로 (그 사이 다른 창이 끼어들 수 없음).
   * fn(저장된 기록) → 저장할 기록, 또는 null(저장하지 않음). 저장한 기록(없으면 null)을 돌려준다.
   */
  update: (id, fn) => tx('drafts', 'readwrite', (s) => new Promise((resolve, reject) => {
    const r = s.get(id);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      try {
        const next = fn(r.result);
        if (next) { next.updatedAt = Date.now(); s.put(structuredClone(next)); }
        resolve(next || null);
      } catch (e) { reject(e); }
    };
  })),
  /** 고친 시각(updatedAt)을 바꾸지 않고 저장 — 다 보낸 기록을 작은 '보냄 기록'으로 줄일 때 (첫 화면 순서 유지) */
  putAsIs: (d) => tx('drafts', 'readwrite', (s) => { s.put(structuredClone(d)); }),
  remove: (id) => tx('drafts', 'readwrite', (s) => s.delete(id)),
};

export const photos = {
  byDraft: (localId) => tx('photos', 'readonly', (s) => req2p(s.index('localId').getAll(localId))),
  all: () => tx('photos', 'readonly', (s) => req2p(s.getAll())),
  /** 정보 저장. blob을 함께 주면 파일도 저장 */
  put: (p, blob) => tx(['photos', 'blobs'], 'readwrite', (s) => {
    const { blob: _ignored, ...meta } = p;
    s.put(meta);
    if (blob) s.transaction.objectStore('blobs').put(blob, p.photoId);
  }),
  blob: (id) => tx('blobs', 'readonly', (s) => req2p(s.get(id))),
  remove: (id) => tx(['photos', 'blobs'], 'readwrite', (s) => { s.delete(id); s.transaction.objectStore('blobs').delete(id); }),
};

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => req2p(s.get(k))),
  set: (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); }),
};

/** 브라우저가 저장소를 함부로 지우지 않도록 요청 (가능한 기기에서만) */
export async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* 무시 */ }
}
