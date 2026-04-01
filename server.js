const fs      = require('fs');
const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const YTDlpWrap = require('yt-dlp-wrap').default;

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
    info:  (msg, ...args) => console.log(`[${new Date().toISOString()}] [INFO]  ${msg}`, ...args),
    warn:  (msg, ...args) => console.warn(`[${new Date().toISOString()}] [WARN]  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`, ...args),
    ok:    (msg, ...args) => console.log(`[${new Date().toISOString()}] [OK]    ${msg}`, ...args),
};

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

// ─── yt-dlp setup ─────────────────────────────────────────────────────────────
const ytDlpBinaryPath = path.join(__dirname, 'yt-dlp');
const ytDlp = new YTDlpWrap(ytDlpBinaryPath);

// Descargar binario de yt-dlp si no existe
(async () => {
    try {
        if (!fs.existsSync(ytDlpBinaryPath)) {
            log.info('Descargando yt-dlp...');
            await YTDlpWrap.downloadFromGithub(ytDlpBinaryPath);
            log.ok('yt-dlp descargado correctamente');
        } else {
            log.ok('yt-dlp ya existe, omitiendo descarga');
        }
    } catch (e) {
        log.error('Error descargando yt-dlp:', e.message);
    }
})();

// ─── Apodos ───────────────────────────────────────────────────────────────────
const path_apodos = path.join(__dirname, 'apodos.json');

function loadApodos() {
    try {
        if (fs.existsSync(path_apodos)) {
            const raw = fs.readFileSync(path_apodos, 'utf8');
            return JSON.parse(raw); // { "usuario_largo_123": "Juanito", ... }
        }
    } catch (e) { log.error('Error cargando apodos:', e.message); }
    return {};
}

function saveApodos(apodos) {
    try { fs.writeFileSync(path_apodos, JSON.stringify(apodos, null, 2), 'utf8'); }
    catch (e) { log.error('Error guardando apodos:', e.message); }
}

let apodos = loadApodos();

// Devuelve el apodo si existe, o el username original
function resolveNombre(username) {
    const key = username.toLowerCase().trim();
    return apodos[key] || username;
}

// ─── Configuracion global ─────────────────────────────────────────────────────
let globalConfig = {
    maxQueue:  50,
    maxWords:  0,
    maxChars:  0,
    ttsRate:   1.1,
    ttsPitch:  1.0,
};

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});

// ─── Rooms ────────────────────────────────────────────────────────────────────
const rooms = new Map();
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECTS     = 5;

// ─── Enqueue comentario ───────────────────────────────────────────────────────
function enqueue(username, usuario, mensaje) {
    const room = rooms.get(username);
    if (!room) return;
    if (room.queue.length >= globalConfig.maxQueue) {
        log.warn(`[${username}] Cola llena (${globalConfig.maxQueue}), descartando: ${usuario}`);
        return;
    }
    const apodo = resolveNombre(usuario);
    room.queue.push({ usuario: apodo, usuarioOriginal: usuario, mensaje });
    io.to(username).emit('nuevo-comentario', { usuario: apodo, usuarioOriginal: usuario, mensaje });
    log.ok(`[${username}] ${apodo} (${usuario}): ${mensaje.slice(0, 50)}`);
}

// ─── Enqueue regalo ───────────────────────────────────────────────────────────
function enqueueGift(username, usuario) {
    const room = rooms.get(username);
    if (!room) return;
    if (room.queue.length >= globalConfig.maxQueue) return;
    const apodo = resolveNombre(usuario);
    io.to(username).emit('nuevo-regalo', { usuario: apodo, usuarioOriginal: usuario });
    log.ok(`[${username}] REGALO de ${apodo} (${usuario})`);
}

// ─── Enqueue seguidor ─────────────────────────────────────────────────────────
function enqueueFollow(username, usuario) {
    const room = rooms.get(username);
    if (!room) return;
    const apodo = resolveNombre(usuario);
    io.to(username).emit('nuevo-follow', { usuario: apodo, usuarioOriginal: usuario });
    log.ok(`[${username}] FOLLOW de ${apodo} (${usuario})`);
}

