function subtleCryptoResult(promiseOrOp) {
    if (promiseOrOp instanceof Promise) {
        return promiseOrOp;
    } else {
        return new Promise((resolve, reject) => {
            promiseOrOp.oncomplete = e => resolve(e.target.result);
            promiseOrOp.onerror = e => reject(e);
        });
    }
}

class CryptoHMACDriver {
    constructor(subtleCrypto) {
        this._subtleCrypto = subtleCrypto;
    }
    /**
     * [hmac description]
     * @param  {BufferSource} key
     * @param  {BufferSource} mac
     * @param  {BufferSource} data
     * @param  {HashName} hash
     * @return {boolean}
     */
    async verify(key, mac, data, hash) {
        const hmacKey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            {
                name: 'HMAC',
                hash: {name: hashName(hash)},
            },
            false,
            ['verify'],
        ));
        const isVerified = await subtleCryptoResult(this._subtleCrypto.verify(
            {name: "HMAC"},
            hmacKey,
            mac,
            data,
        ));
        return isVerified;
    }

    async compute(key, data, hash) {
        const hmacKey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            {
                name: 'HMAC',
                hash: {name: hashName(hash)},
            },
            false,
            ['sign'],
        ));
        const buffer = await subtleCryptoResult(this._subtleCrypto.sign(
            {name: "HMAC"},
            hmacKey,
            data,
        ));
        return new Uint8Array(buffer);
    }
}

const nwbo = (num, len) => {
  const arr = new Uint8Array(len);
  for(let i=0; i<len; i++) arr[i] = 0xFF && (num >> ((len - i - 1)*8));
  return arr;
};

class CryptoLegacyDeriveDriver {
    constructor(cryptoDriver) {
        this._cryptoDriver = cryptoDriver;
    }

    async pbkdf2(password, iterations, salt, hash, length) {
        const dkLen = length / 8;
        if (iterations <= 0) {
            throw new Error('InvalidIterationCount');
        }
        if (dkLen <= 0) {
            throw new Error('InvalidDerivedKeyLength');
        }
        const hLen = this._cryptoDriver.digestSize(hash);
        if(dkLen > (Math.pow(2, 32) - 1) * hLen) throw new Error('DerivedKeyTooLong');

        const l = Math.ceil(dkLen/hLen);
        const r = dkLen - (l-1)*hLen;

        const funcF = async (i) => {
            const seed = new Uint8Array(salt.length + 4);
            seed.set(salt);
            seed.set(nwbo(i+1, 4), salt.length);
            let u = await this._cryptoDriver.hmac.compute(password, seed, hash);
            let outputF = new Uint8Array(u);
            for(let j = 1; j < iterations; j++){
                if ((j % 1000) === 0) {
                    console.log(j, j/iterations);
                }
                u = await this._cryptoDriver.hmac.compute(password, u, hash);
                outputF = u.map( (elem, idx) => elem ^ outputF[idx]);
            }
            return {index: i, value: outputF};
        };

        const Tis = [];
        const DK = new Uint8Array(dkLen);
        for(let i = 0; i < l; i++) {
            Tis.push(funcF(i));
        }
        const TisResolved = await Promise.all(Tis);
        TisResolved.forEach(elem => {
            if (elem.index !== l - 1) {
                DK.set(elem.value, elem.index*hLen);
            }
            else {
                DK.set(elem.value.slice(0, r), elem.index*hLen);
            }
        });

        return DK;
    }

    // based on https://github.com/junkurihara/jscu/blob/develop/packages/js-crypto-hkdf/src/hkdf.ts
    async hkdf(key, salt, info, hash, length) {
        length = length / 8;
        const len = this._cryptoDriver.digestSize(hash);

        // RFC5869 Step 1 (Extract)
        const prk = await this._cryptoDriver.hmac.compute(salt, key, hash);

        // RFC5869 Step 2 (Expand)
        let t = new Uint8Array([]);
        const okm = new Uint8Array(Math.ceil(length / len) * len);
        for(let i = 0; i < Math.ceil(length / len); i++){
            const concat = new Uint8Array(t.length + info.length + 1);
            concat.set(t);
            concat.set(info, t.length);
            concat.set(new Uint8Array([i+1]), t.length + info.length);
            t = await this._cryptoDriver.hmac.compute(prk, concat, hash);
            okm.set(t, len * i);
        }
        return okm.slice(0, length);
    }
}

class CryptoDeriveDriver {
    constructor(subtleCrypto) {
        this._subtleCrypto = subtleCrypto;
    }
    /**
     * [pbkdf2 description]
     * @param  {BufferSource} password
     * @param  {Number} iterations
     * @param  {BufferSource} salt
     * @param  {HashName} hash
     * @param  {Number} length  the desired length of the generated key, in bits (not bytes!)
     * @return {BufferSource}
     */
    async pbkdf2(password, iterations, salt, hash, length) {
        const key = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            password,
            {name: 'PBKDF2'},
            false,
            ['deriveBits'],
        ));
        const keybits = await subtleCryptoResult(this._subtleCrypto.deriveBits(
            {
                name: 'PBKDF2',
                salt,
                iterations,
                hash: hashName(hash),
            },
            key,
            length,
        ));
        return new Uint8Array(keybits);
    }

    /**
     * [hkdf description]
     * @param  {BufferSource} key    [description]
     * @param  {BufferSource} salt   [description]
     * @param  {BufferSource} info   [description]
     * @param  {HashName} hash the hash to use
     * @param  {Number} length desired length of the generated key in bits (not bytes!)
     * @return {[type]}        [description]
     */
    async hkdf(key, salt, info, hash, length) {
        const hkdfkey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            {name: "HKDF"},
            false,
            ["deriveBits"],
        ));
        const keybits = await subtleCryptoResult(this._subtleCrypto.deriveBits({
                name: "HKDF",
                salt,
                info,
                hash: hashName(hash),
            },
            hkdfkey,
            length,
        ));
        return new Uint8Array(keybits);
    }
}

