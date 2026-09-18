# Putting her to sea

## The one thing to understand first

**Vercel cannot run the game server.** Not a setting, not a plugin — a platform
mismatch. Vercel gives you static hosting and short-lived serverless functions.
This game is a 30 Hz authoritative simulation that holds rooms in memory and
keeps a socket open to every player for fifteen minutes. Vercel functions have
no WebSocket upgrade and no process that outlives a request.

So the deployment is in two halves, and they are each on the host that suits
them:

| Half | What it is | Where it goes | Why |
|---|---|---|---|
| **Client** | 306 KB of static HTML, CSS and ES modules. Every sprite and every sound is generated in the browser at boot — there are no image or audio files. | **Vercel** | A CDN is exactly right for this, and redeploys are instant. |
| **Server** | Node + `ws`. 30 Hz simulation, 20 Hz snapshots, rooms in memory. | **Fly.io / Render / Railway** — anywhere that runs a container or a long-lived Node process | It has to hold sockets open. |

The two are joined by one value: **`AAC_SERVER`**, which tells the client where
the match is running.

### The useful safety net

The game server *also* serves a complete copy of the client on its own URL. So
if Vercel is having a bad morning ten minutes before your test, send people
straight to the game server's address instead and everything works. You lose
the CDN; you lose nothing else.

---

## Deploy, in order

The server goes first, because the client needs to be told its address.

### 1. The game server

Pick one. All three read the config files already in this repo.

**Fly.io** — best of the three for this, because the machine stays warm.
Needs no Docker on your own machine; `--remote-only` builds in the cloud.

```bash
fly launch --no-deploy --copy-config --name aye-aye-captain
fly deploy --remote-only
```

**Render** — easiest, and the free plan needs no card. Push this repo to
GitHub, then *New → Blueprint* and point it at the repo; it reads
`render.yaml`. Read the cold-start warning below before you rely on the free
plan for a scheduled test.

**Railway** — `railway up`; it will find the `Dockerfile`.

Then check it is alive, and keep this URL:

```bash
curl https://your-app.fly.dev/healthz
```

```json
{ "ok": true, "rooms": 0, "players": 0, "uptime": 12 }
```

### 2. The client

Put the server's address in one committed file and push. Vercel is watching
the repo, so that push *is* the deploy.

```js
// client/config.js
window.AAC_SERVER = 'wss://aye-aye-captain.onrender.com';
```

Mind the `wss://`. A browser on an `https://` page refuses a plaintext `ws://`
socket, so an address that starts `ws://` will be blocked no matter how
healthy the server is.

`vercel.json` already sets the build (`npm run build`) and the output
directory (`dist`). The build copies `client/` and `shared/` into `dist/` and
writes `dist/config.js` from the address above.

You *can* instead set an `AAC_SERVER` environment variable in the Vercel
project, which overrides the file. It is the worse of the two:

> **An environment variable is baked in at build time, not read at run time.**
> Change it without redeploying and the site keeps pointing at the old server
> — which looks exactly like a server that has died. The committed address
> cannot drift that way, because changing it *is* a deploy.

### 3. Close the gangway (optional, after step 2)

Once the client has a permanent address, let only it open a socket. On the
game server set:

```
ALLOW_ORIGIN=https://your-project.vercel.app
```

Exact origin — scheme and host, no trailing slash, no path. If you also want
Vercel's preview deployments to work, add them comma-separated, or leave
`ALLOW_ORIGIN` unset until after the test. Requests with no `Origin` header at
all (the playtest harness, `curl`) are always allowed through.

---

## Before the test — run down this list

- [ ] `curl https://your-server/healthz` returns `ok: true`.
- [ ] Open the Vercel URL. You should get the six-page **SHIP'S ORDERS**
      briefing on a first visit, then the join card.
- [ ] Join, and confirm the clock is counting and your colours read 580. If the
      clock is frozen the socket did not open — see below.
- [ ] Open the same URL in a second browser and confirm you can see each other.
- [ ] **If the server is on Render's free plan, load the page five minutes
      early.** It sleeps after fifteen idle minutes and the first visitor
      otherwise waits out a cold start of the better part of a minute.
- [ ] Decide rooms. The bare URL puts everyone in the open sea, which is what
      you want for one group. For a private match, put a code on the join card
      and use *copy the invite link* — **share the client link, not the
      server's**. Codes ignore case, spaces and punctuation, so a code written
      down one way and typed another still lands in the same room.
- [ ] **Put the server near the players, not near you.** One box serves
      everyone, so a fleet spread across continents is all paying the distance
      to it. Pick the region closest to most of them, or failing that the one
      in the middle: London or Frankfurt splits Europe and the Americas,
      Singapore splits Europe and Asia-Pacific. This is chosen when the
      service is created and is a nuisance to change afterwards.
- [ ] Someone will open your link on a phone. They are told the game needs a
      keyboard rather than being dropped onto a deck they cannot steer, and
      they do **not** take up a berth while that notice is showing. If they
      have a keyboard attached there is a button to come aboard anyway.
- [ ] Ten players is the hard cap per room. Beyond that they get *THE ACTION IS
      FULL*. Empty berths are crewed by bots, so four players is a real match.

## Knobs on the game server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Your host almost certainly sets this for you. |
| `BOTS` | `4` | Hulls a side. Both fleets always sail the same number. |
| `SKILL` | `1` | Bot competence, `0` green to `1` hard. **Turn this down to `0.5` if your players are new.** |
| `ALLOW_ORIGIN` | unset | Comma-separated origins allowed to open a socket. Unset means anyone. |
| `MAX_ROOMS` | `32` | Ceiling on simultaneous matches. |

## When it does not work

**The clock is frozen and nothing moves.** The page loaded but the socket did
not. Open the browser console:

- `Mixed Content: ... insecure WebSocket` — the page is on `https:` and
  `AAC_SERVER` is `ws://`. Use `wss://`.
- `Error during WebSocket handshake: Unexpected response code: 200` — the
  client is pointed at something that is not the game server. Check
  `window.AAC_SERVER` in the console.
- Connects, then immediately closes — `ALLOW_ORIGIN` does not list the origin
  you are actually on. Preview deployments have their own hostname.

**Test a fix without rebuilding.** Append `?server=` to the client URL; it
overrides everything:

```
https://your-project.vercel.app/?server=wss://some-other-host
```

**Everyone dropped for a second or two.** That is a server redeploy. It closes
sockets with code 1012 (*service restart*) and the client reconnects on its
own. The match is lost, the page is not.

**A player says the page is stale.** Everything is served
`must-revalidate`, so a reload is always enough.

---

## Running it locally — unchanged

```bash
npm start           # http://localhost:8787, serves client and match together
```

Local play needs no configuration at all: with `AAC_SERVER` unset the client
looks for the game server on its own origin, which is where it is.

To rehearse the *split* — client and server genuinely apart, as in production:

```bash
npm start &
AAC_SERVER=ws://localhost:8787 npm run build
npx serve dist -l 8080          # any static server will do
```

## Checking your work

```bash
npm run check       # colour lint, roster rules, then 13 end-to-end scenarios
```

The last of those stands up a real server and drives 72 headless clients
through it over real sockets — full matches, captains quitting mid-match, late
joiners, side switching, and a deliberate abuse pass.
