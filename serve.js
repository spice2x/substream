#!/usr/bin/env node
'use strict';

// Static file server, only here so phones and tablets on the LAN can load the app.
// Plain HTTP on purpose: an HTTPS page cannot talk to the game's http:// and ws:// ports.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// not 8080: spice2x runs its own e-amusement server there for -ea and smart ea. 45000 also
// stays below the 49152 dynamic range, which outbound connections are allocated from.
const PORT = Number(process.argv[2]) || 45000;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
        res.writeHead(400).end();
        return;
    }

    const target = path.normalize(path.join(ROOT, pathname));

    // normalize first, then confirm the result never escaped the root
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
        res.writeHead(403).end();
        return;
    }

    const file = pathname.endsWith('/') || target === ROOT
            ? path.join(target, 'index.html')
            : target;

    fs.readFile(file, (error, data) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
            return;
        }

        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
    });
}).listen(PORT, () => {
    console.log(`substream serving ${ROOT} on http://0.0.0.0:${PORT}`);
});
