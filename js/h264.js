'use strict';

// Drives spice2x's /stream.h264: a bare annex-b elementary stream, no container and no
// timestamps.
//
// WebCodecs decodes straight off the wire and draws each frame to a canvas the instant it is
// ready - anything that schedules against a presentation clock puts the latency straight back,
// which is the whole point of this path. But VideoDecoder is gated behind "secure context",
// which plain http from a LAN IP (the normal way this page is reached) never satisfies in
// Chromium, even though the /stream.h264 bytes decode just fine there - only the browser API is
// missing, not the codec. MediaSource is not gated the same way, so where VideoDecoder is
// missing the same NALs are muxed into fragmented MP4 (mp4mux.js) and played through a real
// <video> element instead, which is then drawn onto the same canvas so the rest of the app
// never has to know which path is active.

// WebCodecs path: lowest latency, used whenever VideoDecoder exists.
class WebCodecsSink {
    // how many frames may be queued before the decoder is considered to have fallen behind
    static QUEUE_LIMIT = 8;

    constructor(spsNal, onframe, onerror) {
        this.onerror = onerror;
        this.resyncing = false;
        this.frameCount = 0;

        // avc1.PPCCLL read straight out of the SPS, so the level always matches the stream
        const codec = 'avc1.' + [spsNal[1], spsNal[2], spsNal[3]]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');

        this.decoder = new VideoDecoder({
            output: (frame) => onframe(frame),
            error: (error) => onerror(error),
        });
        this.decoder.configure({ codec, optimizeForLatency: true });
    }

    decode(nals, key) {
        // a decoder that has fallen behind would otherwise build a backlog, and every queued
        // frame is latency. drop until the next IDR, which repairs the picture cleanly.
        if (this.decoder.decodeQueueSize > WebCodecsSink.QUEUE_LIMIT) {
            this.resyncing = true;
        }
        if (this.resyncing && !key) {
            return;
        }
        this.resyncing = false;

        let size = 0;
        for (const nal of nals) {
            size += 4 + nal.length;
        }

        const data = new Uint8Array(size);
        let at = 0;
        for (const nal of nals) {
            data.set([0, 0, 0, 1], at);
            data.set(nal, at + 4);
            at += 4 + nal.length;
        }

        try {
            this.decoder.decode(new EncodedVideoChunk({
                type: key ? 'key' : 'delta',

                // the stream carries no timestamps; this only has to increase
                timestamp: this.frameCount++ * 1000,
                data: data,
            }));
        } catch (error) {
            this.onerror(error);
        }
    }

    close() {
        try {
            this.decoder.close();
        } catch (error) {
            // already closed by an error callback, nothing to undo
        }
    }
}

// MediaSource fallback: used whenever VideoDecoder is missing but MSE + AVC playback is not.
// Decodes through a detached <video>/MediaSource pair and hands frames to the same onframe
// callback as WebCodecsSink, so H264Stream can treat both paths identically.
class MseSink {
    // baseline 4.2E0 @ level 3.0 (0x1E) is about as widely supported as H.264 gets, so it
    // stands in as "does this engine do AVC via MSE at all" without needing a real stream yet
    static supported() {
        return typeof MediaSource !== 'undefined'
                && typeof MediaSource.isTypeSupported === 'function'
                && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
    }

    // nominal only: used for the very first fragment, before there is a real gap to measure
    static TIMESCALE = 90000;
    static NOMINAL_DURATION = Math.round(MseSink.TIMESCALE / 30);

    // a stray huge gap (tab backgrounded, game hitch) would otherwise stretch one fragment
    // across it and then immediately trip maybeCatchUp() into a seek anyway - clamp instead
    static MAX_DURATION_S = 0.5;

    // how far behind the buffered edge playback may drift before jumping forward
    static MAX_LATENCY_S = 0.5;

    // how far behind live to sit deliberately. the stream carries no timestamps, so the
    // element's clock is reconstructed from arrival gaps and any short-term mismatch starves
    // it - a stall reads as a freeze followed by a jump, where MJPEG (no clock at all) just
    // shows an uneven frame. measured delivery jitter peaks around 30ms, so this is roughly
    // three worst-case gaps of slack; raising it trades latency for tolerance
    static TARGET_LATENCY_S = 0.1;

    // how much buffered history is kept behind the current position
    static KEEP_BEHIND_S = 2;

    // pruning old buffer is only worth doing this often, not on every single decoded frame
    static PRUNE_INTERVAL_S = 1;

