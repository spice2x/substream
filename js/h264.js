'use strict';

// Drives spice2x's /stream.h264: a bare annex-b elementary stream, no container and no
// timestamps. Every frame is drawn the moment it decodes - anything that schedules against a
// presentation clock puts the latency straight back, which is the whole point of this path.
class H264Stream {

    // a NAL that never ends would otherwise grow without bound
    static PENDING_LIMIT = 4 * 1024 * 1024;

    // how many frames may be queued before the decoder is considered to have fallen behind
    static QUEUE_LIMIT = 8;

    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');

        this.controller = null;
        this.decoder = null;
        this.pending = new Uint8Array(0);
        this.unit = [];
        this.frames = 0;
        this.resyncing = false;

        // called on the first decoded frame, on every frame, and on any failure
        this.onframe = () => {};
        this.onerror = () => {};
    }

    async start(url) {
        this.stop();

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

        if (this.decoder) {
            try {
                this.decoder.close();
            } catch (error) {
                // already closed by an error callback, nothing to undo
            }
            this.decoder = null;
        }

        this.pending = new Uint8Array(0);
        this.unit = [];
        this.frames = 0;
        this.resyncing = false;
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

        if (type === 7 && !this.decoder) {
            this.configure(nal);
        }

        if (!this.decoder) {
            return;
        }

        this.unit.push(nal);

        // x264 emits one slice per picture here, so a VCL NAL always closes the access unit
        // that any parameter sets ahead of it belong to
        if (type === 1 || type === 5) {
            this.emit(type === 5);
        }
    }

    configure(sps) {
        // avc1.PPCCLL read straight out of the SPS, so the level always matches the stream
        const codec = 'avc1.' + [sps[1], sps[2], sps[3]]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');

        try {
            this.decoder = new VideoDecoder({
                output: (frame) => this.draw(frame),
                error: (error) => this.fail(error),
            });
            this.decoder.configure({ codec, optimizeForLatency: true });
        } catch (error) {
            this.decoder = null;
            this.fail(error);
        }
    }

    emit(key) {
        // a decoder that has fallen behind would otherwise build a backlog, and every queued
        // frame is latency. drop until the next IDR, which repairs the picture cleanly.
        if (this.decoder.decodeQueueSize > H264Stream.QUEUE_LIMIT) {
            this.resyncing = true;
        }
        if (this.resyncing && !key) {
            this.unit = [];
            return;
        }
        this.resyncing = false;

        let size = 0;
        for (const nal of this.unit) {
            size += 4 + nal.length;
        }

        const data = new Uint8Array(size);
        let at = 0;
        for (const nal of this.unit) {
            data.set([0, 0, 0, 1], at);
            data.set(nal, at + 4);
            at += 4 + nal.length;
        }
        this.unit = [];

        try {
            this.decoder.decode(new EncodedVideoChunk({
                type: key ? 'key' : 'delta',

                // the stream carries no timestamps; this only has to increase
                timestamp: this.frames * 1000,
                data: data,
            }));
        } catch (error) {
            this.fail(error);
        }
    }

    draw(frame) {
        if (this.canvas.width !== frame.displayWidth
                || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        this.context.drawImage(frame, 0, 0);
        frame.close();

        this.frames++;
        this.onframe();
    }
}
