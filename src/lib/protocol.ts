import type { Packet, PacketKind, Player } from '../types';

// MC2 is the compact radio encoding; MC1 (verbose JSON) is still accepted from older clients and queued items.
export const PROTOCOL_PREFIX = 'MC2:';
export const LEGACY_PROTOCOL_PREFIX = 'MC1:';
export const WIRE_PREFIXES = [PROTOCOL_PREFIX, LEGACY_PROTOCOL_PREFIX] as const;
export const GAME_CHANNEL = '#chess';
export const MAX_PACKET_BYTES = 12_000;
export const MAX_SYNC_PACKET_BYTES = MAX_PACKET_BYTES;

export const PACKET_KINDS: readonly PacketKind[] = [
  'hello',
  'challenge',
  'withdraw',
  'accept',
  'move',
  'ack',
  'sync-request',
  'sync',
  'chat',
  'draw',
  'resign',
  'rematch',
  'result',
];

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const kinds = new Set<string>(PACKET_KINDS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayer(value: unknown): value is Player {
  return isObject(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.name === 'string';
}

function packetError(message: string): never {
  throw new Error(`Invalid MeshChess packet: ${message}`);
}

export function validatePacket(value: unknown): value is Packet {
  if (!isObject(value)) return false;
  if (value.v !== 1 || typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.kind !== 'string' || !kinds.has(value.kind)) return false;
  if (!isPlayer(value.from) || !('payload' in value)) return false;
  if (value.to !== undefined && typeof value.to !== 'string') return false;
  if (value.gameId !== undefined && typeof value.gameId !== 'string') return false;
  return typeof value.sentAt === 'number' && Number.isFinite(value.sentAt) && value.sentAt >= 0;
}

export function assertValidPacket(value: unknown): asserts value is Packet {
  if (!isObject(value)) packetError('expected an object');
  if (value.v !== 1) packetError('unsupported version');
  if (typeof value.id !== 'string' || value.id.length === 0) packetError('missing id');
  if (typeof value.kind !== 'string' || !kinds.has(value.kind)) packetError('unknown kind');
  if (!isPlayer(value.from)) packetError('invalid sender');
  if (value.to !== undefined && typeof value.to !== 'string') packetError('invalid recipient');
  if (value.gameId !== undefined && typeof value.gameId !== 'string') packetError('invalid game id');
  if (!('payload' in value)) packetError('missing payload');
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt) || value.sentAt < 0) {
    packetError('invalid timestamp');
  }
}

function assertSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error(`MeshChess packet exceeds ${MAX_PACKET_BYTES} UTF-8 bytes`);
  }
}

// Every LoRa fragment is a chance to lose the whole packet, so field names travel as single capitals.
// No long key is a single capital letter, which keeps the mapping unambiguous in both directions.
const SHORT_KEYS: Record<string, string> = {
  id: 'I', kind: 'K', from: 'F', to: 'T', gameId: 'G', payload: 'P', sentAt: 'S',
  challengeId: 'C', hostColor: 'H', white: 'W', black: 'B', name: 'N', promotion: 'Q',
  san: 'A', fen: 'X', packetId: 'D', moveCount: 'M', moves: 'Y', status: 'Z', winner: 'R',
  text: 'E', response: 'O', offerId: 'U', outcome: 'J', reason: 'L', color: 'V',
};
const LONG_KEYS = Object.fromEntries(Object.entries(SHORT_KEYS).map(([long, short]) => [short, long]));

function renameKeys(value: unknown, table: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => renameKeys(entry, table));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [table[key] ?? key, renameKeys(entry, table)]));
}

export function encodePacket(packet: Packet): string {
  assertValidPacket(packet);
  const { v: _version, ...body } = packet;
  const wire = PROTOCOL_PREFIX + JSON.stringify(renameKeys(body, SHORT_KEYS));
  assertSize(encoder.encode(wire));
  return wire;
}

export function decodePacket<T = unknown>(wire: string | Uint8Array | ArrayBuffer): Packet<T> {
  const bytes = typeof wire === 'string'
    ? encoder.encode(wire)
    : wire instanceof Uint8Array
      ? wire
      : new Uint8Array(wire);
  assertSize(bytes);

  let text: string;
  try {
    text = typeof wire === 'string' ? wire : decoder.decode(bytes);
  } catch {
    throw new Error('Invalid MeshChess packet: malformed UTF-8');
  }
  const compact = text.startsWith(PROTOCOL_PREFIX);
  if (!compact && !text.startsWith(LEGACY_PROTOCOL_PREFIX)) packetError('missing MC2/MC1 prefix');

  let value: unknown;
  try {
    value = JSON.parse(text.slice(PROTOCOL_PREFIX.length));
  } catch {
    throw new Error('Invalid MeshChess packet: malformed JSON');
  }
  if (compact) {
    if (!isObject(value)) packetError('expected an object');
    value = { v: 1, ...(renameKeys(value, LONG_KEYS) as Record<string, unknown>) };
  }
  assertValidPacket(value);
  return value as Packet<T>;
}

// 10 base-36 characters (~51 bits) is ample for a local mesh and far cheaper on air than a UUID.
export function uniqueId(prefix = 'mc'): string {
  const bytes = new Uint8Array(8);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `${prefix}_${value.toString(36).padStart(10, '0').slice(-10)}`;
}

export async function hashtagKey(name: string = GAME_CHANNEL): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', encoder.encode(name));
  return new Uint8Array(digest, 0, 16);
}

export const channelKey = hashtagKey;
