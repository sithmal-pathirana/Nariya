/**
 * Local servers for the e2e tests. Hostnames ending in .test are mapped to
 * 127.0.0.1 by Chromium (--host-resolver-rules), so different hosts give
 * real cross-origin requests.
 */
import http from 'node:http';

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/**
 * Blank HTML page on any host, used as the "frontend"
 */
export async function startAppServer() {
    const server = await listen((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>app</title><h1>app</h1>');
    });
    return { server, port: server.address().port };
}

/**
 * API with no CORS headers unless noted:
 *   /proper     — sends correct credentialed CORS for http://chat.test:<appPort>
 *   /no-options — answers preflights with 405
 *   /echo       — echoes method, headers and body as JSON
 *   anything    — {"ok":true,"path":...}
 */
export async function startApiServer({ properOrigin } = {}) {
    const log = [];
    const server = await listen((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://x');
            const body = Buffer.concat(chunks).toString();
            log.push({ method: req.method, path: url.pathname, headers: req.headers, body });

            if (url.pathname === '/proper') {
                if (req.headers.origin === properOrigin) {
                    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                    res.setHeader('Access-Control-Allow-Headers', 'x-goog-authuser, content-type');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
                }
            }
            if (url.pathname === '/no-options' && req.method === 'OPTIONS') {
                res.writeHead(405);
                return res.end();
            }
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                return res.end();
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-Server', 'nariya-test');
            if (url.pathname === '/stream') {
                // Three chunks, 300ms apart; records whether the client hung up early
                res.setHeader('Content-Type', 'text/plain');
                let i = 0;
                const timer = setInterval(() => {
                    res.write(`chunk${i}\n`);
                    if (++i === 3) { clearInterval(timer); res.end(); }
                }, 300);
                res.on('close', () => {
                    if (i < 3) { clearInterval(timer); log.push({ method: req.method, path: '/stream', aborted: true }); }
                });
                return;
            }
            if (url.pathname === '/slow-origin') {
                const ms = parseInt(url.searchParams.get('ms') || '300', 10);
                return setTimeout(() => res.end(JSON.stringify({ origin: req.headers.origin || null })), ms);
            }
            if (url.pathname === '/echo') {
                return res.end(JSON.stringify({ method: req.method, headers: req.headers, body, query: url.search }));
            }
            if (url.pathname === '/users') {
                return res.end(JSON.stringify([{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }]));
            }
            res.end(JSON.stringify({ ok: true, path: url.pathname }));
        });
    });
    return { server, port: server.address().port, log };
}
