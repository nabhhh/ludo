const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ────────────────────────────────────────────────────────────
const COLORS = ['red', 'blue', 'green', 'yellow'];
const COLOR_NAMES = { red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow' };

// Board path: 52 main squares (0-51), then home stretch 52-57 per color
// Starting squares for each color (on the main path)
const START_SQUARES = { red: 0, blue: 13, green: 26, yellow: 39 };
// Entry squares (where pieces enter from yard)
const ENTRY_SQUARES = { red: 0, blue: 13, green: 26, yellow: 39 };
// Home stretch starts at these main-path indices
const HOME_ENTRY = { red: 51, blue: 12, green: 25, yellow: 38 };
// Safe squares (stars + home entries)
const SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];

// AI think delay ms
const AI_DELAY = 1200;

// ─── Room Storage ──────────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function createPieces(color) {
  return [0, 1, 2, 3].map(i => ({
    id: i,
    color,
    state: 'yard',    // yard | active | home
    pos: -1,          // main path position (0-51) or home stretch (52-57)
    steps: 0          // total steps taken from start
  }));
}

function createRoom(roomId, hostName) {
  return {
    id: roomId,
    host: null,
    players: [],       // { id, name, color, isAI, socketId }
    state: 'lobby',    // lobby | playing | finished
    pieces: {},        // color -> pieces[]
    currentTurn: 0,    // index into players
    dice: null,
    extraTurn: false,
    winner: null,
    lastRoll: null,
    moveHistory: []
  };
}

function colorPath(color) {
  // Returns ordered list of main-path squares for this color
  const start = START_SQUARES[color];
  const path = [];
  for (let i = 0; i < 52; i++) {
    path.push((start + i) % 52);
  }
  return path;
}

function getAbsolutePos(color, steps) {
  // steps: 0 = not yet entered, 1..52 = on main path, 53..57 = home stretch, 58 = home
  if (steps <= 0) return { zone: 'yard', sq: -1 };
  if (steps <= 52) {
    const path = colorPath(color);
    return { zone: 'main', sq: path[steps - 1] };
  }
  if (steps <= 57) {
    return { zone: 'home_stretch', sq: steps - 53, color };
  }
  return { zone: 'home', sq: -1 };
}

function canEnter(piece, dice) {
  return piece.state === 'yard' && (dice === 6 || dice === 1);
}

function getValidMoves(room, color) {
  const pieces = room.pieces[color];
  const dice = room.dice;
  const moves = [];

  pieces.forEach((piece, idx) => {
    if (piece.state === 'home') return;

    if (piece.state === 'yard') {
      if (dice === 6 || dice === 1) {
        moves.push({ pieceIdx: idx, action: 'enter' });
      }
      return;
    }

    // Active piece
    const newSteps = piece.steps + dice;
    if (newSteps <= 58) {
      moves.push({ pieceIdx: idx, action: 'move', newSteps });
    }
  });

  return moves;
}

function applyMove(room, color, pieceIdx, action, newSteps) {
  const piece = room.pieces[color][pieceIdx];
  let grantExtra = false;
  let eliminated = [];

  if (action === 'enter') {
    piece.state = 'active';
    piece.steps = 1;
    piece.pos = ENTRY_SQUARES[color];
  } else {
    piece.steps = newSteps;
    const posInfo = getAbsolutePos(color, newSteps);

    if (posInfo.zone === 'home') {
      piece.state = 'home';
      piece.pos = -1;
      grantExtra = true; // entering home grants extra turn
    } else if (posInfo.zone === 'home_stretch') {
      piece.pos = -2 - posInfo.sq; // negative encoding for home stretch
    } else {
      piece.pos = posInfo.sq;

      // Check captures (not on safe squares)
      if (!SAFE_SQUARES.includes(posInfo.sq)) {
        COLORS.forEach(otherColor => {
          if (otherColor === color) return;
          room.pieces[otherColor].forEach(op => {
            if (op.state === 'active' && op.pos === posInfo.sq) {
              // Check it's not on home stretch
              const opPos = getAbsolutePos(otherColor, op.steps);
              if (opPos.zone === 'main') {
                op.state = 'yard';
                op.pos = -1;
                op.steps = 0;
                eliminated.push({ color: otherColor, pieceIdx: op.id });
                grantExtra = true; // eliminating grants extra turn
              }
            }
          });
        });
      }
    }
  }

  // Check win
  const allHome = room.pieces[color].every(p => p.state === 'home');
  if (allHome) room.winner = color;

  return { grantExtra, eliminated };
}

function checkAllPlayersFinished(room) {
  // A player is "finished" when all their pieces are home
  const activePlayers = room.players.filter(p => {
    return !room.pieces[p.color].every(pc => pc.state === 'home');
  });
  return activePlayers.length <= 1;
}

function nextTurn(room) {
  const n = room.players.length;
  let next = (room.currentTurn + 1) % n;
  // Skip players who have all pieces home
  let tries = 0;
  while (room.pieces[room.players[next].color].every(p => p.state === 'home') && tries < n) {
    next = (next + 1) % n;
    tries++;
  }
  room.currentTurn = next;
  room.dice = null;
  room.extraTurn = false;
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room_update', sanitizeRoom(room));
}

