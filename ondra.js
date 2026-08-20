'use strict';

// ============================================================================
//  ONDRA SPO 186 — Webový emulátor
//  RC1 candidate  |  2026
//
//  Architektura:
//    CPU:    Z80.js (DrGoldfire, MIT licence)
//    Video:  Canvas 320×256, interlace VRAM adresování
//    Zvuk:   AudioWorklet, T-stav přesné přepínání tónů (jako JOndra)
//    Vstup:  Memory-mapped klávesnice 0xE000–0xE009 (MP0=1)
//
//  Paměťová mapa:
//    0x0000–0x3FFF  ROM (MP1=0) nebo RAM (MP1=1)
//    0x4000–0xD7FF  RAM
//    0xD800–0xFFFF  VRAM (0x2800 = 10240 B)
//
//  Port 03h (dekódován A3=0):
//    bit 0  VEN   video DMA enable
//    bit 1  MP1   0=ROM v 0x0000-0x3FFF, 1=RAM
//    bit 2  MP0   0=RAM v 0xE000-0xFFFF, 1=vstupy
//    bit 3  K0    výstup na magnetofon (kazetový beeper)
//    bit 4  SA0   8253 A0
//    bit 5  SA1   8253 A1
//
//  Port 0Ah (dekódován A0=0):
//    bit 0  LED1  aktivní v nule
//    bit 1  LED2  aktivní v nule
//    bit 2  síť OUT
//    bit 3  /STB tiskárny
//    bit 4  relé magnetofonu
//    bits 5-7  M1-M3: číslo tónu 0-7 (0=ticho)
//
//  Port 09h (dekódován A1=0):
//    tiskárna / Melodik — Phase 2
// ============================================================================

// ----------------------------------------------------------------------------
//  Konstanty
// ----------------------------------------------------------------------------

const VRAM_START     = 0xD800;
const VRAM_SIZE      = 0x2800;   // 10240 B
const VID_COLS       = 40;       // sloupce (každý = 8 pixelů)
const VID_ROWS       = 256;      // řádky canvas (fixní)
const VID_WIDTH      = VID_COLS * 8;  // 320 pixelů

const CPU_HZ         = 2_000_000;     // Ondra SPO 186: 2 MHz
const FRAMES_PER_SEC = 50;
const FRAME_MS       = 1000 / FRAMES_PER_SEC;

// ----------------------------------------------------------------------------
//  Paměť
// ----------------------------------------------------------------------------

const MEM_SIZE = 0x10000;
let mem     = new Uint8Array(MEM_SIZE);  // RAM (nikdy neobsahuje ROM)
let rom     = new Uint8Array(0);         // ROM — samostatné pole
let romSize = 0;

// ----------------------------------------------------------------------------
//  Stavové proměnné portů a systému
// ----------------------------------------------------------------------------

let port03       = 0x00;
let port0A       = 0xFF;
let port09       = 0xFF;   // A1=0: Melodik data byte (SN76489) / tiskárna
let melodikStb   = 0;      // stav STB bitu (bit 3 portu 0Ah) — sestupná hrana = zápis na SN76489
let psg          = null;   // SN76489 instance (inicializuje se při startu pokud je SN76489.js načteno)
let melodikBusyTimer = null;
let videoEnabled = false;
let mp1Enabled   = false;  // MP1: false=ROM v 0x0000-0x3FFF, true=RAM
let ioEnabled    = false;  // MP0: false=RAM v 0xE000-0xFFFF, true=vstupy
let selected8253 = 0;      // SA1:SA0 pro 8253
let nRozliseni   = 0;      // počet video řádků (z 8253 čítač 0)
let dbgIoReads   = 0;
let frameTstates = 0;      // T-stavy v aktuálním frame (pro audio timing)

// ----------------------------------------------------------------------------
//  Video — mapovací tabulky
//
//  VRAM adresování: addr = (pageBase | low) kde
//    pageBase = 0xFF00 - col*0x0100  (col = 0..39)
//    low      = (y >> 1) | ((y & 1) << 7)  (interlace)
//
//  addrForFb[fb]    → mem[] adresa pro daný pixel (fb = řádek*40 + sloupec)
//  dispAdr[VRAM_idx] → fb index (-1 pokud pixel mimo aktivní oblast)
// ----------------------------------------------------------------------------

const dispAdr   = new Int16Array(VRAM_SIZE).fill(-1);
const addrForFb = new Uint16Array(VID_ROWS * VID_COLS).fill(0);

// ----------------------------------------------------------------------------
//  Klávesnice — memory-mapped vstupy
// ----------------------------------------------------------------------------

let io = new Uint8Array(256).fill(0xFF);  // 0xFF = klávesa uvolněna

// ----------------------------------------------------------------------------
//  CPU + hlavní smyčka
// ----------------------------------------------------------------------------

let cpu         = null;
let running     = false;
let paused      = false;
let frameHandle = null;
let totalFrames = 0;

// ----------------------------------------------------------------------------
//  ROM loader
//
//  Ondra má dvě EPROM patice (A + B), každá typicky 8KB → 16KB ROM celkem.
//  Každá patice zabírá 8KB. Menší EPROM (2KB/4KB) se v prostoru patice zrcadlí.
// ----------------------------------------------------------------------------

