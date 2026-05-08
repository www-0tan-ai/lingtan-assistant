/**
 * Lingtan Assistant — symmetric-crypto helpers shared between
 * the build-time seed encryptor and the runtime decryptor.
 *
 * SECURITY MODEL — read this before changing anything.
 *
 * The packaged secrets are encrypted with a key derived from a
 * passphrase that is *itself shipped inside the app binary*.  This is
 * obfuscation, not real cryptography — anyone determined enough can
 * extract the passphrase from main.js (or this file) and decrypt.
 *
 * What this DOES buy us:
 *   - The .asar / extraResources binary contents are not human-readable.
 *   - A casual user opening the install dir cannot grep an API key.
 *   - The plaintext key never touches the filesystem at runtime;
 *     it only lives in the env block of the Python child process.
 *
 * What it does NOT buy us:
 *   - Protection against a motivated reverse-engineer.  Treat any
 *     credential bundled this way as already-leaked for security
 *     accounting purposes (rotate-on-public-release, set quotas, etc.).
 *
 * Format for `encrypt(plaintext) -> Buffer`:
 *   [magic:4 = "LSE1"]   "Lingtan Secrets v1"
 *   [salt:16]            random per-bundle (different on every build)
 *   [iv:12]              random AES-GCM nonce
 *   [tag:16]             AES-GCM authentication tag
 *   [ciphertext:N]       AES-256-GCM encrypted payload
 */

'use strict';

const crypto = require('crypto');

const MAGIC = Buffer.from('LSE1', 'ascii'); // 4 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// Passphrase is split on purpose; concatenation happens at runtime so a
// naive `strings | grep` over the binary cannot pull the literal out.
// This is *minor* obfuscation — not security.  See module header.
function _passphrase() {
  const a = 'lingt';
  const b = 'an-as';
  const c = 'sistant-';
  const d = 'L3-';
  const e = '2026.05';
  const f = '-secrets';
  return a + b + c + d + e + f;
}

function _deriveKey(salt) {
  // scrypt is intentionally slow; cost factors here are deliberately
  // modest because we only run this once per process startup.
  return crypto.scryptSync(_passphrase(), salt, KEY_LEN, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(plaintext) {
  const buf = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(String(plaintext), 'utf8');

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = _deriveKey(salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, iv, tag, ct]);
}

function decrypt(blob) {
  if (!Buffer.isBuffer(blob)) blob = Buffer.from(blob);

  const magic = blob.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('crypto-utils: bad magic — not a Lingtan secrets bundle');
  }

  let off = 4;
  const salt = blob.subarray(off, off + SALT_LEN); off += SALT_LEN;
  const iv = blob.subarray(off, off + IV_LEN);     off += IV_LEN;
  const tag = blob.subarray(off, off + TAG_LEN);   off += TAG_LEN;
  const ct = blob.subarray(off);

  const key = _deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

module.exports = { encrypt, decrypt, sha256Hex };
