// Router HTTP minimalista (sin dependencias externas), suficiente para una
// API REST con rutas anidadas y parámetros (ej. /api/events/:id).

export class Router {
  constructor() {
    this.routes = []; // { method, pattern, keys, handler }
  }

  _register(method, pattern, handler) {
    const keys = [];
    const regexStr = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const regex = new RegExp(`^${regexStr}/?$`);
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this._register('GET', pattern, handler); }
  post(pattern, handler) { this._register('POST', pattern, handler); }
  put(pattern, handler) { this._register('PUT', pattern, handler); }
  delete(pattern, handler) { this._register('DELETE', pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (m) {
        const params = {};
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    const MAX = 2 * 1024 * 1024; // 2MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}