function buildRom(dataA, dataB = null) {
  const validSizes = [0x0800, 0x1000, 0x2000];
  if (!dataA || !validSizes.includes(dataA.length)) {
    throw new Error('Patice A: podporována je pouze EPROM 2, 4 nebo 8 KB.');
  }
  if (dataB && !validSizes.includes(dataB.length)) {
    throw new Error('Patice B: podporována je pouze EPROM 2, 4 nebo 8 KB.');
  }

  const newRom = new Uint8Array(0x4000).fill(0xFF);
  const fillSocket = (data, offset) => {
    if (!data) return;
    for (let i = 0; i < 0x2000; i++) newRom[offset + i] = data[i % data.length];
  };
  fillSocket(dataA, 0x0000);
  fillSocket(dataB, 0x2000);
  rom     = newRom;
  romSize = newRom.length;
  mem.fill(0x00);
  console.log(`ROM: patice A ${dataA.length / 1024} KB, patice B ${dataB ? dataB.length / 1024 + ' KB' : 'prázdná'}`);
  return newRom;
}

function readRom(addr) {
  addr &= 0x3FFF;
  return addr < romSize ? rom[addr] : 0xFF;
}

// ----------------------------------------------------------------------------
//  DMA / VRAM model
//
//  VEN=1 (dmaEnable): video aktivní, renderer čte z mem[] přes addrForFb[]
//  VEN=0 (dmaDisable): černá obrazovka
//
//  POZOR: dmaEnable() nesmí provádět drahý loop přes celou VRAM — volá se
//  50×/s z IRQ handleru a blokovalo by main thread (měřeno: 0.3ms × 50 = 15ms/s)
//  Renderer čte mem[] přímo přes addrForFb[] — není třeba udržovat cache.
// ----------------------------------------------------------------------------

function dmaEnable() {
  videoEnabled = true;
}

function dmaDisable() {
  videoEnabled = false;
}

function rebuildDispAdr(rows) {
  // Sestavit mapovací tabulky pro dané rozlišení (počet řádků)
  dispAdr.fill(-1);
  addrForFb.fill(0);
  let fb = 0;
  for (let y = rows; y !== 0; y--) {
    const low = (y >> 1) | ((y & 1) << 7);
    for (let col = 0; col < VID_COLS; col++) {
      const pageBase = 0xFF00 - col * 0x0100;
      const addr     = pageBase | low;
      const idx      = addr - VRAM_START;
      if (idx >= 0 && idx < VRAM_SIZE) {
        dispAdr[idx]  = fb;
        addrForFb[fb] = addr;
      }
      fb++;
    }
  }
}

// ----------------------------------------------------------------------------
//  Port 03h — řídicí latch
// ----------------------------------------------------------------------------

function outPort03(val) {
  // Kazetový beeper: bit 3 (K0) — překlápění generuje zvuk
  const oldCas = cassetteOut;
  cassetteOut  = (val >> 3) & 1;
  if (cassetteOut !== oldCas) queueSoundEvent('cas', cassetteOut);

  const prevVen = videoEnabled;
  port03        = val;
  mp1Enabled    = !!(val & 0x02);
  ioEnabled     = !!(val & 0x04);
  selected8253  = (val >> 4) & 0x03;

  const newVen = !!(val & 0x01);
  if (newVen !== prevVen) {
    if (newVen) dmaEnable();
    else        dmaDisable();
  } else {
    videoEnabled = newVen;
  }
}

// ----------------------------------------------------------------------------
//  ROL8 — vedlejší efekt IN A,(C) pro 8253
//
//  Ondra programuje 8253 přes IN instrukce (vedlejší efekt na sběrnici).
//  ROM typicky dělá RRC C → IN A,(C), takže hodnota pro 8253 = ROL8(C_po_RRC).
//  ROL8(RRC(x)) = x — ROM tím pošle původní hodnotu bez destrukce registru.
// ----------------------------------------------------------------------------

function rol8(x) {
  return (((x << 1) | (x >> 7)) & 0xFF);
}

// ----------------------------------------------------------------------------
//  Paměťový bus
// ----------------------------------------------------------------------------

const memBus = {
  mem_read(addr) {
    addr &= 0xFFFF;
    // MP0=1: paměťově mapované vstupy v 0xE000–0xFFFF
    if (ioEnabled && addr >= 0xE000) {
      dbgIoReads++;
      return io[addr & 0xFF];
    }
    // MP1=0: ROM překrývá RAM v 0x0000–0x3FFF
    if (!mp1Enabled && addr < 0x4000) return readRom(addr);
    return mem[addr];
  },

  mem_write(addr, val) {
    addr &= 0xFFFF;
    val  &= 0xFF;
    if (ioEnabled && addr >= 0xE000) return;  // vstupy jsou read-only
    if (!mp1Enabled && addr < 0x4000) return;  // ROM je read-only
    mem[addr] = val;
  },

  io_read(port) { return 0xFF; },

  io_write(port, val) {
    const lo = port & 0xFF;
    val &= 0xFF;
    // Maskové dekódování — každý dekodér je nezávislý (jako JOndra)
    if ((lo & 0x08) === 0) outPort03(val);           // A3=0: řídicí latch
    if ((lo & 0x01) === 0) {                         // A0=0: port 0Ah
      const newStb = (val >> 3) & 1;                 // bit 3 = /STB pro Melodik
      port0A = val;
      updateLeds();
      updateInternalSound((val >> 5) & 0x07);        // M3:M1 = tón 0–7
      // Sestupná hrana STB (1→0): zapsat port09 do SN76489
      // Protokol: OUT(0xFE,0x1F) → OUT(0xFD,byte) → OUT(0xFE,0x17)
      if (psg && melodikStb === 1 && newStb === 0) {
        psg.write(port09);
        // Simulace BUSY odezvy čipu: bit 5 na 0xE00F na 0 (BUSY=active low)
        // Detekční rutina čte 0xE00F a testuje bit 5 — 0 = Melodik přítomen
        io[0x0F] &= ~(1 << 5);                          // BUSY = 0
        if (melodikBusyTimer) clearTimeout(melodikBusyTimer);
        melodikBusyTimer = setTimeout(() => {
          io[0x0F] |= (1 << 5);
          melodikBusyTimer = null;
        }, 1); // BUSY = 1 po 1ms od posledního zápisu
      }
      melodikStb = newStb;
    }
    if ((lo & 0x02) === 0) {                         // A1=0: Melodik data / tiskárna
      port09 = val;
    }
  },
};

