import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bluetooth, Check, CheckCheck, ChevronDown, Circle,
  Clock3, Copy, Download, Flag, Gamepad2, Handshake, Inbox, Info, ListOrdered,
  MessageCircle, Plus, Radio, RefreshCw, RotateCcw, Send,
  Settings, ShieldCheck, Signal, Swords, Trash2, Trophy, Usb, Users, WifiOff, X,
} from 'lucide-react';
import { ChessBoard } from './components/ChessBoard';
import { useMeshChess } from './hooks/useMeshChess';
import { exportPgn } from './lib/chess';
import { supportsBluetooth, supportsSerial } from './lib/transports';
import { isRadioDeliveryPaused } from './lib/outbox';
import type { Challenge, Color, Game, GameStatus, ResultEntry, TransportKind } from './types';

type View = 'games' | 'lobby' | 'network';
type SideTab = 'moves' | 'chat';
type GameFilter = 'all' | 'turn' | 'finished';

function isYourTurn(game: Game) {
  return game.status === 'active' && (game.moves.length % 2 === 0 ? 'w' : 'b') === game.localColor;
}

function timeAgo(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function opponentOf(game: Game, id: string) {
  return game.white.id === id ? game.black : game.white;
}

function resultLabel(game: Game) {
  if (game.status === 'active') return '';
  if (game.status === 'checkmate') return `${game.winner === 'w' ? 'White' : 'Black'} wins by checkmate`;
  if (game.status === 'resigned') return `${game.winner === 'w' ? 'White' : 'Black'} wins by resignation`;
  if (game.status === 'stalemate') return 'Draw by stalemate';
  if (game.status === 'aborted') return 'Game cancelled';
  return 'Game drawn';
}

function feedResultText(entry: ResultEntry) {
  if (entry.outcome === 'draw') return `${entry.white} drew with ${entry.black}`;
  return entry.outcome === 'white' ? `${entry.white} beat ${entry.black}` : `${entry.black} beat ${entry.white}`;
}

function feedResultReason(reason: GameStatus) {
  if (reason === 'checkmate') return 'Checkmate';
  if (reason === 'stalemate') return 'Stalemate';
  if (reason === 'resigned') return 'Resignation';
  return 'Draw agreed';
}

function App() {
  const mesh = useMeshChess();
  const { state } = mesh;
  const pausedPackets = state.outbox.filter(isRadioDeliveryPaused).length;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('games');
  const [sideTab, setSideTab] = useState<SideTab>('moves');
  const [orientation, setOrientation] = useState<Color>('w');
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [newGameOpen, setNewGameOpen] = useState(false);
  const [newColor, setNewColor] = useState<Color | 'random'>('random');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileGameList, setMobileGameList] = useState(true);
  const [gameFilter, setGameFilter] = useState<GameFilter>('all');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [globalChat, setGlobalChat] = useState(false);
  const [confirm, setConfirm] = useState<'resign' | 'delete' | null>(null);
  const [toast, setToast] = useState('');
  const [installPrompt, setInstallPrompt] = useState<{ prompt(): Promise<void> } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatButtonRef = useRef<HTMLButtonElement>(null);
  const movesButtonRef = useRef<HTMLButtonElement>(null);
  const panelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const gamePanelRef = useRef<HTMLElement>(null);

  const sortedGames = useMemo(() => [...state.games].sort((a, b) => {
    if ((a.status === 'active') !== (b.status === 'active')) return a.status === 'active' ? -1 : 1;
    if (a.status === 'active' && b.status === 'active') {
      const aTurn = a.moves.length % 2 === 0 ? 'w' : 'b';
      const bTurn = b.moves.length % 2 === 0 ? 'w' : 'b';
      if ((aTurn === a.localColor) !== (bTurn === b.localColor)) return aTurn === a.localColor ? -1 : 1;
    }
    return b.updatedAt - a.updatedAt;
  }), [state.games]);
  const turnCount = sortedGames.filter(isYourTurn).length;
  const finishedCount = sortedGames.filter((item) => item.status !== 'active').length;
  const filteredGames = sortedGames.filter((item) => gameFilter === 'turn' ? isYourTurn(item)
    : gameFilter === 'finished' ? item.status !== 'active' : true);
  const game = sortedGames.find((item) => item.id === selectedId) ?? sortedGames[0] ?? null;
  const gameDeliveryPaused = mesh.transport.kind !== 'demo'
    && state.outbox.some((item) => item.packetId === game?.awaitingAck && isRadioDeliveryPaused(item));
  const opponent = game ? opponentOf(game, state.profile.id) : null;
  const myTurn = !!game && game.status === 'active' && (game.moves.length % 2 === 0 ? 'w' : 'b') === game.localColor;
  const unread = (id: string) => state.chats.filter((chat) => chat.gameId === id && !chat.mine && chat.at > (state.games.find((g) => g.id === id)?.lastReadAt ?? 0)).length;
  const activeChallenges = state.challenges.filter((challenge) => !challenge.withdrawn && challenge.host.id !== state.profile.id);
  const ownChallenge = state.challenges.find((challenge) => !challenge.withdrawn && challenge.host.id === state.profile.id);
  const onlinePeers = state.peers.filter((peer) => Date.now() - peer.lastSeen < 10 * 60_000 && peer.id !== state.profile.id);
  const chats = state.chats.filter((chat) => globalChat ? chat.gameId === null : chat.gameId === game?.id);

  useEffect(() => {
    if (game) {
      setSelectedId(game.id);
      setOrientation(game.localColor);
      setReviewPly(null);
    }
  }, [game?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (game && view === 'games' && sideTab === 'chat' && !globalChat
      && (mobileChatOpen || window.matchMedia('(min-width: 901px)').matches)) mesh.markRead(game.id);
  }, [game?.id, view, sideTab, globalChat, mobileChatOpen, chats.length, mesh.markRead]);

  useEffect(() => {
    const messages = chatEndRef.current?.parentElement;
    messages?.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
  }, [chats.length, sideTab, globalChat, mobileChatOpen]);
  useEffect(() => {
    setMobileChatOpen(false);
  }, [view, game?.id]);
  useEffect(() => {
    if (!mobileChatOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileChatOpen(false);
        panelTriggerRef.current?.focus({ preventScroll: true });
      }
    };
    const viewport = window.visualViewport;
    const resizePanel = () => {
      gamePanelRef.current?.style.setProperty('--chat-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      gamePanelRef.current?.style.setProperty('--chat-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resizePanel();
    viewport?.addEventListener('resize', resizePanel);
    viewport?.addEventListener('scroll', resizePanel);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      viewport?.removeEventListener('resize', resizePanel);
      viewport?.removeEventListener('scroll', resizePanel);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileChatOpen]);
  useEffect(() => {
    const listener = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as unknown as { prompt(): Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', listener);
    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timeout);
  }, [toast]);

  const notify = (text: string) => setToast(text);
  const showGames = () => {
    setView('games');
    setMobileGameList(true);
    setMobileChatOpen(false);
  };
  const openPanel = (tab: SideTab) => {
    panelTriggerRef.current = tab === 'chat' ? chatButtonRef.current : movesButtonRef.current;
    setSideTab(tab);
    setMobileChatOpen(true);
    setMobileGameList(false);
  };
  const closePanel = () => {
    setMobileChatOpen(false);
    panelTriggerRef.current?.focus({ preventScroll: true });
  };
  const reviewMove = (ply: number) => {
    setReviewPly(ply);
    closePanel();
  };
  const copy = async (text: string, message: string) => {
    try { await navigator.clipboard.writeText(text); notify(message); } catch { notify('Clipboard unavailable'); }
  };
  const connect = async (kind: TransportKind, chooseNewDevice = false) => {
    try { await mesh.connect(kind, chooseNewDevice); notify(kind === 'demo' ? 'Local demo connected' : 'MeshCore radio connected'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not connect'); }
  };
  const submitChat = () => {
    if (!chatText.trim()) return;
    mesh.sendChat(globalChat ? null : game?.id ?? null, chatText);
    setChatText('');
  };
  const downloadPgn = () => {
    if (!game) return;
    const url = URL.createObjectURL(new Blob([exportPgn(game.moves)], { type: 'application/x-chess-pgn' }));
    const link = document.createElement('a');
    link.href = url; link.download = `cheshy-mess-${game.id.slice(-8)}.pgn`; link.click();
    URL.revokeObjectURL(url);
  };

  if (!mesh.ready) return <div className="loading-screen"><div className="brand-mark">♞</div><h1>Cheshy Mess</h1><span className="spinner" /><p>Opening your chessboard…</p></div>;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={(e) => { e.preventDefault(); showGames(); }}><span className="brand-mark">♞</span><span>cheshy <span>mess</span></span></a>
      <span className="brand-tagline">CHESS BEYOND CONNECTIVITY</span>
      <nav className="main-nav" aria-label="Main navigation">
        <button className={view === 'games' ? 'active' : ''} onClick={showGames}><Swords size={17} />My games{sortedGames.filter((g) => g.status === 'active').length > 0 && <b>{sortedGames.filter((g) => g.status === 'active').length}</b>}</button>
        <button className={view === 'lobby' ? 'active' : ''} onClick={() => setView('lobby')}><Users size={17} />Lobby{activeChallenges.length > 0 && <b>{activeChallenges.length}</b>}</button>
      </nav>
      <div className="header-actions">
        <button className={`connection-pill ${mesh.transport.status}`} aria-label={`Connection settings: ${mesh.transport.detail}`} onClick={() => setView('network')}><span className="status-dot" />{mesh.transport.status === 'connected' ? mesh.transport.kind === 'demo' ? 'Local demo' : 'Radio online' : mesh.transport.status === 'connecting' ? 'Connecting' : mesh.transport.status === 'error' ? 'Connection error' : 'Off-grid'}<ChevronDown size={14} /></button>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Settings size={20} /></button>
        <button className="avatar" onClick={() => setSettingsOpen(true)} aria-label="Your profile">{state.profile.name.slice(0, 1).toUpperCase()}</button>
      </div>
    </header>

    {view === 'games' && <main className={`game-layout ${mobileGameList && game ? 'show-game-list' : ''}`}>
      <aside className="games-sidebar">
        <div className="sidebar-heading"><div><span className="eyebrow">YOUR CORRESPONDENCE</span><h2>My games</h2></div><button className="icon-button" onClick={() => setNewGameOpen(true)} aria-label="New game"><Plus size={21} /></button></div>
        <button className="new-game-button" onClick={() => setNewGameOpen(true)}><Plus size={18} />New game<span>over the mesh</span></button>
        <p className="games-summary">{turnCount ? `${turnCount} game${turnCount === 1 ? '' : 's'} waiting for your move` : 'No rush. Your next move will be here.'}</p>
        <div className="game-filters" aria-label="Filter games">
          <button className={gameFilter === 'all' ? 'active' : ''} aria-pressed={gameFilter === 'all'} onClick={() => setGameFilter('all')}>All <span>{state.games.length}</span></button>
          <button className={gameFilter === 'turn' ? 'active' : ''} aria-pressed={gameFilter === 'turn'} onClick={() => setGameFilter('turn')}>Your turn <span>{turnCount}</span></button>
          <button className={gameFilter === 'finished' ? 'active' : ''} aria-pressed={gameFilter === 'finished'} onClick={() => setGameFilter('finished')}>Finished <span>{finishedCount}</span></button>
        </div>
        <div className="game-list">
          {filteredGames.map((item) => {
            const other = opponentOf(item, state.profile.id);
            const turn = item.moves.length % 2 === 0 ? 'w' : 'b';
            const isTurn = item.status === 'active' && turn === item.localColor;
            return <button key={item.id} className={`game-list-item ${game?.id === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setMobileGameList(false); }}>
              <span className={`mini-avatar ${item.localColor === 'w' ? 'dark' : 'light'}`}>{other.name.slice(0, 1).toUpperCase()}</span>
              <span className="game-item-copy"><strong>{other.name}</strong><small>{item.status === 'active' ? isTurn ? 'Your turn' : 'Waiting for opponent' : resultLabel(item)}</small><small className="game-item-time"><Clock3 size={12} />{timeAgo(item.updatedAt)} · {item.moves.length} {item.moves.length === 1 ? 'move' : 'moves'}</small></span>
              {unread(item.id) > 0 && <span className="unread-badge" aria-label={`${unread(item.id)} unread messages`}>{unread(item.id)}</span>}
              {isTurn && <span className="turn-dot" />}
            </button>;
          })}
          {!state.games.length && <div className="empty-list"><span>♟</span><h3>No games yet</h3><p>Create a game and make your first move when a player joins.</p></div>}
          {state.games.length > 0 && !filteredGames.length && <div className="empty-list"><Clock3 size={28} /><h3>{gameFilter === 'turn' ? 'All caught up' : 'No finished games yet'}</h3><p>{gameFilter === 'turn' ? 'We will keep your games here while you wait for an opponent.' : 'Completed games will appear here.'}</p><button className="text-button" onClick={() => setGameFilter('all')}>Show all games<ArrowRight size={16} /></button></div>}
        </div>
        <button className="sidebar-lobby-link" onClick={() => setView('lobby')}><Inbox size={17} />Find an open game<ArrowRight size={16} /></button>
        <div className="mesh-note"><ShieldCheck size={18} /><div><strong>Made for the long game</strong><p>Your games are saved on this device. Moves queue until your radio reconnects.</p></div></div>
      </aside>

      <section className="board-workspace">
        {game && opponent ? <>
          <div className="board-navigation"><button onClick={showGames}><ArrowLeft size={18} />All games</button><span>{sortedGames.length} saved {sortedGames.length === 1 ? 'game' : 'games'}</span></div>
          <div className="player-strip opponent-strip">
            <span className="player-avatar">{opponent.name.slice(0, 1).toUpperCase()}<i className={onlinePeers.some((p) => p.id === opponent.id) ? 'online' : ''} /></span>
            <div><strong>{opponent.name}</strong><span><span className="tiny-dot" />{onlinePeers.some((p) => p.id === opponent.id) ? 'Recently on mesh' : 'Asynchronous opponent'}</span></div>
            <div className="player-strip-right"><span className="color-label">{game.localColor === 'w' ? 'BLACK' : 'WHITE'}</span><button className="icon-button" aria-label="Remove game" onClick={() => setConfirm('delete')}><Trash2 size={20} /></button></div>
          </div>
          <div className="board-frame"><ChessBoard moves={game.moves} localColor={game.localColor} interactive={myTurn} orientation={orientation} onMove={(input) => mesh.playMove(game.id, input)} reviewPly={reviewPly} onReviewEnd={() => setReviewPly(null)} /></div>
          <div className="player-strip local-strip">
            <span className="player-avatar local">{state.profile.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{state.profile.name} <span className="you-tag">YOU</span></strong><span>{game.localColor === 'w' ? 'White pieces' : 'Black pieces'}</span></div>
            <div className="player-strip-right">{game.awaitingAck && <button className="delivery-label" onClick={() => { mesh.requestSync(game.id); notify('Sync requested'); }} title="Retry pending game update"><RefreshCw size={13} />{gameDeliveryPaused ? 'Delivery paused' : game.status === 'active' ? 'Delivering move' : 'Confirming result'}</button>}<span className="color-label">{game.localColor === 'w' ? 'WHITE' : 'BLACK'}</span></div>
          </div>
          <div className={`turn-banner ${myTurn ? 'your-turn' : ''}`}>
            <span className="turn-icon">{game.status !== 'active' ? <Trophy size={18} /> : myTurn ? <Swords size={18} /> : <Clock3 size={18} />}</span>
            <div><strong>{resultLabel(game) || (myTurn ? 'Your move' : `${opponent.name}’s move`)}</strong><span>{game.status !== 'active' ? 'Game over. Start a new game or remove this one.' : myTurn ? 'Take your time. The mesh will wait.' : 'You’ll find their move here when you return.'}</span></div>
            <span className="no-clock"><WifiOff size={14} />No clock</span>
            {game.drawOffer && game.drawOffer.by !== state.profile.id && <div className="mobile-draw-actions"><span>Draw offer</span><button onClick={() => mesh.respondDraw(game.id, 'accept')}>Accept</button><button onClick={() => mesh.respondDraw(game.id, 'decline')}>Decline</button></div>}
          </div>
          <div className="board-toolbar">
            <button onClick={() => setOrientation(orientation === 'w' ? 'b' : 'w')}><RotateCcw size={16} />Flip board</button>
            <button className="mobile-moves-button" ref={movesButtonRef} aria-controls="game-panel" aria-expanded={sideTab === 'moves' && mobileChatOpen} onClick={() => openPanel('moves')}><ListOrdered size={16} />Moves</button>
            <button ref={chatButtonRef} aria-controls="game-panel" aria-expanded={sideTab === 'chat' && mobileChatOpen} onClick={() => openPanel('chat')}><MessageCircle size={16} />Chat{unread(game.id) > 0 && <i />}</button>
            {game.status === 'active' ? <button onClick={() => setConfirm('resign')}><Flag size={16} />Resign</button> : <button onClick={() => setNewGameOpen(true)}><Plus size={16} />New game</button>}
          </div>
        </> : <div className="welcome-board">
          <div className="welcome-art"><span>♞</span><i className="signal-one" /><i className="signal-two" /><i className="signal-three" /></div>
          <span className="eyebrow">A SLOW GAME. A WORLD AWAY.</span><h1>Your next move is<br />off the grid.</h1>
          <p>Play correspondence chess over MeshCore radio.<br />No servers. No accounts. Just you and the game.</p>
          <button className="primary-button" onClick={() => setNewGameOpen(true)}><Plus size={18} />Start a new game</button>
          <button className="text-button" onClick={() => setView('lobby')}>or find a game in the lobby <ArrowRight size={15} /></button>
          <div className="welcome-guide"><strong>Your first game in three steps</strong><p>Choose your color. Post a challenge. Play when someone joins.</p><button className="text-button" onClick={() => setView('network')}><Radio size={16} />Connect a radio or try the local demo<ArrowRight size={15} /></button></div>
        </div>}
      </section>

      <aside id="game-panel" ref={gamePanelRef} className={`game-panel ${mobileChatOpen ? 'mobile-chat-open' : ''}`}>
        {game && opponent ? <>
          <div className="mobile-chat-header"><button className="mobile-chat-close" onClick={closePanel} aria-label={sideTab === 'chat' ? 'Close chat' : 'Close moves'}><ArrowLeft size={20} />Back to board</button><span>{sideTab === 'chat' ? 'Conversation' : 'Game details'}</span></div>
          <div className="panel-tabs"><button className={sideTab === 'moves' ? 'active' : ''} onClick={() => setSideTab('moves')}>Moves</button><button className={sideTab === 'chat' ? 'active' : ''} onClick={() => { setSideTab('chat'); setGlobalChat(false); mesh.markRead(game.id); }}>Chat{unread(game.id) > 0 && <b>{unread(game.id)}</b>}</button></div>
          {sideTab === 'moves' ? <div className="moves-panel">
            <div className="game-meta"><div><span className="eyebrow">CORRESPONDENCE</span><h3>Game #{game.id.slice(-6).toUpperCase()}</h3></div><span className="async-badge"><Clock3 size={12} />ASYNC</span></div>
            <div className="move-table"><div className="move-table-head"><span>#</span><span>WHITE</span><span>BLACK</span></div>
              {Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, index) => <div className="move-row" key={index}><span>{index + 1}.</span><button className={reviewPly === index * 2 + 1 ? 'active' : ''} onClick={() => reviewMove(index * 2 + 1)}>{game.moves[index * 2]?.san}</button><button disabled={!game.moves[index * 2 + 1]} className={reviewPly === index * 2 + 2 ? 'active' : ''} onClick={() => reviewMove(index * 2 + 2)}>{game.moves[index * 2 + 1]?.san}</button></div>)}
              {!game.moves.length && <div className="no-moves"><span>♙</span><p>The board is set.<br />White makes the first move.</p></div>}
            </div>
            <div className="history-controls"><button onClick={() => setReviewPly(0)} disabled={!game.moves.length} aria-label="First position">|‹</button><button onClick={() => setReviewPly(Math.max(0, (reviewPly ?? game.moves.length) - 1))} disabled={!game.moves.length} aria-label="Previous move"><ArrowLeft size={17} /></button><span>{reviewPly ?? game.moves.length} / {game.moves.length}</span><button onClick={() => { const next = (reviewPly ?? game.moves.length) + 1; setReviewPly(next >= game.moves.length ? null : next); }} disabled={!game.moves.length || reviewPly === null} aria-label="Next move"><ArrowRight size={17} /></button><button onClick={() => setReviewPly(null)} disabled={reviewPly === null} aria-label="Latest position">›|</button></div>
            {game.drawOffer && <div className="draw-offer"><Handshake size={20} /><div><strong>{game.drawOffer.by === state.profile.id ? 'Draw offered' : `${opponent.name} offers a draw`}</strong><p>{game.drawOffer.by === state.profile.id ? 'Waiting for a response.' : 'Do you agree to split the point?'}</p></div>{game.drawOffer.by !== state.profile.id && <div className="draw-actions"><button onClick={() => mesh.respondDraw(game.id, 'accept')}>Accept</button><button onClick={() => mesh.respondDraw(game.id, 'decline')}>Decline</button></div>}</div>}
            <div className="panel-actions"><button onClick={() => mesh.offerDraw(game.id)} disabled={game.status !== 'active' || !!game.drawOffer}><Handshake size={16} />Offer draw</button><button onClick={downloadPgn}><Download size={16} />Export PGN</button></div>
            <div className="sync-row"><span>{game.awaitingAck ? <><RefreshCw size={13} className={gameDeliveryPaused ? undefined : 'spin'} />{gameDeliveryPaused ? 'Paused - retry in Mesh or request sync' : 'Awaiting acknowledgement'}</> : <><CheckCheck size={14} />Board synchronized</>}</span><button onClick={() => mesh.requestSync(game.id)} title="Request state sync"><RefreshCw size={14} /></button></div>
          </div> : <ChatPanel chats={chats} text={chatText} setText={setChatText} send={submitChat} globalChat={globalChat} setGlobalChat={setGlobalChat} hasGame endRef={chatEndRef} />}
          <div className="game-id-row">Game ID <button onClick={() => copy(game.id, 'Game ID copied')}>{game.id.slice(-12)}<Copy size={12} /></button></div>
        </> : <div className="panel-placeholder"><Radio size={28} /><h3>Connected by chess</h3><p>Moves and chat travel directly over your MeshCore network, even when the internet is nowhere to be found.</p><button className="text-button" onClick={() => setView('network')}>Set up your radio <ArrowRight size={15} /></button></div>}
      </aside>
    </main>}

    {view === 'lobby' && <main className="page-content">
      <div className="page-title"><div><span className="eyebrow">PLAY AT YOUR OWN PACE</span><h1>Open games</h1><p>Find a player on the mesh, or post a challenge for someone to discover.</p></div><button className="primary-button" onClick={() => setNewGameOpen(true)}><Plus size={18} />Create game</button></div>
      <div className="connection-context"><Radio size={18} /><p>{mesh.transport.status !== 'connected' ? 'You are offline. Connect to discover players and send your challenge.' : mesh.transport.kind === 'demo' ? 'Local demo: open a second browser tab to find an opponent. Real radio players use Mesh.' : 'Listening for players on #chess. Challenges appear as they arrive.'}</p><button onClick={() => setView('network')}>Connection settings<ArrowRight size={16} /></button></div>
      <div className="lobby-grid"><section className="surface"><div className="section-heading"><h2><Inbox size={20} />Available challenges</h2><span>{activeChallenges.length} open</span></div>
        {ownChallenge && <div className="own-challenge" role="status"><span className="pulse-radio"><Radio size={20} /></span><div><strong>Your challenge is on the mesh</strong><p>Waiting for a player to accept · {ownChallenge.hostColor === 'random' ? 'Random colors' : `You play ${ownChallenge.hostColor === 'w' ? 'White' : 'Black'}`}</p><p>You can browse your games while you wait.</p><button className="secondary-button" disabled={mesh.transport.status !== 'connected'} title={mesh.transport.status === 'connected' ? 'Resend your open challenges without creating new ones' : 'Connect to reannounce your challenges'} onClick={() => { mesh.reannounceChallenges(); notify('Challenges queued for reannouncement'); }}><RefreshCw size={14} />Reannounce challenges</button></div><button className="secondary-button" onClick={() => mesh.withdrawChallenge(ownChallenge.id)}>Withdraw</button></div>}
        <div className="challenge-list">{activeChallenges.map((challenge) => <ChallengeRow key={challenge.id} challenge={challenge} onAccept={() => { const gameId = mesh.acceptChallenge(challenge); if (!gameId) return; setSelectedId(gameId); setMobileGameList(false); setView('games'); notify('Game accepted — good luck!'); }} />)}{!activeChallenges.length && !ownChallenge && <div className="large-empty"><span>♜</span><h3>The board is quiet</h3><p>No open challenges heard yet. Create one, or keep this page open while players join the mesh.</p><button className="primary-button" onClick={() => setNewGameOpen(true)}><Plus size={17} />Post a challenge</button></div>}</div>
      </section><aside className="surface peers-card"><div className="section-heading"><h2><Signal size={20} />Heard on the mesh</h2><span>{onlinePeers.length}</span></div>{onlinePeers.map((peer) => <div className="peer-row" key={peer.id}><span className="mini-avatar">{peer.name[0].toUpperCase()}</span><div><strong>{peer.name}</strong><small>Last heard {timeAgo(peer.lastSeen)}</small></div><span className="status-dot" /></div>)}{!onlinePeers.length && <p className="muted-copy">No other players heard recently. In demo mode, open Cheshy Mess in a second tab to meet yourself on the mesh.</p>}
          <div className="results-block"><div className="section-heading"><h2><Trophy size={20} />Recent results</h2><span>{state.results.length}</span></div>
            {state.results.map((entry) => <div className="result-row" key={entry.id}>{entry.outcome === 'draw' ? <Handshake size={16} className="result-icon" /> : <Trophy size={16} className="result-icon" />}<div><strong>{feedResultText(entry)}</strong><small>{feedResultReason(entry.reason)} · {timeAgo(entry.at)}</small></div></div>)}
            {!state.results.length && <p className="muted-copy">Finished games on #chess will show up here.</p>}
          </div>
        </aside></div>
    </main>}

    {view === 'network' && <main className="page-content network-page">
      <div className="page-title"><div><span className="eyebrow">YOUR LINK TO THE LONG GAME</span><h1>Mesh connection</h1><p>Connect a MeshCore companion radio, or try the complete experience locally.</p></div><span className={`large-status ${mesh.transport.status}`}><span className="status-dot" />{mesh.transport.status === 'connected' ? 'Connected' : 'Off-grid'}</span></div>
      <div className="network-grid"><section className="surface"><div className="section-heading"><h2><Radio size={20} />Choose your connection</h2></div>
        <ConnectionCard icon={<Gamepad2 />} title="Local demo" description="Two browser tabs. No radio needed." active={mesh.transport.kind === 'demo' && mesh.transport.status === 'connected'} action={mesh.transport.kind === 'demo' && mesh.transport.status === 'connected' ? 'Connected' : 'Try demo'} onClick={() => void connect('demo')} />
        <ConnectionCard icon={<Usb />} title="USB Serial" description="MeshCore companion · 115200 baud" active={mesh.transport.kind === 'serial' && mesh.transport.status === 'connected'} action="Connect radio" onClick={() => void connect('serial')} disabled={!supportsSerial()} note={!supportsSerial() ? 'Requires Chrome or Edge on desktop/Android' : undefined} />
        <ConnectionCard icon={<Bluetooth />} title="Bluetooth LE" description="Wireless MeshCore companion" active={mesh.transport.kind === 'ble' && mesh.transport.status === 'connected'} action="Connect Bluetooth" onClick={() => void connect('ble')} disabled={!supportsBluetooth()} note={!supportsBluetooth() ? 'Web Bluetooth is not available in this browser' : undefined} />
        {supportsBluetooth() && <button className="text-button" onClick={() => void connect('ble', true)}>Choose another Bluetooth radio</button>}
        {mesh.transport.status === 'connected' && <button className="disconnect-button" onClick={() => void mesh.disconnect()}>Disconnect {mesh.transport.kind === 'demo' ? 'demo' : 'radio'}</button>}
      </section><aside className="surface channel-card"><div className="section-heading"><h2><Signal size={20} />Channel</h2></div><div className="channel-name">#chess<span>PUBLIC HASHTAG CHANNEL</span></div><dl><div><dt>Status</dt><dd>{mesh.transport.detail}</dd></div><div><dt>Channel slot</dt><dd>{mesh.transport.channel ?? 'Automatic'}</dd></div><div><dt>Queued packets</dt><dd>{state.outbox.length}</dd></div><div><dt>Protocol</dt><dd>MeshCore companion v3</dd></div></dl>
        <p className="muted-copy">Radio packets send once, retry once after five minutes, then pause until you retry manually. Unconfirmed packets stay saved.</p>
        {mesh.transport.kind !== 'demo' && pausedPackets > 0 && <button className="text-button" disabled={mesh.transport.status !== 'connected'} onClick={mesh.retryPausedPackets}>Retry {pausedPackets} paused packet{pausedPackets === 1 ? '' : 's'} once</button>}
        <div className="security-note"><Info size={17} /><p>Public channels are not private or authenticated. Only Cheshy Mess packets on this channel are processed; other messages are ignored.</p></div></aside></div>
      <section className="surface radio-log"><div className="section-heading"><h2>Connection activity</h2><span>{mesh.logs.length} events</span></div>{mesh.logs.length ? [...mesh.logs].reverse().map((log) => <div key={log.id}><time>{new Date(log.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>{log.text}</span></div>) : <p className="muted-copy">Connection and packet activity will appear here.</p>}</section>
    </main>}

    <nav className="mobile-nav" aria-label="Mobile navigation"><button className={view === 'games' ? 'active' : ''} aria-current={view === 'games' ? 'page' : undefined} onClick={showGames}><Swords size={20} />Games{turnCount > 0 && <b aria-label={`${turnCount} games need your move`}>{turnCount}</b>}</button><button className={view === 'lobby' ? 'active' : ''} aria-current={view === 'lobby' ? 'page' : undefined} onClick={() => setView('lobby')}><Users size={20} />Lobby{activeChallenges.length > 0 && <b>{activeChallenges.length}</b>}</button><button className="mobile-create" onClick={() => setNewGameOpen(true)}><Plus size={22} />New</button><button className={view === 'network' ? 'active' : ''} aria-current={view === 'network' ? 'page' : undefined} onClick={() => setView('network')}><Radio size={20} />Mesh</button></nav>

    {newGameOpen && <Modal title="Create a new game" onClose={() => setNewGameOpen(false)}><div className="modal-intro"><span>♞</span><p>Post an open challenge to <strong>#chess</strong>. Your game begins when another player accepts.</p></div><label className="field-label">PLAY AS</label><div className="color-options">{(['w', 'random', 'b'] as const).map((color) => <button key={color} className={newColor === color ? 'selected' : ''} onClick={() => setNewColor(color)}><span>{color === 'w' ? '♔' : color === 'b' ? '♚' : '⚄'}</span>{color === 'w' ? 'White' : color === 'b' ? 'Black' : 'Random'}{newColor === color && <Check size={15} />}</button>)}</div><div className="async-explainer"><Clock3 size={19} /><div><strong>Asynchronous · no clock</strong><p>Moves are queued until your mesh connection is available. Both players can take as long as they like.</p></div></div><button className="primary-button modal-primary" onClick={() => { mesh.createChallenge(newColor); setNewGameOpen(false); setView('lobby'); notify('Challenge posted to the mesh'); }}><Radio size={18} />Post challenge to mesh</button></Modal>}

    {settingsOpen && <Modal title="Your Cheshy Mess" onClose={() => setSettingsOpen(false)}><label className="field-label" htmlFor="profile-name">DISPLAY NAME</label><input id="profile-name" className="text-input" maxLength={24} defaultValue={state.profile.name} onChange={(e) => mesh.updateName(e.target.value)} onBlur={(e) => { e.currentTarget.value = e.currentTarget.value.trim() || state.profile.name; mesh.updateName(e.currentTarget.value); }} /><p className="field-help">This name is visible to other players on the public channel.</p><div className="settings-info"><span>Player ID</span><button onClick={() => copy(state.profile.id, 'Player ID copied')}>{state.profile.id.slice(0, 20)}…<Copy size={13} /></button></div>{installPrompt && <button className="secondary-button full-button" onClick={() => void installPrompt.prompt()}><Download size={17} />Install Cheshy Mess app</button>}<div className="settings-about"><span className="brand-mark">♞</span><div><strong>Cheshy Mess 1.0</strong><p>Offline-first correspondence chess.<br />Open protocol. No account. No server.</p></div></div><button className="primary-button modal-primary" onClick={() => { setSettingsOpen(false); }}><Check size={17} />Save and return</button></Modal>}

    {confirm && game && <Modal title={confirm === 'resign' ? 'Resign this game?' : 'Remove this game?'} onClose={() => setConfirm(null)}><p className="confirm-copy">{confirm === 'resign' ? `This will end your game with ${opponent?.name}. Your opponent will be declared the winner.` : 'This removes the game, its chat, and queued packets from this device only. It does not resign or remove the other player’s game.'}</p><div className="modal-button-row"><button className="secondary-button" onClick={() => setConfirm(null)}>Cancel</button><button className="danger-button" onClick={() => { if (confirm === 'resign') mesh.resign(game.id); else { mesh.deleteLocalGame(game.id); setSelectedId(null); setMobileChatOpen(false); setReviewPly(null); } setConfirm(null); }}>{confirm === 'resign' ? <Flag size={16} /> : <Trash2 size={16} />}{confirm === 'resign' ? 'Resign game' : 'Remove game'}</button></div></Modal>}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  </div>;
}

function ChatPanel({ chats, text, setText, send, globalChat, setGlobalChat, hasGame, endRef }: {
  chats: ReturnType<typeof useMeshChess>['state']['chats']; text: string; setText(text: string): void; send(): void;
  globalChat: boolean; setGlobalChat(value: boolean): void; hasGame: boolean; endRef: React.RefObject<HTMLDivElement | null>;
}) {
  return <div className="chat-panel"><div className="chat-scope"><button className={!globalChat ? 'active' : ''} onClick={() => setGlobalChat(false)} disabled={!hasGame}>Game chat</button><button className={globalChat ? 'active' : ''} onClick={() => setGlobalChat(true)}>Mesh chat</button></div><div className="chat-messages">{chats.map((message) => <div className={`chat-message ${message.mine ? 'mine' : ''}`} key={message.id}>{!message.mine && <strong>{message.from.name}</strong>}<p>{message.text}</p><span>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{message.mine && message.delivery === 'queued' ? <Clock3 size={12} /> : message.mine ? message.delivery === 'acked' ? <CheckCheck size={13} /> : <Check size={13} /> : null}</span></div>)}{!chats.length && <div className="chat-empty"><MessageCircle size={27} /><h3>A little conversation</h3><p>{globalChat ? 'Say hello to everyone on #chess.' : 'Send a note with your next move. Chat travels over the same mesh connection.'}</p></div>}<div ref={endRef} /></div><form className="chat-compose" onSubmit={(e) => { e.preventDefault(); send(); }}><textarea aria-label="Chat message" placeholder={globalChat ? 'Message the mesh…' : 'Write a message…'} maxLength={240} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><div><span>{text.length}/240</span><button className="send-button" disabled={!text.trim()} aria-label="Send message"><Send size={17} /></button></div></form></div>;
}

function ChallengeRow({ challenge, onAccept }: { challenge: Challenge; onAccept(): void }) {
  return <div className="challenge-row"><span className="mini-avatar">{challenge.host.name[0].toUpperCase()}</span><div><strong>{challenge.host.name}</strong><p><Clock3 size={13} />No clock <span>·</span> {challenge.hostColor === 'random' ? 'Random colors' : `${challenge.hostColor === 'w' ? 'White' : 'Black'} for host`}</p></div><span className="challenge-time">{timeAgo(challenge.createdAt)}</span><button className="primary-button small" onClick={onAccept}>Accept<Swords size={15} /></button></div>;
}

function ConnectionCard({ icon, title, description, action, onClick, active, disabled, note }: { icon: React.ReactNode; title: string; description: string; action: string; onClick(): void; active: boolean; disabled?: boolean; note?: string }) {
  return <div className={`connection-card ${active ? 'active' : ''}`}><span className="connection-icon">{icon}</span><div><strong>{title}{active && <span className="connected-label"><Circle size={7} fill="currentColor" />ACTIVE</span>}</strong><p>{description}</p>{note && <small>{note}</small>}</div><button className={active ? 'secondary-button' : 'primary-button small'} onClick={onClick} disabled={disabled || active}>{active ? <Check size={16} /> : null}{action}</button></div>;
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" ref={closeRef} onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</section></div>;
}

export default App;
