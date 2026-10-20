# 5-Card Pineapple

**New here? Double-click `START HERE.html` for the step-by-step guide.**

A card game for two to eight people, each on their own phone. Everyone is dealt five cards; the flop is shown; each player throws away one card, the turn is revealed, everyone throws away another, the river is revealed, everyone throws away a third and keeps two. Best five-card hand from your two cards and the board wins.

The server shuffles and deals, so each phone only ever receives its own cards. Nothing to install: it is plain Node with no dependencies.

```
pineapple/
├── server.js          the game server (Node 18 or newer, no packages)
├── public/
│   ├── index.html     the page every phone opens
│   └── engine.js      cards and hand ranking, shared by server and page
├── package.json
├── Dockerfile         for any host that runs containers
└── render.yaml        one-click blueprint for Render
```

## Put it online for free (Render)

1. Create a free account at https://render.com and a free account at https://github.com if you don't have one.
2. On GitHub, make a new repository (any name, public or private) and upload the contents of this folder. The web uploader works: open the empty repository, choose "uploading an existing file", drag everything in, commit.
3. On Render, choose **New → Web Service**, connect your GitHub account and pick the repository.
4. Settings: Runtime **Node**, Build Command `npm install`, Start Command `node server.js`, Instance Type **Free**. Leave everything else as it is and click **Create Web Service**.
5. After a minute or two the service is live at `https://<your-service-name>.onrender.com`. Open that on your phone, type your name, tap **Open a new table** and send the link it gives you to everyone else.

Alternatively, choose **New → Blueprint** and point it at the repository; the included `render.yaml` sets all of the above.

Good to know about the free tier: the service goes to sleep after about 15 minutes with nobody connected, and the first visitor afterwards waits 30–60 seconds while it wakes. Tables live in the server's memory, so a sleep or a redeploy ends any table that was open; just open a new one. If you want a server that never sleeps, Render's paid tier, Railway or Fly.io all run this unchanged.

## Other ways to run it

**On your own computer, same Wi‑Fi**: `node server.js` then open http://localhost:3000. Other phones on the same network can use `http://<your computer's IP address>:3000`. (Over plain http the Copy link button may not reach the clipboard; the link is still selectable to copy by hand.)

**Any host with Node**: `PORT=8080 node server.js`. The server reads the `PORT` environment variable and defaults to 3000.

**Docker**: `docker build -t pineapple . && docker run -p 3000:3000 pineapple`

**Behind nginx or another reverse proxy**: live updates use Server-Sent Events, so turn off response buffering for the app (`proxy_buffering off;` in nginx) or players will see moves arrive late.

## How it works

Each phone makes a random player id and secret the first time it opens the page and keeps them in its browser storage, so a reload or a dropped connection lands you back in your seat with your cards. Game state streams to each phone over `/api/tables/<code>/events`; moves are POSTed to `/api/tables/<code>/deal|discard|leave|close`. The dealer is whoever opened the table; if they leave or are away for more than a minute, the dealer role passes to the next player. Tables are forgotten after six idle hours. `/healthz` reports the server is up and how many tables are open.
