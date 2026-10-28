import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { Game, MoveRecord } from '../types';
import {
  currentFen,
  exportPgn,
  gameFrom,
  gameResult,
  legalTargets,
  makeMove,
  validateHistory,
  buildSyncPayload,
  restoreSyncHistory,
} from './chess';

const moves = (san: string[]): MoveRecord[] => {
  const history: MoveRecord[] = [];
  san.forEach((move, index) => {
    const game = gameFrom(history);
    const result = game.move(move);
    history.push({
      from: result.from,
      to: result.to,
      ...(result.promotion ? { promotion: result.promotion } : {}),
      san: result.san,
      fen: result.after,
      color: result.color,
      packetId: `packet-${index}`,
      at: index,
    });
  });
  return history;
};

function syncGame(history: MoveRecord[]): Game {
  return {
    id: 'game', challengeId: 'challenge', white: { id: 'white', name: 'White' },
    black: { id: 'black', name: 'Black' }, localColor: 'w', status: 'active', moves: history,
    createdAt: 0, updatedAt: 0, lastReadAt: 0, drawOffer: null, awaitingAck: null, seenPackets: [],
  };
}

describe('LoRa history sync', () => {
  it('sends only missing moves after verifying the shared base position', () => {
    const history = moves(['e4', 'e5', 'Nf3', 'Nc6']);
    const prefix = history.slice(0, 3);
    const payload = buildSyncPayload(syncGame(history), { moveCount: 3, fen: currentFen(prefix), packetId: prefix.at(-1)?.packetId });
    expect(payload.moves).toEqual(history.slice(3));
    expect(payload.base).toBe(3);
    expect(restoreSyncHistory(payload, prefix)).toEqual(history);
  });

  it('sends no history for equal boards while preserving terminal results', () => {
    const history = moves(['e4', 'e5']);
    const game = { ...syncGame(history), status: 'resigned' as const, winner: 'b' as const };
    const payload = buildSyncPayload(game, { moveCount: 2, fen: currentFen(history), packetId: history.at(-1)?.packetId });
    expect(payload.moves).toEqual([]);
    expect(payload).toMatchObject({ status: 'resigned', winner: 'b' });
    expect(restoreSyncHistory(payload, history)).toEqual(history);
  });

  it('falls back to a full snapshot for legacy, divergent, or invalid requests', () => {
    const history = moves(['e4', 'e5']);
    for (const request of [undefined, {}, { moveCount: 1, fen: 'mismatch' }, { moveCount: 100 }, { moveCount: -1 }, { moveCount: 0.5 }]) {
      const payload = buildSyncPayload(syncGame(history), request);
      expect(payload.moves).toEqual(history);
      expect(payload.base).toBeUndefined();
      expect(restoreSyncHistory(payload, [])).toEqual(history);
    }
  });

  it('rejects invalid deltas instead of appending to the wrong position', () => {
    const history = moves(['e4', 'e5']);
    const payload = buildSyncPayload(syncGame(history), {
      moveCount: 1, fen: currentFen(history.slice(0, 1)), packetId: history[0].packetId,
    });
    expect(restoreSyncHistory(payload, [])).toBeNull();
    expect(restoreSyncHistory(payload, moves(['d4']))).toBeNull();
    expect(restoreSyncHistory({ ...payload, base: -1 }, history)).toBeNull();
    expect(restoreSyncHistory({ ...payload, base: 0.5 }, history)).toBeNull();
    expect(restoreSyncHistory({ ...payload, moves: [{ ...history[1], san: 'wrong' }] }, history)).toBeNull();
    expect(restoreSyncHistory(payload, [{ ...history[0], packetId: 'different-origin' }])).toBeNull();
    expect(buildSyncPayload(syncGame(history), {
      moveCount: 1, fen: currentFen(history.slice(0, 1)), packetId: 'different-origin',
    }).base).toBeUndefined();
  });
});

describe('chess helpers', () => {
  it('replays moves and reports legal targets and the current FEN', () => {
    expect(legalTargets([], 'e2').sort()).toEqual(['e3', 'e4']);
    const history = moves(['e4', 'e5', 'Nf3']);
    expect(gameFrom(history).history()).toEqual(['e4', 'e5', 'Nf3']);
    expect(currentFen(history)).toBe(history.at(-1)?.fen);
  });

  it('creates move records and rejects illegal moves', () => {
    const move = makeMove([], 'e2', 'e4', undefined, { packetId: 'p1', at: 10 });
    expect(move).toMatchObject({ from: 'e2', to: 'e4', san: 'e4', color: 'w', packetId: 'p1', at: 10 });
    expect(move.fen).toContain(' b ');
    expect(() => makeMove([], 'e2', 'e5')).toThrow();
  });

  it('handles castling and en passant through ordinary replay', () => {
    const castling = moves(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O']);
    expect(castling.at(-1)?.san).toBe('O-O');
    const castled = gameFrom(castling);
    expect(castled.get('g1')).toEqual({ type: 'k', color: 'w' });
    expect(castled.get('f1')).toEqual({ type: 'r', color: 'w' });

    const enPassant = moves(['e4', 'a6', 'e5', 'd5', 'exd6']);
    const captured = gameFrom(enPassant);
    expect(captured.get('d5')).toBeUndefined();
    expect(captured.get('d6')).toEqual({ type: 'p', color: 'w' });
  });

  it('supports underpromotion', () => {
    const history = moves(['a4', 'b5', 'axb5', 'a6', 'b6', 'c5', 'b7', 'd6', 'bxa8=N']);
    expect(history.at(-1)).toMatchObject({ to: 'a8', promotion: 'n' });
    expect(gameFrom(history).get('a8')).toEqual({ type: 'n', color: 'w' });
  });

  it('distinguishes checkmate, stalemate, draws, and active games', () => {
    const mate = moves(['f3', 'e5', 'g4', 'Qh4#']);
    expect(gameResult(mate)).toEqual({ status: 'checkmate', winner: 'b' });
    expect(gameResult(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'))).toEqual({ status: 'stalemate' });
    expect(gameResult(new Chess('8/8/8/8/8/8/6k1/K7 w - - 0 1'))).toEqual({ status: 'draw' });
    expect(gameResult([])).toEqual({ status: 'active' });
  });

  it('exports PGN and validates every recorded field by replaying the history', () => {
    const history = moves(['e4', 'c5', 'Nf3']);
    expect(exportPgn(history)).toContain('\n\n1. e4 c5 2. Nf3 *');
    expect(validateHistory(history)).toBe(true);
    expect(validateHistory(history.map((move, index) => index === 1 ? { ...move, fen: currentFen([]) } : move))).toBe(false);
    expect(validateHistory(history.map((move, index) => index === 1 ? { ...move, san: 'c6' } : move))).toBe(false);
    expect(validateHistory([{ ...history[0], packetId: '' }])).toBe(false);
    expect(validateHistory(moves(['e4']).concat(moves(['e4'])))).toBe(false);
  });
});