// ─── Like ─────────────────────────────────────────────────────────────────────
const likeThrottle = new Map(); // evita spam: un aviso cada 30s por usuario
function handleLike(username, usuario, likeCount) {
    const key = `${username}:${usuario}`;
    const now = Date.now();
    if (likeThrottle.has(key) && now - likeThrottle.get(key) < 30_000) return;
    likeThrottle.set(key, now);
    const apodo = resolveNombre(usuario);
    io.to(username).emit('nuevo-like', { usuario: apodo, usuarioOriginal: usuario, likeCount });
    log.ok(`[${username}] LIKE x${likeCount} de ${apodo} (${usuario})`);
}

// ─── Share ────────────────────────────────────────────────────────────────────
function handleShare(username, usuario) {
    const apodo = resolveNombre(usuario);
    io.to(username).emit('nuevo-share', { usuario: apodo, usuarioOriginal: usuario });
    log.ok(`[${username}] SHARE de ${apodo} (${usuario})`);
}

// ─── Conexion TikTok Live ─────────────────────────────────────────────────────
function connectToLive(username, reconnectCount = 0) {
    const room = rooms.get(username);
    if (!room) return;
    const conn = new WebcastPushConnection(username);
    room.connection = conn;

    conn.connect()
        .then(state => {
            log.ok(`Conectado a @${username} (roomId: ${state.roomId})`);
            io.to(username).emit('status', { type: 'connected', message: `Conectado al Live de @${username}` });
        })
        .catch(err => {
            log.error(`No se pudo conectar a @${username}: ${err.message}`);
            io.to(username).emit('status', { type: 'error', message: `Error al conectar: ${err.message}` });
            scheduleReconnect(username, reconnectCount);
        });

    // Comentarios de chat
    conn.on('chat', (data) => enqueue(username, data.nickname, data.comment));

    // Regalos — solo se procesa cuando el regalo está "completado" (streakFinished)
    // para no repetir el agradecimiento en cada tick del streak
    conn.on('gift', (data) => {
        const nombre = data.nickname || data.uniqueId || 'alguien';
        // giftType 1 = regalo de streak (se repite), esperamos a que termine
        if (data.giftType === 1 && !data.repeatEnd) return;
        enqueueGift(username, nombre);
    });

    // Nuevos seguidores — evento dedicado de la librería
    conn.on('follow', (data) => {
        const nombre = data.nickname || data.uniqueId || 'alguien';
        enqueueFollow(username, nombre);
    });

    // Likes
    conn.on('like', (data) => {
        const nombre = data.nickname || data.uniqueId || 'alguien';
        handleLike(username, nombre, data.likeCount || 1);
    });

    // Shares (evento 'social' con displayType share)
    conn.on('social', (data) => {
        if (data.displayType === 'pm_mt_msg_viewer_share') {
            const nombre = data.nickname || data.uniqueId || 'alguien';
            handleShare(username, nombre);
        }
    });

    conn.on('disconnected', () => {
        log.warn(`[${username}] Desconectado`);
        io.to(username).emit('status', { type: 'reconnecting', message: `Reconectando a @${username}...` });
        scheduleReconnect(username, reconnectCount);
    });

    conn.on('error', (err) => log.error(`[${username}]: ${err.message}`));
}

