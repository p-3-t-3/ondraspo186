'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ESnap = require('../ESnap.js');

const ondraSource = fs.readFileSync(path.join(__dirname, '..', 'ondra.js'), 'utf8');
const begin = ondraSource.indexOf('//  Snapshoty ESNAP 1.0');
const end = ondraSource.indexOf('//  UI helpers', begin);
assert(begin >= 0 && end > begin, 'Snapshot section not found in ondra.js');
const snapshotSource = ondraSource.slice(ondraSource.lastIndexOf('// ----------------------------------------------------------------------------', begin),
  ondraSource.lastIndexOf('// ----------------------------------------------------------------------------', end));

const initialCpuState = {
  a: 0x12, b: 0x34, c: 0x56, d: 0x78, e: 0x9A, h: 0xBC, l: 0xDE,
  a_prime: 1, b_prime: 2, c_prime: 3, d_prime: 4, e_prime: 5, h_prime: 6, l_prime: 7,
  ix: 0x1234, iy: 0x5678, sp: 0xD480, pc: 0x79A0, i: 0x22, r: 0x33,
  flags: { S: 1, Z: 0, Y: 1, H: 0, X: 1, P: 0, N: 1, C: 0 },
  flags_prime: { S: 0, Z: 1, Y: 0, H: 1, X: 0, P: 1, N: 0, C: 1 },
  imode: 1, iff1: 1, iff2: 1, halted: false,
  do_delayed_di: false, do_delayed_ei: true, cycle_counter: 0
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class FakeCpu {
  constructor() { this.state = clone(initialCpuState); }
  getState() { return clone(this.state); }
  setState(state) { this.state = clone(state); }
  reset() {}
}

const initialPsgState = {
  registers: [0x06B, 15, 0x055, 15, 1, 1, 7, 0],
  latchedRegister: 6,
  tonePhases: [0.125, 0.5, 0.999999], noisePhase: 0.333333,
  noiseShiftRegister: 0x1D575, writeCount: 4404, lastWrite: 0xE7
};

class FakePsg {
  constructor() { this.state = clone(initialPsgState); }
  getState() { return clone(this.state); }
  setState(state) { this.state = clone(state); }
}

const sandbox = {
  ESnap,
  window: { ESnap, SN76489: FakePsg, addEventListener() {} },
  SN76489: FakePsg,
  Z80: FakeCpu,
  TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer, BigInt,
  Number, Math, Set, Date, console,
  setTimeout(fn) { fn(); return 1; },
  setInterval() { return 1; },
  document: { getElementById() { return { classList: { add() {} } }; } },
  MEM_SIZE: 0x10000,
  mem: new Uint8Array(0x10000), rom: new Uint8Array(0x4000), romSize: 0x4000,
  cpu: new FakeCpu(), psg: new FakePsg(),
  port03: 3, port0A: 0x17, port09: 0xE7, melodikStb: 0,
  nRozliseni: 191, soundTone: 2, cassetteOut: 1,
  masterTstates: 123456789, totalFrames: 4567,
  paused: true, running: true, frameHandle: 1,
  FRAME_MS: 20,
  videoEnabled: true, mp1Enabled: true, ioEnabled: false, selected8253: 0,
  _audioTone: 0, _audioCas: 0, _audioFramePos: 0, frameTstates: 0,
  melodikBusyTimer: null, io: new Uint8Array(256),
  memBus: {}, wrapIORead() { return 0xFF; },
  initVideo() {}, initAudio() {}, _initAudioFrame() {}, rebuildDispAdr() {},
  updateLeds() {}, renderFrame() {}, updateDebug() {}, setStatus() {},
  keyDown() {}, keyUp() {}, keyFocusLost() {},
  emulatorFrame() {},
  tapeMotor: false, tapeStops: 0, stopTape() { sandbox.tapeStops++; },
  alert() {}
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(snapshotSource + '\nthis.snapshotApi = { createSnapshotBuffer, parseSnapshotBuffer, restoreSnapshotBuffer, encodeMachineState };', sandbox);

for (let i = 0; i < sandbox.mem.length; i++) sandbox.mem[i] = (i * 37 + 11) & 0xFF;
for (let i = 0; i < sandbox.rom.length; i++) sandbox.rom[i] = (i * 13 + 7) & 0xFF;

const savedCpu = sandbox.cpu.getState();
const savedRamCrc = ESnap.crc32(sandbox.mem);
const savedRomCrc = ESnap.crc32(sandbox.rom);
const savedMachine = Array.from(sandbox.snapshotApi.encodeMachineState());
const savedTime = { masterTstates: sandbox.masterTstates, totalFrames: sandbox.totalFrames };
const encoded = sandbox.snapshotApi.createSnapshotBuffer();
const container = ESnap.decode(encoded);
assert.deepStrictEqual(container.chunks.map(chunk => chunk.type),
  ['SYS ', 'META', 'TIME', 'CPU ', 'MACH', 'RAM ', 'ROM ', 'PSG ', 'EXEC']);
const cpuChunk = ESnap.findChunk(container, 'CPU ');
assert.strictEqual(String.fromCharCode(...cpuChunk.data.subarray(0, 4)), 'Z80 ');
assert.strictEqual(new DataView(cpuChunk.data.buffer, cpuChunk.data.byteOffset).getUint16(4, true), 1);
assert.strictEqual(ESnap.parseJsonChunk(ESnap.findChunk(container, 'META')).machineId, 'ondra-spo186');
const savedPsgBytes = Array.from(ESnap.findChunk(container, 'PSG ').data);

sandbox.mem.fill(0xA5);
sandbox.rom.fill(0x5A);
sandbox.cpu.state.pc = 0;
sandbox.port03 = 0;
sandbox.masterTstates = 1;
sandbox.psg.state.registers.fill(0);
sandbox.snapshotApi.restoreSnapshotBuffer(encoded);

assert.deepStrictEqual(sandbox.cpu.getState(), savedCpu);
assert.strictEqual(ESnap.crc32(sandbox.mem), savedRamCrc);
assert.strictEqual(ESnap.crc32(sandbox.rom), savedRomCrc);
assert.deepStrictEqual(Array.from(sandbox.snapshotApi.encodeMachineState()), savedMachine);
assert.deepStrictEqual({ masterTstates: sandbox.masterTstates, totalFrames: sandbox.totalFrames }, savedTime);
// ESNAP schéma 1 nemá stav pásky: obnovení kazetu zastaví, motor odpovídá portu 0Ah.
assert.strictEqual(sandbox.tapeStops, 1);
assert.strictEqual(sandbox.tapeMotor, true);
const afterRoundTrip = ESnap.decode(sandbox.snapshotApi.createSnapshotBuffer());
assert.deepStrictEqual(Array.from(ESnap.findChunk(afterRoundTrip, 'PSG ').data), savedPsgBytes);

// Fresh page path: no CPU, ROM or PSG exists before restore.
sandbox.cpu = null;
sandbox.psg = null;
sandbox.rom = new Uint8Array(0);
sandbox.romSize = 0;
sandbox.running = false;
sandbox.frameHandle = null;
sandbox.snapshotApi.restoreSnapshotBuffer(encoded);
assert(sandbox.cpu instanceof FakeCpu);
assert(sandbox.psg instanceof FakePsg);
assert.deepStrictEqual(sandbox.cpu.getState(), savedCpu);
assert.strictEqual(ESnap.crc32(sandbox.mem), savedRamCrc);
assert.strictEqual(ESnap.crc32(sandbox.rom), savedRomCrc);

// Damage is rejected before machine state changes.
const damaged = encoded.slice(0);
new Uint8Array(damaged)[new Uint8Array(damaged).length - 1] ^= 0x80;
const beforeRejectedLoad = ESnap.crc32(sandbox.mem);
assert.throws(() => sandbox.snapshotApi.restoreSnapshotBuffer(damaged), /Kontrolní součet/);
assert.strictEqual(ESnap.crc32(sandbox.mem), beforeRejectedLoad);

// The generic CPU chunk is accepted only when its architecture matches Ondra.
const foreignCpu = new Uint8Array(cpuChunk.data);
foreignCpu.set([0x38, 0x30, 0x38, 0x30], 0); // "8080"
const foreignCpuSnapshot = ESnap.encode(container.chunks.map(chunk => ({
  ...chunk,
  data: chunk.type === 'CPU ' ? foreignCpu : chunk.data
})));
assert.throws(() => sandbox.snapshotApi.parseSnapshotBuffer(foreignCpuSnapshot), /nepodporovaný procesor 8080/);

console.log('Ondra ESNAP integration round-trip: OK');
