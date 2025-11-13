const { WebSocketServer } = require('ws');
const http = require('http');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const ALLOWED_ORIGINS = [
    'https://your-frontend-app.vercel.app',
    'http://localhost:3000'
];
const PORT = process.env.PORT || 3001;

const app = express();

const corsOptions = {
  origin: function (origin, callback) {
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  optionsSuccessStatus: 200 
};

app.use(cors(corsOptions));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg' || file.mimetype === 'image/gif' || file.mimetype === 'image/webp') {
        cb(null, true);
    } else {
        cb(new Error('Only PNG, JPEG, GIF, and WebP files are allowed!'), false);
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 1024 * 1024 * 5 },
    fileFilter: fileFilter
});

app.use('/uploads', express.static(uploadDir));

app.post('/upload', (req, res) => {
    upload.single('image')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).send({ error: err.message });
        } else if (err) {
            return res.status(400).send({ error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).send({ error: 'No file uploaded.' });
        }
        
        res.send({ imageUrl: `/uploads/${req.file.filename}` });
    });
});

function sanitize(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;');
}

const server = http.createServer(app);

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

function clearUploads() {
  console.log('Running cleanup job: Clearing /uploads directory...');
  fs.readdir(uploadDir, (err, files) => {
    if (err) {
      console.error('Failed to read uploads directory:', err);
      return;
    }

    for (const file of files) {
      if (file === '.gitkeep') {
        continue; 
      }
      
      const filePath = path.join(uploadDir, file);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error('Failed to delete file:', filePath, err);
        }
      });
    }
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

                if (data.payload.text) {
                    data.payload.text = sanitize(data.payload.text);
                }

                if (ws.roomName && rooms.has(ws.roomName)) {
                    const roomClients = rooms.get(ws.roomName);
                    const messageString = JSON.stringify(data.payload);

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
const cleanupInterval = setInterval(clearUploads, 60000);

wss.on('close', function close() {
    clearInterval(interval);
    clearInterval(cleanupInterval);
});

server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;

    if (!ALLOWED_ORIGINS.includes(origin) && origin) { 
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