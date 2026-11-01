'use strict';

// ESNAP — platform-independent emulator snapshot container.
// The container deliberately knows nothing about Ondra or any other machine.
// Machine implementations define the payload and schema of individual chunks.
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ESnap = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function() {
  const MAGIC = new Uint8Array([0x45, 0x4D, 0x55, 0x53, 0x4E, 0x41, 0x50, 0x00]); // EMUSNAP\0
  const VERSION_MAJOR = 1;
  const VERSION_MINOR = 0;
  const HEADER_SIZE = 32;
  const CHUNK_HEADER_SIZE = 24;
  const MAX_CHUNKS = 1024;

  const Encoding = Object.freeze({ RAW: 0, JSON: 1 });
  const ChunkFlags = Object.freeze({ REQUIRED: 0x0001, MEDIA: 0x0002 });

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

  function asBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError('Data bloku ESNAP musí být binární pole.');
  }

  function validateType(type) {
    if (typeof type !== 'string' || type.length !== 4 || !/^[\x20-\x7E]{4}$/.test(type)) {
      throw new Error('Typ bloku ESNAP musí mít právě čtyři ASCII znaky.');
    }
  }

  function rawChunk(type, data, options = {}) {
    validateType(type);
    return {
      type,
      instance: options.instance ?? 0,
      schema: options.schema ?? 1,
      encoding: Encoding.RAW,
      flags: options.flags ?? 0,
      data: asBytes(data)
    };
  }

  function jsonChunk(type, value, options = {}) {
    validateType(type);
    return {
      type,
      instance: options.instance ?? 0,
      schema: options.schema ?? 1,
      encoding: Encoding.JSON,
      flags: options.flags ?? 0,
      data: new TextEncoder().encode(JSON.stringify(value))
    };
  }

  function encode(chunks, options = {}) {
    if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_CHUNKS) {
      throw new Error('ESNAP musí obsahovat 1 až 1024 bloků.');
    }

    const normalized = chunks.map(chunk => {
      validateType(chunk.type);
      const data = asBytes(chunk.data);
      const integer16 = value => Number.isInteger(value) && value >= 0 && value <= 0xFFFF;
      if (!integer16(chunk.instance) || !integer16(chunk.schema) ||
          !integer16(chunk.encoding) || !integer16(chunk.flags)) {
        throw new Error(`Blok ${chunk.type} má neplatnou hlavičku.`);
      }
      return { ...chunk, data };
    });

    const payloadLength = normalized.reduce((sum, chunk) => sum + CHUNK_HEADER_SIZE + chunk.data.length, 0);
    const totalLength = HEADER_SIZE + payloadLength;
    if (totalLength > 0xFFFFFFFF) throw new Error('ESNAP je příliš velký.');

    const result = new Uint8Array(totalLength);
    result.set(MAGIC, 0);
    const view = new DataView(result.buffer);
    view.setUint16(8, options.versionMajor ?? VERSION_MAJOR, true);
    view.setUint16(10, options.versionMinor ?? VERSION_MINOR, true);
    view.setUint16(12, HEADER_SIZE, true);
    view.setUint16(14, CHUNK_HEADER_SIZE, true);
    view.setUint32(16, options.flags ?? 0, true);
    view.setUint32(20, normalized.length, true);
    view.setUint32(24, totalLength, true);

    let offset = HEADER_SIZE;
    for (const chunk of normalized) {
      for (let i = 0; i < 4; i++) result[offset + i] = chunk.type.charCodeAt(i);
      view.setUint16(offset + 4, chunk.instance, true);
      view.setUint16(offset + 6, chunk.schema, true);
      view.setUint16(offset + 8, chunk.encoding, true);
      view.setUint16(offset + 10, chunk.flags, true);
      view.setUint32(offset + 12, chunk.data.length, true);
      view.setUint32(offset + 16, chunk.data.length, true); // no compression in ESNAP 1.0
      view.setUint32(offset + 20, crc32(chunk.data), true);
      offset += CHUNK_HEADER_SIZE;
      result.set(chunk.data, offset);
      offset += chunk.data.length;
    }

    view.setUint32(28, crc32(result.subarray(HEADER_SIZE)), true);
    return result.buffer;
  }

  function decode(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < HEADER_SIZE) throw new Error('Soubor ESNAP je příliš krátký.');
    if (!MAGIC.every((value, i) => bytes[i] === value)) throw new Error('Soubor nemá identifikaci EMUSNAP.');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const versionMajor = view.getUint16(8, true);
    const versionMinor = view.getUint16(10, true);
    const headerSize = view.getUint16(12, true);
    const chunkHeaderSize = view.getUint16(14, true);
    const flags = view.getUint32(16, true);
    const chunkCount = view.getUint32(20, true);
    const totalLength = view.getUint32(24, true);
    const expectedPayloadCrc = view.getUint32(28, true);

    if (versionMajor !== VERSION_MAJOR) throw new Error(`Nepodporovaná hlavní verze ESNAP ${versionMajor}.`);
    if (headerSize !== HEADER_SIZE || chunkHeaderSize !== CHUNK_HEADER_SIZE) {
      throw new Error('Nepodporovaná velikost hlavičky ESNAP.');
    }
    if (chunkCount === 0 || chunkCount > MAX_CHUNKS || totalLength !== bytes.length) {
      throw new Error('ESNAP je neúplný nebo má neplatný počet bloků.');
    }
    if (crc32(bytes.subarray(HEADER_SIZE)) !== expectedPayloadCrc) {
      throw new Error('Kontrolní součet ESNAP nesouhlasí.');
    }

    const chunks = [];
    let offset = HEADER_SIZE;
    for (let index = 0; index < chunkCount; index++) {
      if (offset + CHUNK_HEADER_SIZE > bytes.length) throw new Error('ESNAP končí uprostřed hlavičky bloku.');
      const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      validateType(type);
      const instance = view.getUint16(offset + 4, true);
      const schema = view.getUint16(offset + 6, true);
      const encoding = view.getUint16(offset + 8, true);
      const chunkFlags = view.getUint16(offset + 10, true);
      const storedLength = view.getUint32(offset + 12, true);
      const unpackedLength = view.getUint32(offset + 16, true);
      const expectedCrc = view.getUint32(offset + 20, true);
      offset += CHUNK_HEADER_SIZE;

      if (storedLength !== unpackedLength) throw new Error(`Blok ${type} používá nepodporovanou kompresi.`);
      if (offset + storedLength > bytes.length) throw new Error(`Blok ${type} je neúplný.`);
      const data = bytes.slice(offset, offset + storedLength);
      if (crc32(data) !== expectedCrc) throw new Error(`Kontrolní součet bloku ${type} nesouhlasí.`);
      chunks.push({ type, instance, schema, encoding, flags: chunkFlags, data });
      offset += storedLength;
    }
    if (offset !== bytes.length) throw new Error('Za posledním blokem ESNAP jsou nadbytečná data.');

    return { versionMajor, versionMinor, flags, chunks };
  }

  function findChunk(snapshot, type, instance = 0, required = true) {
    const matches = snapshot.chunks.filter(chunk => chunk.type === type && chunk.instance === instance);
    if (matches.length > 1) throw new Error(`ESNAP obsahuje blok ${type}/${instance} vícekrát.`);
    if (!matches.length && required) throw new Error(`V ESNAP chybí blok ${type}/${instance}.`);
    return matches[0] ?? null;
  }

  function parseJsonChunk(chunk) {
    if (!chunk || chunk.encoding !== Encoding.JSON) throw new Error('Blok ESNAP nemá JSON kódování.');
    try {
      return JSON.parse(new TextDecoder().decode(chunk.data));
    } catch(e) {
      throw new Error(`JSON v bloku ${chunk.type} je poškozený.`);
    }
  }

  return Object.freeze({
    MAGIC: 'EMUSNAP\\0', VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, CHUNK_HEADER_SIZE,
    Encoding, ChunkFlags, crc32, rawChunk, jsonChunk, encode, decode, findChunk, parseJsonChunk
  });
});
