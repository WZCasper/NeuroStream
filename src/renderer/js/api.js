// Тонкая обёртка над fetch() для локального REST API (тот же источник, поэтому
// относительные пути вида '/api/...' всегда указывают на встроенный сервер).

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message = (data && data.error) || `Ошибка запроса (${res.status})`;
    throw new Error(message);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** Загружает файл через multipart/form-data (для медиатеки). */
export async function uploadFile(url, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Ошибка загрузки (${res.status})`);
  return data;
}
