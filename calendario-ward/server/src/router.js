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

// Lee el cuerpo crudo como Buffer (para multipart/form-data — subida de
// archivos). `maxSize` en bytes.
export function readRawBody(req, maxSize = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parser mínimo de multipart/form-data (sin librerías externas): alcanza
// para el único caso de uso de esta app — subir un PDF (y algún campo de
// texto suelto) desde un <form>/FormData del navegador. Devuelve
// { fields: {nombre: valor}, files: [{field, filename, contentType, data}] }.
export function parseMultipart(buffer, contentType) {
  const fields = {};
  const files = [];
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = match ? (match[1] || match[2]).trim() : null;
  if (!boundary) return { fields, files };
  const boundaryBuf = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return { fields, files };
  start += boundaryBuf.length;
  while (true) {
    if (buffer.slice(start, start + 2).toString('latin1') === '--') break; // boundary final
    let partStart = start;
    if (buffer.slice(partStart, partStart + 2).toString('latin1') === '\r\n') partStart += 2;
    const nextBoundary = buffer.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;
    let partEnd = nextBoundary;
    if (buffer.slice(partEnd - 2, partEnd).toString('latin1') === '\r\n') partEnd -= 2;
    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8');
      const content = part.slice(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      const name = nameMatch ? nameMatch[1] : null;
      if (filenameMatch) {
        files.push({ field: name, filename: filenameMatch[1], contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', data: content });
      } else if (name) {
        fields[name] = content.toString('utf8');
      }
    }
    start = nextBoundary + boundaryBuf.length;
  }
  return { fields, files };
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 2 * 1024 * 1024; // 2MB
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Cuerpo de la petición demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      // Corrección (revisión de código): antes se armaba el cuerpo
      // concatenando STRINGS (`raw += chunk`), lo que obliga a Node a
      // decodificar cada Buffer de cada paquete TCP como UTF-8 por
      // separado — si un caracter multibyte (una tilde, la "ñ") queda
      // partido justo en el borde entre dos paquetes de red (nada raro con
      // nombres/textos largos), cada mitad se decodifica sola y sale como
      // el caracter de reemplazo "�", corrompiendo el dato en silencio (el
      // JSON sigue siendo válido, solo con el texto mal — nunca se ve un
      // error). Ahora se acumulan los Buffers tal cual y se decodifica UNA
      // SOLA VEZ al final, sobre el binario completo ya reensamblado.
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}