class CryptoAESDriver {
    constructor(subtleCrypto) {
        this._subtleCrypto = subtleCrypto;
    }
    /**
     * [decrypt description]
     * @param  {BufferSource} key        [description]
     * @param  {BufferSource} iv         [description]
     * @param  {BufferSource} ciphertext [description]
     * @return {BufferSource}            [description]
     */
    async decrypt(key, iv, ciphertext) {
        const aesKey = await subtleCryptoResult(this._subtleCrypto.importKey(
            'raw',
            key,
            {name: 'AES-CTR'},
            false,
            ['decrypt'],
        ));
        const plaintext = await subtleCryptoResult(this._subtleCrypto.decrypt(
            // see https://developer.mozilla.org/en-US/docs/Web/API/AesCtrParams
            {
                name: "AES-CTR",
                counter: iv,
                length: 64,
            },
            aesKey,
            ciphertext,
        ));
        return new Uint8Array(plaintext);
    }
}

function hashName(name) {
    if (name !== "SHA-256" && name !== "SHA-512") {
        throw new Error(`Invalid hash name: ${name}`);
    }
    return name;
}

export class CryptoDriver {
    constructor(subtleCrypto) {
        this.aes = new CryptoAESDriver(subtleCrypto);
        //this.derive = new CryptoDeriveDriver(subtleCrypto);
        this.derive = new CryptoLegacyDeriveDriver(this);
        // subtleCrypto.deriveBits ?
        //     new CryptoDeriveDriver(subtleCrypto) :
        //     new CryptoLegacyDeriveDriver(this);
        this.hmac = new CryptoHMACDriver(subtleCrypto);
        this._subtleCrypto = subtleCrypto;
    }

    /**
     * [digest description]
     * @param  {HashName} hash
     * @param  {BufferSource} data
     * @return {BufferSource}
     */
    async digest(hash, data) {
        return await subtleCryptoResult(this._subtleCrypto.digest(hashName(hash), data));
    }

    digestSize(hash) {
        switch (hashName(hash)) {
            case "SHA-512": return 64;
            case "SHA-256": return 32;
            default: throw new Error(`Not implemented for ${hashName(hash)}`);
        }
    }
}

function decodeBase64(base64) {
    const binStr = window.atob(base64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
}

const DEFAULT_ITERATIONS = 500000;

const DEFAULT_BITSIZE = 256;

export async function deriveSSSSKey(cryptoDriver, passphrase, ssssKey) {
    const textEncoder = new TextEncoder();
    return await cryptoDriver.derive.pbkdf2(
        textEncoder.encode(passphrase),
        ssssKey.content.passphrase.iterations || DEFAULT_ITERATIONS,
        textEncoder.encode(ssssKey.content.passphrase.salt),
        "SHA-512",
        ssssKey.content.passphrase.bits || DEFAULT_BITSIZE);
}

export async function decryptSecret(cryptoDriver, keyId, ssssKey, event) {
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    // now derive the aes and mac key from the 4s key
    const hkdfKey = await cryptoDriver.derive.hkdf(
        ssssKey,
        new Uint8Array(8).buffer,   //salt
        textEncoder.encode(event.type), // info
        "SHA-256",
        512 // 512 bits or 64 bytes
    );
    const aesKey = hkdfKey.slice(0, 32);
    const hmacKey = hkdfKey.slice(32);

    const data = event.content.encrypted[keyId];

    const ciphertextBytes = decodeBase64(data.ciphertext);
    const isVerified = await cryptoDriver.hmac.verify(
        hmacKey, decodeBase64(data.mac),
        ciphertextBytes, "SHA-256");

    if (!isVerified) {
        throw new Error("Bad MAC");
    }

    const plaintext = await cryptoDriver.aes.decrypt(aesKey, decodeBase64(data.iv), ciphertextBytes);
    return textDecoder.decode(new Uint8Array(plaintext));
}


export async function decryptSession(backupKeyBase64, backupInfo, sessionResponse) {
    const privKey = decodeBase64(backupKeyBase64);

    const decryption = new window.Olm.PkDecryption();
    let backupPubKey;
    try {
        backupPubKey = decryption.init_with_private_key(privKey);
    } catch (e) {
        decryption.free();
        throw e;
    }

    // If the pubkey computed from the private data we've been given
    // doesn't match the one in the auth_data, the user has enetered
    // a different recovery key / the wrong passphrase.
    if (backupPubKey !== backupInfo.auth_data.public_key) {
        console.log({backupPubKey})
        throw new Error("bad backup key");
    }

    const sessionInfo = decryption.decrypt(
        sessionResponse.session_data.ephemeral,
        sessionResponse.session_data.mac,
        sessionResponse.session_data.ciphertext,
    );
    return JSON.parse(sessionInfo);
}