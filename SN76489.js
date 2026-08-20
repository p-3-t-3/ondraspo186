'use strict';

/**
 * SN76489 programmable sound generator.
 *
 * Phase 3.0.1/3.0.2: bus write protocol and all eight registers.
 * Phase 3.0.3a: first audible output — tone channel A only.
 * Phase 3.0.3b: all three tone channels and 16-step attenuation.
 * Phase 3.0.3c: white/periodic noise, fixed dividers and Tone C clocking.
 */
class SN76489 {
  // Melodik používá samostatný krystal 4 MHz.
  static CLOCK_HZ = 4_000_000;

  // Relative output levels used by the JOndra reference implementation.
  // Register value 0 is loudest, 15 is silent.
  static VOLUME_TABLE = new Float32Array([
    25 / 25, 20 / 25, 16 / 25, 13 / 25,
    10 / 25,  8 / 25,  6 / 25,  5 / 25,
     4 / 25,  3 / 25,  3 / 25,  2 / 25,
     2 / 25,  1 / 25,  1 / 25,  0
  ]);

  constructor(clockHz = SN76489.CLOCK_HZ) {
    this.clockHz = clockHz;
    this.registers = new Uint16Array(8);
    this.latchedRegister = 0;
    this.writeCount = 0;
    this.lastWrite = null;
    this.tonePhases = new Float64Array(3);
    this.noisePhase = 0;
    this.noiseShiftRegister = 0x10000;
    this.reset();
  }

  reset() {
    this.registers.fill(0);

    // Hardware reset leaves the tone registers at zero. On the TI SN76489A,
    // a zero tone period is interpreted as 0x400 by getTonePeriod().
    // Volumes use attenuation 0=loudest ... 15=silent.
    this.registers[0] = 0;
    this.registers[1] = 0x0F;
    this.registers[2] = 0;
    this.registers[3] = 0x0F;
    this.registers[4] = 0;
    this.registers[5] = 0x0F;
    this.registers[6] = 0;
    this.registers[7] = 0x0F;

    this.latchedRegister = 0;
    this.writeCount = 0;
    this.lastWrite = null;
    this.tonePhases.fill(0);
    this.noisePhase = 0;
    this.noiseShiftRegister = 0x10000;
  }

  /**
   * Write one byte to the PSG data bus.
   * Bit 7 set: latch/data byte (%1cctdddd).
   * Bit 7 clear: continuation data for the currently latched register.
   */
  write(value) {
    value &= 0xFF;

    if (value & 0x80) {
      this.latchedRegister = (value >>> 4) & 0x07;
      const index = this.latchedRegister;

      if (index === 0 || index === 2 || index === 4) {
        this.registers[index] = (this.registers[index] & 0x03F0) | (value & 0x0F);
      } else if (index === 6) {
        this.registers[index] = value & 0x07;
      } else {
        this.registers[index] = value & 0x0F;
      }
    } else {
      const index = this.latchedRegister;

      if (index === 0 || index === 2 || index === 4) {
        this.registers[index] = (this.registers[index] & 0x000F) | ((value & 0x3F) << 4);
      } else if (index === 6) {
        this.registers[index] = value & 0x07;
      } else {
        this.registers[index] = value & 0x0F;
      }
    }

    // Every write to the noise register restarts the 17-bit TI LFSR, as on the chip.
    if (this.latchedRegister === 6) {
      this.noiseShiftRegister = 0x10000;
      this.noisePhase = 0;
    }

    this.writeCount++;
    this.lastWrite = value;
  }

  getTonePeriod(channel) {
    if (channel < 0 || channel > 2) throw new RangeError('Tone channel must be 0..2.');
    const period = this.registers[channel << 1] & 0x03FF;
    // TI SN76489A treats a programmed period of zero as 0x400.
    return period === 0 ? 0x0400 : period;
  }

  getToneFrequency(channel) {
    const period = this.getTonePeriod(channel);
    return this.clockHz / (32 * period);
  }

  getVolume(channel) {
    if (channel < 0 || channel > 3) throw new RangeError('Volume channel must be 0..3.');
    return this.registers[(channel << 1) + 1] & 0x0F;
  }

  getAmplitude(channel) {
    return SN76489.VOLUME_TABLE[this.getVolume(channel)];
  }

  getNoiseMode() {
    return (this.registers[6] & 0x04) ? 'white' : 'periodic';
  }

  getNoiseClockSource() {
    const rate = this.registers[6] & 0x03;
    return rate === 3 ? 'tone-c' : `fixed-${rate}`;
  }

  getNoiseShiftFrequency() {
    const rate = this.registers[6] & 0x03;
    if (rate === 3) return this.getToneFrequency(2);
    return this.clockHz / (512 << rate);
  }

