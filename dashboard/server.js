const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const port = Number(process.env.PORT || 5050);

function loadLocalEnvironment() {
  const envPath = path.join(rootDir, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith('#') || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

loadLocalEnvironment();

const apiHandlers = {
  overview: require('./api/overview'),
  visits: require('./api/visits'),
  turnover: require('./api/turnover'),
  consistency: require('./api/consistency')
};

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function enhanceResponse(response) {
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (payload) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
    return response;
  };
}

async function serveApi(request, response, pathname, searchParams) {
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const handlerPath = path.join(rootDir, 'api', `${name}.js`);
  if (!fs.existsSync(handlerPath)) {
    response.statusCode = 404;
    response.end('API não encontrada');
    return;
  }
  delete require.cache[require.resolve(handlerPath)];
  const handler = require(handlerPath);
  request.query = Object.fromEntries(searchParams.entries());
  enhanceResponse(response);
  await handler(request, response);
}

function serveStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(requestedPath)}`);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.statusCode = 404;
    response.end('Arquivo não encontrado');
    return;
  }
  response.setHeader('Content-Type', mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `localhost:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      await serveApi(request, response, url.pathname, url.searchParams);
      return;
    }
    serveStatic(response, url.pathname);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Dashboard Labor Rural disponível em http://localhost:${port}`);
});
