import { describe, expect, it } from 'vitest';
import type { Packet } from '../types';
import {
  decodePacket,
  encodePacket,
  GAME_CHANNEL,
  hashtagKey,
  MAX_PACKET_BYTES,
  PACKET_KINDS,
  uniqueId,
  validatePacket,
} from './protocol';
import { radioMessageCount } from './transports';
import { buildSyncPayload, currentFen, gameFrom, makeMove } from './chess';
import type { Game, MoveRecord } from '../types';

function packet(payload: unknown = { text: 'hello' }): Packet {
  return {
    v: 1,
    id: 'packet-1',
    kind: 'chat',
    from: { id: 'player-1', name: 'Alice' },
    payload,
    sentAt: 123,
  };
}

describe('MeshChess wire protocol', () => {
  it('round-trips prefixed UTF-8 JSON without changing the packet', () => {
    const original = packet({ text: 'Checkmate ♞' });
    const wire = encodePacket(original);
    expect(wire.startsWith('MC3:')).toBe(true);
    expect(decodePacket(wire)).toEqual(original);
    expect(decodePacket(new TextEncoder().encode(wire))).toEqual(original);
  });

  it('still decodes verbose MC1 packets from older clients', () => {
    const original = packet({ text: 'from an older build' });
    expect(decodePacket('MC1:' + JSON.stringify(original))).toEqual(original);
  });

  it('still decodes compact MC2 packets from older clients', () => {
    expect(decodePacket('MC2:{"I":"packet-1","K":"chat","F":{"I":"player-1","N":"Alice"},"P":{"E":"hello"},"S":123}'))
      .toEqual(packet());
  });

  it('round-trips strings that resemble compressed identifiers', () => {
    for (const text of ['~11234567890', '~~literal', 'player_1234567890', '~unknown']) {
      expect(decodePacket(encodePacket(packet({ text })))).toEqual(packet({ text }));
    }
  });

  it('keeps an accept small enough for a few LoRa messages', () => {
    const player = (name: string) => ({ id: uniqueId('player'), name });
    const host = player('Guest 1234');
    const guest = player('Guest 5678');
    const gameId = uniqueId('game');
    const accept: Packet = {
      v: 1,
      id: uniqueId('accept'),
      kind: 'accept',
      from: guest,
      to: host.id,
      gameId,
      payload: { challengeId: uniqueId('challenge'), gameId, white: host, black: guest },
      sentAt: Date.now(),
    };
    const wire = encodePacket(accept);
    expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(260);
    expect(radioMessageCount(wire)).toBeLessThanOrEqual(4);
    expect(decodePacket(wire)).toEqual(accept);
    expect(uniqueId('player').length).toBeLessThanOrEqual(24);
  });

  it('fits a hello into a single radio message', () => {
    const hello: Packet = { v: 1, id: uniqueId('hello'), kind: 'hello', from: { id: uniqueId('player'), name: 'Guest 1234' }, payload: {}, sentAt: Date.now() };
    expect(radioMessageCount(encodePacket(hello))).toBe(1);
  });

  it.each(['move', 'ack', 'resign'] as const)('fits a routine %s into one radio message', (kind) => {
    const original: Packet = {
      v: 1, id: uniqueId(kind), kind,
      from: { id: uniqueId('player'), name: 'Guest 1234' },
      to: uniqueId('player'), gameId: uniqueId('game'), sentAt: Date.now(),
      payload: kind === 'move' ? { n: 120, from: 'e2', to: 'e4', san: 'e4' }
        : kind === 'ack' ? { packetId: uniqueId('move'), moveCount: 120 } : {},
    };
    if (kind === 'ack') original.payload = { packetId: uniqueId('move'), gameId: original.gameId, moveCount: 120 };
    expect(radioMessageCount(encodePacket(original))).toBe(1);
    expect(decodePacket(encodePacket(original))).toEqual(original);
  });

  it.each([
    ['castling', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']],
    ['en passant', ['e4', 'a6', 'e5', 'd5', 'exd6']],
    ['underpromotion', ['a4', 'b5', 'axb5', 'a6', 'b6', 'c5', 'b7', 'd6', 'bxa8=N']],
  ])('round-trips compact full and delta histories with %s', (_label, sequence) => {
    const history: MoveRecord[] = [];
    for (const san of sequence) {
      const move = gameFrom(history).move(san);
      history.push(makeMove(history, move, { packetId: uniqueId('move'), at: 123 }));
    }
    const game: Game = {
      id: uniqueId('game'), challengeId: 'challenge', white: { id: 'alice', name: 'Alice' },
      black: { id: 'bob', name: 'Bob' }, localColor: 'w', status: 'active', moves: history,
      createdAt: 0, updatedAt: 0, lastReadAt: 0, drawOffer: null, awaitingAck: null, seenPackets: [],
    };
    for (const base of [0, history.length - 2, history.length]) {
      const payload = buildSyncPayload(game, {
        moveCount: base, fen: currentFen(history.slice(0, base)), packetId: history[base - 1]?.packetId,
      });
      const original: Packet = { ...packet(payload), kind: 'sync', gameId: game.id };
      const wire = encodePacket(original);
      expect(decodePacket(wire)).toEqual(original);
      if (base < history.length) expect(wire).not.toContain(history.at(-1)?.fen);
      expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(650);
      if (base === 0) {
        const legacyBytes = new TextEncoder().encode('MC1:' + JSON.stringify(original)).byteLength;
        expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(legacyBytes * 0.4);
      }
    }
  });

  it('rejects malformed compact envelopes, payload tags, moves and histories', () => {
    const header = ['id', PACKET_KINDS.indexOf('move'), 'sender', 'Alice', 'recipient', 'game', 123];
    expect(() => decodePacket('MC3:[]')).toThrow(/envelope/);
    expect(() => decodePacket('MC3:' + JSON.stringify([...header, [99]]))).toThrow(/payload/);
    expect(() => decodePacket('MC3:' + JSON.stringify([...header, [1, 1, 'e2e9', 'e9']]))).toThrow(/move/);
    header[1] = PACKET_KINDS.indexOf('sync');
    expect(() => decodePacket('MC3:' + JSON.stringify([...header, [2, 'active', null, -1, null, null, []]]))).toThrow(/history/);
    expect(() => decodePacket('MC3:' + JSON.stringify([...header, [2, 'active', null, null, null, null, [['e2e5', 'p1', 123]]]]))).toThrow();
  });

  it('rejects malformed prefixes, JSON, versions, senders, and kinds', () => {
    expect(() => decodePacket(JSON.stringify(packet()))).toThrow(/prefix/);
    expect(() => decodePacket('MC1:{broken')).toThrow(/JSON/);
    expect(() => decodePacket('MC1:' + JSON.stringify({ ...packet(), v: 2 }))).toThrow(/version/);
    expect(() => decodePacket('MC1:' + JSON.stringify({ ...packet(), from: null }))).toThrow(/sender/);
    expect(() => decodePacket('MC1:' + JSON.stringify({ ...packet(), kind: 'unknown' }))).toThrow(/kind/);
    expect(validatePacket({ ...packet(), sentAt: Number.NaN })).toBe(false);
  });

  it('round-trips result announcements', () => {
    const original: Packet = {
      ...packet(),
      kind: 'result',
      gameId: 'game-1',
      payload: { white: 'Alice', black: 'Bob', outcome: 'white', reason: 'checkmate' },
    };
    expect(decodePacket(encodePacket(original))).toEqual(original);
  });

  it('measures the packet limit in UTF-8 bytes', () => {
    const oversized = packet({ text: 'é'.repeat(MAX_PACKET_BYTES / 2) });
    expect(() => encodePacket(oversized)).toThrow(/UTF-8 bytes/);
    expect(() => decodePacket('MC1:' + 'x'.repeat(MAX_PACKET_BYTES))).toThrow(/UTF-8 bytes/);
  });

  it('generates unique ids and derives the 16-byte hashtag secret', async () => {
    expect(uniqueId()).not.toBe(uniqueId());
    expect(uniqueId('move').startsWith('move_')).toBe(true);
    expect(GAME_CHANNEL).toBe('#chess');
    const key = await hashtagKey('#test');
    expect(key).toHaveLength(16);
    expect(Buffer.from(key).toString('hex')).toBe('9cd8fcf22a47333b591d96a2b848b73f');
  });
});