// Vedlejší efekt IN A,(C): hodnota pro 8253 = ROL8(C)
memBus.in_bc = function(bc) {
  const v = rol8(bc & 0xFF);
  if (selected8253 === 0) {
    nRozliseni = v;
    rebuildDispAdr(nRozliseni);
  }
};

// io_read s vedlejším efektem pro 8253
function wrapIORead(port) {
  memBus.in_bc(port & 0xFFFF);
  return 0xFF;
}

// ----------------------------------------------------------------------------
//  Zvukový systém — AudioWorklet, T-stav přesné přepínání
//
//  Princip (jako JOndra fillWithSample):
//    Při každém OUT na zvukový port zaznamenáme aktuální T-stav (frameTstates).
//    Z toho vypočteme pozici v audio bufferu pro daný frame.
//    Na konci frame pošleme celý buffer do AudioWorklet.
//    Worklet přehraje sample po samplu — každá změna tónu je časově přesná.
//
//  Audio buffer format: Uint8Array, jeden byte na vzorek
//    bity 3-1: tón 0-7 (ONDRA_FREQS)
//    bit  0:   kazetový výstup (0/1)
//
//  Frekvence tónů [Hz]: 0=ticho, 1-7 dle hardware obvodu Ondry
// ----------------------------------------------------------------------------

const ONDRA_FREQS = [0, 384, 606, 827, 1366, 1508, 1615, 1753];

let audioCtx    = null;
let soundTone   = 0;
let cassetteOut = 0;

// Audio frame buffer (plněn během frame, posílán do worklet)
let _audioFrameBuf = null;
let _audioFramePos = 0;
let _audioTone     = 0;
let _audioCas      = 0;

// AudioWorklet kód — generuje průběh sample po samplu
const WORKLET_CODE = `
class OndraSound extends AudioWorkletProcessor {
  constructor() {
    super();
    this._tone    = 0;
    this._phase   = 0;
    this._casLvl  = 0;
    this._pending = null;
    this._buf     = null;
    this._bufPos  = 0;
    this._psgBuf  = null;
    this._psgPos  = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'frame') this._pending = e.data;
    };
  }
  process(inputs, outputs) {
    const out   = outputs[0][0];
    const freqs = [0, 384, 606, 827, 1366, 1508, 1615, 1753];
    for (let i = 0; i < out.length; i++) {
      // Přejít na nový frame buffer
      if (this._pending && (!this._buf || this._bufPos >= this._buf.length)) {
        this._buf    = this._pending.buf;
        this._bufPos = 0;
        this._psgBuf = this._pending.psg || null;
        this._psgPos = 0;
        this._pending = null;
      }
      // Načíst stav pro tento vzorek
      if (this._buf && this._bufPos < this._buf.length) {
        const packed = this._buf[this._bufPos++];
        this._tone   = (packed >> 1) & 0x07;
        this._casLvl =  packed       & 0x01;
      }
      // Generovat vzorek: kazetový beeper + tónový oscilátor (čtvercový průběh)
      let s = this._casLvl ? 0.2 : -0.2;
      if (this._tone > 0) {
        this._phase = (this._phase + freqs[this._tone] / sampleRate) % 1;
        s += this._phase < 0.5 ? 0.2 : -0.2;
      }
      // Melodik (SN76489) mix
      if (this._psgBuf && this._psgPos < this._psgBuf.length) {
        s += this._psgBuf[this._psgPos++];
      }

      out[i] = Math.max(-1, Math.min(1, s));
    }
    return true;
  }
}
registerProcessor('ondra-sound', OndraSound);
`;

function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    audioCtx.audioWorklet.addModule(url).then(() => {
      const node = new AudioWorkletNode(audioCtx, 'ondra-sound', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]
      });
      node.connect(audioCtx.destination);
      URL.revokeObjectURL(url);
      window._soundNode = node;
    }).catch(e => console.warn('AudioWorklet chyba:', e));
  } catch(e) {
    console.warn('Web Audio nedostupné:', e);
  }
}

function _initAudioFrame() {
  if (!audioCtx) return;
  const samplesPerFrame = Math.ceil(audioCtx.sampleRate / FRAMES_PER_SEC);
  _audioFrameBuf = new Uint8Array(samplesPerFrame);
  _audioFramePos = 0;
}

function _fillAudioFrame(toTstate, totalTstates) {
  // Vyplnit buffer od aktuální pozice po vzorek odpovídající toTstate
  if (!_audioFrameBuf) return;
  const targetPos = Math.min(
    Math.floor(toTstate / totalTstates * _audioFrameBuf.length),
    _audioFrameBuf.length
  );
  const packed = ((_audioTone & 0x07) << 1) | (_audioCas & 0x01);
  while (_audioFramePos < targetPos) _audioFrameBuf[_audioFramePos++] = packed;
}