  #shiftNoiseRegister() {
    // TI SN76489A LFSR (as fitted to the SORD M5): white-noise taps are bits 2
    // and 3, feedback is injected at bit 16, output is bit 0. This matches
    // MAME's sn76489a_device (feedback 0x10000, taps 0x04/0x08). It differs from
    // the Sega VDP PSG (feedback 0x8000, taps 0x01/0x08), which earlier phases
    // implemented by mistake.
    const white = (this.registers[6] & 0x04) !== 0;
    const tap1 = (this.noiseShiftRegister & 0x04) !== 0;      // bit 2
    const tap2 = white && ((this.noiseShiftRegister & 0x08) !== 0); // bit 3, only in white mode
    const feedback = tap1 !== tap2;                           // XOR
    this.noiseShiftRegister >>>= 1;
    if (feedback) this.noiseShiftRegister |= 0x10000;
  }

  /**
   * Render all four PSG channels into one mono Float32 PCM buffer.
   * Tone channels are bipolar square waves. The noise output follows the
   * JOndra reference implementation: LFSR bit 0 produces 0 or double level.
   */
  renderChannels(buffer, sampleRate, channelGain = 0.18) {
    const phaseSteps = new Float64Array(3);
    const amplitudes = new Float32Array(3);

    for (let channel = 0; channel < 3; channel++) {
      const frequency = this.getToneFrequency(channel);
      phaseSteps[channel] = frequency / sampleRate;
      // Skutečný Melodik může generovat ultrazvuk (např. 125 kHz při periodě 1),
      // který analogová cesta nepřehraje. Přímé vzorkování by jej přeložilo zpět
      // do slyšitelného pásma jako falešný tón. Generátor dál běží a může taktovat
      // šum, pouze jeho nadnyquistový výstup není přimíchán do audia.
      amplitudes[channel] = frequency < sampleRate / 2
        ? this.getAmplitude(channel) * channelGain
        : 0;
    }

    const noiseStep = this.getNoiseShiftFrequency() / sampleRate;
    const noiseAmplitude = this.getAmplitude(3) * channelGain * 2;

    for (let i = 0; i < buffer.length; i++) {
      let mixed = 0;

      for (let channel = 0; channel < 3; channel++) {
        const amplitude = amplitudes[channel];
        if (amplitude !== 0) {
          mixed += this.tonePhases[channel] < 0.5 ? amplitude : -amplitude;
        }

        let phase = this.tonePhases[channel] + phaseSteps[channel];
        phase -= Math.floor(phase);
        this.tonePhases[channel] = phase;
      }

      if (noiseAmplitude !== 0 && (this.noiseShiftRegister & 1)) {
        mixed += noiseAmplitude;
      }

      this.noisePhase += noiseStep;
      while (this.noisePhase >= 1) {
        this.noisePhase -= 1;
        this.#shiftNoiseRegister();
      }

      // Keep pathological mixes inside the Web Audio range.
      buffer[i] = Math.max(-1, Math.min(1, mixed));
    }
  }

  // Compatibility alias retained for any code from phase 3.0.3b.
  renderToneChannels(buffer, sampleRate, channelGain = 0.18) {
    this.renderChannels(buffer, sampleRate, channelGain);
  }

  getState() {
    return {
      clockHz: this.clockHz,
      latchedRegister: this.latchedRegister,
      registers: Array.from(this.registers),
      tonePeriods: [0, 1, 2].map(channel => this.getTonePeriod(channel)),
      toneFrequencies: [0, 1, 2].map(channel => this.getToneFrequency(channel)),
      volumes: [0, 1, 2, 3].map(channel => this.getVolume(channel)),
      amplitudes: [0, 1, 2, 3].map(channel => this.getAmplitude(channel)),
      noise: this.registers[6] & 0x07,
      noiseMode: this.getNoiseMode(),
      noiseClockSource: this.getNoiseClockSource(),
      noiseShiftFrequency: this.getNoiseShiftFrequency(),
      noiseShiftRegister: this.noiseShiftRegister,
      noisePhase: this.noisePhase,
      tonePhases: Array.from(this.tonePhases),
      writeCount: this.writeCount,
      lastWrite: this.lastWrite
    };
  }

  /** Restore a state previously returned by getState(). */
  setState(state) {
    if (!state || !Array.isArray(state.registers) || state.registers.length !== 8) {
      throw new Error('Neplatný stav SN76489.');
    }
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const tonePhases = Array.isArray(state.tonePhases) && state.tonePhases.length === 3
      ? state.tonePhases
      : [0, 0, 0];
    const noisePhase = finite(state.noisePhase) ? state.noisePhase : 0;
    if (!state.registers.every(finite) || !tonePhases.every(finite) ||
        !finite(state.noiseShiftRegister)) {
      throw new Error('Snapshot obsahuje poškozený stav SN76489.');
    }

    // Takt je vlastnost hardwaru, nikoli stav programu. Starší snapshoty mohly
    // obsahovat frekvenci SORDu 3,579545 MHz; při obnovení ji proto ignorujeme.
    this.clockHz = SN76489.CLOCK_HZ;
    this.registers.set(state.registers.map(value => value & 0x03FF));
    this.latchedRegister = (state.latchedRegister ?? 0) & 0x07;
    // Starší snapshoty tyto fáze neukládaly. Nulová fáze zachová registry,
    // frekvence i šumový registr; může způsobit nanejvýš neslyšný fázový skok.
    this.tonePhases.set(tonePhases.map(value => value - Math.floor(value)));
    this.noisePhase = noisePhase - Math.floor(noisePhase);
    this.noiseShiftRegister = state.noiseShiftRegister & 0x1FFFF;
    this.writeCount = Number.isInteger(state.writeCount) ? state.writeCount : 0;
    this.lastWrite = state.lastWrite === null ? null : ((state.lastWrite ?? 0) & 0xFF);
  }
}

window.SN76489 = SN76489;
