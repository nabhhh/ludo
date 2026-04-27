# 🎲 Ludo Royale — Multiplayer Ludo Game

A real-time multiplayer Ludo game with room system, AI players, and shareable links.

## Features
- 🏠 Create private rooms with shareable links
- 👥 2–4 players per room
- 🤖 AI players to fill empty spots
- 🎯 Rules: 6 or 1 to enter a piece, capturing earns extra turn, reaching home earns extra turn
- 📱 Mobile-friendly canvas board

## Quick Start (Local)

```bash
npm install
npm start
```
Then open http://localhost:3000

## Deploy to Railway (Free)

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select your repo — Railway auto-detects Node.js
4. Your game is live at the provided URL!

## Deploy to Render (Free)

1. Push to GitHub
2. Go to https://render.com → New Web Service
3. Connect your repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Done!

## Deploy to Fly.io

```bash
npm install -g flyctl
fly auth login
fly launch
fly deploy
```

## Game Rules
- Roll **6 or 1** to bring a piece out of the yard
- Landing on an opponent's piece **sends it back** to yard (you get an extra turn!)
- Getting all 4 pieces **home** wins the game
- Reaching home with a piece grants an **extra turn**
- Rolling a **6** also grants an extra turn
- ⭐ Star squares are **safe** — pieces cannot be captured there

## Environment Variables
- `PORT` — defaults to 3000
