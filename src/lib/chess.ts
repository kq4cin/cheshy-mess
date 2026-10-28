import { Chess } from 'chess.js';
import type { Color, Game, GameStatus, MoveRecord, SyncPayload, SyncRequestPayload } from '../types';
import { uniqueId } from './protocol';

export interface MoveInput {
  from: string;
  to: string;
  promotion?: string;
}

export interface GameResult {
  status: GameStatus;
  winner?: Color;
}

export interface MoveMetadata {
  packetId?: string;
  at?: number;
}

export type MoveHistory = readonly (MoveInput | MoveRecord | string)[];
type GameSource = Chess | MoveHistory;

function asGame(source: GameSource): Chess {
  return source instanceof Chess ? source : gameFrom(source);
}

export function gameFrom(moves: MoveHistory = []): Chess {
  const game = new Chess();
  for (const move of moves) {
    if (typeof move === 'string') {
      game.move(move);
    } else {
      game.move({
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion.toLowerCase() } : {}),
      });
    }
  }
  return game;
}

export function currentFen(source: GameSource = []): string {
  return asGame(source).fen();
}

export function legalTargets(source: GameSource, from: string): string[] {
  const moves = asGame(source).moves({ square: from as never, verbose: true });
  return [...new Set(moves.map((move) => move.to))];
}

export function makeMove(
  moves: MoveHistory,
  input: MoveInput,
  metadata?: MoveMetadata,
): MoveRecord;
export function makeMove(
  moves: MoveHistory,
  from: string,
  to: string,
  promotion?: string,
  metadata?: MoveMetadata,
): MoveRecord;
export function makeMove(
  moves: MoveHistory,
  inputOrFrom: MoveInput | string,
  toOrMetadata?: string | MoveMetadata,
  promotion?: string,
  metadata: MoveMetadata = {},
): MoveRecord {
  const input = typeof inputOrFrom === 'string'
    ? { from: inputOrFrom, to: toOrMetadata as string, promotion }
    : inputOrFrom;
  const details = typeof inputOrFrom === 'string' ? metadata : (toOrMetadata as MoveMetadata | undefined) ?? {};
  const game = gameFrom(moves);
  const move = game.move({
    from: input.from,
    to: input.to,
    ...(input.promotion ? { promotion: input.promotion.toLowerCase() } : {}),
  });
  return {
    from: move.from,
    to: move.to,
    ...(move.promotion ? { promotion: move.promotion } : {}),
    san: move.san,
    fen: move.after,
    color: move.color,
    packetId: details.packetId ?? uniqueId('move'),
    at: details.at ?? Date.now(),
  };
}

export function gameResult(source: GameSource = []): GameResult {
  const game = asGame(source);
  if (game.isCheckmate()) {
    return { status: 'checkmate', winner: game.turn() === 'w' ? 'b' : 'w' };
  }
  if (game.isStalemate()) return { status: 'stalemate' };
  if (game.isDraw()) return { status: 'draw' };
  return { status: 'active' };
}

export function exportPgn(moves: MoveHistory = []): string {
  return gameFrom(moves).pgn();
}

export const gameToPgn = exportPgn;

export function validateHistory(moves: unknown): moves is MoveRecord[] {
  if (!Array.isArray(moves)) return false;
  const game = new Chess();
  try {
    for (const record of moves as unknown[]) {
      if (typeof record !== 'object' || record === null) return false;
      const candidate = record as Partial<MoveRecord>;
      if (typeof candidate.from !== 'string' || typeof candidate.to !== 'string') return false;
      if (typeof candidate.san !== 'string' || typeof candidate.fen !== 'string') return false;
      if (candidate.color !== 'w' && candidate.color !== 'b') return false;
      if (typeof candidate.packetId !== 'string' || candidate.packetId.length === 0) return false;
      if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return false;
      if (candidate.promotion !== undefined && typeof candidate.promotion !== 'string') return false;

      const move = game.move({
        from: candidate.from,
        to: candidate.to,
        ...(candidate.promotion ? { promotion: candidate.promotion.toLowerCase() } : {}),
      });
      if (move.san !== candidate.san || move.after !== candidate.fen || move.color !== candidate.color) {
        return false;
      }
      if ((move.promotion ?? undefined) !== candidate.promotion) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export const validateMoveHistory = validateHistory;

export function buildSyncPayload(game: Game, request?: Partial<SyncRequestPayload>): SyncPayload {
  const count = request?.moveCount;
  const base = typeof count === 'number' && Number.isSafeInteger(count) && count > 0
    && count <= game.moves.length && game.moves[count - 1].packetId === request?.packetId
    && currentFen(game.moves.slice(0, count)) === request?.fen ? count : 0;
  return {
    moves: game.moves.slice(base),
    status: game.status,
    ...(game.winner ? { winner: game.winner } : {}),
    ...(base > 0 ? {
      base, baseFen: currentFen(game.moves.slice(0, base)), basePacketId: game.moves[base - 1].packetId,
    } : {}),
  };
}

export function restoreSyncHistory(payload: Partial<SyncPayload>, localMoves: MoveRecord[]): MoveRecord[] | null {
  const base = payload.base ?? 0;
  if (!Number.isSafeInteger(base) || base < 0 || base > localMoves.length || !Array.isArray(payload.moves)) return null;
  if (base > 0 && (currentFen(localMoves.slice(0, base)) !== payload.baseFen
    || localMoves[base - 1].packetId !== payload.basePacketId)) return null;
  const moves = [...localMoves.slice(0, base), ...payload.moves];
  return validateHistory(moves) ? moves : null;
}
