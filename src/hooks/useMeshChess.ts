import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AcceptPayload,
  AckPayload,
  Challenge,
  ChallengePayload,
  ChatMessage,
  ChatPayload,
  Color,
  DrawPayload,
  Game,
  GameStatus,
  MovePayload,
  OutboxItem,
  Packet,
  PacketKind,
  PersistedState,
  Player,
  RadioLog,
  ResultEntry,
  ResultPayload,
  SyncPayload,
  TransportKind,
  TransportState,
} from '../types';
import { gameResult, makeMove, validateHistory } from '../lib/chess';
import { decodePacket, encodePacket, GAME_CHANNEL, uniqueId } from '../lib/protocol';
import { createDefaultState, loadState, saveState } from '../lib/storage';
import { BLEAdapter, radioMessageCount, SerialAdapter } from '../lib/transports';
import type { Transport } from '../lib/transports';
import { onServiceWorkerMessage } from '../sw-events';

const CHANNEL_NAME = 'meshchess-demo-v1';
const RELIABLE_KINDS = new Set<PacketKind>(['move', 'accept', 'sync', 'draw', 'resign', 'rematch', 'chat']);
const GAME_STATUSES = new Set<GameStatus>(['active', 'checkmate', 'stalemate', 'draw', 'resigned', 'aborted']);
const OFFLINE_TRANSPORT: TransportState = { kind: null, status: 'offline', detail: 'Not connected' };

export interface MeshChessApi {
  ready: boolean;
  state: PersistedState;
  transport: TransportState;
  logs: RadioLog[];
  connect(kind: TransportKind, chooseNewDevice?: boolean): Promise<void>;
  disconnect(): Promise<void>;
  updateName(name: string): void;
  createChallenge(hostColor: Color | 'random'): void;
  withdrawChallenge(id: string): void;
  acceptChallenge(challenge: Challenge): string | null;
  playMove(gameId: string, input: { from: string; to: string; promotion?: string }): boolean;
  resign(gameId: string): void;
  offerDraw(gameId: string): void;
  respondDraw(gameId: string, response: 'accept' | 'decline'): void;
  sendChat(gameId: string | null, text: string): void;
  requestSync(gameId: string): void;
  markRead(gameId: string): void;
  deleteLocalGame(gameId: string): void;
}

type StateUpdater = (state: PersistedState) => PersistedState;
type EnqueueFunction = (packet: Packet, reliable?: boolean) => void;

function packet(
  kind: PacketKind,
  from: Player,
  payload: unknown,
  options: { id?: string; to?: string; gameId?: string } = {},
): Packet {
  return {
    v: 1,
    id: options.id ?? uniqueId(kind),
    kind,
    from: { ...from },
    ...(options.to ? { to: options.to } : {}),
    ...(options.gameId ? { gameId: options.gameId } : {}),
    payload,
    sentAt: Date.now(),
  };
}

function opponent(game: Game, localId: string): Player {
  return game.white.id === localId ? game.black : game.white;
}

function outboxRecipient(wire: string): string | undefined {
  try {
    return decodePacket(wire).to;
  } catch {
    return undefined;
  }
}

const ANNOUNCED_STATUSES = new Set<GameStatus>(['checkmate', 'stalemate', 'draw', 'resigned']);
const MAX_RESULTS = 20;

function validResultPayload(value: unknown): value is ResultPayload {
  if (!isObject(value)) return false;
  const payload = value as Partial<ResultPayload>;
  return typeof payload.white === 'string' && typeof payload.black === 'string'
    && (payload.outcome === 'white' || payload.outcome === 'black' || payload.outcome === 'draw')
    && typeof payload.reason === 'string' && ANNOUNCED_STATUSES.has(payload.reason);
}

function localColor(game: Game, localId: string): Color {
  return game.white.id === localId ? 'w' : 'b';
}

function replaceGame(state: PersistedState, gameId: string, update: (game: Game) => Game): PersistedState {
  return {
    ...state,
    games: state.games.map((game) => game.id === gameId ? update(game) : game),
  };
}

