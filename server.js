const { WebSocketServer } = require('ws');
const http = require('http');

const ALLOWED_ORIGINS = [
    'https://your-frontend-app.vercel.app',
    'http://localhost:3000'
];

const PORT = process.env.PORT || 3001;

function sanitize(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;');
}

const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found. This is a WebSocket server.');
});

const wss = new WebSocketServer({ noServer: true });

const rooms = new Map();
const MESSAGE_COOLDOWN_MS = 1000;

function heartbeat() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) {
            console.log('Terminating dead connection...');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}

wss.on('connection', (ws, request) => {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.lastMessageTime = 0;
    ws.roomName = null;

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());

            if (data.type === 'join') {
                if (ws.roomName && rooms.has(ws.roomName)) {
                    rooms.get(ws.roomName).delete(ws);
                }
                const roomName = data.room;
                ws.roomName = roomName;
                if (!rooms.has(roomName)) {
                    rooms.set(roomName, new Set());
                }
                rooms.get(roomName).add(ws);

            } else if (data.type === 'chat') {
                const now = Date.now();
                if (now - ws.lastMessageTime < MESSAGE_COOLDOWN_MS) {
                    return;
                }
                ws.lastMessageTime = now;

                if (ws.roomName && rooms.has(ws.roomName)) {
                    const roomClients = rooms.get(ws.roomName);
                    
                    const sanitizedPayload = {
                        sender: data.payload.sender,
                        text: sanitize(data.payload.text)
                    };
                    const messageString = JSON.stringify(sanitizedPayload);

                    roomClients.forEach((client) => {
                        if (client.readyState === ws.OPEN) {
                            client.send(messageString);
                        }
                    });
                }
            }
        } catch (e) {
            console.log('invalid json', e);
        }
    });

    ws.on('close', () => {
        if (ws.roomName && rooms.has(ws.roomName)) {
            const roomClients = rooms.get(ws.roomName);
            roomClients.delete(ws);
            if (roomClients.size === 0) {
                rooms.delete(ws.roomName);
                console.log(`Room ${ws.roomName} is empty and deleted.`);
            }
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error on connection:', err);
    });
});

const interval = setInterval(heartbeat, 30000);

wss.on('close', function close() {
    clearInterval(interval);
});

server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;

    if (!ALLOWED_ORIGINS.includes(origin)) {
        console.log(`Connection from origin ${origin} REJECTED.`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
    console.log(`Allowing connections from: ${ALLOWED_ORIGINS.join(', ')}`);
});