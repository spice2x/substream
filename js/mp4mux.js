'use strict';

// Minimal fragmented-MP4 (ISOBMFF) muxer for a single H.264 (AVC) video track, built by hand:
// MediaSource needs a real container - it rejects the bare Annex-B that spice2x sends and that
// VideoDecoder happily eats raw - and no muxer library is worth pulling in for one codec on one
// track. Produces a single init segment (ftyp+moov) plus one moof+mdat fragment per access unit.
const Mp4Mux = (() => {
    function u8(...bytes) { return new Uint8Array(bytes); }
    function u16(n) { return new Uint8Array([(n >> 8) & 0xff, n & 0xff]); }
    function u32(n) {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, n >>> 0);
        return out;
    }
    function u64(n) {
        const out = new Uint8Array(8);
        const view = new DataView(out.buffer);
        view.setUint32(0, Math.floor(n / 4294967296));
        view.setUint32(4, n >>> 0);
        return out;
    }
    function str(s) { return new TextEncoder().encode(s); }

    function concat(...parts) {
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }

    function box(type, ...parts) {
        const content = concat(...parts);
        return concat(u32(content.length + 8), str(type), content);
    }

    function fullBox(type, version, flags, ...parts) {
        return box(type, u8(version), u8((flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
    }

    // AVCDecoderConfigurationRecord - profile/level read straight from the SPS so it always
    // matches the stream, one SPS/PPS each since that is all x264 ever emits here
    function avcC(sps, pps) {
        return box('avcC',
                u8(1, sps[1], sps[2], sps[3], 0xff, 0xe1),
                u16(sps.length), sps,
                u8(1),
                u16(pps.length), pps);
    }

    function avc1(width, height, avcCBox) {
        return box('avc1',
                new Uint8Array(6), u16(1),              // reserved, data_reference_index
                u16(0), u16(0), new Uint8Array(12),      // pre_defined / reserved
                u16(width), u16(height),
                u32(0x00480000), u32(0x00480000),        // h/v resolution, 72dpi
                u32(0), u16(1),                          // reserved, frame_count
                new Uint8Array(32),                      // compressorname (empty pascal string)
                u16(0x0018), u16(0xffff),                 // depth, pre_defined = -1
                avcCBox);
    }

    function stsd(avc1Box) { return fullBox('stsd', 0, 0, u32(1), avc1Box); }
    function stts() { return fullBox('stts', 0, 0, u32(0)); }
    function stsc() { return fullBox('stsc', 0, 0, u32(0)); }
    function stsz() { return fullBox('stsz', 0, 0, u32(0), u32(0)); }
    function stco() { return fullBox('stco', 0, 0, u32(0)); }
    function stbl(avc1Box) { return box('stbl', stsd(avc1Box), stts(), stsc(), stsz(), stco()); }
    function vmhd() { return fullBox('vmhd', 0, 1, u16(0), new Uint8Array(6)); }
    function dref() { return fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)); }
    function dinf() { return box('dinf', dref()); }
    function minf(avc1Box) { return box('minf', vmhd(), dinf(), stbl(avc1Box)); }

    // 0xd5c4 packs the 3-letter language code "und" (undetermined) into 15 bits, per spec
    function mdhd(timescale) {
        return fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0xd5c4), u16(0));
    }
    function hdlr() {
        return fullBox('hdlr', 0, 0, u32(0), str('vide'), new Uint8Array(12), str('VideoHandler\0'));
    }
    function mdia(timescale, avc1Box) { return box('mdia', mdhd(timescale), hdlr(), minf(avc1Box)); }

    function tkhd(width, height) {
        return fullBox('tkhd', 0, 7, // flags: track enabled | in movie | in preview
                u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(8),
                u16(0), u16(0), u16(0), u16(0),
                u32(0x00010000), u32(0), u32(0),         // unity transform matrix
                u32(0), u32(0x00010000), u32(0),
                u32(0), u32(0), u32(0x40000000),
                u32(width << 16), u32(height << 16));    // 16.16 fixed point
    }
    function trak(width, height, timescale, avc1Box) {
        return box('trak', tkhd(width, height), mdia(timescale, avc1Box));
    }

    function mvhd(timescale) {
        return fullBox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0),
                u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
                u32(0x00010000), u32(0), u32(0),
                u32(0), u32(0x00010000), u32(0),
                u32(0), u32(0), u32(0x40000000),
                new Uint8Array(24), u32(2));
    }
    function trex() { return fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)); }
    function mvex() { return box('mvex', trex()); }
    function moov(width, height, timescale, avc1Box) {
        return box('moov', mvhd(timescale), trak(width, height, timescale, avc1Box), mvex());
    }
    function ftyp() {
        return box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    }

    // one-time header: brand + an empty (sample-less) moov. The container's declared width/
    // height is only a formality - actual playback dimensions come from the decoded SPS.
    function initSegment(sps, pps, width, height, timescale) {
        return concat(ftyp(), moov(width, height, timescale, avc1(width, height, avcC(sps, pps))));
    }

    function tfhd() { return fullBox('tfhd', 0, 0x020000, u32(1)); } // default-base-is-moof
    function tfdt(baseMediaDecodeTime) { return fullBox('tfdt', 1, 0, u64(baseMediaDecodeTime)); }

    function trun(sampleSize, sampleDuration, sampleFlags, dataOffset) {
        return fullBox('trun', 0, 0x000001 | 0x000100 | 0x000200 | 0x000400, // data-offset/duration/size/flags present
                u32(1), u32(dataOffset), u32(sampleDuration), u32(sampleSize), u32(sampleFlags));
    }
    function traf(sampleSize, sampleDuration, sampleFlags, baseMediaDecodeTime, dataOffset) {
        return box('traf', tfhd(), tfdt(baseMediaDecodeTime), trun(sampleSize, sampleDuration, sampleFlags, dataOffset));
    }
    function mfhd(sequenceNumber) { return fullBox('mfhd', 0, 0, u32(sequenceNumber)); }

    function moof(sequenceNumber, sampleSize, sampleDuration, sampleFlags, baseMediaDecodeTime) {
        const mfhdBox = mfhd(sequenceNumber);
        // trun's data_offset is measured from the start of moof, which needs moof's own size
        // first - build traf once with a placeholder offset to measure it, then again for real
        const placeholder = traf(sampleSize, sampleDuration, sampleFlags, baseMediaDecodeTime, 0);
        const dataOffset = 8 + mfhdBox.length + placeholder.length + 8;
        return box('moof', mfhdBox, traf(sampleSize, sampleDuration, sampleFlags, baseMediaDecodeTime, dataOffset));
    }

    // ISOBMFF samples are length-prefixed (AVCC), not the Annex-B start codes the NALs arrived with
    function mdat(nals) {
        const parts = [];
        for (const nal of nals) {
            parts.push(u32(nal.length), nal);
        }
        return box('mdat', ...parts);
    }

    // sample_depends_on=2 / is_non_sync=0 for a keyframe, =1/1 for a delta frame (ISO 14496-12 8.8.3.1)
    function fragment(nals, sequenceNumber, baseMediaDecodeTime, durationTicks, keyframe) {
        const mdatBox = mdat(nals);
        const sampleSize = mdatBox.length - 8;
        const sampleFlags = keyframe ? 0x02000000 : 0x01010000;
        return concat(moof(sequenceNumber, sampleSize, durationTicks, sampleFlags, baseMediaDecodeTime), mdatBox);
    }

    return { initSegment, fragment };
})();
