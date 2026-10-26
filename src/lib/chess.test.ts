import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { MoveRecord } from '../types';
import {
  currentFen,
  exportPgn,
  gameFrom,
  gameResult,
  legalTargets,
  makeMove,
  validateHistory,
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
