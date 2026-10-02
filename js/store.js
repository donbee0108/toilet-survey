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
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장 취소됨'));
  });
}

const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const drafts = {
  get: (id) => tx('drafts', 'readonly', (s) => req2p(s.get(id))),
  all: () => tx('drafts', 'readonly', (s) => req2p(s.getAll())),
  put: (d) => tx('drafts', 'readwrite', (s) => { d.updatedAt = Date.now(); s.put(structuredClone(d)); }),
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