function _flushAudioFrame(totalTstates) {
  // Vyplnit zbytek Ondra tónového bufferu
  _fillAudioFrame(totalTstates, totalTstates);
  if (!window._soundNode || !_audioFrameBuf) { _audioFramePos = 0; return; }

  // Melodik (SN76489): renderovat frame do Float32 bufferu
  let psgBuf = null;
  if (psg && audioCtx) {
    psgBuf = new Float32Array(_audioFrameBuf.length);
    psg.renderChannels(psgBuf, audioCtx.sampleRate, 0.4);
  }

  const copy = new Uint8Array(_audioFrameBuf);
  const transfers = psgBuf ? [copy.buffer, psgBuf.buffer] : [copy.buffer];
  window._soundNode.port.postMessage({ type: 'frame', buf: copy, psg: psgBuf }, transfers);
  _audioFramePos = 0;
}

function updateInternalSound(tone) {
  if (tone === soundTone) return;
  soundTone = tone;
  _fillAudioFrame(frameTstates, cyclesPerFrame());
  _audioTone = tone;
}

function queueSoundEvent(type, value) {
  // Kazetový beeper: zaznamenat hranu do audio bufferu
  _fillAudioFrame(frameTstates, cyclesPerFrame());
  _audioCas = value;
}

// ----------------------------------------------------------------------------
//  Video renderer
//
//  Čte přímo z mem[] přes addrForFb[] — vždy aktuální stav VRAM.
//  Při VEN=0 zobrazuje černou obrazovku.
// ----------------------------------------------------------------------------

let canvas, ctx, imageData, pixels32;

function initVideo() {
  canvas = document.getElementById('screen');
  canvas.width  = VID_WIDTH;
  canvas.height = VID_ROWS;
  ctx       = canvas.getContext('2d');
  imageData = ctx.createImageData(VID_WIDTH, VID_ROWS);
  pixels32  = new Uint32Array(imageData.data.buffer);
}

const COLOR_ON  = 0xFFFFFFFF;
const COLOR_OFF = 0xFF000000;

function renderFrame() {
  let pixelIdx = 0;
  if (videoEnabled) {
    const total = nRozliseni * VID_COLS;
    for (let fb = 0; fb < total; fb++) {
      const byte = mem[addrForFb[fb]];
      for (let bit = 7; bit >= 0; bit--) {
        pixels32[pixelIdx++] = (byte >> bit) & 1 ? COLOR_ON : COLOR_OFF;
      }
    }
  }
  while (pixelIdx < pixels32.length) pixels32[pixelIdx++] = COLOR_OFF;
  ctx.putImageData(imageData, 0, 0);
}

// ----------------------------------------------------------------------------
//  CPU timing
//
//  T-stavů na frame:
//    VEN=1: (312 - nRozliseni) * 128  (DMA krade čas)
//    VEN=0: 312 * 128 = 39936 T
//
//  INT přichází 40 řádků před začátkem aktivního obrazu. Z80 tedy po INT
//  dostane nejprve 40 * 128 = 5120 T, potom začne obrazová DMA. Stav VRAM
//  pro zobrazení se musí zachytit právě v tomto okamžiku, ne až na konci
//  celého CPU přídělu.
// ----------------------------------------------------------------------------

const VIDEO_START_TSTATES = 40 * 128; // 5120 T od INT do začátku obrazové DMA

function cyclesPerFrame() {
  return videoEnabled ? (312 - nRozliseni) * 128 : 312 * 128;
}

// ----------------------------------------------------------------------------
//  Hlavní smyčka — 50 Hz přes setInterval
// ----------------------------------------------------------------------------

function emulatorFrame() {
  if (!running || paused) return;

  // Přerušení na začátek frame — Z80.js interrupt() je jednorázové (edge trigger)
  try { cpu.interrupt(false, 0xFF); }
  catch(e) { console.error('Chyba při obsluze INT:', e); }

  let cycles   = 0;
  frameTstates = 0;

  const runCpuUntil = limit => {
    while (cycles < limit) {
      const c = cpu.run_instruction();
      cycles += c;
      frameTstates += c;
    }
  };

  // Vertikální mezera: Z80 běží od INT do začátku aktivního obrazu.
  runCpuUntil(VIDEO_START_TSTATES);

  // Skutečný hardware začne VRAM číst až nyní. Během aktivních řádků DMA
  // zastaví CPU, takže jednorázový snímek VRAM je pro tento model dostačující.
  renderFrame();

  // IRQ handler mohl v prvních 5120 T změnit VEN nebo naprogramovat výšku
  // obrazu. Příděl CPU proto určujeme až podle stavu na začátku obrazové DMA.
  const target = cyclesPerFrame();
  runCpuUntil(target);

  _flushAudioFrame(target);
  totalFrames++;
  dbgIoReads = 0;
  if (totalFrames % 25 === 0) setStatus(`▶ ${totalFrames} snímků`);
}

// ----------------------------------------------------------------------------
//  Klávesnice
//
//  Memory-mapped vstupy na 0xE000–0xE009 (při MP0=1).
//  Aktivní v nule — bit = 0 znamená klávesa stisknuta.
//
//  Mapování ověřeno empiricky LEDkami na reálné ROM:
//    ShiftLeft=SHIFT, ShiftRight=NUMBERS, AltLeft=SYMBOLS
//    AltRight/CapsLock=ČS, Ctrl=CTRL
// ----------------------------------------------------------------------------