function sanitizeRoom(room) {
  return {
    id: room.id,
    players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, isAI: p.isAI })),
    state: room.state,
    pieces: room.pieces,
    currentTurn: room.currentTurn,
    dice: room.dice,
    extraTurn: room.extraTurn,
    winner: room.winner,
    lastRoll: room.lastRoll,
    moveHistory: room.moveHistory.slice(-10)
  };
}

// ─── AI Logic ─────────────────────────────────────────────────────────────────
function aiPickMove(room, color) {
  const moves = getValidMoves(room, color);
  if (moves.length === 0) return null;

  // Priority: capture > enter > advance furthest piece
  let best = null;

  // Check for capture
  for (const move of moves) {
    if (move.action === 'move') {
      const posInfo = getAbsolutePos(color, move.newSteps);
      if (posInfo.zone === 'main') {
        const canCapture = COLORS.some(oc => {
          if (oc === color) return false;
          return room.pieces[oc].some(op => op.state === 'active' && op.pos === posInfo.sq &&
            !SAFE_SQUARES.includes(posInfo.sq));
        });
        if (canCapture) { best = move; break; }
      }
    }
  }

  if (!best) {
    // Enter piece if possible
    const enterMove = moves.find(m => m.action === 'enter');
    if (enterMove) best = enterMove;
  }

  if (!best) {
    // Advance furthest active piece
    let maxSteps = -1;
    for (const move of moves) {
      const piece = room.pieces[color][move.pieceIdx];
      if (piece.steps > maxSteps) { maxSteps = piece.steps; best = move; }
    }
  }

  return best || moves[0];
}

function scheduleAI(roomId) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing' || room.winner) return;

  const currentPlayer = room.players[room.currentTurn];
  if (!currentPlayer || !currentPlayer.isAI) return;

  setTimeout(() => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing' || !room.players[room.currentTurn]?.isAI) return;

    // Roll dice
    const dice = Math.floor(Math.random() * 6) + 1;
    room.dice = dice;
    room.lastRoll = { player: currentPlayer.name, color: currentPlayer.color, value: dice };

    broadcastRoom(roomId);

    setTimeout(() => {
      const room = rooms[roomId];
      if (!room) return;
      const moves = getValidMoves(room, currentPlayer.color);

      if (moves.length === 0) {
        // No moves: extra turn on 6, else next
        if (dice === 6) {
          room.extraTurn = true;
          room.moveHistory.push(`${currentPlayer.name} rolled 6 but has no valid moves`);
          broadcastRoom(roomId);
          scheduleAI(roomId);
        } else {
          room.moveHistory.push(`${currentPlayer.name} rolled ${dice}, no moves`);
          nextTurn(room);
          broadcastRoom(roomId);
          scheduleAI(roomId);
        }
        return;
      }

      const move = aiPickMove(room, currentPlayer.color);
      const { grantExtra, eliminated } = applyMove(room, currentPlayer.color, move.pieceIdx, move.action, move.newSteps);

      let histMsg = `${currentPlayer.name} rolled ${dice}`;
      if (move.action === 'enter') histMsg += ` and entered a piece`;
      else histMsg += ` and moved piece ${move.pieceIdx + 1}`;
      if (eliminated.length) histMsg += ` (eliminated ${eliminated.length} piece${eliminated.length > 1 ? 's' : ''}!)`;
      room.moveHistory.push(histMsg);

      if (room.winner) {
        room.state = 'finished';
        broadcastRoom(roomId);
        return;
      }

      const shouldExtra = grantExtra || dice === 6;
      if (shouldExtra) {
        room.extraTurn = true;
        room.dice = null;
        broadcastRoom(roomId);
        scheduleAI(roomId);
      } else {
        nextTurn(room);
        broadcastRoom(roomId);
        scheduleAI(roomId);
      }
    }, AI_DELAY / 2);
  }, AI_DELAY);
}

