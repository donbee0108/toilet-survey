// Apps Script 웹앱 호출. Content-Type을 붙이지 않아 CORS 사전요청이 생기지 않는다.
const TIMEOUT_MS = 60000;
const PHOTO_TIMEOUT_MS = 180000; // 신호가 약하면 사진 올리기가 오래 걸린다

export function apiUrl() {
  return (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
}

export function password() {
  try { return localStorage.getItem('ts.password') || ''; } catch { return ''; }
}

export async function call(action, body = {}, { timeoutMs } = {}) {
  const url = apiUrl();
  if (!url || url.includes('여기에')) throw new Error('config.js에 웹앱 주소(API_URL)가 설정되지 않았습니다.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || (action === 'uploadPhoto' ? PHOTO_TIMEOUT_MS : TIMEOUT_MS));
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action, password: password(), ...body }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '서버 응답이 너무 늦습니다.' : '인터넷에 연결되지 않았습니다.');
  } finally {
    clearTimeout(timer);
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`서버 응답을 읽지 못했습니다 (${res.status}). 웹앱 배포 설정을 확인해 주세요.`); }
  if (!data.ok) throw new Error(data.error || '서버 오류');
  return data;
}
