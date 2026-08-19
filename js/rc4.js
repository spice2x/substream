'use strict';

// RC4 as spice2x uses it: one keystream per connection, shared by both directions,
// keyed with the raw bytes of the API password.
class RC4 {

    constructor(key) {
        this.s = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            this.s[i] = i;
        }

        if (key.length > 0) {
            let j = 0;
            for (let i = 0; i < 256; i++) {
                j = (j + this.s[i] + key[i % key.length]) & 0xff;
                const tmp = this.s[i];
                this.s[i] = this.s[j];
                this.s[j] = tmp;
            }
        }

        this.a = 0;
        this.b = 0;
    }

    crypt(data) {
        for (let pos = 0; pos < data.length; pos++) {
            this.a = (this.a + 1) & 0xff;
            this.b = (this.b + this.s[this.a]) & 0xff;

            const tmp = this.s[this.a];
            this.s[this.a] = this.s[this.b];
            this.s[this.b] = tmp;

            data[pos] ^= this.s[(this.s[this.a] + this.s[this.b]) & 0xff];
        }
        return data;
    }
}