function scheduleReconnect(username, previousCount) {
    const room = rooms.get(username);
    if (!room || room.sockets.size === 0) return;
    if (previousCount >= MAX_RECONNECTS) {
        io.to(username).emit('status', { type: 'failed', message: `Sin reconexion tras ${MAX_RECONNECTS} intentos` });
        return;
    }
    const delay = RECONNECT_DELAY_MS * (previousCount + 1);
    room.reconnectTimer = setTimeout(() => {
        if (rooms.has(username) && rooms.get(username).sockets.size > 0)
            connectToLive(username, previousCount + 1);
    }, delay);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    log.info(`Socket conectado: ${socket.id}`);
    let currentRoom = null;
    let isAdmin = false;

    socket.emit('config-update', globalConfig);

    socket.on('join-live', (username) => {
        if (!username || typeof username !== 'string') {
            socket.emit('status', { type: 'error', message: 'Username invalido' });
            return;
        }
        username = username.trim().replace(/^@/, '').toLowerCase();
        if (currentRoom) leaveRoom(socket, currentRoom);
        currentRoom = username;
        socket.join(username);

        if (!rooms.has(username)) {
            rooms.set(username, { connection: null, sockets: new Set([socket.id]), queue: [], reconnectTimer: null, reconnectCount: 0 });
            connectToLive(username);
        } else {
            rooms.get(username).sockets.add(socket.id);
            socket.emit('status', { type: 'connected', message: `Unido al Live de @${username}` });
        }
    });

    socket.on('leave-live', () => {
        if (currentRoom) { leaveRoom(socket, currentRoom); currentRoom = null; }
    });

    socket.on('admin-login', (password) => {
        if (password === ADMIN_PASSWORD) {
            isAdmin = true;
            socket.join('admins');
            socket.emit('admin-auth', { ok: true, config: globalConfig });
            socket.emit('apodos-update', apodos);
            log.ok(`Admin autenticado: ${socket.id}`);
        } else {
            socket.emit('admin-auth', { ok: false });
            log.warn(`Contrasena incorrecta desde ${socket.id}`);
        }
    });

    socket.on('admin-set-config', (newConfig) => {
        if (!isAdmin) { socket.emit('status', { type: 'error', message: 'No autorizado' }); return; }
        const rules = {
            maxQueue: [1,   500],
            maxWords: [0,   100],
            maxChars: [0,   500],
            ttsRate:  [0.5, 3.0],
            ttsPitch: [0.0, 2.0],
        };
        for (const [key, [min, max]] of Object.entries(rules)) {
            if (newConfig[key] !== undefined) {
                const val = parseFloat(newConfig[key]);
                if (!isNaN(val) && val >= min && val <= max) globalConfig[key] = val;
            }
        }
        log.ok('Config actualizada:', JSON.stringify(globalConfig));
        io.emit('config-update', globalConfig);
        socket.emit('admin-config-saved', globalConfig);
    });

    // Admin: disparar sonido a todos
    socket.on('admin-play-sound', (soundId) => {
        if (!isAdmin) return;
        const valid = ['aplausos','redoble','fanfarria','campana','risas','fail',
                       'rimshot','suspenso','abucheo','alerta','levelup','moneda',
                       'gameover','explosion','sirena'];
        if (!valid.includes(soundId)) return;
        io.emit('play-sound', soundId);
        log.ok(`Admin disparó sonido: ${soundId}`);
    });

    // Admin: enviar mensaje TTS a todos
    socket.on('admin-tts', (mensaje) => {
        if (!isAdmin) return;
        if (typeof mensaje !== 'string' || !mensaje.trim()) return;
        const texto = mensaje.trim().slice(0, 300);
        io.emit('admin-mensaje', { texto });
        log.ok(`Admin TTS: ${texto.slice(0, 60)}`);
    });

    // ─── Apodos (solo admin) ──────────────────────────────────────────────────
    socket.on('admin-set-apodo', ({ username, apodo }) => {
        if (!isAdmin) { socket.emit('status', { type: 'error', message: 'No autorizado' }); return; }
        if (typeof username !== 'string' || !username.trim()) return;
        const key = username.trim().replace(/^@/, '').toLowerCase();
        const valor = (apodo || '').trim();
        if (valor) {
            apodos[key] = valor;
            log.ok(`Apodo asignado: ${key} → ${valor}`);
        } else {
            delete apodos[key];
            log.ok(`Apodo eliminado: ${key}`);
        }
        saveApodos(apodos);
        io.to('admins').emit('apodos-update', apodos);
    });

    socket.on('admin-get-apodos', () => {
        if (!isAdmin) return;
        socket.emit('apodos-update', apodos);
    });

    socket.on('admin-delete-apodo', (username) => {
        if (!isAdmin) return;
        const key = (username || '').trim().replace(/^@/, '').toLowerCase();
        if (apodos[key]) {
            delete apodos[key];
            saveApodos(apodos);
            log.ok(`Apodo eliminado: ${key}`);
        }
        io.to('admins').emit('apodos-update', apodos);
    });

    // ─── Música (solo admin) ──────────────────────────────────────────────────
    socket.on('admin-music-share', (payload) => {
        if (!isAdmin) return;
        if (!payload || typeof payload !== 'object') return;
        log.ok(`Admin música → ${payload.action} "${payload.title || payload.url || ''}"`);
        io.emit('music-command', payload);
    });

    socket.on('disconnect', () => {
        if (currentRoom) leaveRoom(socket, currentRoom);
    });
});

