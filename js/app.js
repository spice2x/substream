'use strict';

(function () {

    const el = (id) => document.getElementById(id);

    const SETTINGS_KEY = 'substream.spice2x.settings';

    // kept in localStorage, password included - it is a LAN game API key, not a credential
    const SETTINGS_FIELDS = [
        'host', 'apiPort', 'password', 'screen', 'fps', 'quality',
    ];

    const STREAM_RETRY_MS = 3000;
    const STREAM_RESTART_MS = 300;
    const STREAM_STALL_MS = 8000;
    const API_RETRY_MS = 3000;
    const TOUCH_REPEAT_MS = 50;

    // whoever served this page is usually also running the game, but not when it is hosted
    // elsewhere - keep it a placeholder so it never reads as a confirmed address
    const HOST_GUESS = location.protocol.startsWith('http') && location.hostname
            ? location.hostname
            : '127.0.0.1';

    // SpiceAPI takes touch coordinates in a canvas the game fixes, which is not always the
    // resolution the stream arrives in - spice2x rescales or rotates them on the way in.
    // Anything not listed here is addressed in stream pixels.
    const MODEL_CANVAS = {
        LDJ: { width: 1280, height: 720 },   // IIDX TDJ subscreen, FHD is upscaled by spice2x
        KFC: { width: 1920, height: 1080 },  // SDVX, portrait fullscreen is rotated by spice2x
        M39: { width: 1280, height: 800 },   // pop'n music
    };

    const stage = el('stage');
    const video = el('video');
    const message = el('message');
    const status = el('status');
    const settings = el('settings');
    const connectButton = el('connect');

    let api = null;
    let apiState = 'idle';
    let streamState = 'idle';
    let streamWanted = false;
    let touchCanvas = null;
    let retryTimer = null;
    let stallTimer = null;
    let apiRetryTimer = null;
    let repeatTimer = null;
    let noteTimer = null;

    // active pointers, keyed by browser pointer id
    const pointers = new Map();
    const resets = [];
    let nextTouchId = 1;
    let flushQueued = false;

    function number(value, fallback) {
        const parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function loadSettings() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        } catch (error) {
            saved = null;
        }

        for (const field of SETTINGS_FIELDS) {
            if (saved && saved[field] !== undefined && saved[field] !== null) {
                el(field).value = saved[field];
            }
        }

        // unconditional, so the hint always matches what hostName() falls back to
        el('host').placeholder = HOST_GUESS;

        return saved !== null;
    }

    function saveSettings() {
        const out = {};
        for (const field of SETTINGS_FIELDS) {
            out[field] = el(field).value;
        }
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
        } catch (error) {
            // private browsing without storage is not worth failing over
        }
    }

    function apiPort() {
        return clamp(number(el('apiPort').value, 1337), 1, 65533);
    }

    function hostName() {
        return el('host').value.trim() || HOST_GUESS;
    }

    function streamUrl() {
        const host = hostName();
        const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

        // the stream server sits two ports above the API port
        const port = apiPort() + 2;

        const query = new URLSearchParams();
        if (el('screen').value !== '') {
            query.set('screen', el('screen').value);
        }
        query.set('fps', String(clamp(number(el('fps').value, 30), 1, 60)));
        query.set('q', String(clamp(number(el('quality').value, 70), 1, 100)));

        // a fresh URL keeps the browser from reusing the previous stream connection
        query.set('_', String(Date.now()));

        return `http://${authority}:${port}/stream.mjpg?${query.toString()}`;
    }

    function canvasSize() {
        return touchCanvas || { width: video.naturalWidth, height: video.naturalHeight };
    }

    function detectTouchCanvas() {
        api.request('info', 'avs').then((data) => {
            const info = data[0] || {};

            // GITADORA arena SMALL subscreen, only those two specs have one
            touchCanvas = info.model === 'M32' && (info.spec === 'C' || info.spec === 'D')
                    ? { width: 800, height: 1280 }
                    : MODEL_CANVAS[info.model] || null;
        }).catch(() => {
            touchCanvas = null;
        });
    }

    // where the letterboxed frame actually sits inside the image element
    function contentRect() {
        const rect = video.getBoundingClientRect();
        if (!video.naturalWidth || !video.naturalHeight || !rect.width || !rect.height) {
            return null;
        }

        const scale = Math.min(
                rect.width / video.naturalWidth,
                rect.height / video.naturalHeight);
        const width = video.naturalWidth * scale;
        const height = video.naturalHeight * scale;

        return {
            left: rect.left + (rect.width - width) / 2,
            top: rect.top + (rect.height - height) / 2,
            width: width,
            height: height,
        };
    }

    function toCanvas(clientX, clientY, requireInside) {
        const box = contentRect();
        const size = canvasSize();
        if (!box || size.width <= 0 || size.height <= 0) {
            return null;
        }

        const u = (clientX - box.left) / box.width;
        const v = (clientY - box.top) / box.height;
        if (requireInside && (u < 0 || u > 1 || v < 0 || v > 1)) {
            return null;
        }

        return {
            x: clamp(Math.round(u * size.width), 0, size.width - 1),
            y: clamp(Math.round(v * size.height), 0, size.height - 1),
        };
    }

    function scheduleFlush() {
        if (!flushQueued) {
            flushQueued = true;
            requestAnimationFrame(flush);
        }
    }

    function flush() {
        flushQueued = false;

        if (api && api.connected) {
            if (resets.length > 0) {
                api.send('touch', 'write_reset', resets.splice(0, resets.length));
            }

            if (pointers.size > 0) {
                const params = [];
                pointers.forEach((point) => params.push([point.id, point.x, point.y]));

                // only one request is in flight at a time, so let a queued update be overwritten
                api.send('touch', 'write', params, 'touch.write');
            }
        } else {
            resets.length = 0;
        }

        // a contact the game never hears about again is dropped, so keep asserting it.
        // driven straight off the timer because requestAnimationFrame stops in a hidden tab
        if (pointers.size > 0 && repeatTimer === null) {
            repeatTimer = setInterval(flush, TOUCH_REPEAT_MS);
        } else if (pointers.size === 0 && repeatTimer !== null) {
            clearInterval(repeatTimer);
            repeatTimer = null;
        }
    }

    function releaseAll() {
        pointers.forEach((point) => resets.push(point.id));
        pointers.clear();
        flush();
    }

    stage.addEventListener('pointerdown', (event) => {
        const point = toCanvas(event.clientX, event.clientY, true);
        if (!point) {
            return;
        }

        event.preventDefault();

        if (nextTouchId > 0xffff) {
            nextTouchId = 1;
        }
        pointers.set(event.pointerId, { id: nextTouchId++, x: point.x, y: point.y });

        try {
            stage.setPointerCapture(event.pointerId);
        } catch (error) {
            // capture is a convenience, dragging off the element just stops updating
        }

        scheduleFlush();
    });

    stage.addEventListener('pointermove', (event) => {
        const active = pointers.get(event.pointerId);
        if (!active) {
            return;
        }

        const point = toCanvas(event.clientX, event.clientY, false);
        if (!point || (point.x === active.x && point.y === active.y)) {
            return;
        }

        event.preventDefault();
        active.x = point.x;
        active.y = point.y;
        scheduleFlush();
    });

    function endPointer(event) {
        const active = pointers.get(event.pointerId);
        if (!active) {
            return;
        }

        pointers.delete(event.pointerId);
        resets.push(active.id);
        scheduleFlush();
    }

    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('blur', releaseAll);

    // touch-action does not cover pinch on iOS, these are WebKit's own gesture events
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
        document.addEventListener(name, (event) => event.preventDefault(), { passive: false });
    });

    function render() {
        let text;
        let cssClass = '';

        if (apiState === 'open' && streamState === 'live') {
            text = 'connected';
            cssClass = 'ok';
        } else if (apiState === 'idle' && !streamWanted) {
            text = 'idle';
        } else {
            text = `api: ${apiState} / stream: ${streamState}`;
            cssClass = apiState === 'error' || streamState === 'error' ? 'bad' : '';
        }

        status.textContent = text;
        status.className = `status ${cssClass}`;
        connectButton.textContent = streamWanted ? 'Disconnect' : 'Connect';

        if (noteTimer) {
            return;
        }

        if (!streamWanted) {
            message.textContent = 'Not connected';
            message.hidden = false;
        } else if (streamState === 'live') {
            message.hidden = true;
        } else if (streamState === 'error') {
            message.textContent = 'No video - retrying';
            message.hidden = false;
        } else {
            message.textContent = 'Waiting for video';
            message.hidden = false;
        }
    }

    function note(text) {
        message.textContent = text;
        message.hidden = false;

        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
            noteTimer = null;
            render();
        }, 4000);
    }

    // a dead stream never fires error, so a timeout is the only thing that can notice one.
    // load repeats per frame on a multipart stream, which makes it a usable heartbeat
    function armStall() {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            note(streamState === 'live'
                    ? 'Video stopped - reconnecting'
                    : 'No frames on that screen - retrying');
            streamFailed();
        }, STREAM_STALL_MS);
    }

    function startStream() {
        clearTimeout(retryTimer);
        retryTimer = null;
        streamState = 'connecting';
        video.src = streamUrl();
        armStall();
        render();
    }

    function streamFailed() {
        if (!streamWanted) {
            return;
        }

        clearTimeout(stallTimer);
        stallTimer = null;
        streamState = 'error';
        render();

        clearTimeout(retryTimer);
        retryTimer = setTimeout(startStream, STREAM_RETRY_MS);
    }

    function stopStream() {
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(stallTimer);
        stallTimer = null;
        streamState = 'idle';
        video.removeAttribute('src');
    }

    // screen, fps and quality are fixed for the life of the request, so they need a new one
    function restartStream() {
        if (!streamWanted) {
            return;
        }

        stopStream();

        // the server only allows one viewer per screen, give it a moment to let go
        streamState = 'connecting';
        retryTimer = setTimeout(startStream, STREAM_RESTART_MS);
        render();
    }

    video.addEventListener('load', () => {
        if (!streamWanted) {
            return;
        }

        armStall();

        // multipart streams fire this once per frame, only the first is a state change
        if (streamState !== 'live') {
            streamState = 'live';
            render();
        }
    });

    video.addEventListener('error', () => {
        // the server refuses a second viewer per screen, so keep trying quietly
        streamFailed();
    });

    function connect() {
        disconnect();
        saveSettings();

        streamWanted = true;
        startStream();

        api = new SpiceApi(
                hostName(),
                apiPort(),
                el('password').value);

        api.onstate = (state) => {
            apiState = state;
            if (state === 'open') {
                detectTouchCanvas();
            } else {
                touchCanvas = null;
                pointers.clear();
                resets.length = 0;
            }

            if ((state === 'closed' || state === 'error') && streamWanted) {
                clearTimeout(apiRetryTimer);
                apiRetryTimer = setTimeout(() => {
                    if (streamWanted && api) {
                        api.connect();
                    }
                }, API_RETRY_MS);
            }

            render();
        };
        api.onerror = (text) => note(`API: ${text}`);
        api.connect();

        settings.hidden = true;
        render();
    }

    function disconnect() {
        streamWanted = false;
        stopStream();

        clearTimeout(apiRetryTimer);
        apiRetryTimer = null;

        if (api) {
            releaseAll();
            api.close();
            api = null;
        }

        touchCanvas = null;
        pointers.clear();
        resets.length = 0;
        apiState = 'idle';
        render();
    }

    connectButton.addEventListener('click', () => {
        if (streamWanted) {
            disconnect();
        } else {
            connect();
        }
    });

    el('toggle-settings').addEventListener('click', () => {
        settings.hidden = !settings.hidden;
    });

    ['screen', 'fps', 'quality'].forEach((field) => {
        el(field).addEventListener('change', () => {
            saveSettings();
            restartStream();
        });
    });

    // iPhone Safari has no element fullscreen at all, and a home screen app is already
    // chromeless, so offer the button only where it does something
    const enterFullscreen = document.documentElement.requestFullscreen
            || document.documentElement.webkitRequestFullscreen;

    if (!enterFullscreen || navigator.standalone) {
        el('fullscreen').hidden = true;
    } else {
        el('fullscreen').addEventListener('click', () => {
            if (document.fullscreenElement || document.webkitFullscreenElement) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                return;
            }

            const started = enterFullscreen.call(document.documentElement);
            if (started && started.catch) {
                started.catch(() => {});
            }
        });
    }

    // first run has nothing to connect to yet, so start on the settings
    settings.hidden = loadSettings();
    render();
})();