function resolveRandom(id: string): Color {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  return (hash & 1) === 0 ? 'w' : 'b';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validAcceptPayload(value: unknown): value is AcceptPayload {
  if (!isObject(value)) return false;
  const player = (candidate: unknown): candidate is Player => isObject(candidate)
    && typeof candidate.id === 'string' && candidate.id.length > 0 && typeof candidate.name === 'string';
  return typeof value.challengeId === 'string' && typeof value.gameId === 'string'
    && value.gameId.length > 0 && player(value.white) && player(value.black)
    && value.white.id !== value.black.id;
}

function acceptedGame(payload: AcceptPayload, localId: string): Game {
  const now = Date.now();
  return {
    id: payload.gameId,
    challengeId: payload.challengeId,
    white: { ...payload.white },
    black: { ...payload.black },
    localColor: payload.white.id === localId ? 'w' : 'b',
    status: 'active',
    moves: [],
    createdAt: now,
    updatedAt: now,
    lastReadAt: now,
    drawOffer: null,
    awaitingAck: null,
    seenPackets: [],
  };
}

function validResult(status: unknown, winner: unknown): status is GameStatus {
  return typeof status === 'string' && GAME_STATUSES.has(status as GameStatus)
    && (winner === undefined || winner === 'w' || winner === 'b');
}

function syncConfirms(item: OutboxItem, payload: SyncPayload, game: Game): boolean {
  if (item.kind === 'accept') return true;
  if (item.kind === 'move') return payload.moves.some((move, index) => (
    move.packetId === item.packetId && move.fen === game.moves[index]?.fen
  ));
  if (item.kind === 'resign') {
    const outgoing = decodePacket(item.wire);
    const winner = outgoing.from.id === game.white.id ? 'b' : 'w';
    return payload.status === 'resigned' && payload.winner === winner;
  }
  if (item.kind === 'draw') return payload.status === 'draw'
    && decodePacket<DrawPayload>(item.wire).payload.response === 'accept';
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function useMeshChess(): MeshChessApi {
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PersistedState>(createDefaultState);
  const [transport, setTransport] = useState<TransportState>(OFFLINE_TRANSPORT);
  const [logs, setLogs] = useState<RadioLog[]>([]);
  const stateRef = useRef(state);
  const transportRef = useRef(transport);
  const mountedRef = useRef(true);
  const adapterRef = useRef<Transport | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const connectionRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const flushTailRef = useRef<Promise<void>>(Promise.resolve());
  const receiveRef = useRef<(wire: string) => void>(() => undefined);
  const enqueueRef = useRef<EnqueueFunction>(() => undefined);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const connectRef = useRef<(kind: TransportKind) => Promise<void>>(async () => undefined);
  const logIdRef = useRef(0);

  const addLog = useCallback((text: string) => {
    if (!mountedRef.current) return;
    const entry = { id: ++logIdRef.current, text, at: Date.now() };
    setLogs((current) => [...current.slice(-79), entry]);
  }, []);

  const updateTransport = useCallback((next: TransportState) => {
    transportRef.current = next;
    if (mountedRef.current) setTransport(next);
  }, []);

  const persist = useCallback((next: PersistedState): Promise<void> => {
    const write = writeTailRef.current.then(() => saveState(next));
    writeTailRef.current = write.catch(() => undefined);
    return write;
  }, []);

  const commit = useCallback((updater: StateUpdater, afterPersist?: () => void): PersistedState => {
    const current = stateRef.current;
    const next = updater(current);
    if (next === current) return current;
    stateRef.current = next;
    if (mountedRef.current) setState(next);
    const saved = persist(next);
    if (afterPersist) void saved.then(afterPersist).catch(() => undefined);
    void saved.catch((error: unknown) => addLog(`Storage: ${error instanceof Error ? error.message : String(error)}`));
    return next;
  }, [addLog, persist]);

  const announceResult = useCallback((game: Game, status: GameStatus, winner: Color | undefined) => {
    if (!ANNOUNCED_STATUSES.has(status)) return;
    const outcome: ResultEntry['outcome'] = winner ? (winner === 'w' ? 'white' : 'black') : 'draw';
    const payload: ResultPayload = { white: game.white.name, black: game.black.name, outcome, reason: status };
    const outgoing = packet('result', stateRef.current.profile, payload, { gameId: game.id });
    const entry: ResultEntry = {
      id: outgoing.id,
      gameId: game.id,
      white: payload.white,
      black: payload.black,
      outcome,
      reason: status,
      at: Date.now(),
    };
    commit((latest) => ({
      ...latest,
      results: [entry, ...latest.results.filter((item) => item.gameId !== game.id)].slice(0, MAX_RESULTS),
    }));
    enqueueRef.current(outgoing, false);
  }, [commit]);

  // Challenges are one-shot broadcasts; repeat open ones when a radio link appears or a new player is heard.
  const announceOpenChallenges = useCallback(() => {
    const current = stateRef.current;
    for (const challenge of current.challenges) {
      if (challenge.withdrawn || challenge.host.id !== current.profile.id) continue;
      const payload: ChallengePayload = { challengeId: challenge.id, hostColor: challenge.hostColor };
      enqueueRef.current(packet('challenge', current.profile, payload), false);
    }
  }, []);

  const flushOutbox = useCallback((): Promise<void> => {
    const run = flushTailRef.current.then(async () => {
      const active = transportRef.current;
      if (active.status !== 'connected' || !active.kind) return;
      const items = stateRef.current.outbox;
      let sentAny = false;
      for (const item of items) {
        const current = stateRef.current.outbox.find((candidate) => candidate.id === item.id);
        if (!current) continue;
        const retryBase = active.kind === 'demo' ? 10_000 : 30_000;
        const retryAfter = Math.min(300_000, retryBase * 2 ** Math.min(Math.max(current.attempts - 1, 0), 5));
        if (current.lastAttempt > 0 && Date.now() - current.lastAttempt < retryAfter) continue;
        if (sentAny) await delay(active.kind === 'demo' ? 300 : 1200);

        commit((latest) => ({
          ...latest,
          outbox: latest.outbox.map((entry) => entry.id === current.id
            ? { ...entry, attempts: entry.attempts + 1, lastAttempt: Date.now() }
            : entry),
        }));
        try {
          if (active.kind === 'demo') {
            const channel = channelRef.current;
            if (!channel) throw new Error('Demo channel is not open');
            channel.postMessage(current.wire);
          } else {
            const adapter = adapterRef.current;
            if (!adapter) throw new Error('Radio is not connected');
            await adapter.send(current.wire);
          }
          sentAny = true;
          addLog(active.kind === 'demo'
            ? `Sent ${current.kind}`
            : `Sent ${current.kind} (${radioMessageCount(current.wire)} radio message${radioMessageCount(current.wire) === 1 ? '' : 's'})`);
          commit((latest) => {
            const exists = latest.outbox.some((entry) => entry.id === current.id);
            if (!exists) return latest;
            const reliable = RELIABLE_KINDS.has(current.kind);
            return {
              ...latest,
              outbox: reliable ? latest.outbox : latest.outbox.filter((entry) => entry.id !== current.id),
              chats: reliable
                ? latest.chats.map((chat) => chat.id === current.packetId && chat.delivery === 'queued'
                  ? { ...chat, delivery: 'sent' as const }
                  : chat)
                : latest.chats,
            };
          });
        } catch (error) {
          addLog(`Send ${current.kind}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    flushTailRef.current = run.catch(() => undefined);
    void run.catch((error: unknown) => addLog(`Outbox: ${error instanceof Error ? error.message : String(error)}`));
    return run;
  }, [addLog, commit]);
  flushRef.current = flushOutbox;

  const enqueue = useCallback<EnqueueFunction>((outgoing, reliable = RELIABLE_KINDS.has(outgoing.kind)) => {
    let wire: string;
    try {
      wire = encodePacket(outgoing);
    } catch (error) {
      addLog(`Packet: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const now = Date.now();
    const item: OutboxItem = {
      id: uniqueId('outbox'),
      wire,
      packetId: outgoing.id,
      kind: outgoing.kind,
      ...(outgoing.gameId ? { gameId: outgoing.gameId } : {}),
      ...(reliable ? { ackId: outgoing.id } : {}),
      createdAt: now,
      attempts: 0,
      lastAttempt: 0,
    };
    commit((latest) => {
      const coalesces = outgoing.kind === 'sync' || outgoing.kind === 'sync-request';
      const removed = coalesces
        ? latest.outbox.filter((entry) => entry.kind === outgoing.kind
          && entry.gameId === outgoing.gameId && outboxRecipient(entry.wire) === outgoing.to)
        : [];
      const removedIds = new Set(removed.map((entry) => entry.packetId));
      return {
        ...latest,
        outbox: [...latest.outbox.filter((entry) => !removedIds.has(entry.packetId)), item],
        games: removedIds.size === 0 ? latest.games : latest.games.map((game) => (
          game.awaitingAck && removedIds.has(game.awaitingAck) ? { ...game, awaitingAck: outgoing.id } : game
        )),
      };
    }, () => {
      void flushRef.current();
      if (transportRef.current.status !== 'connected' && 'serviceWorker' in navigator) {
        void navigator.serviceWorker.ready.then((registration) => {
          const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
          return sync?.register('meshchess-outbox');
        }).catch(() => undefined);
      }
    });
  }, [addLog, commit]);
  enqueueRef.current = enqueue;

  const sendAck = useCallback((incoming: Packet) => {
    if (!RELIABLE_KINDS.has(incoming.kind)) return;
    commit((latest) => latest.seen.includes(incoming.id) ? latest : ({
      ...latest,
      seen: [...latest.seen, incoming.id].slice(-2000),
    }));
    const game = incoming.gameId
      ? stateRef.current.games.find((candidate) => candidate.id === incoming.gameId)
      : undefined;
    const payload: AckPayload = {
      packetId: incoming.id,
      ...(incoming.gameId ? { gameId: incoming.gameId } : {}),
      moveCount: game?.moves.length ?? 0,
    };
    enqueueRef.current(packet('ack', stateRef.current.profile, payload, {
      to: incoming.from.id,
      ...(incoming.gameId ? { gameId: incoming.gameId } : {}),
    }), false);
  }, [commit]);

  const sendSyncRequest = useCallback((gameId: string, to: string) => {
    enqueueRef.current(packet('sync-request', stateRef.current.profile, {}, { gameId, to }), false);
  }, []);

  const sendSync = useCallback((game: Game, to: string) => {
    if (!validateHistory(game.moves)) return;
    const payload: SyncPayload = {
      moves: game.moves,
      status: game.status,
      ...(game.winner ? { winner: game.winner } : {}),
    };
    const outgoing = packet('sync', stateRef.current.profile, payload, { gameId: game.id, to });
    commit((latest) => replaceGame(latest, game.id, (current) => ({ ...current, awaitingAck: outgoing.id })));
    enqueueRef.current(outgoing);
  }, [commit]);

  const receive = useCallback((wire: string) => {
    let incoming: Packet;
    try {
      incoming = decodePacket(wire);
    } catch {
      return;
    }
    const current = stateRef.current;
    const me = current.profile;
    if (incoming.from.id === me.id) return;
    const overRadio = transportRef.current.kind !== null && transportRef.current.kind !== 'demo';
    if (incoming.to !== undefined && incoming.to !== me.id) {
      // Surfacing this makes identity mismatches (e.g. an accept for a stale player id) visible.
      if (overRadio && incoming.kind !== 'ack' && incoming.kind !== 'hello') {
        addLog(`Ignored ${incoming.kind} from ${incoming.from.name}: addressed to another player`);
      }
      return;
    }
    if (overRadio) addLog(`Heard ${incoming.kind} from ${incoming.from.name}`);
    if (current.seen.includes(incoming.id)) {
      sendAck(incoming);
      return;
    }
    // Reliable packets are only deduplicated after validation and application, when we ACK them.
    if (!RELIABLE_KINDS.has(incoming.kind)) {
      commit((latest) => ({ ...latest, seen: [...latest.seen, incoming.id].slice(-2000) }));
    }

    const upsertPeer = () => commit((latest) => ({
      ...latest,
      peers: [
        ...latest.peers.filter((peer) => peer.id !== incoming.from.id),
        { id: incoming.from.id, name: incoming.from.name, lastSeen: Date.now() },
      ],
    }));

    switch (incoming.kind) {
      case 'hello': {
        const unknown = !current.peers.some((peer) => peer.id === incoming.from.id);
        upsertPeer();
        if (unknown) {
          enqueueRef.current(packet('hello', stateRef.current.profile, {}, { to: incoming.from.id }), false);
          announceOpenChallenges();
        }
        break;
      }
      case 'challenge': {
        if (!isObject(incoming.payload) || typeof incoming.payload.challengeId !== 'string'
          || (incoming.payload.hostColor !== 'w' && incoming.payload.hostColor !== 'b' && incoming.payload.hostColor !== 'random')) break;
        const challenge: Challenge = {
          id: incoming.payload.challengeId,
          host: { ...incoming.from },
          hostColor: incoming.payload.hostColor,
          createdAt: incoming.sentAt,
        };
        // Hosts re-announce open challenges, so never revive one this device already saw withdrawn or accepted.
        const known = current.challenges.find((entry) => entry.id === challenge.id);
        if (known?.withdrawn || current.games.some((game) => game.challengeId === challenge.id)) {
          upsertPeer();
          break;
        }
        commit((latest) => ({
          ...latest,
          challenges: [...latest.challenges.filter((entry) => entry.id !== challenge.id), challenge],
        }));
        upsertPeer();
        break;
      }
      case 'withdraw': {
        if (!isObject(incoming.payload) || typeof incoming.payload.challengeId !== 'string') break;
        const challengeId = incoming.payload.challengeId;
        commit((latest) => ({
          ...latest,
          challenges: latest.challenges.map((challenge) => challenge.id === challengeId
            && challenge.host.id === incoming.from.id ? { ...challenge, withdrawn: true } : challenge),
        }));
        break;
      }
      case 'accept': {
        if (!validAcceptPayload(incoming.payload) || incoming.to !== me.id || incoming.gameId !== incoming.payload.gameId) break;
        const payload = incoming.payload;
        const challenge = current.challenges.find((entry) => entry.id === payload.challengeId);
        if (!challenge || challenge.withdrawn || challenge.host.id !== me.id || current.games.some((game) => game.id === payload.gameId)) break;
        const participants = [payload.white.id, payload.black.id];
        if (!participants.includes(me.id) || !participants.includes(incoming.from.id)) break;
        if ((challenge.hostColor === 'w' && payload.white.id !== me.id)
          || (challenge.hostColor === 'b' && payload.black.id !== me.id)) break;
        const game = acceptedGame(payload, me.id);
        commit((latest) => ({
          ...latest,
          games: [...latest.games, game],
          challenges: latest.challenges.map((entry) => entry.id === challenge.id ? { ...entry, withdrawn: true } : entry),
        }));
        sendAck(incoming);
        addLog(`Game started with ${incoming.from.name}`);
        break;
      }
      case 'move': {
        if (incoming.to !== me.id || !incoming.gameId || !isObject(incoming.payload)) break;
        const game = current.games.find((entry) => entry.id === incoming.gameId);
        const payload = incoming.payload as Partial<MovePayload>;
        if (!game || game.status !== 'active' || opponent(game, me.id).id !== incoming.from.id
          || payload.n !== game.moves.length + 1 || typeof payload.from !== 'string' || typeof payload.to !== 'string'
          || (payload.promotion !== undefined && typeof payload.promotion !== 'string')) {
          if (game && incoming.gameId) sendSyncRequest(game.id, incoming.from.id);
          break;
        }
        try {
          const move = makeMove(game.moves, {
            from: payload.from,
            to: payload.to,
            ...(payload.promotion ? { promotion: payload.promotion } : {}),
          }, { packetId: incoming.id, at: incoming.sentAt });
          if (move.san !== payload.san || (payload.fen !== undefined && move.fen !== payload.fen)) throw new Error('Move metadata mismatch');
          const result = gameResult([...game.moves, move]);
          commit((latest) => {
            // Their next move proves our earlier move/accept arrived, even if the ack was lost on air.
            const delivered = new Set(latest.outbox
              .filter((item) => item.gameId === game.id && (item.kind === 'move' || item.kind === 'accept'))
              .map((item) => item.packetId));
            const updated = replaceGame(latest, game.id, (value) => ({
              ...value,
              moves: [...value.moves, move],
              status: result.status,
              ...(result.winner ? { winner: result.winner } : { winner: undefined }),
              drawOffer: null,
              awaitingAck: value.awaitingAck && delivered.has(value.awaitingAck) ? null : value.awaitingAck,
              updatedAt: Date.now(),
            }));
            return { ...updated, outbox: updated.outbox.filter((item) => !delivered.has(item.packetId)) };
          });
          sendAck(incoming);
        } catch {
          sendSyncRequest(game.id, incoming.from.id);
        }
        break;
      }
      case 'ack': {
        if (!isObject(incoming.payload) || typeof incoming.payload.packetId !== 'string') break;
        const ack = incoming.payload as Partial<AckPayload>;
        const ackId = ack.packetId;
        commit((latest) => {
          const acknowledged = latest.outbox.find((item) => item.packetId === ackId);
          if (!acknowledged) return latest;
          const recipient = outboxRecipient(acknowledged.wire);
          if (recipient !== undefined && recipient !== incoming.from.id) return latest;
          const delivered = new Set([acknowledged.packetId]);
          if (acknowledged.kind === 'sync') {
            const synced = decodePacket<SyncPayload>(acknowledged.wire);
            const game = latest.games.find((entry) => entry.id === acknowledged.gameId);
            // A confirmed snapshot also delivers the moves and result it contains.
            for (const item of latest.outbox) {
              if (game && item.gameId === game.id && syncConfirms(item, synced.payload, game)) {
                delivered.add(item.packetId);
              }
            }
          }
          return {
            ...latest,
            outbox: latest.outbox.filter((item) => !delivered.has(item.packetId)),
            games: latest.games.map((game) => game.awaitingAck && delivered.has(game.awaitingAck)
              ? { ...game, awaitingAck: null } : game),
            chats: latest.chats.map((chat) => delivered.has(chat.id) && chat.mine
              ? { ...chat, delivery: 'acked' as const }
              : chat),
          };
        });
        break;
      }
      case 'sync-request': {
        if (incoming.to !== me.id || !incoming.gameId) break;
        const game = stateRef.current.games.find((entry) => entry.id === incoming.gameId);
        if (game && opponent(game, me.id).id === incoming.from.id) sendSync(game, incoming.from.id);
        break;
      }
      case 'sync': {
        if (incoming.to !== me.id || !incoming.gameId || !isObject(incoming.payload)) break;
        const game = current.games.find((entry) => entry.id === incoming.gameId);
        const payload = incoming.payload as Partial<SyncPayload>;
        if (!game || opponent(game, me.id).id !== incoming.from.id
          || !validateHistory(payload.moves) || !validResult(payload.status, payload.winner)) break;
        const moves = payload.moves;
        const status = payload.status;
        const snapshot: SyncPayload = { moves, status, winner: payload.winner };
        const differs = payload.moves.length !== game.moves.length
          || payload.moves.some((move, index) => move.packetId !== game.moves[index]?.packetId || move.fen !== game.moves[index]?.fen);
        commit((latest) => {
          const delivered = new Set(latest.outbox.filter((item) => item.gameId === game.id
            && syncConfirms(item, snapshot, game)).map((item) => item.packetId));
          const updated = replaceGame(latest, game.id, (value) => ({
            ...value,
            ...(moves.length > value.moves.length || (moves.length === value.moves.length && differs) ? {
              moves,
              drawOffer: null,
              updatedAt: Date.now(),
            } : {}),
            ...(moves.length >= value.moves.length && value.status === 'active' ? {
              status,
              winner: payload.winner,
              ...(status !== 'active' ? { drawOffer: null, updatedAt: Date.now() } : {}),
            } : {}),
            awaitingAck: value.awaitingAck && delivered.has(value.awaitingAck) ? null : value.awaitingAck,
          }));
          return { ...updated, outbox: updated.outbox.filter((item) => !delivered.has(item.packetId)) };
        });
        sendAck(incoming);
        // Never roll back an undelivered local move to the peer's older board.
        if (moves.length < game.moves.length || (game.status !== 'active' && status === 'active')) {
          sendSync(stateRef.current.games.find((entry) => entry.id === game.id) ?? game, incoming.from.id);
        }
        break;
      }
      case 'chat': {
        if (!isObject(incoming.payload) || typeof incoming.payload.text !== 'string') break;
        const text = incoming.payload.text.trim();
        if (!text || text.length > 240) break;
        if (incoming.gameId) {
          const game = current.games.find((entry) => entry.id === incoming.gameId);
          if (!game || opponent(game, me.id).id !== incoming.from.id) break;
        }
        const chat: ChatMessage = {
          id: incoming.id,
          gameId: incoming.gameId ?? null,
          from: { ...incoming.from },
          text,
          at: incoming.sentAt,
          delivery: 'received',
          mine: false,
        };
        commit((latest) => ({ ...latest, chats: [...latest.chats, chat] }));
        sendAck(incoming);
        break;
      }
      case 'draw': {
        if (incoming.to !== me.id || !incoming.gameId || !isObject(incoming.payload)) break;
        const game = current.games.find((entry) => entry.id === incoming.gameId);
        if (!game || game.status !== 'active' || opponent(game, me.id).id !== incoming.from.id) break;
        const payload = incoming.payload as DrawPayload;
        if (payload.response === undefined) {
          commit((latest) => replaceGame(latest, game.id, (value) => ({
            ...value,
            drawOffer: { by: incoming.from.id, at: incoming.sentAt },
            updatedAt: Date.now(),
          })));
        } else if ((payload.response === 'accept' || payload.response === 'decline')
          && game.drawOffer?.by === me.id) {
          commit((latest) => replaceGame(latest, game.id, (value) => ({
            ...value,
            status: payload.response === 'accept' ? 'draw' : value.status,
            winner: undefined,
            drawOffer: null,
            updatedAt: Date.now(),
          })));
        } else break;
        sendAck(incoming);
        break;
      }
      case 'resign': {
        if (incoming.to !== me.id || !incoming.gameId) break;
        const game = current.games.find((entry) => entry.id === incoming.gameId);
        if (!game || game.status !== 'active' || opponent(game, me.id).id !== incoming.from.id) break;
        commit((latest) => replaceGame(latest, game.id, (value) => ({
          ...value,
          status: 'resigned',
          winner: localColor(value, me.id),
          drawOffer: null,
          updatedAt: Date.now(),
        })));
        sendAck(incoming);
        announceResult(game, 'resigned', localColor(game, me.id));
        break;
      }
      case 'result': {
        if (incoming.to !== undefined || !incoming.gameId || !validResultPayload(incoming.payload)) break;
        const payload = incoming.payload;
        const entry: ResultEntry = {
          id: incoming.id,
          gameId: incoming.gameId,
          white: payload.white.slice(0, 24),
          black: payload.black.slice(0, 24),
          outcome: payload.outcome,
          reason: payload.reason,
          at: incoming.sentAt,
        };
        commit((latest) => latest.results.some((item) => item.gameId === entry.gameId) ? latest : ({
          ...latest,
          results: [entry, ...latest.results].slice(0, MAX_RESULTS),
        }));
        break;
      }
      case 'rematch': {
        if (incoming.to !== me.id || !validAcceptPayload(incoming.payload)) break;
        const payload = incoming.payload;
        const previous = current.games.find((entry) => entry.id === incoming.gameId);
        if (!previous || current.games.some((entry) => entry.id === payload.gameId)
          || ![payload.white.id, payload.black.id].includes(me.id)
          || ![payload.white.id, payload.black.id].includes(incoming.from.id)) break;
        commit((latest) => ({ ...latest, games: [...latest.games, acceptedGame(payload, me.id)] }));
        sendAck(incoming);
        break;
      }
    }
  }, [addLog, announceOpenChallenges, announceResult, commit, sendAck, sendSync, sendSyncRequest]);
  receiveRef.current = receive;

  const disconnect = useCallback(async (): Promise<void> => {
    connectionRef.current += 1;
    channelRef.current?.close();
    channelRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    if (adapter) await adapter.disconnect().catch(() => undefined);
    updateTransport(OFFLINE_TRANSPORT);
  }, [updateTransport]);

  const connect = useCallback(async (kind: TransportKind, chooseNewDevice = false): Promise<void> => {
    await disconnect();
    const connection = ++connectionRef.current;
    updateTransport({ kind, status: 'connecting', detail: kind === 'demo' ? 'Opening demo channel' : 'Connecting radio' });
    if (kind === 'demo') {
      if (typeof BroadcastChannel === 'undefined') {
        updateTransport({ kind, status: 'error', detail: 'BroadcastChannel is unavailable' });
        throw new Error('BroadcastChannel is unavailable');
      }
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (connectionRef.current === connection && typeof event.data === 'string') receiveRef.current(event.data);
      };
      updateTransport({ kind, status: 'connected', detail: 'Demo channel connected', channelName: CHANNEL_NAME });
      enqueueRef.current(packet('hello', stateRef.current.profile, {}), false);
      void flushRef.current();
      return;
    }

    const callbacks = {
      onMessage: (text: string) => {
        if (connectionRef.current === connection) receiveRef.current(text);
      },
      onDirectMessage: (message: { text: string }) => {
        if (connectionRef.current === connection) receiveRef.current(message.text);
      },
      onState: (next: TransportState) => {
        if (connectionRef.current === connection) updateTransport(next);
      },
      onLog: (text: string) => {
        if (connectionRef.current === connection) addLog(text);
      },
    };
    const adapter = kind === 'serial' ? new SerialAdapter(callbacks) : new BLEAdapter(callbacks);
    adapterRef.current = adapter;
    try {
      if (adapter instanceof BLEAdapter) await adapter.connect(undefined, chooseNewDevice);
      else await adapter.connect();
      if (connectionRef.current !== connection) {
        await adapter.disconnect().catch(() => undefined);
        return;
      }
      addLog(`${kind === 'serial' ? 'USB' : 'Bluetooth'} radio ready on ${GAME_CHANNEL}`);
      enqueueRef.current(packet('hello', stateRef.current.profile, {}), false);
      announceOpenChallenges();
      void flushRef.current();
    } catch (error) {
      if (connectionRef.current === connection) {
        adapterRef.current = null;
        updateTransport({ kind, status: 'error', detail: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }, [addLog, announceOpenChallenges, disconnect, updateTransport]);
  connectRef.current = connect;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void loadState().then((loaded) => {
      if (cancelled) return;
      stateRef.current = loaded;
      setState(loaded);
      setReady(true);
      void connectRef.current('demo').catch((error: unknown) => {
        addLog(`Demo: ${error instanceof Error ? error.message : String(error)}`);
      });
    }).catch((error: unknown) => {
      if (!cancelled) addLog(`Load: ${error instanceof Error ? error.message : String(error)}`);
    });
    const retryTimer = setInterval(() => void flushRef.current(), 1000);
    const flush = () => void flushRef.current();
    const removeServiceWorkerListener = onServiceWorkerMessage(flush);
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      clearInterval(retryTimer);
      removeServiceWorkerListener();
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', flush);
      connectionRef.current += 1;
      channelRef.current?.close();
      channelRef.current = null;
      const adapter = adapterRef.current;
      adapterRef.current = null;
      if (adapter) void adapter.disconnect().catch(() => undefined);
    };
  }, [addLog]);

  const updateName = useCallback((name: string) => {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    commit((latest) => {
      const profile = { ...latest.profile, name: clean };
      try {
        globalThis.sessionStorage?.setItem('meshchess-profile-v1', JSON.stringify(profile));
      } catch {}
      const rename = (player: Player) => player.id === profile.id ? { ...player, name: clean } : player;
      return {
        ...latest,
        profile,
        games: latest.games.map((game) => ({ ...game, white: rename(game.white), black: rename(game.black) })),
        challenges: latest.challenges.map((challenge) => ({ ...challenge, host: rename(challenge.host) })),
        chats: latest.chats.map((chat) => ({ ...chat, from: rename(chat.from) })),
      };
    });
  }, [commit]);

  const createChallenge = useCallback((hostColor: Color | 'random') => {
    const id = uniqueId('challenge');
    const challenge: Challenge = { id, host: { ...stateRef.current.profile }, hostColor, createdAt: Date.now() };
    commit((latest) => ({ ...latest, challenges: [...latest.challenges, challenge] }));
    const payload: ChallengePayload = { challengeId: id, hostColor };
    enqueueRef.current(packet('challenge', stateRef.current.profile, payload), false);
  }, [commit]);

  const withdrawChallenge = useCallback((id: string) => {
    const challenge = stateRef.current.challenges.find((entry) => entry.id === id);
    if (!challenge || challenge.host.id !== stateRef.current.profile.id || challenge.withdrawn) return;
    commit((latest) => ({
      ...latest,
      challenges: latest.challenges.map((entry) => entry.id === id ? { ...entry, withdrawn: true } : entry),
    }));
    enqueueRef.current(packet('withdraw', stateRef.current.profile, { challengeId: id }), false);
  }, [commit]);

  const acceptChallenge = useCallback((challenge: Challenge): string | null => {
    const current = stateRef.current;
    const available = current.challenges.find((entry) => entry.id === challenge.id);
    if (!available || available.host.id === current.profile.id || available.withdrawn
      || current.games.some((game) => game.challengeId === challenge.id)) return null;
    challenge = available;
    const hostColor = challenge.hostColor === 'random' ? resolveRandom(challenge.id) : challenge.hostColor;
    const white = hostColor === 'w' ? challenge.host : current.profile;
    const black = hostColor === 'w' ? current.profile : challenge.host;
    const payload: AcceptPayload = {
      challengeId: challenge.id,
      gameId: uniqueId('game'),
      white: { ...white },
      black: { ...black },
    };
    const outgoing = packet('accept', current.profile, payload, { to: challenge.host.id, gameId: payload.gameId });
    const game = { ...acceptedGame(payload, current.profile.id), awaitingAck: outgoing.id };
    commit((latest) => ({
      ...latest,
      games: [...latest.games, game],
      challenges: latest.challenges.map((entry) => entry.id === challenge.id ? { ...entry, withdrawn: true } : entry),
    }));
    enqueueRef.current(outgoing);
    return game.id;
  }, [commit]);

  const playMove = useCallback((gameId: string, input: { from: string; to: string; promotion?: string }): boolean => {
    const current = stateRef.current;
    const game = current.games.find((entry) => entry.id === gameId);
    if (!game || game.status !== 'active') return false;
    const turn: Color = game.moves.length % 2 === 0 ? 'w' : 'b';
    if (game.localColor !== turn) return false;
    try {
      const outgoingId = uniqueId('move');
      const move = makeMove(game.moves, input, { packetId: outgoingId });
      const payload: MovePayload = {
        n: game.moves.length + 1,
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
        san: move.san,
      };
      const result = gameResult([...game.moves, move]);
      const outgoing = packet('move', current.profile, payload, {
        id: outgoingId,
        gameId,
        to: opponent(game, current.profile.id).id,
      });
      commit((latest) => replaceGame(latest, gameId, (value) => ({
        ...value,
        moves: [...value.moves, move],
        status: result.status,
        ...(result.winner ? { winner: result.winner } : { winner: undefined }),
        drawOffer: null,
        awaitingAck: outgoingId,
        updatedAt: Date.now(),
      })));
      enqueueRef.current(outgoing);
      announceResult(game, result.status, result.winner);
      return true;
    } catch {
      return false;
    }
  }, [announceResult, commit]);

  const resign = useCallback((gameId: string) => {
    const current = stateRef.current;
    const game = current.games.find((entry) => entry.id === gameId);
    if (!game || game.status !== 'active') return;
    const outgoing = packet('resign', current.profile, {}, {
      gameId,
      to: opponent(game, current.profile.id).id,
    });
    commit((latest) => replaceGame(latest, gameId, (value) => ({
      ...value,
      status: 'resigned',
      winner: value.localColor === 'w' ? 'b' : 'w',
      drawOffer: null,
      awaitingAck: outgoing.id,
      updatedAt: Date.now(),
    })));
    enqueueRef.current(outgoing);
  }, [commit]);

  const offerDraw = useCallback((gameId: string) => {
    const current = stateRef.current;
    const game = current.games.find((entry) => entry.id === gameId);
    if (!game || game.status !== 'active') return;
    const payload: DrawPayload = { offerId: uniqueId('draw') };
    const outgoing = packet('draw', current.profile, payload, {
      gameId,
      to: opponent(game, current.profile.id).id,
    });
    commit((latest) => replaceGame(latest, gameId, (value) => ({
      ...value,
      drawOffer: { by: current.profile.id, at: Date.now() },
      awaitingAck: outgoing.id,
      updatedAt: Date.now(),
    })));
    enqueueRef.current(outgoing);
  }, [commit]);

  const respondDraw = useCallback((gameId: string, response: 'accept' | 'decline') => {
    const current = stateRef.current;
    const game = current.games.find((entry) => entry.id === gameId);
    if (!game || game.status !== 'active' || !game.drawOffer || game.drawOffer.by === current.profile.id) return;
    const payload: DrawPayload = { response, offerId: uniqueId('draw-response') };
    const outgoing = packet('draw', current.profile, payload, {
      gameId,
      to: opponent(game, current.profile.id).id,
    });
    commit((latest) => replaceGame(latest, gameId, (value) => ({
      ...value,
      status: response === 'accept' ? 'draw' : value.status,
      winner: undefined,
      drawOffer: null,
      awaitingAck: outgoing.id,
      updatedAt: Date.now(),
    })));
    enqueueRef.current(outgoing);
    if (response === 'accept') announceResult(game, 'draw', undefined);
  }, [announceResult, commit]);

  const sendChat = useCallback((gameId: string | null, text: string) => {
    const clean = text.trim();
    if (!clean || clean.length > 240) return;
    const current = stateRef.current;
    const game = gameId ? current.games.find((entry) => entry.id === gameId) : undefined;
    if (gameId && !game) return;
    const outgoing = packet('chat', current.profile, { text: clean } satisfies ChatPayload, {
      ...(game ? { gameId: game.id, to: opponent(game, current.profile.id).id } : {}),
    });
    const chat: ChatMessage = {
      id: outgoing.id,
      gameId,
      from: { ...current.profile },
      text: clean,
      at: outgoing.sentAt,
      delivery: 'queued',
      mine: true,
    };
    commit((latest) => ({ ...latest, chats: [...latest.chats, chat] }));
    enqueueRef.current(outgoing);
  }, [commit]);

  const requestSync = useCallback((gameId: string) => {
    const current = stateRef.current;
    const game = current.games.find((entry) => entry.id === gameId);
    if (game) sendSyncRequest(gameId, opponent(game, current.profile.id).id);
  }, [sendSyncRequest]);

  const markRead = useCallback((gameId: string) => {
    commit((latest) => replaceGame(latest, gameId, (game) => ({ ...game, lastReadAt: Date.now() })));
  }, [commit]);

  const deleteLocalGame = useCallback((gameId: string) => {
    commit((latest) => ({
      ...latest,
      games: latest.games.filter((game) => game.id !== gameId),
      chats: latest.chats.filter((chat) => chat.gameId !== gameId),
      outbox: latest.outbox.filter((item) => item.gameId !== gameId),
    }));
  }, [commit]);

  return {
    ready,
    state,
    transport,
    logs,
    connect,
    disconnect,
    updateName,
    createChallenge,
    withdrawChallenge,
    acceptChallenge,
    playMove,
    resign,
    offerDraw,
    respondDraw,
    sendChat,
    requestSync,
    markRead,
    deleteLocalGame,
  };
}

export default useMeshChess;
