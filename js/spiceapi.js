'use strict';

// Minimal SpiceAPI client over the websocket the API server opens on <api port> + 1.
// Requests are JSON in binary frames, responses are NUL-terminated JSON.
//
// One request at a time, always: the server runs a single RC4 keystream over both
// directions and steps it as decrypt(request), encrypt(response), so sending again before
// the reply is read desynchronises the cipher and every later message is garbage.
class SpiceApi {

    static BUFFER_LIMIT = 1024 * 1024;
    static QUEUE_LIMIT = 64;
    static REQUEST_TIMEOUT_MS = 3000;

    constructor(host, port, password) {
        this.host = host;
        this.port = port;
        this.password = password || '';

        this.socket = null;
        this.cipher = null;
        this.buffer = new Uint8Array(0);
        this.nextId = 1;
        this.queue = [];
        this.outstanding = null;
        this.timer = null;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();

        // callbacks
        this.onstate = () => {};
        this.onerror = () => {};
    }

    get connected() {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    get url() {
        // the websocket listener always sits one port above the API port
        const host = this.host.includes(':') && !this.host.startsWith('[')
                ? `[${this.host}]`
                : this.host;
        return `ws://${host}:${this.port + 1}`;
    }

    connect() {
        this.close();

        this.cipher = this.password
                ? new RC4(this.encoder.encode(this.password))
                : null;
        this.buffer = new Uint8Array(0);

        const socket = new WebSocket(this.url);
        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        this.onstate('connecting');

        socket.onopen = () => {
            if (this.socket === socket) {
                this.onstate('open');
            }
        };

        socket.onmessage = (event) => {
            if (this.socket === socket) {
                this.receive(new Uint8Array(event.data));
            }
        };

        socket.onerror = () => {
            if (this.socket === socket) {
                this.onstate('error');
            }
        };

        socket.onclose = () => {
            if (this.socket === socket) {
                this.socket = null;
                this.onstate('closed');
            }
        };
    }

    close() {
        const socket = this.socket;
        this.socket = null;

        clearTimeout(this.timer);
        this.timer = null;

        const dropped = this.queue.concat(this.outstanding ? [this.outstanding] : []);
        this.queue = [];
        this.outstanding = null;
        dropped.forEach((entry) => {
            if (entry.reject) {
                entry.reject(new Error('connection closed'));
            }
        });

        if (socket) {
            socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
            socket.close();
        }
    }

    // fire and forget; entries sharing a coalesce key replace each other while queued
    send(module, func, params, coalesce) {
        return this.enqueue({
            module: module,
            func: func,
            params: params || [],
            coalesce: coalesce,
        });
    }

    request(module, func, params) {
        return new Promise((resolve, reject) => {
            const queued = this.enqueue({
                module: module,
                func: func,
                params: params || [],
                resolve: resolve,
                reject: reject,
            });

            if (!queued) {
                reject(new Error(this.connected ? 'request queue is full' : 'not connected'));
            }
        });
    }

    enqueue(entry) {
        if (!this.connected) {
            return false;
        }

        // only the tail is folded, so anything already queued keeps its place in line
        const last = this.queue[this.queue.length - 1];
        if (entry.coalesce && last && last.coalesce === entry.coalesce) {
            last.params = entry.params;
            return true;
        }

        if (this.queue.length >= SpiceApi.QUEUE_LIMIT) {
            return false;
        }

        this.queue.push(entry);
        this.pump();
        return true;
    }

    pump() {
        if (this.outstanding || this.queue.length === 0 || !this.connected) {
            return;
        }

        const entry = this.queue.shift();
        entry.id = this.nextId++;
        if (this.nextId > 0xffffffff) {
            this.nextId = 1;
        }

        const data = this.encoder.encode(JSON.stringify({
            id: entry.id,
            module: entry.module,
            function: entry.func,
            params: entry.params,
        }));

        this.socket.send(this.cipher ? this.cipher.crypt(data) : data);
        this.outstanding = entry;

        // a reply that never lands leaves the keystream stuck, so give up on the connection
        this.timer = setTimeout(() => this.fail('request timed out'),
                SpiceApi.REQUEST_TIMEOUT_MS);
    }

    fail(text) {
        this.onerror(text);
        this.close();
        this.onstate('closed');
    }

    receive(data) {
        if (this.cipher) {
            this.cipher.crypt(data);
        }

        const merged = new Uint8Array(this.buffer.length + data.length);
        merged.set(this.buffer);
        merged.set(data, this.buffer.length);
        this.buffer = merged;

        // a response that never terminates would grow without bound
        if (this.buffer.length > SpiceApi.BUFFER_LIMIT) {
            this.fail('response buffer overflow');
            return;
        }

        let start = 0;
        for (let i = 0; i < this.buffer.length; i++) {
            if (this.buffer[i] !== 0) {
                continue;
            }

            if (i > start) {
                this.handle(this.buffer.subarray(start, i));
            }
            start = i + 1;
        }

        this.buffer = this.buffer.slice(start);
    }

    handle(bytes) {
        let response;
        try {
            response = JSON.parse(this.decoder.decode(bytes));
        } catch (error) {
            // with a password this means the keystream has drifted, nothing will parse again
            this.fail('malformed response');
            return;
        }

        const entry = this.outstanding;
        if (!entry || entry.id !== response.id) {
            this.fail('unexpected response');
            return;
        }

        clearTimeout(this.timer);
        this.timer = null;
        this.outstanding = null;

        const errors = Array.isArray(response.errors) ? response.errors : [];
        if (errors.length > 0) {
            const message = String(errors[0]);
            if (entry.reject) {
                entry.reject(new Error(message));
            } else {
                this.onerror(message);
            }
        } else if (entry.resolve) {
            entry.resolve(response.data || []);
        }

        this.pump();
    }
}
