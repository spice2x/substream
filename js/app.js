'use strict';

(function () {

    const el = (id) => document.getElementById(id);

    const SETTINGS_KEY = 'substream.spice2x.settings';

    // kept in localStorage, password included - it is a LAN game API key, not a credential
    const SETTINGS_FIELDS = [
        'host', 'apiPort', 'password', 'format', 'screen', 'fps', 'quality',
    ];

    const STREAM_RETRY_MS = 1000;
    const STREAM_RETRY_MAX_MS = 15000;
    const STREAM_RESTART_MS = 300;
    const STREAM_STALL_MS = 8000;
    const API_RETRY_MS = 3000;
    const API_PING_MS = 10000;
    const TOUCH_REPEAT_MS = 50;

    // 1x1 transparent GIF. assigning a new source is what aborts a multipart request -
    // removing the attribute leaves the socket open, and the server goes on streaming to it
    // and holding the screen claim because nothing about the connection looks wrong
    const BLANK_IMAGE = 'data:image/gif;base64,'
            + 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    // whoever served this page is usually also running the game, so a blank host falls back
    // to it rather than making the address be typed out again
    const HOST_GUESS = (location.protocol.startsWith('http') && location.hostname)
            || '127.0.0.1';
    const HTTPS_PAGE = location.protocol === 'https:';

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
    const frame = el('frame');
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
    let retryDelay = STREAM_RETRY_MS;
    let stallTimer = null;
    let apiRetryTimer = null;
    let pingTimer = null;
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
                const target = el(field);
                const fallback = target.value;
                target.value = saved[field];

                // a select goes blank when handed a value it has no option for
                if (target.value === '' && saved[field] !== '') {
                    target.value = fallback;
                }
            }
        }

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

    function streamUrl(path) {
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

        return `http://${authority}:${port}${path}?${query.toString()}`;
    }

    // H.264 decodes into a canvas, MJPEG lands in an img; only one is ever on screen
    function wantH264() {
        return el('format').value !== 'mjpg';
    }

    function activeView() {
        return frame.hidden ? video : frame;
    }

    function viewSize() {
        return frame.hidden
                ? { width: video.naturalWidth, height: video.naturalHeight }
                : { width: frame.width, height: frame.height };
    }

    function canvasSize() {
        return touchCanvas || viewSize();
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

    // where the letterboxed frame actually sits inside the element showing it
    function contentRect() {
        const view = activeView();
        const size = viewSize();
        const rect = view.getBoundingClientRect();
        if (!size.width || !size.height || !rect.width || !rect.height) {
            return null;
        }

        const scale = Math.min(
                rect.width / size.width,
                rect.height / size.height);
        const width = size.width * scale;
        const height = size.height * scale;

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
        // the stage wants no browser default anywhere, including the letterbox around the
        // frame - in landscape that dead area is most of it
        event.preventDefault();

        // without a picture there is nothing to aim at, and the frame on screen is stale
        if (streamState !== 'live') {
            return;
        }

        const point = toCanvas(event.clientX, event.clientY, true);
        if (!point) {
            return;
        }

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

    // touch-action: manipulation ought to be enough, but iOS still zooms on a quick second
    // tap. Controls are left alone so their tap still turns into a click.
    let lastTapAt = 0;
    document.addEventListener('touchend', (event) => {
        const now = Date.now();
        if (now - lastTapAt < 300 && !event.target.closest('button, input, select, label')) {
            event.preventDefault();
        }
        lastTapAt = now;
    }, { passive: false });

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

        if (HTTPS_PAGE) {
            message.textContent = 'HTTPS blocks spice2x connections - open this page over HTTP';
            message.hidden = false;
        } else if (!streamWanted) {
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

    // a stream that is accepted and then stays silent fires no error at all, so a timeout is
    // the only thing that can notice. this covers the first frame only - load fires once per
    // connection, not once per frame, so it cannot be used as a heartbeat
    function armStall() {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            note('No frames on that screen - retrying');
            streamFailed();
        }, STREAM_STALL_MS);
    }

    function startStream() {
        clearTimeout(retryTimer);
        retryTimer = null;
        streamState = 'connecting';

        const h264 = wantH264();
        frame.hidden = !h264;
        video.hidden = h264;

        if (h264) {
            decoder.start(streamUrl('/stream.h264'));
        } else {
            video.src = streamUrl('/stream.mjpg');
        }

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

        // a contact held when the picture died would otherwise keep being asserted
        releaseAll();

        // a fresh element drops the failed load, and the broken image glyph with it
        resetVideo();
        render();

        clearTimeout(retryTimer);

        // a busy screen is routine rather than broken, so ease off instead of hammering it
        retryTimer = setTimeout(startStream, retryDelay);
        retryDelay = Math.min(retryDelay * 2, STREAM_RETRY_MAX_MS);
    }

    function stopStream() {
        clearTimeout(retryTimer);
        retryTimer = null;
        clearTimeout(stallTimer);
        stallTimer = null;
        streamState = 'idle';
        releaseAll();
        resetVideo();
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

    function goLive() {
        clearTimeout(stallTimer);
        stallTimer = null;
        retryDelay = STREAM_RETRY_MS;
        streamState = 'live';
        render();
    }

    video.addEventListener('load', () => {
        // the blank placeholder loads too, and it is not the stream coming up
        if (!streamWanted || video.src.startsWith('data:')) {
            return;
        }

        if (streamState !== 'live') {
            goLive();
        }
    });

    video.addEventListener('error', () => {
        // the server refuses a second viewer per screen, so keep trying quietly
        streamFailed();
    });

    const decoder = new H264Stream(frame);

    // every frame arrives here, which an img never gave us - so this is a real liveness
    // signal and the watchdog can cover a stream that dies mid-flight, not just a dead start
    decoder.onframe = () => {
        if (!streamWanted) {
            return;
        }

        armStall();

        if (streamState !== 'live') {
            goLive();
        }
    };

    decoder.onerror = (error, status) => {
        // only a build without the H.264 encoder answers 404 on a path the server routes
        if (status === 404 && el('format').value !== 'mjpg') {
            el('format').value = 'mjpg';
            saveSettings();
            note('No H.264 in this build - using MJPEG');
        }

        streamFailed();
    };

    // Chromium drops the multipart request when the source changes, WebKit ignores that and
    // honours only the browser's own stop. Nothing else of ours is ever in flight here, and
    // stop() leaves the websocket alone.
    function resetVideo() {
        decoder.stop();
        video.src = BLANK_IMAGE;
        window.stop();
    }

    // a hidden page stops reading and the server drops the stream a few seconds later, which
    // an img reports as nothing at all - so treat coming back as a stream that needs rebuilding
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && streamWanted) {
            restartStream();
        }
    });

    // a websocket that dies without a close stays readyState OPEN, so only traffic proves it.
    // touches count as traffic; without this the first touch after a drop is what discovers it
    function startPing() {
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (api && api.connected && pointers.size === 0) {
                api.request('info', 'avs').catch(() => {});
            }
        }, API_PING_MS);
    }

    function stopPing() {
        clearInterval(pingTimer);
        pingTimer = null;
    }

    function connect() {
        disconnect();
        saveSettings();

        streamWanted = true;
        retryDelay = STREAM_RETRY_MS;
        startStream();

        api = new SpiceApi(
                hostName(),
                apiPort(),
                el('password').value);

        api.onstate = (state) => {
            apiState = state;
            if (state === 'open') {
                detectTouchCanvas();
                startPing();
            } else {
                stopPing();
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
        stopPing();

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

    ['format', 'screen', 'fps', 'quality'].forEach((field) => {
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

    // shows what a blank field resolves to instead of leaving the user guessing
    el('host').placeholder = HOST_GUESS;

    render();
})();
