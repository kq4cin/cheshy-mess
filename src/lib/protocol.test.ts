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
    expect(wire.startsWith('MC1:')).toBe(true);
    expect(decodePacket(wire)).toEqual(original);
    expect(decodePacket(new TextEncoder().encode(wire))).toEqual(original);
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
