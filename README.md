# ♞ CHESHY MESS

## ▶️ [Play now: kq4cin.github.io/cheshy-mess](https://kq4cin.github.io/cheshy-mess/)

Click the link above. The game runs in your web browser. There is nothing to download and no account to create.

---

## What is it?

A chess game you can play **anywhere** — even with no internet at all. It's **correspondence chess**: make your move whenever you like, close the app, and come back days later. There is no clock and no pressure.

- ♟️ **Full chess rules** — castling, en passant, promotion, draws, resignation
- ⏳ **Play at your own pace** — your games wait for you, forever
- 💬 **Chat built in** — private chat with your opponent, plus a public channel for everyone
- 🏆 **Recent results** — finished games are announced on the channel, so the lobby shows who beat who
- 📡 **Play over the air** — send moves through a MeshCore LoRa radio instead of the internet (optional)
- 📶 **Works offline** — install it once and it keeps working with no connection
- 🔓 **No account, no server** — your games and profile never leave your device

---

## First time playing?

1. Open the [game link](https://kq4cin.github.io/cheshy-mess/).
2. Click **Start a new game**, pick a color, and post your challenge to **#chess**.
3. When another player accepts, your game begins.

White moves first. You can move only on your turn in an active game. Use **Resign** below the board to end an active game, or the **trash button** beside your opponent to remove a game from this device (including its chat and queued packets). Removing a game does not resign it or change the opponent's copy. Finished games offer **New game** instead of Resign.

**No radio and no friend nearby?** Open the game in a **second browser tab** (same browser). The built-in demo mode lets your two tabs find each other, so you can accept your own challenge and play both sides to see how it works.

---

## Install it like an app (optional)

Installing puts an icon on your home screen and lets you play **without internet**.

| Device | How to install |
|---|---|
| **Android** (Chrome) | Open the game → tap the **⋮** menu → **Install app** or **Add to Home screen** |
| **iPhone / iPad** (Safari) | Open the game → tap the **Share** button → **Add to Home Screen** |
| **Windows / Mac** (Chrome or Edge) | Open the game → click the **install icon** in the address bar |

---

## Is my game saved?

Yes. Your games, chats, and profile save automatically in your browser.

- They are saved **on that device only**.
- Clearing your browser data will erase them.

---

## Playing over the radio (optional)

You do **not** need this to play. To play with real people nearby — with **no internet at all** — you need a **MeshCore companion radio** (a small LoRa radio device).

1. Use **Chrome** or **Edge** on a computer or Android phone.
2. Open the connection menu in the top bar and choose **USB Serial** or **Bluetooth LE**, then pick your radio.
3. The game automatically sets up a public channel on your radio called **#chess**. Other players on that channel show up under **Heard on the mesh**.

Bluetooth reconnects reuse your last selected radio; supported browsers can also restore that selection after a reload. Use **Choose another Bluetooth radio** in Mesh to switch devices. Like Mesh Wars, the app uses the standard Web Bluetooth connection flow and does not request or store a BLE PIN. Android or radio firmware may still require pairing; the app cannot bypass that prompt.

Moves and chat travel as tiny radio packets. If your radio disconnects, moves and messages **queue up and send when it reconnects** — the other player can be offline for days.

When a game ends, a small result announcement is posted to **#chess** ("Alice beat Bob · checkmate"). Everyone on the channel sees recent results in the **Lobby**.

> ℹ️ Radio connections do not work in Safari or on iPhone.

> ⚠️ **#chess is a public channel.** Display names are not verified, so don't share private information in chat.

---

## Need help?

| Problem | Try this |
|---|---|
| The page looks old after an update | Refresh the page once or twice |
| I can't find the install option | Make sure you are using Chrome, Edge, or Safari |
| My radio won't connect | Use Chrome or Edge, and close other apps using the radio. Open **Mesh → Connection activity** to see what the radio reported |
| No free channel slot on my radio | Free a slot in the MeshCore app, then reconnect |
| I added #chess myself but the game can't find it | Add it as a **public hashtag channel** named `#chess` (not a private channel), so its key matches |
| A game stays on "Delivering move" or "Confirming result" | Keep both players connected to the same transport, then tap that status to retry sync. Sync resends missing moves and confirms moves or results the opponent already received |
| I want to start over | Use the trash button beside the opponent to remove the game, then start a new one. There is no need to clear your browser data |

---

## For developers

Built with **React + TypeScript + Vite**, chess rules by [chess.js](https://github.com/jhlywa/chess.js), radio via the MeshCore companion protocol (Web Serial / Web Bluetooth). Requires Node.js 20.19+ or 22.12+.

```bash
git clone https://github.com/kq4cin/cheshy-mess.git
cd cheshy-mess
npm install
npm run dev
```

Then open <http://localhost:5173> in your browser.

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm test` | Run unit tests (chess rules, wire protocol, radio transports) |
| `npm run build` | Type-check and build for production into `dist/` |
| `npm run check` | Build + tests |

The site on GitHub Pages rebuilds and deploys automatically on every push to `main`.

<details>
<summary>Technical notes</summary>

- Games, profile, chat, and the outgoing packet queue are stored locally in IndexedDB (localStorage fallback).
- Reliable packets (moves, accepts, chat) stay queued until acknowledged, with retry/backoff and duplicate detection.
- Move gaps or position mismatches trigger a full validated-history resync.
- The `#chess` channel secret follows the MeshCore hashtag convention: the first 16 bytes of SHA-256(`#chess`).
- Demo mode uses `BroadcastChannel` with the same packets, validation, ACKs, and retries as a real radio; demo traffic never touches a connected radio.
- MeshCore companion behavior adapted from [Mesh Wars](https://github.com/kq4cin/mesh-wars).

**Radio field testing still requires physical MeshCore devices.** The unit tests validate the protocol and simulated transports, not RF behavior or every firmware version.

</details>

---

## License

Code is free to use, change, and share under the [MIT License](LICENSE).
