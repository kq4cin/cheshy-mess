import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import type { Color, MoveRecord } from '../types';
import './chessboard.css';

export interface ChessBoardProps {
  moves: MoveRecord[];
  localColor: Color;
  interactive: boolean;
  orientation: Color;
  onMove(input: { from: string; to: string; promotion?: string }): boolean;
  reviewPly: number | null;
  onReviewEnd(): void;
}

type PromotionPiece = 'q' | 'r' | 'b' | 'n';
type PendingPromotion = { from: Square; to: Square };

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
const PIECES = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
} as const;
const PIECE_NAMES = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
} as const;
const PROMOTIONS: { piece: PromotionPiece; name: string }[] = [
  { piece: 'q', name: 'Queen' },
  { piece: 'r', name: 'Rook' },
  { piece: 'b', name: 'Bishop' },
  { piece: 'n', name: 'Knight' },
];
const SQUARES = new Set<string>(
  RANKS.flatMap((rank) => FILES.map((file) => `${file}${rank}`)),
);

function isSquare(value: string): value is Square {
  return SQUARES.has(value);
}

export function ChessBoard({
  moves,
  localColor,
  interactive,
  orientation,
  onMove,
  reviewPly,
  onReviewEnd,
}: ChessBoardProps) {
  const [selected, setSelected] = useState<Square | null>(null);
  const [draggedFrom, setDraggedFrom] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const queenButtonRef = useRef<HTMLButtonElement>(null);
  const reviewing = reviewPly !== null;
  const displayedPly = reviewing
    ? Math.max(0, Math.min(reviewPly, moves.length))
    : moves.length;

  const game = useMemo(() => {
    const position = new Chess();
    for (const move of moves.slice(0, displayedPly)) {
      position.move({ from: move.from, to: move.to, promotion: move.promotion });
    }
    return position;
  }, [displayedPly, moves]);

  const canInteract = interactive
    && !reviewing
    && !game.isGameOver()
    && game.turn() === localColor;
  const legalMoves = useMemo(
    () => selected && canInteract
      ? game.moves({ square: selected, verbose: true })
      : [],
    [canInteract, game, selected],
  );
  const legalTargets = useMemo(
    () => new Set(legalMoves.map((move) => move.to)),
    [legalMoves],
  );
  const lastMove = displayedPly > 0 ? moves[displayedPly - 1] : null;
  const checkedKing = game.isCheck()
    ? game.findPiece({ type: 'k', color: game.turn() })[0] ?? null
    : null;
  const files = orientation === 'w' ? FILES : [...FILES].reverse();
  const ranks = orientation === 'w' ? [...RANKS].reverse() : RANKS;

  useEffect(() => {
    setSelected(null);
    setDraggedFrom(null);
    setPendingPromotion(null);
  }, [localColor, moves, reviewPly]);

  useEffect(() => {
    if (pendingPromotion) queenButtonRef.current?.focus();
  }, [pendingPromotion]);

  function submitMove(from: Square, to: Square, promotion?: PromotionPiece) {
    const accepted = onMove(promotion ? { from, to, promotion } : { from, to });
    if (accepted) {
      setSelected(null);
      setDraggedFrom(null);
      setPendingPromotion(null);
    }
  }

  function attemptMove(from: Square, to: Square) {
    if (!canInteract || pendingPromotion) return;
    const candidates = game
      .moves({ square: from, verbose: true })
      .filter((move) => move.to === to);
    if (candidates.length === 0) {
      setSelected(null);
      return;
    }
    if (candidates.some((move) => move.promotion)) {
      setPendingPromotion({ from, to });
      return;
    }
    submitMove(from, to);
  }

  function selectSquare(square: Square) {
    if (!canInteract || pendingPromotion) return;
    const piece = game.get(square);
    if (selected) {
      if (square === selected) {
        setSelected(null);
        return;
      }
      if (legalTargets.has(square)) {
        attemptMove(selected, square);
        return;
      }
    }
    setSelected(piece?.color === localColor ? square : null);
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, square: Square) {
    if (!canInteract || game.get(square)?.color !== localColor) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', square);
    setDraggedFrom(square);
    setSelected(square);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>, to: Square) {
    event.preventDefault();
    const from = event.dataTransfer.getData('text/plain') || draggedFrom || selected || '';
    setDraggedFrom(null);
    if (isSquare(from)) attemptMove(from, to);
  }

  function handlePromotionKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setPendingPromotion(null);
    }
  }

  return (
    <section className="mc-chessboard" aria-label="Chess game">
      {reviewing && (
        <div className="mc-review-bar">
          <span>Reviewing move {displayedPly} of {moves.length}</span>
          <button type="button" onClick={onReviewEnd}>Return to live</button>
        </div>
      )}

      <div className="mc-board-frame">
        <div
          className="mc-board"
          aria-label={`Chess board, ${orientation === 'w' ? 'white' : 'black'} orientation`}
          aria-disabled={!canInteract}
        >
          {ranks.map((rank, row) => files.map((file, column) => {
            const square = `${file}${rank}` as Square;
            const piece = game.get(square);
            const isLight = (FILES.indexOf(file) + Number(rank)) % 2 === 0;
            const isLegalTarget = legalTargets.has(square);
            const isLastMove = lastMove?.from === square || lastMove?.to === square;
            const labels: string[] = [square];
            if (piece) labels.push(`${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}`);
            if (square === selected) labels.push('selected');
            if (isLegalTarget) labels.push(piece ? 'legal capture' : 'legal move');
            if (isLastMove) labels.push('last move');
            if (square === checkedKing) labels.push('in check');

            return (
              <button
                key={square}
                type="button"
                className={[
                  'mc-square',
                  isLight ? 'is-light' : 'is-dark',
                  square === selected ? 'is-selected' : '',
                  isLegalTarget ? 'is-legal-target' : '',
                  isLegalTarget && piece ? 'has-piece' : '',
                  isLastMove ? 'is-last-move' : '',
                  square === checkedKing ? 'is-check' : '',
                  canInteract && piece?.color === localColor ? 'is-movable' : '',
                ].filter(Boolean).join(' ')}
                aria-label={labels.join(', ')}
                aria-pressed={square === selected}
                disabled={!canInteract}
                draggable={canInteract && piece?.color === localColor}
                onClick={() => selectSquare(square)}
                onDragStart={(event) => handleDragStart(event, square)}
                onDragEnd={() => setDraggedFrom(null)}
                onDragOver={(event) => {
                  if (canInteract && (legalTargets.has(square) || draggedFrom)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => handleDrop(event, square)}
              >
                {column === 0 && <span className="mc-rank-label" aria-hidden="true">{rank}</span>}
                {row === 7 && <span className="mc-file-label" aria-hidden="true">{file}</span>}
                {piece && (
                  <span className={`mc-piece is-${piece.color}`} aria-hidden="true">
                    {PIECES[piece.color][piece.type]}
                  </span>
                )}
              </button>
            );
          }))}
        </div>
      </div>

      <p className="mc-sr-only" aria-live="polite">
        {reviewing
          ? `Review mode. Board input disabled at ply ${displayedPly}.`
          : game.isCheck()
            ? `${game.turn() === 'w' ? 'White' : 'Black'} is in check.`
            : `${game.turn() === 'w' ? 'White' : 'Black'} to move.`}
      </p>

      {pendingPromotion && (
        <div
          className="mc-promotion-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingPromotion(null);
          }}
        >
          <div
            className="mc-promotion-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mc-promotion-title"
            onKeyDown={handlePromotionKeyDown}
          >
            <h2 id="mc-promotion-title">Choose promotion</h2>
            <div className="mc-promotion-options">
              {PROMOTIONS.map(({ piece, name }, index) => (
                <button
                  key={piece}
                  ref={index === 0 ? queenButtonRef : undefined}
                  type="button"
                  aria-label={`Promote to ${name.toLowerCase()}`}
                  onClick={() => submitMove(
                    pendingPromotion.from,
                    pendingPromotion.to,
                    piece,
                  )}
                >
                  <span aria-hidden="true">{PIECES[localColor][piece]}</span>
                  <small>{name}</small>
                </button>
              ))}
            </div>
            <button
              className="mc-promotion-cancel"
              type="button"
              onClick={() => setPendingPromotion(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