    constructor(spsNal, ppsNal, onframe, onerror) {
        this.onerror = onerror;
        this.onframe = onframe;
        this.sequence = 1;
        this.mediaTimeTicks = 0;
        this.lastDecodeAt = null;
        this.queue = Promise.resolve();
        this.lastPruneAt = 0;

        const codec = 'avc1.' + [spsNal[1], spsNal[2], spsNal[3]]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
        const mime = `video/mp4; codecs="${codec}"`;
        if (!MediaSource.isTypeSupported(mime)) {
            throw new Error(`unsupported codec: ${codec}`);
        }

        // played, but never attached to the document - the canvas stays the one visible
        // surface for both decode paths, so app.js never has to know which one is active
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.addEventListener('error', () => {
            this.onerror(this.video.error || new Error('video element error'));
        });

        this.mediaSource = new MediaSource();
        this.objectUrl = URL.createObjectURL(this.mediaSource);
        this.video.src = this.objectUrl;

        this.mediaSource.addEventListener('sourceopen', () => {
            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
                this.sourceBuffer.mode = 'segments';
                this.append(Mp4Mux.initSegment(spsNal, ppsNal, 1920, 1080, MseSink.TIMESCALE));
            } catch (error) {
                this.onerror(error);
            }
        }, { once: true });

        this.drawLoop();
    }

    // appendBuffer and remove are serialized behind the same queue since a SourceBuffer only
    // allows one update at a time - either kind - and throws if either is called while the
    // other is still in flight
    enqueue(operation) {
        this.queue = this.queue.then(operation).catch((error) => this.onerror(error));
    }

    settle(action) {
        return new Promise((resolve, reject) => {
            const sb = this.sourceBuffer;
            const onUpdateEnd = () => {
                sb.removeEventListener('error', onError);
                resolve();
            };
            const onError = () => {
                sb.removeEventListener('updateend', onUpdateEnd);
                reject(new Error('SourceBuffer operation failed'));
            };
            sb.addEventListener('updateend', onUpdateEnd, { once: true });
            sb.addEventListener('error', onError, { once: true });
            action(sb);
        });
    }

    append(data) {
        this.enqueue(() => this.settle((sb) => sb.appendBuffer(data)));
    }

    decode(nals, key) {
        if (!this.sourceBuffer) {
            return;
        }

        // the source carries no timestamps, so the gap since the last frame is the only
        // signal for how long this one should play - matching it to spice2x's actual
        // delivery rate keeps the buffered edge from drifting away from playback, which a
        // fixed nominal duration did whenever the real rate wasn't exactly what was assumed
        const now = performance.now();
        const elapsedS = this.lastDecodeAt === null
                ? MseSink.NOMINAL_DURATION / MseSink.TIMESCALE
                : Math.min((now - this.lastDecodeAt) / 1000, MseSink.MAX_DURATION_S);
        this.lastDecodeAt = now;
        const durationTicks = Math.max(1, Math.round(elapsedS * MseSink.TIMESCALE));

        this.append(Mp4Mux.fragment(nals, this.sequence, this.mediaTimeTicks, durationTicks, key));
        this.mediaTimeTicks += durationTicks;
        this.sequence++;

        // starting the moment a single frame is decodable leaves nothing in hand, so the
        // first hiccup stalls it; wait for the cushion to fill first
        if (this.video.paused && this.video.readyState >= 2 && this.buffered_ahead() >= MseSink.TARGET_LATENCY_S) {
            this.video.play().catch(() => {});
        }

        this.maybeCatchUp();
    }

    buffered_ahead() {
        const buffered = this.video.buffered;
        if (buffered.length === 0) {
            return 0;
        }

        return buffered.end(buffered.length - 1) - this.video.currentTime;
    }

    // a <video> plays at 1x from wherever it started; without this, a slow start or a brief
    // stall would leave it forever behind live instead of just skipping the gap
    maybeCatchUp() {
        const buffered = this.video.buffered;
        if (buffered.length === 0) {
            return;
        }

        const end = buffered.end(buffered.length - 1);
        if (end - this.video.currentTime > MseSink.MAX_LATENCY_S) {
            // landing right on the live edge would starve the clock again immediately
            this.video.currentTime = end - MseSink.TARGET_LATENCY_S;
        }

        const keepFrom = end - MseSink.KEEP_BEHIND_S;
        if (keepFrom > 0.1 && end - this.lastPruneAt > MseSink.PRUNE_INTERVAL_S) {
            this.lastPruneAt = end;
            this.enqueue(() => this.settle((sb) => sb.remove(0, keepFrom)));
        }
    }

    // rVFC (Chrome 83+, Safari 15.4+) paces draws to actual decoded frames instead of the
    // display refresh rate; where it is missing, rAF polling is a close enough fallback
    drawLoop() {
        const draw = () => {
            if (!this.video) {
                return;
            }
            if (this.video.videoWidth) {
                this.onframe(this.video);
            }
            if (typeof this.video.requestVideoFrameCallback === 'function') {
                this.video.requestVideoFrameCallback(draw);
            } else {
                requestAnimationFrame(draw);
            }
        };
        if (typeof this.video.requestVideoFrameCallback === 'function') {
            this.video.requestVideoFrameCallback(draw);
        } else {
            requestAnimationFrame(draw);
        }
    }

    close() {
        const video = this.video;
        this.video = null;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
                this.mediaSource.endOfStream();
            } catch (error) {
                // already closing, nothing to undo
            }
        }
        this.sourceBuffer = null;
        URL.revokeObjectURL(this.objectUrl);
    }
}

