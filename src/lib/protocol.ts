import type { Packet, PacketKind, Player } from '../types';

export const PROTOCOL_PREFIX = 'MC1:';
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

export function encodePacket(packet: Packet): string {
  assertValidPacket(packet);
  const wire = PROTOCOL_PREFIX + JSON.stringify(packet);
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
  if (!text.startsWith(PROTOCOL_PREFIX)) packetError('missing MC1 prefix');

  let value: unknown;
  try {
    value = JSON.parse(text.slice(PROTOCOL_PREFIX.length));
  } catch {
    throw new Error('Invalid MeshChess packet: malformed JSON');
  }
  assertValidPacket(value);
  return value as Packet<T>;
}

export function uniqueId(prefix = 'mc'): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return `${prefix}_${cryptoApi.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (cryptoApi) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return `${prefix}_${Date.now().toString(36)}_${hex(bytes)}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashtagKey(name: string = GAME_CHANNEL): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', encoder.encode(name));
  return new Uint8Array(digest, 0, 16);
}

export const channelKey = hashtagKey;
