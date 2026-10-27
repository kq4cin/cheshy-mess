import { GAME_CHANNEL, hashtagKey, MAX_PACKET_BYTES, WIRE_PREFIXES } from './protocol';
import type { TransportKind, TransportState } from '../types';

export const SERIAL_BAUD_RATE = 115200;
// Firmware caps channel text at 160 bytes including the "<node name>: " prefix (node names are <= 31 bytes).
export const RADIO_TEXT_MAX_BYTES = 120;
export const FRAGMENT_DELAY_MS = 1_200;
export const FRAGMENT_ASSEMBLY_TTL_MS = 120_000;
export const MAX_FRAGMENT_ASSEMBLIES = 16;
export const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// 72 bytes base64-encode to 96 characters; with the MCF header a fragment stays within RADIO_TEXT_MAX_BYTES.
export const FRAGMENT_PAYLOAD_BYTES = 72;
const MAX_FRAGMENTS = Math.ceil(MAX_PACKET_BYTES / FRAGMENT_PAYLOAD_BYTES);
const FRAGMENT_PATTERN = /^MCF:([A-Za-z0-9]{4,12}):(\d{1,3}):(\d{1,3}):([A-Za-z0-9+/]*={0,2})$/;

export const CompanionCode = {
  OK: 0,
  ERROR: 1,
  SELF_INFO: 5,
  MESSAGE_SENT: 6,
  CONTACT_MESSAGE: 7,
  CHANNEL_MESSAGE: 8,
  NO_MORE_MESSAGES: 10,
  DEVICE_INFO: 13,
  CONTACT_MESSAGE_V3: 16,
  CHANNEL_MESSAGE_V3: 17,
  CHANNEL_INFO: 18,
  MESSAGES_WAITING: 131,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return encodeBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function nextFragmentId(): string {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return hex(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function encodeSerialFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 0xffff) throw new Error('MeshCore frame is too large');
  const frame = new Uint8Array(payload.byteLength + 3);
  frame[0] = 0x3c;
  frame[1] = payload.byteLength & 0xff;
  frame[2] = payload.byteLength >>> 8;
  frame.set(payload, 3);
  return frame;
}

export class SerialFrameParser {
  private buffered = new Uint8Array(0);

  constructor(private readonly maxPayloadBytes = 0xffff) {
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 0 || maxPayloadBytes > 0xffff) {
      throw new RangeError('Invalid maximum serial payload size');
    }
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.byteLength);
    this.buffered = joined;

    const frames: Uint8Array[] = [];
    let cursor = 0;
    while (cursor < this.buffered.byteLength) {
      if (this.buffered[cursor] !== 0x3e) {
        cursor += 1;
        continue;
      }
      if (this.buffered.byteLength - cursor < 3) break;
      const length = this.buffered[cursor + 1] | (this.buffered[cursor + 2] << 8);
      if (length > this.maxPayloadBytes) {
        cursor += 1;
        continue;
      }
      if (this.buffered.byteLength - cursor < length + 3) break;
      frames.push(this.buffered.slice(cursor + 3, cursor + 3 + length));
      cursor += length + 3;
    }
    this.buffered = this.buffered.slice(cursor);
    return frames;
  }

  reset(): void {
    this.buffered = new Uint8Array(0);
  }
}

export interface Transport {
  send(text: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface TransportCallbacks {
  onMessage?: (text: string) => void;
  onDirectMessage?: (message: DirectTextMessage) => void;
  onState?: (state: TransportState) => void;
  onLog?: (text: string) => void;
}

export interface ChannelTextMessage {
  channel: number;
  pathLength: number;
  textType: number;
  timestamp: number;
  snr: number | null;
  text: string;
}

export interface DirectTextMessage {
  sender: string;
  pathLength: number;
  textType: number;
  timestamp: number;
  snr: number | null;
  text: string;
}

function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes).replace(/\0+$/u, '');
}

// Firmware strcpy()s names into a reused buffer, so bytes after the first NUL are stale garbage.
function decodeCString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return textDecoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const FRAGMENT_PREFIX = 'MCF:';
const PAYLOAD_PREFIXES = [FRAGMENT_PREFIX, ...WIRE_PREFIXES];