const KEY_MAP_CODE = {
  // Přeřazovače
  'ShiftLeft':    [0x04, 4],  // SHIFT
  'ShiftRight':   [0x04, 1],  // NUMBERS
  'AltLeft':      [0x02, 4],  // SYMBOLS
  'AltRight':     [0x04, 2],  // ČS
  'CapsLock':     [0x04, 2],  // ČS alternativa
  'ControlLeft':  [0x07, 4],  // CTRL
  'ControlRight': [0x07, 4],  // CTRL
  // E000: Q T W E R
  'KeyQ': [0x00, 4], 'KeyT': [0x00, 3], 'KeyW': [0x00, 2], 'KeyE': [0x00, 1], 'KeyR': [0x00, 0],
  // E001: A G S D F
  'KeyA': [0x01, 4], 'KeyG': [0x01, 3], 'KeyS': [0x01, 2], 'KeyD': [0x01, 1], 'KeyF': [0x01, 0],
  // E002: V Z X C (+ SYMBOLS)
  'KeyV': [0x02, 3], 'KeyZ': [0x02, 2], 'KeyX': [0x02, 1], 'KeyC': [0x02, 0],
  // E003: SPACE
  'Space': [0x03, 0],
  // E005: ENTER H L K J
  'Enter': [0x05, 4], 'KeyH': [0x05, 3], 'KeyL': [0x05, 2], 'KeyK': [0x05, 1], 'KeyJ': [0x05, 0],
  // E006: P Y O I U
  'KeyP': [0x06, 4], 'KeyY': [0x06, 3], 'KeyO': [0x06, 2], 'KeyI': [0x06, 1], 'KeyU': [0x06, 0],
  // E007: B ↑ M N (+ CTRL)
  'KeyB': [0x07, 3], 'ArrowUp': [0x07, 2], 'KeyM': [0x07, 1], 'KeyN': [0x07, 0],
  // E008: → ↓ ← (Backspace = ←)
  'ArrowRight': [0x08, 4], 'ArrowDown': [0x08, 2], 'ArrowLeft': [0x08, 1],
  'Backspace':  [0x08, 1],
  // E009: joystick (Numpad)
  'Numpad0': [0x09, 4], 'Numpad2': [0x09, 3], 'Numpad8': [0x09, 2],
  'Numpad4': [0x09, 1], 'Numpad6': [0x09, 0],
};

// Jeden bod matice může současně držet fyzická i dotyková klávesa. Zdroje
// evidujeme odděleně, aby uvolnění jednoho vstupu nepustilo druhý.
const keyboardInputSources = new Map();
const onscreenPointers = new Map();

function setKeyboardInput(code, source, pressed) {
  const m = KEY_MAP_CODE[code];
  if (!m) return;

  const matrixId = `${m[0]}:${m[1]}`;
  let sources = keyboardInputSources.get(matrixId);
  if (!sources) {
    sources = new Set();
    keyboardInputSources.set(matrixId, sources);
  }

  if (pressed) sources.add(source);
  else sources.delete(source);

  if (sources.size) io[m[0]] &= ~(1 << m[1]);
  else {
    io[m[0]] |= (1 << m[1]);
    keyboardInputSources.delete(matrixId);
  }
  updateLeds();
}

function keyDown(e) {
  if (!KEY_MAP_CODE[e.code]) return;
  setKeyboardInput(e.code, `physical:${e.code}`, true);
  e.preventDefault();
}

function keyUp(e) {
  if (!KEY_MAP_CODE[e.code]) return;
  setKeyboardInput(e.code, `physical:${e.code}`, false);
}

function resetKeyboardInputs() {
  keyboardInputSources.clear();
  onscreenPointers.clear();
  io.fill(0xFF);
  document.querySelectorAll('.osk-key.pressed, .osk-key.latched').forEach(button => {
    button.classList.remove('pressed', 'latched');
    if (button.dataset.modifier === 'true') button.setAttribute('aria-pressed', 'false');
  });
  updateLeds();
}

function keyFocusLost() { resetKeyboardInputs(); }

function initOnscreenKeyboard() {
  const keyboard = document.getElementById('onscreen-keyboard');
  if (!keyboard || keyboard.dataset.initialized) return;
  keyboard.dataset.initialized = 'true';

  keyboard.addEventListener('contextmenu', e => e.preventDefault());

  keyboard.querySelectorAll('.osk-key[data-code]').forEach(button => {
    button.addEventListener('pointerdown', e => {
      e.preventDefault();
      const code = button.dataset.code;

      if (button.dataset.modifier === 'true') {
        const latched = !button.classList.contains('latched');
        button.classList.toggle('latched', latched);
        button.setAttribute('aria-pressed', String(latched));
        setKeyboardInput(code, `onscreen-latch:${code}`, latched);
        return;
      }

      const source = `onscreen-pointer:${e.pointerId}`;
      onscreenPointers.set(e.pointerId, { button, code, source });
      button.classList.add('pressed');
      button.setPointerCapture?.(e.pointerId);
      setKeyboardInput(code, source, true);
    });
  });

  const releasePointer = e => {
    const active = onscreenPointers.get(e.pointerId);
    if (!active) return;
    setKeyboardInput(active.code, active.source, false);
    onscreenPointers.delete(e.pointerId);
    const stillPressed = Array.from(onscreenPointers.values())
      .some(item => item.button === active.button);
    if (!stillPressed) active.button.classList.remove('pressed');
  };

  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
}

initOnscreenKeyboard();

// ----------------------------------------------------------------------------
//  LEDky (port 0Ah bit 0 = LED1, bit 1 = LED2, aktivní v nule)
// ----------------------------------------------------------------------------

function updateLeds() {
  const setLed = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', on);
  };
  setLed('led-1', !(port0A & 0x01));
  setLed('led-2', !(port0A & 0x02));
}

// ----------------------------------------------------------------------------
//  Reset stavu emulátoru
// ----------------------------------------------------------------------------