function leaveRoom(socket, username) {
    socket.leave(username);
    const room = rooms.get(username);
    if (!room) return;
    room.sockets.delete(socket.id);
    if (room.sockets.size === 0) {
        if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
        if (room.connection) try { room.connection.disconnect(); } catch (_) {}
        rooms.delete(username);
        log.info(`Room eliminado: ${username}`);
    }
}

// ─── Endpoint: extraer URL de audio de YouTube ────────────────────────────────
// Cache simple en memoria para no re-procesar el mismo video
const ytAudioCache = new Map();
const YT_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 horas

app.get('/api/yt-audio', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Falta parametro url' });

    // Validar que sea YouTube
    if (!/youtu\.?be/.test(url)) return res.status(400).json({ error: 'No es un link de YouTube' });

    // Revisar cache
    const cached = ytAudioCache.get(url);
    if (cached && Date.now() - cached.ts < YT_CACHE_TTL) {
        log.info(`Cache hit: ${url.slice(0, 60)}`);
        return res.json({ audioUrl: cached.audioUrl, title: cached.title });
    }

    try {
        log.info(`Extrayendo audio de: ${url.slice(0, 60)}`);

        // Obtener info del video (formato de solo audio, mejor calidad)
        const info = await ytDlp.getVideoInfo(url);
        const title = info.title || 'YouTube Audio';

        // Buscar mejor formato de audio directo
        const formats = info.formats || [];
        // Preferir m4a/opus/webm de solo audio, ordenar por calidad
        const audioFormats = formats
            .filter(f => f.acodec !== 'none' && (f.vcodec === 'none' || !f.vcodec) && f.url)
            .sort((a, b) => (b.abr || 0) - (a.abr || 0));

        if (!audioFormats.length) {
            // Fallback: cualquier formato con audio
            const fallback = formats.filter(f => f.url && f.acodec !== 'none').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
            if (!fallback) return res.status(404).json({ error: 'No se encontro formato de audio' });
            ytAudioCache.set(url, { audioUrl: fallback.url, title, ts: Date.now() });
            return res.json({ audioUrl: fallback.url, title });
        }

        const best = audioFormats[0];
        ytAudioCache.set(url, { audioUrl: best.url, title, ts: Date.now() });
        log.ok(`Audio extraido: ${title} (${best.ext || 'audio'}, ${best.abr || '?'}kbps)`);
        return res.json({ audioUrl: best.url, title });

    } catch (err) {
        log.error(`Error extrayendo audio de ${url}: ${err.message}`);
        return res.status(500).json({ error: 'No se pudo extraer el audio: ' + err.message });
    }
});

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        config: globalConfig,
        rooms: [...rooms.keys()].map(u => ({
            username: u,
            sockets: rooms.get(u).sockets.size,
            queueLength: rooms.get(u).queue.length,
        })),
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log.ok(`Servidor en puerto ${PORT}`);
    log.info(`Admin panel -> http://localhost:${PORT}/admin.html`);
    log.warn(`Contrasena admin: ${ADMIN_PASSWORD}`);
});

// ─── Auto-ping (evita que Render Free pause el servicio) ──────────────────────
if (process.env.RENDER_EXTERNAL_URL) {
    const https = require('https');
    const PING_INTERVAL_MS = 10 * 60 * 1000; // cada 10 minutos

    setInterval(() => {
        const url = `${process.env.RENDER_EXTERNAL_URL}/health`;
        https.get(url, (res) => {
            log.info(`Auto-ping OK: ${res.statusCode} → ${url}`);
        }).on('error', (err) => {
            log.warn(`Auto-ping fallido: ${err.message}`);
        });
    }, PING_INTERVAL_MS);

    log.info(`Auto-ping activado → ${process.env.RENDER_EXTERNAL_URL}/health (cada 10 min)`);
}
