import { describe, expect, it } from 'vitest';
import type { Packet } from '../types';
import {
  decodePacket,
  encodePacket,
  GAME_CHANNEL,
  hashtagKey,
  MAX_PACKET_BYTES,
  uniqueId,
  validatePacket,
} from './protocol';
import { radioMessageCount } from './transports';

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
    expect(wire.startsWith('MC2:')).toBe(true);
    expect(decodePacket(wire)).toEqual(original);
    expect(decodePacket(new TextEncoder().encode(wire))).toEqual(original);
  });

  it('still decodes verbose MC1 packets from older clients', () => {
    const original = packet({ text: 'from an older build' });
    expect(decodePacket('MC1:' + JSON.stringify(original))).toEqual(original);
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
    expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(320);
    expect(radioMessageCount(wire)).toBeLessThanOrEqual(5);
    expect(decodePacket(wire)).toEqual(accept);
    expect(uniqueId('player').length).toBeLessThanOrEqual(24);
  });

  it('fits a hello into a single radio message', () => {
    const hello: Packet = { v: 1, id: uniqueId('hello'), kind: 'hello', from: { id: uniqueId('player'), name: 'Guest 1234' }, payload: {}, sentAt: Date.now() };
    expect(radioMessageCount(encodePacket(hello))).toBe(1);
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
