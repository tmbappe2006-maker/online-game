// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get('/_health', (_, res) => res.send('OK'));

// 3部屋：locked = 二人で開始後は両者がロビーへ戻るまで「試合中」ロック
const rooms = [
  { id: 1, players: [], locked: false },
  { id: 2, players: [], locked: false },
  { id: 3, players: [], locked: false }
];

// ゲーム状態: roomId -> { board, colorMap:{sid:'black'|'white'}, turn:'black'|'white', inProgress, rematch:Set<sid> }
const games = new Map();

io.on('connection', (socket) => {
  emitRooms();

  socket.on('joinRoom', (roomId) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) return;

    // locked の部屋は途中参戦不可（1人でも入れない）
    if (room.locked || room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    // 入室
    room.players = room.players.filter(p => p !== socket.id);
    room.players.push(socket.id);
    socket.roomId = room.id;

    if (room.players.length === 1) {
      // 一人目: 待機（locked はまだ false）
      socket.emit('waitingOpponent');
      emitRooms();
    } else if (room.players.length === 2) {
      // 二人目: 試合開始 → locked = true
      room.locked = true;
      startNewGame(room, /*randomize*/ true);
      emitRooms();
    }
  });

  // プレイ（手を打つ）
  socket.on('play', ({ x, y }) => {
    const room = getMyRoom(socket);
    if (!room) return;
    const game = games.get(room.id);
    if (!game || !game.inProgress) return;

    const myColor = game.colorMap[socket.id];
    if (!myColor) return;
    if (game.turn !== myColor) return; // 手番違い

    const n = game.board.length;
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    if (game.board[y][x] !== null) return;

    // 置く
    game.board[y][x] = myColor;

    // 皆に正規化された手を通知
    const nextTurn = myColor === 'black' ? 'white' : 'black';
    io.to(roomChannel(room.id)).emit('move', { x, y, color: myColor, nextTurn });

    // 勝敗判定
    if (checkWin(game.board, x, y, myColor)) {
      game.inProgress = false;
      io.to(roomChannel(room.id)).emit('gameOver', { winnerColor: myColor, reason: 'five-in-a-row' });
      game.rematch = new Set(); // 次の再戦票は空から
      return;
    }

    // 引き分け判定
    if (isFull(game.board)) {
      game.inProgress = false;
      io.to(roomChannel(room.id)).emit('gameOver', { winnerColor: null, reason: 'draw' });
      game.rematch = new Set();
      return;
    }

    // 継続
    game.turn = nextTurn;
  });

  // 再戦リクエスト（両者が押したら新規対局／先後ランダム）
  socket.on('rematchRequest', () => {
    const room = getMyRoom(socket);
    if (!room) return;
    const game = games.get(room.id);
    if (!game || game.inProgress !== false) return; // 対局終了時のみ

    if (!game.rematch) game.rematch = new Set();
    game.rematch.add(socket.id);

    const both = room.players.length === 2 &&
                 room.players.every(pid => game.rematch.has(pid));
    if (both) {
      startNewGame(room, /*randomize*/ true);
      emitRooms();
    } else {
      // 片方待ち
      const other = room.players.find(p => p !== socket.id);
      if (other) io.to(other).emit('opponentRematchWaiting');
    }
  });

  // 自分が「退出」：UI を閉じるだけ（部屋は playing 維持）
  socket.on('exitGame', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    const other = room.players.find(p => p !== socket.id);
    if (other) io.to(other).emit('opponentLeft');

    emitRooms();
  });

  // 「ルーム選択に戻る」：実際に部屋人数を減らす（2→1 でも playing 維持、1→0 で空き）
  socket.on('returnToLobby', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    room.players = room.players.filter(p => p !== socket.id);
    socket.roomId = null;

    if (room.players.length === 0) {
      // 完全に空に戻ったらロック解除＆ゲーム破棄
      room.locked = false;
      games.delete(room.id);
    }
    emitRooms();
  });

  // 切断：人数を減らす。2→1 は playing、1→0 は空き。
  socket.on('disconnect', () => {
    const room = getMyRoom(socket);
    if (!room) return;

    room.players = room.players.filter(p => p !== socket.id);
    const other = room.players[0];
    if (other) io.to(other).emit('opponentLeft');

    if (room.players.length === 0) {
      room.locked = false;
      games.delete(room.id);
    }
    emitRooms();
  });

  // --- ユーティリティ ---
  function startNewGame(room, randomize) {
    const [a, b] = room.players;
    if (!a || !b) return;

    // 盤面初期化
    const board = Array.from({ length: 15 }, () => Array(15).fill(null));

    // 先後割り当て
    const firstIsA = randomize ? (Math.random() < 0.5) : true;
    const colorMap = {};
    if (firstIsA) {
      colorMap[a] = 'black';
      colorMap[b] = 'white';
    } else {
      colorMap[a] = 'white';
      colorMap[b] = 'black';
    }

    const game = {
      board,
      colorMap,
      turn: 'black',     // 常に黒手番から
      inProgress: true,
      rematch: new Set()
    };
    games.set(room.id, game);

    // ソケットを部屋に入れる（ルームチャンネル）
    io.sockets.sockets.get(a)?.join(roomChannel(room.id));
    io.sockets.sockets.get(b)?.join(roomChannel(room.id));

    // 両者へ開始通知（yourTurn / yourColor を渡す）
    io.to(a).emit('startGame', { yourTurn: colorMap[a] === 'black', yourColor: colorMap[a] });
    io.to(b).emit('startGame', { yourTurn: colorMap[b] === 'black', yourColor: colorMap[b] });
  }

  function getMyRoom(s) {
    const id = s.roomId;
    if (!id) return null;
    return rooms.find(r => r.id === id) || null;
  }

  function emitRooms() {
    // 表示ルール：
    // 0人 → empty
    // 1人＆!locked → waiting（最初の待機のみ）
    // それ以外（locked かつ 2→1 を含む）→ playing
    const payload = rooms.map(r => ({
      id: r.id,
      state:
        r.players.length === 0
          ? 'empty'
          : (!r.locked && r.players.length === 1 ? 'waiting' : 'playing')
    }));
    io.emit('updateRooms', payload);
  }

  function roomChannel(roomId) {
    return `room-${roomId}`;
  }
});

// ------ 勝敗判定ユーティリティ ------
function checkWin(board, x, y, color) {
  const dirs = [[1,0],[0,1],[1,1],[1,-1]];
  const n = board.length;
  for (const [dx, dy] of dirs) {
    let count = 1;
    for (let s = 1; s < 5; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) break;
      if (board[ny][nx] === color) count++; else break;
    }
    for (let s = 1; s < 5; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) break;
      if (board[ny][nx] === color) count++; else break;
    }
    if (count >= 5) return true;
  }
  return false;
}

function isFull(board) {
  return board.every(row => row.every(c => c !== null));
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
