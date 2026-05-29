import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', 'static');
const port = Number.parseInt(process.env.PORT || '4177', 10);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const cleanPath = decodeURIComponent(requestUrl.pathname);
  const relativePath = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  const resolvedPath = existsSync(filePath) ? filePath : path.join(root, 'index.html');
  const extension = path.extname(resolvedPath);
  response.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  createReadStream(resolvedPath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard available at http://127.0.0.1:${port}`);
});