function _resetState() {
  mem.fill(0x00);
  port03 = 0x00; port0A = 0xFF; port09 = 0xFF; melodikStb = 0;
  if (psg) psg.reset();
  if (melodikBusyTimer) { clearTimeout(melodikBusyTimer); melodikBusyTimer = null; }
  videoEnabled = false; mp1Enabled = false; ioEnabled = false;
  selected8253 = 0; nRozliseni = 0;
  soundTone = 0; cassetteOut = 0;
  _audioTone = 0; _audioCas = 0; _audioFramePos = 0;
  frameTstates = 0; dbgIoReads = 0; totalFrames = 0;
  resetKeyboardInputs();
  rebuildDispAdr(0);
}

// ----------------------------------------------------------------------------
//  Veřejné funkce
// ----------------------------------------------------------------------------

function startEmulator(romData) {
  stopEmulator();
  rom     = romData;
  romSize = romData.length;
  _resetState();
  initVideo();
  initAudio();
  setTimeout(() => {
    _initAudioFrame();
    // Inicializovat Melodik PSG pokud je SN76489.js načteno
    if (window.SN76489) {
      psg = new SN76489();
      console.log('Melodik: SN76489 připraven');
    }
  }, 200);

  const bus = Object.assign({}, memBus, { io_read: wrapIORead });
  cpu = new Z80(bus);
  cpu.reset();

  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup',   keyUp);
  window.addEventListener('blur',    keyFocusLost);

  document.getElementById('overlay').classList.add('hidden');
  running = true; paused = false;
  setStatus('▶ Startuji…');
  frameHandle = setInterval(emulatorFrame, FRAME_MS);
}

function resetEmulator() {
  if (!cpu) return;
  _resetState();
  cpu.reset();
  updateLeds();
  setStatus('↺ Reset');
  if (!running) { running = true; frameHandle = setInterval(emulatorFrame, FRAME_MS); }
}

function stopEmulator() {
  running = false;
  if (frameHandle) { clearInterval(frameHandle); frameHandle = null; }
  window.removeEventListener('keydown', keyDown);
  window.removeEventListener('keyup',   keyUp);
  window.removeEventListener('blur',    keyFocusLost);
}

function togglePause() {
  if (!cpu) return;
  paused = !paused;
  setStatus(paused ? '⏸ Pozastaveno' : '▶ Pokračuji');
}

function triggerNMI() {
  if (!cpu) return;
  try { cpu.interrupt(true, 0xFF); }
  catch(e) {
    console.error('Chyba při obsluze NMI:', e);
    setStatus('Chyba NMI — podrobnosti jsou v konzoli');
  }
}

// ----------------------------------------------------------------------------
//  Debug panel (aktualizace 2×/s)
// ----------------------------------------------------------------------------

let debugInterval = null;

function toggleDebug() {
  const panel = document.getElementById('debug-panel');
  panel.classList.toggle('visible');
  if (panel.classList.contains('visible')) {
    updateDebug();
    debugInterval = setInterval(updateDebug, 500);
  } else {
    clearInterval(debugInterval);
    debugInterval = null;
  }
}

