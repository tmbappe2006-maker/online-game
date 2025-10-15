const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname)); // index.html を配信

let players = [];

io.on('connection', (socket) => {
    console.log('接続:', socket.id);
    players.push(socket.id);

    if (players.length >= 2) {
        io.to(players[0]).emit('start', { yourTurn: true });
        io.to(players[1]).emit('start', { yourTurn: false });
    }

    socket.on('move', (data) => {
        socket.broadcast.emit('opponentMove', data);
    });

    socket.on('disconnect', () => {
        console.log('切断:', socket.id);
        players = players.filter(id => id !== socket.id);
        io.emit('opponentLeft');
    });
});
