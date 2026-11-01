'use strict';

const assert = require('assert');
const ESnap = require('../ESnap.js');

const chunks = [
  ESnap.jsonChunk('META', { machineId: 'ondra-spo186' }, { flags: ESnap.ChunkFlags.REQUIRED }),
  ESnap.rawChunk('RAM ', new Uint8Array([0, 1, 2, 255]), { flags: ESnap.ChunkFlags.REQUIRED })
];

const encoded = ESnap.encode(chunks);
const decoded = ESnap.decode(encoded);
assert.strictEqual(decoded.versionMajor, 1);
assert.deepStrictEqual(ESnap.parseJsonChunk(ESnap.findChunk(decoded, 'META')), { machineId: 'ondra-spo186' });
assert.deepStrictEqual(Array.from(ESnap.findChunk(decoded, 'RAM ').data), [0, 1, 2, 255]);

const damaged = encoded.slice(0);
new Uint8Array(damaged)[new Uint8Array(damaged).length - 1] ^= 0x80;
assert.throws(() => ESnap.decode(damaged), /Kontrolní součet/);

const truncated = encoded.slice(0, encoded.byteLength - 1);
assert.throws(() => ESnap.decode(truncated), /neúplný|neplatný/);

console.log('ESNAP container tests: OK');
