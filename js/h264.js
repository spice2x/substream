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

    // The source stops for a second or more between loading screens, which nothing here can
    // play through. Capping the duration keeps that gap from being written into the timeline:
    // nothing was on screen during it, so the frame that ends it is an ordinary frame, not one
    // that held for the length of the gap.
    //
    // It also decides how much cushion survives a gap. The element drains its cushion and stalls
    // while the source is away, and the frame that ends the gap is the only chance to put any
    // back, so the cushion lands at roughly this value and stays there. At 0.05 that was a third
    // of the target, measured before and after a gap in the same run: 0.15 down to 0.03, never
    // recovering, leaving less margin than the delivery jitter it has to absorb.
    //
    // Self limiting rather than cumulative: a gap sets the cushion to about this much, it cannot
    // go beyond it, and there is no longer a drift seek for an inflated timeline to trigger.
    static MAX_DURATION_S = 0.25;

    // How far behind live to sit deliberately. The stream carries no timestamps, so the
    // element's clock is reconstructed from arrival gaps and any short-term mismatch starves
    // it. Enough to cover the ~40ms delivery jitter several times over without adding latency
    // that is felt.
    static TARGET_LATENCY_S = 0.15;

    // How much buffered history is kept behind the current position. This has to stay well
    // clear of the keyframe interval, two seconds here: at exactly one interval the removal
    // boundary lands on the keyframe the frames being played still reference, and stripping it
    // leaves them undecodable. That killed playback within a couple of seconds of every start,
    // reliably, and moving the boundary several keyframes back fixed it.
    //
    // Three intervals of margin rather than more, because this is all held as encoded video: at
    // the ~4MB/s this stream runs at, every second kept is a megabyte a phone has to find, and
    // overrunning the browser's buffer quota fails the append outright rather than degrading.
    static KEEP_BEHIND_S = 6;

    // pruning old buffer is only worth doing this often, not on every single decoded frame
    static PRUNE_INTERVAL_S = 1;

    constructor(spsNal, ppsNal, size, onframe, onerror) {
        // the track header fixes the picture size for the whole stream, and the browser
        // scales the decoded frames into it, so a wrong guess here is a permanently
        // distorted image rather than something the decoder can correct later
        if (!size || !size.width || !size.height) {
            throw new Error('stream size unknown');
        }

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
                this.append(Mp4Mux.initSegment(
                        spsNal, ppsNal, size.width, size.height, MseSink.TIMESCALE));
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

        this.prune();
    }

    buffered_ahead() {
        const buffered = this.video.buffered;
        if (buffered.length === 0) {
            return 0;
        }

        return buffered.end(buffered.length - 1) - this.video.currentTime;
    }

    prune() {
        const buffered = this.video.buffered;
        if (buffered.length === 0) {
            return;
        }

        const end = buffered.end(buffered.length - 1);
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
        this.size = null;
        this.sps = null;
        this.pps = null;
        this.pending = new Uint8Array(0);
        this.headSize = 0;
        this.scanned = 0;
        this.unit = [];
        this.unitHasVcl = false;
        this.unitIsKey = false;

        // called on the first decoded frame, on every frame, and on any failure
        this.onframe = () => {};
        this.onerror = () => {};
    }

    async start(url, mode, size) {
        this.stop();
        this.mode = mode;
        this.size = size;

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
        this.headSize = 0;
        this.scanned = 0;
        this.unit = [];
        this.unitHasVcl = false;
        this.unitIsKey = false;
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

    // Whether a NAL is the first of a new access unit, from the bitstream itself rather than
    // from how many slices a picture is expected to arrive in. A picture may be split into any
    // number of slices, and assuming it was always one is what this used to get wrong.
    static startsAccessUnit(header, first) {
        const type = header & 0x1f;

        // parameter sets and delimiters lead the access unit they describe
        if (type !== 1 && type !== 5) {
            return true;
        }

        // first_mb_in_slice leads the slice header as an exp-Golomb value, where a leading set
        // bit is how zero is written. only the slice covering the top left macroblock opens a
        // picture; the rest continue one already open
        return (first & 0x80) !== 0;
    }

    consume(chunk) {
        const merged = new Uint8Array(this.pending.length + chunk.length);
        merged.set(this.pending);
        merged.set(chunk, this.pending.length);

        const marks = [];

        // the start code at the head was found on an earlier pass; looking for it again would
        // mean rescanning the whole buffer, which is the thing being avoided here
        if (this.headSize > 0) {
            marks.push({ begin: 0, payload: this.headSize });
        }

        // Only what just arrived needs examining, plus a few bytes before it in case a start
        // code straddles the join. Rescanning from the beginning made each chunk of a frame
        // cost more than the one before it, so a large keyframe spread over many chunks cost
        // far more than its size suggests, once every keyframe interval.
        for (let i = Math.max(this.headSize, this.scanned - 3); i + 3 < merged.length; i++) {
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

        if (marks.length > 0) {
            const last = marks[marks.length - 1];
            this.pending = merged.subarray(last.begin);
            this.headSize = last.payload - last.begin;
        } else {
            this.pending = merged;
            this.headSize = 0;
        }

        this.scanned = this.pending.length;

        this.closeUnitIfNextBegan();

        if (this.pending.length > H264Stream.PENDING_LIMIT) {
            this.fail(new Error('h264 buffer overflow'));
        }
    }

    // The header of the NAL still arriving is enough to tell that the buffered picture is
    // complete, so it goes to the decoder now rather than waiting a whole frame for that NAL
    // to finish.
    closeUnitIfNextBegan() {
        if (!this.unitHasVcl) {
            return;
        }

        const size = H264Stream.startCode(this.pending, 0);
        if (size === 0 || this.pending.length < size + 2) {
            return;
        }

        if (H264Stream.startsAccessUnit(this.pending[size], this.pending[size + 1])) {
            this.emit();
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

        // the previous picture is finished once a NAL belonging to the next one turns up
        if (this.unitHasVcl && H264Stream.startsAccessUnit(nal[0], nal.length > 1 ? nal[1] : 0)) {
            this.emit();
        }

        this.unit.push(nal);

        if (type === 1 || type === 5) {
            this.unitHasVcl = true;
            if (type === 5) {
                this.unitIsKey = true;
            }
        }
    }

    configure() {
        const onframe = (frame) => this.draw(frame);
        const onerror = (error) => this.fail(error);

        try {
            this.sink = this.mode === 'mse'
                    ? new MseSink(this.sps, this.pps, this.size, onframe, onerror)
                    : new WebCodecsSink(this.sps, onframe, onerror);
        } catch (error) {
            this.sink = null;
            this.fail(error);
        }
    }

    emit() {
        const nals = this.unit;
        const key = this.unitIsKey;

        this.unit = [];
        this.unitHasVcl = false;
        this.unitIsKey = false;

        if (nals.length > 0) {
            this.sink.decode(nals, key);
        }
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
