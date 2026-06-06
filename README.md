# Globle Discord Bot

A Discord bot that lets people play [**Globle**](https://globle-game.com/) — guess the
daily mystery country using geography — right inside Discord, using the **real, official
daily answer** from globle-game.com.

Each player plays their own private daily game on a **rendered world map** — a flat
Natural-Earth map with every guess heat-shaded by proximity, plus a 3D globe inset
auto-centered on your closest guess. When you finish, you see everyone else's results for
the day, and everyone who already finished gets a DM with your result (map included).

## How it gets the real answer

The bot talks to globle-game.com exactly the way the official web client does:

1. `GET https://globle-game.com/answer?day=YYYY-MM-DD&list=197` returns the day's answer
   as an AES-encrypted country index.
2. The bot decrypts it (CryptoJS-compatible AES, passphrase mode) to an index into the
   official 197-country dataset (`data/country_data.json`).
3. Proximity for each guess is the minimum great-circle distance between the guess's and
   the answer's polygon borders — a port of the game's own `distance.ts`.
4. The map is drawn locally from the official polygon data with `d3-geo` + canvas, shaded
   with the same `interpolateOrRd` square-root scale the game uses (green for the answer).
   Tiny countries (Nauru, Vatican, Singapore…) get a visible marker so they're never lost.
   The shareable results also use the game's emoji bands (🟥 🟧 🟨 ⬜ → 🟩).

No scraping of "answer of the day" blogs — it's the genuine value every player sees, and
no external map/tile service — the board is rendered entirely from local data.

## Commands

| Command | What it does |
|---|---|
| `/globle` | Start or resume today's game (private to you). |
| `/guess <country>` | Guess a country (with autocomplete). Shows the heat-shaded map + globe inset, and your guesses closest-first with distance. |
| `/giveup` | Reveal today's mystery country and end your game. |
| `/results` | See everyone's results for today (only after you've finished — no spoilers). |
| `/stats` | Your personal stats (played, win rate, best, average). |

When you finish (win or give up) you get the day's leaderboard, and every other player
who already finished today is DM'd your result.

## Setup

Requires **Node.js 18+**.

1. **Create a Discord application + bot**
   - Go to <https://discord.com/developers/applications> → *New Application*.
   - *Bot* tab → *Reset Token* → copy the token.
   - *General Information* tab → copy the *Application ID*.

2. **Configure**
   ```bash
   cp .env.example .env
   ```
   Fill in `DISCORD_TOKEN` and `CLIENT_ID`. Optionally set `GUILD_ID` (a test server, for
   instant command registration) and `GLOBLE_TZ` (the timezone that decides when the day
   rolls over — all players share it; default `UTC`).

3. **Install + register commands + run**
   ```bash
   npm install
   npm run deploy   # registers the slash commands
   npm start        # starts the bot
   ```

4. **Invite the bot** to a server with the `applications.commands` and `bot` scopes, e.g.:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands
   ```
   (Players must share a server with the bot so it can DM them notifications.)

## Deploying (Railway / containers) — persisting data

Hosts like Railway, Fly, or any container have an **ephemeral filesystem**: every deploy
starts a fresh container, so anything written to the app directory (including
`data/state.json`) is wiped. To keep player history across deploys, store the state file
on a **persistent volume**.

**On Railway:**
1. Open your service → **Settings** (or the **Volumes** section) → **Add Volume**.
2. Give it any mount path, e.g. `/data`.
3. Redeploy. That's it — the bot auto-detects Railway's `RAILWAY_VOLUME_MOUNT_PATH` and
   writes `state.json` there. Confirm in the deploy logs: `Globle state file: /data/state.json`.

**Anywhere else:** set `STATE_FILE` to a path on a persistent disk, e.g.
`STATE_FILE=/var/lib/globle/state.json`.

The bot resolves the state path in this order: `STATE_FILE` → `RAILWAY_VOLUME_MOUNT_PATH` →
local `data/state.json` (dev default). The directory is created automatically.

## Notes

- **Timezone:** the daily answer depends on the date string sent to globle-game.com, so
  the bot uses a single `GLOBLE_TZ` for everyone to keep the shared leaderboard consistent.
- **Storage:** games are persisted to a single JSON file (git-ignored). See the deploy
  section above for keeping it across redeploys.
- **Privacy:** gameplay replies are ephemeral (only you see them); cross-player
  notifications are sent via DM.

## Project layout

```
src/globle.js        Answer fetch/decrypt, country data, distance, colour, name matching
src/render.js        Map rendering (flat Natural-Earth map + globe inset) via d3-geo + canvas
src/store.js         Per-user daily game persistence (data/state.json)
src/index.js         Discord client, slash-command handlers, finish/notify flow
deploy-commands.js   Registers the slash commands with Discord
data/                Official Globle country dataset + name aliases
```

## Credits

Globle is created by [The Abe Train](https://the-abe-train.com/) /
[Trainwreck Labs](https://trainwreck.fun/). This bot is an unofficial client that uses the
game's public daily answer endpoint and open country data. All game data and the answer
service belong to the original authors.