// Firmware sends channel text as "<sender node name>: <text>"; recover the app payload after that prefix.
export function stripSenderPrefix(text: string): string {
  if (PAYLOAD_PREFIXES.some((prefix) => text.startsWith(prefix))) return text;
  let best = -1;
  for (const prefix of PAYLOAD_PREFIXES) {
    const index = text.indexOf(`: ${prefix}`);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best < 0 ? text : text.slice(best + 2);
}

export function radioMessageCount(text: string): number {
  const bytes = textEncoder.encode(text).byteLength;
  return bytes <= RADIO_TEXT_MAX_BYTES && !text.startsWith(FRAGMENT_PREFIX) ? 1 : Math.ceil(bytes / FRAGMENT_PAYLOAD_BYTES);
}

export function parseChannelMessage(frame: Uint8Array): ChannelTextMessage | null {
  if (frame.byteLength < 8) return null;
  const version3 = frame[0] === CompanionCode.CHANNEL_MESSAGE_V3;
  if (frame[0] !== CompanionCode.CHANNEL_MESSAGE && !version3) return null;
  const offset = version3 ? 4 : 1;
  if (frame.byteLength < offset + 7) return null;
  const snr = version3 ? ((frame[1] << 24) >> 24) / 4 : null;
  const timestampOffset = offset + 3;
  const timestamp = new DataView(frame.buffer, frame.byteOffset + timestampOffset, 4).getUint32(0, true);
  return {
    channel: frame[offset],
    pathLength: frame[offset + 1],
    textType: frame[offset + 2],
    timestamp,
    snr,
    text: decodeText(frame.subarray(offset + 7)),
  };
}

export function parseDirectMessage(frame: Uint8Array): DirectTextMessage | null {
  if (frame.byteLength < 13) return null;
  const version3 = frame[0] === CompanionCode.CONTACT_MESSAGE_V3;
  if (frame[0] !== CompanionCode.CONTACT_MESSAGE && !version3) return null;
  const offset = version3 ? 4 : 1;
  if (frame.byteLength < offset + 12) return null;
  const snr = version3 ? ((frame[1] << 24) >> 24) / 4 : null;
  const textType = frame[offset + 7];
  const timestampOffset = offset + 8;
  const textOffset = timestampOffset + 4 + (textType === 2 ? 4 : 0);
  if (frame.byteLength < textOffset) return null;
  const timestamp = new DataView(frame.buffer, frame.byteOffset + timestampOffset, 4).getUint32(0, true);
  return {
    sender: hex(frame.subarray(offset, offset + 6)),
    pathLength: frame[offset + 6],
    textType,
    timestamp,
    snr,
    text: decodeText(frame.subarray(textOffset)),
  };
}

export type FrameWriter = (frame: Uint8Array) => void | Promise<void>;

export interface MeshCoreOptions {
  appName?: string;
  channelName?: string;
  timeoutMs?: number;
  syncIntervalMs?: number;
  fragmentDelayMs?: number;
  maxChannels?: number;
}

interface PendingRequest {
  expected: readonly number[];
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface FragmentAssembly {
  chunks: (Uint8Array | undefined)[];
  received: number;
  byteLength: number;
  expiresAt: number;
}

export class MeshCoreClient {
  private pending: PendingRequest | null = null;
  private requestTail: Promise<void> = Promise.resolve();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncTask: Promise<void> | null = null;
  private readonly assemblies = new Map<string, FragmentAssembly>();
  private readonly completedAssemblies = new Map<string, number>();
  private running = false;
  private maxChannels: number;
  private channel: number | null = null;

  constructor(
    private readonly writeFrame: FrameWriter,
    private readonly callbacks: TransportCallbacks = {},
    private readonly options: MeshCoreOptions = {},
  ) {
    this.maxChannels = options.maxChannels ?? 8;
  }

  get channelIndex(): number | null {
    return this.channel;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const device = await this.request(Uint8Array.of(0x16, 0x03), CompanionCode.DEVICE_INFO);
      if (device.byteLength > 3 && device[1] >= 3 && device[3] > 0) this.maxChannels = Math.min(device[3], 64);
      this.callbacks.onLog?.(`Companion firmware code v${device[1] ?? '?'}, ${this.maxChannels} channel slots`);
      const appName = textEncoder.encode(this.options.appName ?? 'Cheshy Mess');
      const appStart = new Uint8Array(8 + appName.byteLength);
      appStart[0] = 0x01;
      appStart[1] = 3;
      appStart.set(appName, 8);
      await this.request(appStart, CompanionCode.SELF_INFO);
      this.channel = await this.ensureChannel(this.options.channelName ?? GAME_CHANNEL);
      this.syncTimer = setInterval(() => {
        void this.syncNow().catch((error: unknown) => this.reportError(error));
      }, this.options.syncIntervalMs ?? 90_000);
      // Draining queued messages is best-effort; a slow first sync must not abort a working connection.
      await this.syncNow().catch((error: unknown) => this.reportError(error));
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  request(command: Uint8Array, expected: number | readonly number[], timeoutMs = this.options.timeoutMs ?? 5_000): Promise<Uint8Array> {
    const expectedCodes = typeof expected === 'number' ? [expected] : expected;
    const result = this.requestTail.then(() => this.performRequest(command, expectedCodes, timeoutMs));
    this.requestTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performRequest(command: Uint8Array, expected: readonly number[], timeoutMs: number): Promise<Uint8Array> {
    if (!this.running) throw new Error('MeshCore client is stopped');
    if (this.pending) throw new Error('MeshCore command already pending');
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`MeshCore response timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { expected, resolve, reject, timer };
      Promise.resolve().then(() => this.writeFrame(command)).catch((error: unknown) => {
        if (!this.pending) return;
        clearTimeout(this.pending.timer);
        this.pending = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  handleFrame(frame: Uint8Array): void {
    if (frame.byteLength === 0) return;
    const code = frame[0];
    if (code === CompanionCode.CHANNEL_MESSAGE || code === CompanionCode.CHANNEL_MESSAGE_V3) {
      const message = parseChannelMessage(frame);
      if (message && (this.channel === null || message.channel === this.channel)) {
        this.receiveChannelText(message.text);
      }
    } else if (code === CompanionCode.CONTACT_MESSAGE || code === CompanionCode.CONTACT_MESSAGE_V3) {
      const message = parseDirectMessage(frame);
      if (message) this.callbacks.onDirectMessage?.(message);
    }

    const pending = this.pending;
    if (pending && code === CompanionCode.ERROR) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(new Error(`MeshCore command failed with code ${frame[1] ?? 'unknown'}`));
    } else if (pending?.expected.includes(code)) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.resolve(frame);
    }

    if (code === CompanionCode.MESSAGES_WAITING && this.running) {
      void this.syncNow().catch((error: unknown) => this.reportError(error));
    }
  }

  private receiveChannelText(raw: string): void {
    const text = stripSenderPrefix(raw);
    const match = FRAGMENT_PATTERN.exec(text);
    if (!match) {
      this.callbacks.onMessage?.(text);
      return;
    }

    const now = Date.now();
    for (const [id, assembly] of this.assemblies) {
      if (assembly.expiresAt <= now) this.assemblies.delete(id);
    }
    for (const [id, expiresAt] of this.completedAssemblies) {
      if (expiresAt <= now) this.completedAssemblies.delete(id);
    }

    const [, id, indexText, totalText, encoded] = match;
    const index = Number(indexText);
    const total = Number(totalText);
    if (this.completedAssemblies.has(id) || total < 1 || total > MAX_FRAGMENTS || index >= total) return;
    const payload = decodeBase64(encoded);
    if (!payload) return;
    const last = index === total - 1;
    if ((!last && payload.byteLength !== FRAGMENT_PAYLOAD_BYTES)
      || (last && (payload.byteLength < 1 || payload.byteLength > FRAGMENT_PAYLOAD_BYTES))) return;

    let assembly = this.assemblies.get(id);
    if (assembly && assembly.chunks.length !== total) {
      this.assemblies.delete(id);
      return;
    }
    if (!assembly) {
      // A lost fragment strands its partial packet until it expires; evict the stalest one instead of
      // refusing new packets, otherwise a few RF losses would block all incoming traffic for minutes.
      if (this.assemblies.size >= MAX_FRAGMENT_ASSEMBLIES) {
        let stalest: string | null = null;
        let stalestExpiry = Infinity;
        for (const [candidate, entry] of this.assemblies) {
          if (entry.expiresAt < stalestExpiry) {
            stalest = candidate;
            stalestExpiry = entry.expiresAt;
          }
        }
        if (stalest) this.assemblies.delete(stalest);
      }
      assembly = {
        chunks: Array.from({ length: total }),
        received: 0,
        byteLength: 0,
        expiresAt: now + FRAGMENT_ASSEMBLY_TTL_MS,
      };
      this.assemblies.set(id, assembly);
    }

    const previous = assembly.chunks[index];
    if (previous) {
      if (!equalBytes(previous, payload)) this.assemblies.delete(id);
      return;
    }
    if (assembly.byteLength + payload.byteLength > MAX_PACKET_BYTES) {
      this.assemblies.delete(id);
      return;
    }
    assembly.chunks[index] = payload;
    assembly.received += 1;
    assembly.byteLength += payload.byteLength;
    assembly.expiresAt = now + FRAGMENT_ASSEMBLY_TTL_MS;
    if (assembly.received !== total) return;

    const joined = new Uint8Array(assembly.byteLength);
    let offset = 0;
    for (const chunk of assembly.chunks) {
      if (!chunk) return;
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.assemblies.delete(id);
    this.completedAssemblies.set(id, now + FRAGMENT_ASSEMBLY_TTL_MS);
    if (this.completedAssemblies.size > MAX_FRAGMENT_ASSEMBLIES * 2) {
      const oldest = this.completedAssemblies.keys().next().value;
      if (oldest) this.completedAssemblies.delete(oldest);
    }
    try {
      this.callbacks.onMessage?.(strictTextDecoder.decode(joined));
    } catch {
      return;
    }
  }

  async ensureChannel(name = GAME_CHANNEL): Promise<number> {
    const nameBytes = textEncoder.encode(name);
    if (nameBytes.byteLength > 32) throw new Error('MeshCore channel name exceeds 32 UTF-8 bytes');
    const secret = await hashtagKey(name);
    const slots: { index: number; name: string; secret: Uint8Array }[] = [];
    for (let index = 0; index < this.maxChannels; index += 1) {
      let response: Uint8Array;
      try {
        response = await this.request(Uint8Array.of(0x1f, index), CompanionCode.CHANNEL_INFO, 2_500);
      } catch {
        break; // ERR_CODE_NOT_FOUND (or no reply) marks the end of the radio's channel table
      }
      if (response.byteLength < 50) break;
      slots.push({ index: response[1], name: decodeCString(response.subarray(2, 34)), secret: response.slice(34, 50) });
    }
    if (!slots.length) throw new Error('Radio did not report any channels (companion firmware too old?)');
    const named = slots.filter((slot) => slot.name || slot.secret.some((byte) => byte !== 0));
    this.callbacks.onLog?.(`Radio channels: ${named.map((slot) => `${slot.index}:${slot.name || '(unnamed)'}`).join(', ') || 'none'}`);

    // Match on the secret like Mesh Wars: the key is what makes traffic interoperable, names are cosmetic.
    const found = slots.find((slot) => equalBytes(slot.secret, secret));
    if (found) {
      this.callbacks.onLog?.(`Game channel ${name} found in slot ${found.index}`);
      return found.index;
    }
    const lookalike = named.find((slot) => slot.name.replace(/^#+/, '').toLowerCase() === name.replace(/^#+/, '').toLowerCase());
    if (lookalike) {
      this.callbacks.onLog?.(`Slot ${lookalike.index} is named ${lookalike.name} but uses a different key; ${name} must be added as a public hashtag channel`);
    }

    const free = slots.find((slot) => slot.index !== 0 && !slot.name && slot.secret.every((byte) => byte === 0));
    if (!free) throw new Error(`No free MeshCore channel slot for ${name} - remove a channel in the MeshCore app, then reconnect`);

    const command = new Uint8Array(50);
    command[0] = 0x20;
    command[1] = free.index;
    command.set(nameBytes.subarray(0, 31), 2);
    command.set(secret, 34);
    try {
      await this.request(command, CompanionCode.OK);
    } catch (error) {
      throw new Error(`Radio refused to create ${name} in slot ${free.index}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.callbacks.onLog?.(`Created public channel ${name} in slot ${free.index}`);
    return free.index;
  }

  async sendChannel(text: string, at = Date.now()): Promise<void> {
    if (this.channel === null) throw new Error('MeshChess channel is not configured');
    const bytes = textEncoder.encode(text);
    if (bytes.byteLength > MAX_PACKET_BYTES) throw new Error(`MeshChess message exceeds ${MAX_PACKET_BYTES} UTF-8 bytes`);
    if (bytes.byteLength <= RADIO_TEXT_MAX_BYTES && !text.startsWith('MCF:')) {
      await this.sendRawChannel(text, at);
      return;
    }

    const id = nextFragmentId();
    const total = Math.ceil(bytes.byteLength / FRAGMENT_PAYLOAD_BYTES);
    for (let index = 0; index < total; index += 1) {
      const payload = bytes.subarray(index * FRAGMENT_PAYLOAD_BYTES, (index + 1) * FRAGMENT_PAYLOAD_BYTES);
      const envelope = `MCF:${id}:${index}:${total}:${encodeBase64(payload)}`;
      await this.sendRawChannel(envelope, at);
      if (index + 1 < total) {
        const delay = this.options.fragmentDelayMs ?? FRAGMENT_DELAY_MS;
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async sendRawChannel(text: string, at: number): Promise<void> {
    if (this.channel === null) throw new Error('MeshChess channel is not configured');
    const message = textEncoder.encode(text);
    if (message.byteLength > RADIO_TEXT_MAX_BYTES) throw new Error('MeshCore radio text exceeds 96 UTF-8 bytes');
    const command = new Uint8Array(7 + message.byteLength);
    command[0] = 0x03;
    command[1] = 0;
    command[2] = this.channel;
    new DataView(command.buffer).setUint32(3, Math.floor(at / 1000), true);
    command.set(message, 7);
    await this.request(command, [CompanionCode.OK, CompanionCode.MESSAGE_SENT]);
  }

  syncNow(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.syncTask) return this.syncTask;
    this.syncTask = (async () => {
      for (let count = 0; count < 100; count += 1) {
        const response = await this.request(
          Uint8Array.of(0x0a),
          [CompanionCode.NO_MORE_MESSAGES, CompanionCode.CHANNEL_MESSAGE, CompanionCode.CHANNEL_MESSAGE_V3, CompanionCode.CONTACT_MESSAGE, CompanionCode.CONTACT_MESSAGE_V3],
        );
        if (response[0] === CompanionCode.NO_MORE_MESSAGES) return;
      }
      throw new Error('MeshCore message sync did not finish');
    })().finally(() => {
      this.syncTask = null;
    });
    return this.syncTask;
  }

  stop(): void {
    this.running = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.assemblies.clear();
    this.completedAssemblies.clear();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('MeshCore client stopped'));
      this.pending = null;
    }
  }

  private reportError(error: unknown): void {
    this.callbacks.onLog?.(error instanceof Error ? error.message : String(error));
  }
}

export interface SerialReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
  releaseLock(): void;
}

export interface SerialWriterLike {
  write(data: Uint8Array): Promise<void>;
  releaseLock(): void;
}

export interface SerialPortLike {
  readable: { getReader(): SerialReaderLike } | null;
  writable: { getWriter(): SerialWriterLike } | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface SerialNavigator {
  requestPort(): Promise<SerialPortLike>;
}

export class SerialAdapter implements Transport {
  private port: SerialPortLike | null = null;
  private reader: SerialReaderLike | null = null;
  private writer: SerialWriterLike | null = null;
  private readTask: Promise<void> | null = null;
  private client: MeshCoreClient | null = null;
  private disconnecting = false;

  constructor(
    private readonly callbacks: TransportCallbacks = {},
    private readonly options: MeshCoreOptions = {},
  ) {}

  async connect(port?: SerialPortLike): Promise<void> {
    this.emit('connecting', 'Opening serial radio');
    this.disconnecting = false;
    try {
      const serial = (globalThis.navigator as Navigator & { serial?: SerialNavigator } | undefined)?.serial;
      this.port = port ?? await serial?.requestPort() ?? null;
      if (!this.port) throw new Error('Web Serial is unavailable');
      await this.port.open({ baudRate: SERIAL_BAUD_RATE });
      if (!this.port.readable || !this.port.writable) throw new Error('Serial port streams are unavailable');
      this.writer = this.port.writable.getWriter();
      const writer = this.writer;
      const parser = new SerialFrameParser();
      this.client = new MeshCoreClient(
        async (frame) => writer.write(encodeSerialFrame(frame)),
        this.callbacks,
        this.options,
      );
      this.reader = this.port.readable.getReader();
      this.readTask = this.readLoop(parser);
      await this.client.start();
      this.emit('connected', 'Serial radio connected', this.client.channelIndex ?? undefined);
    } catch (error) {
      await this.close();
      this.emit('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async send(text: string): Promise<void> {
    if (!this.client) throw new Error('Serial radio is not connected');
    await this.client.sendChannel(text);
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    await this.close();
    this.emit('offline', 'Serial radio disconnected');
  }

  private async readLoop(parser: SerialFrameParser): Promise<void> {
    while (!this.disconnecting && this.reader) {
      const reader = this.reader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) for (const frame of parser.push(value)) this.client?.handleFrame(frame);
        }
      } catch (error) {
        if (!this.disconnecting) this.callbacks.onLog?.(`Serial read error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.disconnecting) return;
      // Recoverable errors (e.g. buffer overrun) leave the port open with a fresh readable stream.
      try {
        reader.releaseLock();
      } catch {}
      this.reader = null;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (this.disconnecting || !this.port?.readable) break;
      parser.reset();
      this.reader = this.port.readable.getReader();
    }
    if (!this.disconnecting) {
      this.client?.stop();
      this.emit('offline', 'Serial radio disconnected');
    }
  }

  private async close(): Promise<void> {
    this.disconnecting = true;
    this.client?.stop();
    this.client = null;
    const reader = this.reader;
    this.reader = null;
    if (reader?.cancel) await reader.cancel().catch(() => undefined);
    if (this.readTask) await this.readTask;
    this.readTask = null;
    try {
      reader?.releaseLock();
    } catch {}
    const writer = this.writer;
    this.writer = null;
    try {
      writer?.releaseLock();
    } catch {}
    const port = this.port;
    this.port = null;
    if (port) await port.close().catch(() => undefined);
  }

  private emit(status: TransportState['status'], detail: string, channel?: number): void {
    this.callbacks.onState?.({
      kind: 'serial',
      status,
      detail,
      ...(channel === undefined ? {} : { channel, channelName: this.options.channelName ?? GAME_CHANNEL }),
    });
  }
}

export interface BluetoothCharacteristicLike {
  value?: DataView;
  startNotifications(): Promise<void>;
  stopNotifications?(): Promise<void>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
  writeValueWithResponse?(data: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(data: Uint8Array): Promise<void>;
  writeValue?(data: Uint8Array): Promise<void>;
}

interface BluetoothServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

interface BluetoothGattLike {
  connected: boolean;
  connect(): Promise<BluetoothGattLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothServiceLike>;
}

export interface BluetoothDeviceLike {
  gatt?: BluetoothGattLike;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

interface BluetoothNavigator {
  requestDevice(options: unknown): Promise<BluetoothDeviceLike>;
}

export class BLEAdapter implements Transport {
  private device: BluetoothDeviceLike | null = null;
  private tx: BluetoothCharacteristicLike | null = null;
  private client: MeshCoreClient | null = null;
  private readonly notificationListener = (event: Event): void => {
    const characteristic = event.target as unknown as BluetoothCharacteristicLike;
    const value = characteristic.value;
    if (value) this.client?.handleFrame(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
  };
  private readonly disconnectListener = (): void => {
    this.client?.stop();
    this.emit('offline', 'Bluetooth radio disconnected');
  };

  constructor(
    private readonly callbacks: TransportCallbacks = {},
    private readonly options: MeshCoreOptions = {},
  ) {}

  async connect(device?: BluetoothDeviceLike): Promise<void> {
    this.emit('connecting', 'Opening Bluetooth radio');
    try {
      const bluetooth = (globalThis.navigator as Navigator & { bluetooth?: BluetoothNavigator } | undefined)?.bluetooth;
      this.device = device ?? await bluetooth?.requestDevice({
        filters: [{ services: [NORDIC_UART_SERVICE] }, { namePrefix: 'MeshCore' }],
        optionalServices: [NORDIC_UART_SERVICE],
      }) ?? null;
      if (!this.device?.gatt) throw new Error('Web Bluetooth is unavailable');
      const gatt = await this.device.gatt.connect();
      const service = await gatt.getPrimaryService(NORDIC_UART_SERVICE);
      const rx = await service.getCharacteristic(NORDIC_UART_RX);
      this.tx = await service.getCharacteristic(NORDIC_UART_TX);
      this.tx.addEventListener('characteristicvaluechanged', this.notificationListener);
      await this.tx.startNotifications();
      this.device.addEventListener?.('gattserverdisconnected', this.disconnectListener);
      this.client = new MeshCoreClient(async (frame) => {
        if (rx.writeValueWithResponse) await rx.writeValueWithResponse(frame);
        else if (rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(frame);
        else if (rx.writeValue) await rx.writeValue(frame);
        else throw new Error('Bluetooth UART RX characteristic is not writable');
      }, this.callbacks, this.options);
      await this.client.start();
      this.emit('connected', 'Bluetooth radio connected', this.client.channelIndex ?? undefined);
    } catch (error) {
      await this.close();
      this.emit('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async send(text: string): Promise<void> {
    if (!this.client) throw new Error('Bluetooth radio is not connected');
    await this.client.sendChannel(text);
  }

  async disconnect(): Promise<void> {
    await this.close();
    this.emit('offline', 'Bluetooth radio disconnected');
  }

  private async close(): Promise<void> {
    this.client?.stop();
    this.client = null;
    if (this.tx) {
      this.tx.removeEventListener?.('characteristicvaluechanged', this.notificationListener);
      await this.tx.stopNotifications?.().catch(() => undefined);
    }
    this.tx = null;
    this.device?.removeEventListener?.('gattserverdisconnected', this.disconnectListener);
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.device = null;
  }

  private emit(status: TransportState['status'], detail: string, channel?: number): void {
    this.callbacks.onState?.({
      kind: 'ble',
      status,
      detail,
      ...(channel === undefined ? {} : { channel, channelName: this.options.channelName ?? GAME_CHANNEL }),
    });
  }
}

export function supportsSerial(): boolean {
  const serial = (globalThis.navigator as Navigator & { serial?: SerialNavigator } | undefined)?.serial;
  return typeof serial?.requestPort === 'function';
}

export function supportsBluetooth(): boolean {
  const bluetooth = (globalThis.navigator as Navigator & { bluetooth?: BluetoothNavigator } | undefined)?.bluetooth;
  return typeof bluetooth?.requestDevice === 'function';
}

export function supportsTransport(kind: TransportKind): boolean {
  if (kind === 'serial') return supportsSerial();
  if (kind === 'ble') return supportsBluetooth();
  return true;
}

export const isSerialSupported = supportsSerial;
export const isBluetoothSupported = supportsBluetooth;