function updateDebug() {
  if (!cpu) return;
  try {
    const s  = cpu.getState();
    const h4 = n => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
    const h2 = n => (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
    const flagsToF = f => typeof f === 'object'
      ? ((f.S << 7) | (f.Z << 6) | (f.Y << 5) | (f.H << 4) | (f.X << 3) | (f.P << 2) | (f.N << 1) | f.C)
      : (f ?? 0);
    const ioDbg = Array.from(io.slice(0, 10)).map(v => h2(v)).join(' ');
    document.getElementById('debug-output').textContent = [
      `PC:${h4(s.pc)}  SP:${h4(s.sp)}  IX:${h4(s.ix)}  IY:${h4(s.iy)}`,
      `AF:${h2(s.a)}${h2(flagsToF(s.flags))}  BC:${h2(s.b)}${h2(s.c)}  DE:${h2(s.d)}${h2(s.e)}  HL:${h2(s.h)}${h2(s.l)}`,
      `port03:${h2(port03)}  VEN:${+videoEnabled}  MP1:${+mp1Enabled}  MP0:${+ioEnabled}  nR:${nRozliseni}`,
      `cyclesPerFrame:${cyclesPerFrame()}T  tone:${soundTone}  snímek:${totalFrames}`,
      `io[E000-E009]: ${ioDbg}  kbReads:${dbgIoReads}`,
      `ROM:${romSize / 1024}KB`,
    ].join('\n');
  } catch(e) {
    document.getElementById('debug-output').textContent = 'Debug chyba: ' + e.message;
  }
}

// ----------------------------------------------------------------------------
//  Snapshoty (.osn)
//
//  28B pevná hlavička:
//    0..7   "ONDRASNP"
//    8..9   verze formátu (LE)
//    12..15 délka JSON hlavičky
//    16..19 délka RAM
//    20..23 délka ROM
//    24..27 CRC32 celého payloadu (JSON + RAM + ROM)
// ----------------------------------------------------------------------------

const SNAP_MAGIC = 'ONDRASNP';
const SNAP_VERSION = 1;
const SNAP_FIXED_HEADER = 28;

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function validateCpuState(state) {
  if (!state || typeof state !== 'object') throw new Error('Ve snapshotu chybí stav CPU.');
  const byteFields = ['a','b','c','d','e','h','l','a_prime','b_prime','c_prime','d_prime','e_prime','h_prime','l_prime','i','r'];
  const wordFields = ['ix','iy','sp','pc'];
  const integerIn = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  if (!byteFields.every(name => integerIn(state[name], 0xFF)) ||
      !wordFields.every(name => integerIn(state[name], 0xFFFF))) {
    throw new Error('Snapshot obsahuje neplatné registry CPU.');
  }
  for (const name of ['flags', 'flags_prime']) {
    const flags = state[name];
    if (!flags || !['S','Z','Y','H','X','P','N','C'].every(flag => integerIn(flags[flag], 1))) {
      throw new Error('Snapshot obsahuje neplatné příznaky CPU.');
    }
  }
  if (!integerIn(state.imode, 2) || !integerIn(state.iff1, 1) || !integerIn(state.iff2, 1) ||
      typeof state.halted !== 'boolean' || typeof state.do_delayed_di !== 'boolean' ||
      typeof state.do_delayed_ei !== 'boolean' || !Number.isFinite(state.cycle_counter)) {
    throw new Error('Snapshot obsahuje neplatný řídicí stav CPU.');
  }
}

function createSnapshotBuffer() {
  if (!cpu) throw new Error('Emulátor ještě není spuštěný.');
  const header = {
    machine: 'Ondra SPO 186',
    createdAt: new Date().toISOString(),
    cpu: cpu.getState(),
    machineState: {
      port03, port0A, port09, melodikStb, nRozliseni,
      soundTone, cassetteOut, totalFrames
    },
    execution: { paused },
    psg: psg ? psg.getState() : null
  };

  const json = new TextEncoder().encode(JSON.stringify(header));
  const ramBytes = new Uint8Array(mem);
  const romBytes = new Uint8Array(rom);
  const payload = new Uint8Array(json.length + ramBytes.length + romBytes.length);
  payload.set(json, 0);
  payload.set(ramBytes, json.length);
  payload.set(romBytes, json.length + ramBytes.length);

  const result = new Uint8Array(SNAP_FIXED_HEADER + payload.length);
  result.set(new TextEncoder().encode(SNAP_MAGIC), 0);
  const view = new DataView(result.buffer);
  view.setUint16(8, SNAP_VERSION, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, ramBytes.length, true);
  view.setUint32(20, romBytes.length, true);
  view.setUint32(24, crc32(payload), true);
  result.set(payload, SNAP_FIXED_HEADER);
  return result.buffer;
}

function parseSnapshotBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < SNAP_FIXED_HEADER) {
    throw new Error('Soubor je příliš krátký.');
  }
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.slice(0, 8));
  if (magic !== SNAP_MAGIC) throw new Error('Soubor není snapshot webulátoru Ondry.');

  const view = new DataView(buffer);
  const version = view.getUint16(8, true);
  if (version !== SNAP_VERSION) throw new Error(`Nepodporovaná verze snapshotu ${version}.`);
  const jsonLength = view.getUint32(12, true);
  const ramLength = view.getUint32(16, true);
  const romLength = view.getUint32(20, true);
  const expectedCrc = view.getUint32(24, true);
  const expectedLength = SNAP_FIXED_HEADER + jsonLength + ramLength + romLength;
  if (ramLength !== MEM_SIZE || romLength !== 0x4000 || expectedLength !== bytes.length) {
    throw new Error('Snapshot má neplatnou velikost paměti nebo je neúplný.');
  }

  const payload = bytes.slice(SNAP_FIXED_HEADER);
  if (crc32(payload) !== expectedCrc) throw new Error('Kontrolní součet snapshotu nesouhlasí.');
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(payload.slice(0, jsonLength)));
  } catch(e) {
    throw new Error('Metadata snapshotu jsou poškozená.');
  }
  if (header.machine !== 'Ondra SPO 186' || !header.machineState || !header.execution) {
    throw new Error('Snapshot neobsahuje platný stav Ondry.');
  }
  validateCpuState(header.cpu);

  const machineFields = ['port03','port0A','port09','melodikStb','nRozliseni','soundTone','cassetteOut'];
  if (!machineFields.every(name => Number.isInteger(header.machineState[name]))) {
    throw new Error('Snapshot obsahuje neplatný stav periferií.');
  }
  const ramOffset = jsonLength;
  const romOffset = ramOffset + ramLength;
  return {
    header,
    ram: payload.slice(ramOffset, romOffset),
    rom: payload.slice(romOffset, romOffset + romLength)
  };
}

function restoreSnapshotBuffer(buffer) {
  const snapshot = parseSnapshotBuffer(buffer);
  let restoredPsg = null;
  if (snapshot.header.psg) {
    if (!window.SN76489) throw new Error('Emulace SN76489 není dostupná.');
    restoredPsg = new SN76489();
    restoredPsg.setState(snapshot.header.psg);
  }

  // Snapshot je samostatný: musí jít načíst i před prvním spuštěním ROM.
  if (!cpu) {
    initVideo();
    initAudio();
    const bus = Object.assign({}, memBus, { io_read: wrapIORead });
    cpu = new Z80(bus);
    cpu.reset();
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup',   keyUp);
    window.addEventListener('blur',    keyFocusLost);
    setTimeout(_initAudioFrame, 200);
  }
  document.getElementById('overlay').classList.add('hidden');
  if (!running) {
    running = true;
    if (!frameHandle) frameHandle = setInterval(emulatorFrame, FRAME_MS);
  }

  mem.set(snapshot.ram);
  rom = new Uint8Array(snapshot.rom);
  romSize = rom.length;
  try {
    cpu.setState(snapshot.header.cpu);
  } catch(e) {
    throw new Error('Nepodařilo se obnovit stav CPU: ' + e.message);
  }

  const state = snapshot.header.machineState;
  port03 = state.port03 & 0xFF;
  port0A = state.port0A & 0xFF;
  port09 = state.port09 & 0xFF;
  melodikStb = state.melodikStb & 1;
  videoEnabled = !!(port03 & 0x01);
  mp1Enabled = !!(port03 & 0x02);
  ioEnabled = !!(port03 & 0x04);
  selected8253 = (port03 >> 4) & 0x03;
  nRozliseni = Math.max(0, Math.min(255, state.nRozliseni));
  soundTone = state.soundTone & 0x07;
  cassetteOut = state.cassetteOut & 1;
  _audioTone = soundTone;
  _audioCas = cassetteOut;
  _audioFramePos = 0;
  frameTstates = 0;
  totalFrames = Number.isInteger(state.totalFrames) ? state.totalFrames : 0;
  if (melodikBusyTimer) { clearTimeout(melodikBusyTimer); melodikBusyTimer = null; }
  psg = restoredPsg;
  io.fill(0xFF); // fyzicky stisknuté klávesy se do snapshotu nepřenášejí
  rebuildDispAdr(nRozliseni);
  updateLeds();
  renderFrame();
  updateDebug();
  paused = !!snapshot.header.execution.paused;
  setStatus(paused ? '📂 Snapshot obnoven — pozastaveno' : '📂 Snapshot obnoven');
}

