# Orb Arena: a Manus game on Edgegap

A 2-4 player neon drone arena made with [Manus](https://manus.im) Game Dev, hosted on [Edgegap](https://edgegap.com): one authoritative server per match, near the players, that stops itself when the match is over. Finding a match through the Edgegap matchmaker is **optional**; without it the game works exactly as Manus built it (room code + server address).

Manus Game Dev asks for a Manus Cloud Computer before it writes a multiplayer game. This sample is what you get by asking Manus for a self-hostable server instead and running that server on Edgegap. The tag [`manus-original`](../../tree/manus-original) is Manus's untouched output; every change after it is in the history.

## What's here

| Path | What |
|---|---|
| `server/` | Node.js WebSocket server (Manus), `src/edgegap.js` (self-stop + matchmaker tickets, inert off Edgegap), `Dockerfile` |
| `client/` | Browser client (Manus): canvas game, room code, `?server=`; optional FIND MATCH (`config.js`) |
| `matchmaker/arena.json` | Edgegap matchmaker config: profile `arena`, 2-4 players, a solo match after 20 s |
| `tests/` | `ws-check.cjs` (message counts per client), `two-players.cjs`, `mock-delete.cjs` (local self-stop check) |

## Run it locally

```bash
cd server && npm install && npm start          # ws://localhost:8787/ws
cd client && python -m http.server 8091        # open http://localhost:8091/ in two tabs, same room code
```

## Host it on Edgegap

1. Build and push the image (`linux/amd64`), tagged with the UTC build time:
   ```bash
   docker build --platform linux/amd64 -t registry.edgegap.com/<project>/manus-orb-arena:<YYYYMMDD-HHMM> server
   docker push registry.edgegap.com/<project>/manus-orb-arena:<YYYYMMDD-HHMM>
   ```
2. Create an application and a version with that image: port **8787**, name `gameport`, protocol **WS**, **TLS Upgrade on**, 256 CPU units / 512 MB, restart policy `never`, max duration 15-30 min.
3. **Without a matchmaker:** deploy one server from the dashboard (or the Edgegap MCP), then open the client with `?server=wss://<fqdn>:<external port>/ws&room=ARENA1` in two tabs.
4. **With the matchmaker (optional):** set `application.name`/`version` in `matchmaker/arena.json`, add your page's origin to `allowed_cors_origins`, then Edgegap dashboard → Matchmakers → Create → upload it → Create And Start. Put its **API URL** and **Auth Token** in `client/config.js` (or `client/config.local.js`, git-ignored, or `?mm=<url>&token=<token>`). The lobby now shows FIND MATCH.

The matchmaker Auth Token is a client token meant to ship in game clients; it gives no access to your Edgegap account. Never put your Edgegap API token in the client.

## How the server behaves on Edgegap

- `ARBITRIUM_*` variables present → it stops its own deployment when nobody joined in 120 s, everyone left 30 s ago, or the match ended 60 s ago (`EDGEGAP_NO_JOIN_SEC`, `EDGEGAP_EMPTY_SEC`, `EDGEGAP_RESULTS_SEC`).
- Started by the matchmaker (`MM_TICKET_IDS` present) → only the matched tickets get a seat (others get `NOT_MATCHED`), and the match starts when every matched player is in, or 15 s after the second one.
- Anywhere else (your machine, the `pkg` binaries Manus builds) → none of this runs.

## Verified (2026-11-20, Edgegap, Toronto)

- Direct deploy: two scripted players got 15 snapshots/s over `wss://`; two browser tabs played one match; the deployment stopped itself ~36 s after both left.
- Matchmaker: two browser tabs clicked FIND MATCH, were matched (`HOST_ASSIGNED` in under 20 s, image not cached), landed on the same deployment and played; a third client without a ticket was refused; the deployment stopped itself within 40 s of both leaving.
- Not verified: two different networks or devices, parties, a paid matchmaker tier (the free tier stops 3 hours after each start).

## Changes from Manus's output

- Snapshots stopped after the first one (`room.revision % 2` while sending bumps `revision`): fixed to every 2nd tick.
- A replaced socket's close handler cleared the new socket (reconnect): guarded.
- Added `src/edgegap.js`, the Dockerfile, the optional matchmaker, a clean socket close on page exit.
