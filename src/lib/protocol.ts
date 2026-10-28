import { Chess } from 'chess.js';
import type { MovePayload, MoveRecord, Packet, PacketKind, Player } from '../types';

// Older encodings remain readable for saved queues and incoming traffic.
export const PROTOCOL_PREFIX = 'MC3:';
export const COMPACT_PROTOCOL_PREFIX = 'MC2:';
export const LEGACY_PROTOCOL_PREFIX = 'MC1:';
export const WIRE_PREFIXES = [PROTOCOL_PREFIX, COMPACT_PROTOCOL_PREFIX, LEGACY_PROTOCOL_PREFIX] as const;
export const GAME_CHANNEL = '#chess';
export const MAX_PACKET_BYTES = 12_000;
export const MAX_SYNC_PACKET_BYTES = MAX_PACKET_BYTES;

// MC3 uses these indices on air: append new kinds, never reorder.
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

const ID_PREFIXES = ['mc', 'player', 'game', ...PACKET_KINDS, 'outbox'];

function packId(value: string): string {
  const match = /^([a-z-]+)_([a-z0-9]{10})$/.exec(value);
  const index = match ? ID_PREFIXES.indexOf(match[1]) : -1;
  return match && index >= 0 ? `~${index.toString(36)}${match[2]}` : value.startsWith('~') ? `~${value}` : value;
}

function unpackId(value: string): string {
  if (value.startsWith('~~')) return value.slice(1);
  const match = /^~([0-9a-z])([a-z0-9]{10})$/.exec(value);
  const prefix = match ? ID_PREFIXES[parseInt(match[1], 36)] : undefined;
  return match && prefix ? `${prefix}_${match[2]}` : value;
}

function transformIds(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((entry) => transformIds(entry, transform));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, transformIds(entry, transform)]));
}

function packPayload(packet: Packet): unknown[] {
  const payload = packet.payload;
  if (packet.kind === 'move' && isObject(payload)
    && typeof payload.n === 'number' && typeof payload.from === 'string' && typeof payload.to === 'string'
    && /^[a-h][1-8]$/.test(payload.from) && /^[a-h][1-8]$/.test(payload.to)
    && (payload.promotion === undefined || /^[qrbn]$/.test(String(payload.promotion)))
    && typeof payload.san === 'string' && (payload.fen === undefined || typeof payload.fen === 'string')
    && Object.keys(payload).every((key) => ['n', 'from', 'to', 'promotion', 'san', 'fen'].includes(key))) {
    return [1, payload.n, payload.from + payload.to + (payload.promotion ?? ''), payload.san,
      ...(payload.fen === undefined ? [] : [payload.fen])];
  }
  if (packet.kind === 'ack' && isObject(payload)
    && typeof payload.packetId === 'string' && typeof payload.moveCount === 'number'
    && (payload.gameId === undefined || typeof payload.gameId === 'string')
    && Object.keys(payload).every((key) => ['packetId', 'moveCount', 'gameId'].includes(key))) {
    return [3, payload.packetId, payload.moveCount,
      ...(payload.gameId === undefined ? [] : [payload.gameId === packet.gameId ? 1 : payload.gameId])];
  }
  if (packet.kind === 'sync' && isObject(payload) && Array.isArray(payload.moves)
    && Object.keys(payload).every((key) => ['moves', 'status', 'winner', 'base', 'baseFen', 'basePacketId'].includes(key))) {
    const records: unknown[] = [];
    for (const move of payload.moves) {
      if (!isObject(move) || typeof move.from !== 'string' || typeof move.to !== 'string') {
        return [0, renameKeys(payload, SHORT_KEYS)];
      }
      records.push([move.from + move.to + (move.promotion ?? ''), move.packetId, move.at]);
    }
    const compact = [2, payload.status, payload.winner ?? null, payload.base ?? null,
      payload.baseFen ?? null, payload.basePacketId ?? null, records];
    // Only discard derived metadata if replay reproduces it exactly.
    const restored = unpackPayload('sync', compact);
    if (isObject(restored) && Array.isArray(restored.moves)) {
      const replayed = restored.moves;
      const sameMetadata = Object.keys(payload).every((key) => key === 'moves' || payload[key] === restored[key])
        && Object.keys(restored).every((key) => key === 'moves' || payload[key] === restored[key]);
      const sameMoves = payload.moves.every((move: unknown, index: number) => {
        const other: unknown = replayed[index];
        return isObject(move) && isObject(other)
          && Object.keys(move).every((key) => move[key] === other[key])
          && Object.keys(other).every((key) => move[key] === other[key]);
      });
      if (sameMetadata && sameMoves) return compact;
    }
  }
  return [0, renameKeys(payload, SHORT_KEYS)];
}

