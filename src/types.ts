export type Color = 'w' | 'b';
export type GameStatus = 'active' | 'checkmate' | 'stalemate' | 'draw' | 'resigned' | 'aborted';
export type Delivery = 'queued' | 'sent' | 'acked' | 'received';
export type DrawState = { by: string; at: number } | null;

export interface Player { id: string; name: string }
export interface MoveRecord {
  from: string;
  to: string;
  promotion?: string;
  san: string;
  fen: string;
  color: Color;
  packetId: string;
  at: number;
}
export interface ChatMessage {
  id: string;
  gameId: string | null;
  from: Player;
  text: string;
  at: number;
  delivery: Delivery;
  mine: boolean;
}
export interface Game {
  id: string;
  challengeId: string;
  white: Player;
  black: Player;
  localColor: Color;
  status: GameStatus;
  winner?: Color;
  moves: MoveRecord[];
  createdAt: number;
  updatedAt: number;
  lastReadAt: number;
  drawOffer: DrawState;
  awaitingAck: string | null;
  seenPackets: string[];
}
export interface Challenge {
  id: string;
  host: Player;
  hostColor: Color | 'random';
  createdAt: number;
  withdrawn?: boolean;
}
export interface Peer { id: string; name: string; lastSeen: number }
export interface ResultEntry {
  id: string;
  gameId: string;
  white: string;
  black: string;
  outcome: 'white' | 'black' | 'draw';
  reason: GameStatus;
  at: number;
}
export interface Profile { id: string; name: string }
export interface OutboxItem {
  id: string;
  wire: string;
  packetId: string;
  kind: PacketKind;
  gameId?: string;
  ackId?: string;
  createdAt: number;
  attempts: number;
  lastAttempt: number;
}
export interface PersistedState {
  profile: Profile;
  games: Game[];
  challenges: Challenge[];
  peers: Peer[];
  results: ResultEntry[];
  chats: ChatMessage[];
  outbox: OutboxItem[];
  seen: string[];
}

export type PacketKind = 'hello' | 'challenge' | 'withdraw' | 'accept' | 'move' | 'ack' | 'sync-request' | 'sync' | 'chat' | 'draw' | 'resign' | 'rematch' | 'result';
export interface Packet<T = unknown> {
  v: 1;
  id: string;
  kind: PacketKind;
  from: Player;
  to?: string;
  gameId?: string;
  payload: T;
  sentAt: number;
}
export interface ChallengePayload { challengeId: string; hostColor: Color | 'random' }
export interface AcceptPayload { challengeId: string; gameId: string; white: Player; black: Player }
export interface MovePayload { n: number; from: string; to: string; promotion?: string; san: string; fen?: string }
export interface AckPayload { packetId: string; gameId?: string; moveCount: number }
export interface SyncPayload { moves: MoveRecord[]; status: GameStatus; winner?: Color }
export interface ChatPayload { text: string }
export interface DrawPayload { response?: 'accept' | 'decline'; offerId?: string }
export interface ResultPayload { white: string; black: string; outcome: 'white' | 'black' | 'draw'; reason: GameStatus }

export type TransportKind = 'demo' | 'serial' | 'ble';
export type ConnectionStatus = 'offline' | 'connecting' | 'connected' | 'error';
export interface TransportState {
  kind: TransportKind | null;
  status: ConnectionStatus;
  detail: string;
  channel?: number;
  channelName?: string;
}
export interface RadioLog { id: number; text: string; at: number }