class H264Stream {

    // a NAL that never ends would otherwise grow without bound
    static PENDING_LIMIT = 4 * 1024 * 1024;

    static get webCodecSupported() {
        return typeof VideoDecoder !== 'undefined' && typeof AbortController !== 'undefined';
    }

    static get mseSupported() {
        return typeof AbortController !== 'undefined' && MseSink.supported();
    }

    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');

        this.controller = null;
        this.sink = null;
        this.mode = null;
        this.sps = null;
        this.pps = null;
        this.pending = new Uint8Array(0);
        this.unit = [];

        // called on the first decoded frame, on every frame, and on any failure
        this.onframe = () => {};
        this.onerror = () => {};
    }

    async start(url, mode) {
        this.stop();
        this.mode = mode;

        const controller = new AbortController();
        this.controller = controller;

        try {
            const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });

            if (!response.ok) {
                this.fail(new Error(String(response.status)), response.status);
                return;
            }
            if (!response.body) {
                this.fail(new Error('no stream body'));
                return;
            }

            const reader = response.body.getReader();
            for (;;) {
                const { value, done } = await reader.read();
                if (this.controller !== controller) {
                    return;
                }
                if (done) {
                    this.fail(new Error('stream ended'));
                    return;
                }
                this.consume(value);
            }
        } catch (error) {
            // an abort is us, and never a failure worth reporting
            if (this.controller === controller) {
                this.fail(error);
            }
        }
    }

    stop() {
        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }

        if (this.sink) {
            this.sink.close();
            this.sink = null;
        }

        this.sps = null;
        this.pps = null;
        this.pending = new Uint8Array(0);
        this.unit = [];
    }

    fail(error, status) {
        const controller = this.controller;
        this.stop();
        if (controller) {
            this.onerror(error, status);
        }
    }

    static startCode(data, i) {
        if (data[i] !== 0 || data[i + 1] !== 0) {
            return 0;
        }
        if (data[i + 2] === 1) {
            return 3;
        }
        return data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    }

    consume(chunk) {
        const merged = new Uint8Array(this.pending.length + chunk.length);
        merged.set(this.pending);
        merged.set(chunk, this.pending.length);

        const marks = [];
        for (let i = 0; i + 3 < merged.length; i++) {
            const size = H264Stream.startCode(merged, i);
            if (size > 0) {
                marks.push({ begin: i, payload: i + size });
                i += size - 1;
            }
        }

        // a NAL runs to the start code of the next one, so the last is still arriving
        for (let m = 0; m + 1 < marks.length; m++) {
            this.push(merged.subarray(marks[m].payload, marks[m + 1].begin));
        }

        this.pending = marks.length > 0
                ? merged.subarray(marks[marks.length - 1].begin)
                : merged;

        if (this.pending.length > H264Stream.PENDING_LIMIT) {
            this.fail(new Error('h264 buffer overflow'));
        }
    }

    push(nal) {
        if (nal.length === 0) {
            return;
        }

        const type = nal[0] & 0x1f;

        if (type === 7) {
            this.sps = nal;
        } else if (type === 8) {
            this.pps = nal;
        }

        // WebCodecs only needs the SPS up front (PPS travels inline with each decoded chunk);
        // the MSE muxer needs both up front to build the init segment's avcC box
        if (!this.sink && this.sps && (this.mode === 'mse' ? this.pps : true)) {
            this.configure();
        }

        if (!this.sink) {
            return;
        }

        this.unit.push(nal);

        // x264 emits one slice per picture here, so a VCL NAL always closes the access unit
        // that any parameter sets ahead of it belong to
        if (type === 1 || type === 5) {
            this.emit(type === 5);
        }
    }

    configure() {
        const onframe = (frame) => this.draw(frame);
        const onerror = (error) => this.fail(error);

        try {
            this.sink = this.mode === 'mse'
                    ? new MseSink(this.sps, this.pps, onframe, onerror)
                    : new WebCodecsSink(this.sps, onframe, onerror);
        } catch (error) {
            this.sink = null;
            this.fail(error);
        }
    }

    emit(key) {
        const nals = this.unit;
        this.unit = [];
        this.sink.decode(nals, key);
    }

    // frame is a WebCodecs VideoFrame (has displayWidth/displayHeight, needs close()) or a
    // <video> element (has videoWidth/videoHeight) from the MSE sink - drawImage() and the
    // canvas resize both work the same way for either
    draw(frame) {
        const width = frame.displayWidth || frame.videoWidth;
        const height = frame.displayHeight || frame.videoHeight;

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        this.context.drawImage(frame, 0, 0);
        if (typeof frame.close === 'function') {
            frame.close();
        }

        this.onframe();
    }
}