function unpackPayload(kind: PacketKind, value: unknown, gameId?: string): unknown {
  if (!Array.isArray(value)) packetError('invalid compact payload');
  if (value[0] === 0 && value.length === 2) return renameKeys(value[1], LONG_KEYS);
  if (kind === 'move' && value[0] === 1 && (value.length === 4 || value.length === 5)) {
    const [, n, coordinates, san, fen] = value;
    if (typeof n !== 'number' || typeof coordinates !== 'string'
      || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(coordinates) || typeof san !== 'string'
      || (fen !== undefined && typeof fen !== 'string')) packetError('invalid compact move');
    const payload: MovePayload = {
      n, from: coordinates.slice(0, 2), to: coordinates.slice(2, 4),
      ...(coordinates.length === 5 ? { promotion: coordinates[4] } : {}),
      san, ...(fen === undefined ? {} : { fen }),
    };
    return payload;
  }
  if (kind === 'ack' && value[0] === 3 && (value.length === 3 || value.length === 4)) {
    const [, packetId, moveCount, game] = value;
    if (typeof packetId !== 'string' || typeof moveCount !== 'number'
      || (game !== undefined && typeof game !== 'string' && !(game === 1 && gameId !== undefined))) packetError('invalid compact ack');
    return { packetId, moveCount, ...(game === undefined ? {} : { gameId: game === 1 ? gameId : game }) };
  }
  if (kind === 'sync' && value[0] === 2 && value.length === 7) {
    const [, status, winner, base, baseFen, basePacketId, records] = value;
    if (typeof status !== 'string' || (winner !== null && winner !== 'w' && winner !== 'b')
      || (base !== null && (!Number.isSafeInteger(base) || base < 0))
      || (baseFen !== null && typeof baseFen !== 'string')
      || (basePacketId !== null && typeof basePacketId !== 'string') || !Array.isArray(records)) packetError('invalid compact history');
    const chess = baseFen === null ? new Chess() : new Chess(baseFen);
    const moves: MoveRecord[] = records.map((record: unknown) => {
      if (!Array.isArray(record) || record.length !== 3) packetError('invalid compact history move');
      const [coordinates, packetId, at] = record;
      if (typeof coordinates !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(coordinates)
        || typeof packetId !== 'string' || !packetId || typeof at !== 'number' || !Number.isFinite(at)) packetError('invalid compact history move');
      const move = chess.move({
        from: coordinates.slice(0, 2), to: coordinates.slice(2, 4),
        ...(coordinates.length === 5 ? { promotion: coordinates[4] } : {}),
      });
      return {
        from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}),
        san: move.san, fen: move.after, color: move.color, packetId, at,
      };
    });
    return {
      moves, status, ...(winner === null ? {} : { winner }),
      ...(base === null ? {} : { base }), ...(baseFen === null ? {} : { baseFen }),
      ...(basePacketId === null ? {} : { basePacketId }),
    };
  }
  return packetError('invalid compact payload');
}

export function encodePacket(packet: Packet): string {
  assertValidPacket(packet);
  const body = [
    packet.id, PACKET_KINDS.indexOf(packet.kind), packet.from.id, packet.from.name,
    packet.to ?? null, packet.gameId ?? null, packet.sentAt, packPayload(packet),
  ];
  const wire = PROTOCOL_PREFIX + JSON.stringify(transformIds(body, packId));
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
  const compact = text.startsWith(COMPACT_PROTOCOL_PREFIX);
  const positional = text.startsWith(PROTOCOL_PREFIX);
  if (!positional && !compact && !text.startsWith(LEGACY_PROTOCOL_PREFIX)) packetError('missing MC3/MC2/MC1 prefix');

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
  if (positional) {
    const fields = transformIds(value, unpackId);
    if (!Array.isArray(fields) || fields.length !== 8) packetError('invalid compact envelope');
    const [id, kindIndex, fromId, name, to, gameId, sentAt, payload] = fields;
    if (!Number.isInteger(kindIndex) || kindIndex < 0 || kindIndex >= PACKET_KINDS.length
      || (to !== null && typeof to !== 'string') || (gameId !== null && typeof gameId !== 'string')) packetError('invalid compact envelope');
    const kind = PACKET_KINDS[kindIndex];
    value = {
      v: 1, id, kind, from: { id: fromId, name },
      ...(to === null ? {} : { to }), ...(gameId === null ? {} : { gameId }),
      sentAt, payload: unpackPayload(kind, payload, gameId ?? undefined),
    };
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