// ─── Socket.IO Events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ playerName }, cb) => {
    const roomId = uuidv4().substring(0, 6).toUpperCase();
    const room = createRoom(roomId, playerName);
    const playerId = uuidv4();
    const color = COLORS[0];
    room.host = playerId;
    room.players.push({ id: playerId, name: playerName, color, isAI: false, socketId: socket.id });
    room.pieces[color] = createPieces(color);
    rooms[roomId] = room;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    cb({ roomId, playerId, color });
    broadcastRoom(roomId);
  });

  socket.on('join_room', ({ roomId, playerName }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb({ error: 'Room not found' });
    if (room.state !== 'lobby') return cb({ error: 'Game already started' });
    if (room.players.length >= 4) return cb({ error: 'Room is full' });

    const usedColors = room.players.map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c));
    if (!color) return cb({ error: 'No colors available' });

    const playerId = uuidv4();
    room.players.push({ id: playerId, name: playerName, color, isAI: false, socketId: socket.id });
    room.pieces[color] = createPieces(color);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    cb({ roomId, playerId, color });
    broadcastRoom(roomId);
  });

  socket.on('add_ai', ({ roomId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.state !== 'lobby') return cb?.({ error: 'Game already started' });
    if (room.players.length >= 4) return cb?.({ error: 'Room is full' });

    const usedColors = room.players.map(p => p.color);
    const color = COLORS.find(c => !usedColors.includes(c));
    if (!color) return cb?.({ error: 'No colors' });

    const aiNames = ['Arjun AI', 'Priya AI', 'Rohan AI', 'Sneha AI'];
    const name = aiNames.find(n => !room.players.some(p => p.name === n)) || `Bot ${room.players.length}`;
    room.players.push({ id: uuidv4(), name, color, isAI: true, socketId: null });
    room.pieces[color] = createPieces(color);
    cb?.({ ok: true });
    broadcastRoom(roomId);
  });

  socket.on('remove_ai', ({ roomId, color }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'lobby') return;
    const idx = room.players.findIndex(p => p.color === color && p.isAI);
    if (idx === -1) return;
    room.players.splice(idx, 1);
    delete room.pieces[color];
    cb?.({ ok: true });
    broadcastRoom(roomId);
  });

  socket.on('start_game', ({ roomId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb?.({ error: 'Room not found' });
    if (room.players.length < 2) return cb?.({ error: 'Need at least 2 players' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.id !== room.host) return cb?.({ error: 'Only host can start' });

    room.state = 'playing';
    room.currentTurn = 0;
    broadcastRoom(roomId);

    // If first player is AI, start AI loop
    if (room.players[0]?.isAI) scheduleAI(roomId);
    cb?.({ ok: true });
  });

  socket.on('roll_dice', ({ roomId, playerId }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const playerIdx = room.players.findIndex(p => p.id === playerId);
    if (playerIdx !== room.currentTurn) return cb?.({ error: 'Not your turn' });
    if (room.dice !== null) return cb?.({ error: 'Already rolled' });

    const dice = Math.floor(Math.random() * 6) + 1;
    room.dice = dice;
    room.lastRoll = { player: room.players[playerIdx].name, color: room.players[playerIdx].color, value: dice };

    const moves = getValidMoves(room, room.players[playerIdx].color);
    if (moves.length === 0) {
      // Auto advance
      setTimeout(() => {
        if (!rooms[roomId]) return;
        if (dice === 6) {
          room.extraTurn = true;
          room.moveHistory.push(`${room.players[playerIdx].name} rolled 6 but has no valid moves`);
        } else {
          room.moveHistory.push(`${room.players[playerIdx].name} rolled ${dice}, no moves`);
          nextTurn(room);
        }
        broadcastRoom(roomId);
        if (room.players[room.currentTurn]?.isAI) scheduleAI(roomId);
      }, 1500);
    }

    broadcastRoom(roomId);
    cb?.({ dice, moves });
  });

  socket.on('make_move', ({ roomId, playerId, pieceIdx, action, newSteps }, cb) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const playerIdx = room.players.findIndex(p => p.id === playerId);
    if (playerIdx !== room.currentTurn) return cb?.({ error: 'Not your turn' });
    if (room.dice === null) return cb?.({ error: 'Roll first' });

    const color = room.players[playerIdx].color;
    const moves = getValidMoves(room, color);
    const validMove = moves.find(m => m.pieceIdx === pieceIdx && m.action === action);
    if (!validMove) return cb?.({ error: 'Invalid move' });

    const { grantExtra, eliminated } = applyMove(room, color, pieceIdx, action, newSteps || validMove.newSteps);

    let histMsg = `${room.players[playerIdx].name} rolled ${room.dice}`;
    if (action === 'enter') histMsg += ` and entered a piece`;
    else histMsg += ` and moved piece ${pieceIdx + 1}`;
    if (eliminated.length) histMsg += ` 💥 eliminated ${eliminated.length} piece${eliminated.length > 1 ? 's' : ''}!`;
    room.moveHistory.push(histMsg);

    if (room.winner) {
      room.state = 'finished';
      broadcastRoom(roomId);
      return cb?.({ ok: true });
    }

    const shouldExtra = grantExtra || room.dice === 6;
    if (shouldExtra) {
      room.extraTurn = true;
      room.dice = null;
    } else {
      nextTurn(room);
    }

    broadcastRoom(roomId);
    if (room.players[room.currentTurn]?.isAI) scheduleAI(roomId);
    cb?.({ ok: true });
  });

  socket.on('restart_game', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.id !== room.host) return;

    // Reset game state
    room.state = 'lobby';
    room.currentTurn = 0;
    room.dice = null;
    room.extraTurn = false;
    room.winner = null;
    room.lastRoll = null;
    room.moveHistory = [];
    room.players.forEach(p => {
      room.pieces[p.color] = createPieces(p.color);
    });

    broadcastRoom(roomId);
  });

  socket.on('disconnect', () => {
    const { roomId, playerId } = socket.data;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.socketId = null;
      io.to(roomId).emit('player_disconnected', { name: player.name, color: player.color });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ludo server running on http://localhost:${PORT}`));