function saveSnapshot() {
  try {
    const data = createSnapshotBuffer();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ondra-${stamp}.osn`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('💾 Snapshot uložen');
  } catch(e) {
    alert('Snapshot se nepodařilo uložit: ' + e.message);
  }
}

function loadSnapshot(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = ev => {
    const oldPaused = paused;
    paused = true;
    try {
      restoreSnapshotBuffer(ev.target.result);
    } catch(e) {
      paused = oldPaused;
      alert('Snapshot se nepodařilo načíst: ' + e.message);
      setStatus('Snapshot nebyl načten');
    }
  };
  reader.onerror = () => alert('Soubor snapshotu se nepodařilo přečíst.');
  reader.readAsArrayBuffer(file);
}

// ----------------------------------------------------------------------------
//  UI helpers
// ----------------------------------------------------------------------------

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// ----------------------------------------------------------------------------
//  Tape loader — Phase 2
// ----------------------------------------------------------------------------

function loadTape(input) {
  const file = input.files[0];
  if (!file) return;
  setStatus(`📼 ${file.name} — načítání pásky zatím není implementováno`);
  input.value = '';
}

// ----------------------------------------------------------------------------
//  BIN loader
//
//  Formát: sekvence bloků ukončená blokem 0x02
//    0x01 + adresa (2B LE) + délka (2B LE) + data  → datový blok
//    0x02 + startAddr (2B LE)                       → start, konec souboru
//
//  Před zápisem: mp1Enabled = true (jako JOndra mem.mapRom(false))
//  — přímá manipulace bez vedlejších efektů outPort03()
//  Po zápisu: PC = startAddr, halted = false, pak pokračuje emulace
// ----------------------------------------------------------------------------

function loadBinary(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  const reader = new FileReader();
  reader.onload = function(ev) {
    const oldPaused = paused;
    paused = true;

    try {
      const data = new Uint8Array(ev.target.result);
      const parsedBlocks = [];
      let pos = 0;
      let startAddr = null;

      // Nejdřív ověřit celý soubor; stav stroje se při chybě nesmí změnit.
      while (pos < data.length) {
        const typ = data[pos++];
        if (typ === 0x01) {
          if (pos + 4 > data.length) throw new Error('Neočekávaný konec souboru v hlavičce bloku.');
          const addr = data[pos] | (data[pos + 1] << 8); pos += 2;
          const length = data[pos] | (data[pos + 1] << 8); pos += 2;
          if (pos + length > data.length) {
            throw new Error(`Blok ${parsedBlocks.length + 1}: hlavička říká ${length} B, ale soubor má jen ${data.length - pos} B.`);
          }
          if (addr + length > 0x10000) {
            throw new Error(`Blok ${parsedBlocks.length + 1} přesahuje konec paměti.`);
          }
          parsedBlocks.push({ addr, bytes: data.slice(pos, pos + length) });
          pos += length;
        } else if (typ === 0x02) {
          if (pos + 2 > data.length) throw new Error('Neočekávaný konec souboru ve startovací hlavičce.');
          startAddr = data[pos] | (data[pos + 1] << 8); pos += 2;
          break;
        } else {
          throw new Error(`Neznámý typ bloku 0x${typ.toString(16)} na offsetu ${pos - 1}.`);
        }
      }

      mp1Enabled = true;
      parsedBlocks.forEach((block, index) => {
        mem.set(block.bytes, block.addr);
        console.log(`BIN blok ${index + 1}: 0x${block.addr.toString(16).toUpperCase()} + ${block.bytes.length} B`);
      });

      const startHex = startAddr !== null
        ? `→ start 0x${startAddr.toString(16).toUpperCase()}`
        : '(bez startovací adresy)';
      const blockCount = parsedBlocks.length;
      setStatus(`⬇ ${file.name}: ${blockCount} blok${blockCount === 1 ? '' : 'ů'} ${startHex}`);

      if (startAddr !== null && cpu) {
        const state = cpu.getState();
        state.pc = startAddr;
        if ('halted' in state) state.halted = false;
        cpu.setState(state);
      }
    } catch(e) {
      alert('Chyba načítání BIN: ' + e.message);
      setStatus('BIN nebyl načten');
    } finally {
      paused = oldPaused;
    }
  };
  reader.onerror = () => {
    alert('Soubor BIN se nepodařilo přečíst.');
    setStatus('BIN nebyl načten');
  };
  reader.readAsArrayBuffer(file);
}
