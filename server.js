const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
require('winston-daily-rotate-file');

// ── Security headers ──────────────────────────────────────
// npm install helmet  (adicione ao package.json se necessário)
let helmet;
try { helmet = require('helmet'); } catch { helmet = null; }

// ── Logger setup ──────────────────────────────────────────
const logsDir = process.env.LOGS_DIR || './logs';
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        // Console output (colorized for development)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
                    return `${timestamp} [${level}] ${message}${extra}`;
                })
            )
        }),
        // Daily rotating file — all logs
        new winston.transports.DailyRotateFile({
            dirname: logsDir,
            filename: 'app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '14d',   // keep 14 days
            maxSize: '20m',
            zippedArchive: true
        }),
        // Separate file for errors only
        new winston.transports.DailyRotateFile({
            dirname: logsDir,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '30d',
            maxSize: '10m',
            zippedArchive: true
        })
    ]
});

// ── Config & Secrets ──────────────────────────────────────
const PORT = process.env.PORT || 3001;
const UZAPI_URL = process.env.UZAPI_URL || process.env.EVOLUTION_API_URL;
const UZAPI_TOKEN = process.env.UZAPI_TOKEN || process.env.EVOLUTION_API_KEY;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_INSTANCE = process.env.ADMIN_INSTANCE || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || ''; // sem + nem espaços
const JWT_SECRET = process.env.JWT_SECRET;
const TIMEZONE = process.env.TZ || 'America/Sao_Paulo';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ── OpenAI setup ──────────────────────────────────────────
let openaiClient = null;
if (OPENAI_API_KEY) {
    try {
        const { OpenAI } = require('openai');
        openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
        logger.info('OpenAI client initialized');
    } catch (e) {
        logger.warn('OpenAI package not found, chatbot disabled', { err: e.message });
    }
}

// Fail fast on missing critical secrets
if (!UZAPI_URL) { logger.error('UZAPI_URL (ou EVOLUTION_API_URL) env var is required'); process.exit(1); }
if (!UZAPI_TOKEN) { logger.error('UZAPI_TOKEN (ou EVOLUTION_API_KEY) env var is required'); process.exit(1); }
if (!JWT_SECRET) { logger.error('JWT_SECRET env var is required'); process.exit(1); }
if (JWT_SECRET.length < 32) { logger.error('JWT_SECRET deve ter pelo menos 32 caracteres para segurança'); process.exit(1); }

// ── File setup ────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Allowed upload mimetypes
const ALLOWED_MIMETYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/quicktime'
]);

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIMETYPES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`));
        }
    }
});

// ── DB helpers with write queue (prevents race conditions) ─
const DB_FILE = process.env.DB_FILE || './data.json';
const USERS_FILE = process.env.USERS_FILE || './data/users.json';

const dataDir = path.dirname(USERS_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Simple async write queue — ensures writes are serialised
let dbWriteQueue = Promise.resolve();
function queueDBWrite(fn) {
    dbWriteQueue = dbWriteQueue.then(fn).catch(err => logger.error('DB write queue error', { err: err.message }));
    return dbWriteQueue;
}

function loadDB() {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ schedules: [], history: [] }));
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { logger.error('Failed to parse data.json', { err: e.message }); return { schedules: [], history: [] }; }
}
function saveDB(data) {
    return queueDBWrite(() => {
        // Trim history to last 500 entries to keep data.json lean
        if (data.history && data.history.length > 500) {
            data.history = data.history.slice(-500);
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    });
}

function loadUsers() {
    if (!fs.existsSync(USERS_FILE)) {
        const admin = {
            id: 'admin', name: 'Admin', email: 'admin@wascheduler.com',
            password: bcrypt.hashSync('Admin123!', 10),
            role: 'admin', plan: 'unlimited', plan_expires: null,
            created_at: new Date().toISOString(), active: true
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
        logger.info('Created default admin user');
    }
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
    catch (e) { logger.error('Failed to parse users.json', { err: e.message }); return []; }
}
function saveUsers(users) {
    queueDBWrite(() => {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    });
}

// ── Express app ───────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // necessário para rate-limit atrás de proxy (EasyPanel/nginx)
// CORS restrito apenas à própria origem
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));

// Security headers via helmet
if (helmet) app.use(helmet({ contentSecurityPolicy: false }));

// Limite de tamanho do body — evita payload bombing
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// HTTP request logging via morgan → winston
app.use(morgan('combined', {
    stream: { write: msg => logger.http(msg.trim()) }
}));

// ── Rate limiting ─────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 10,                      // max 10 login attempts per window
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn('Rate limit hit on login', { ip: req.ip, email: req.body?.email });
        res.status(429).json(options.message);
    }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,    // 1 minute
    max: 100,
    message: { error: 'Muitas requisições. Aguarde um momento.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', apiLimiter);

// ── Auth middleware ───────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Não autorizado' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const users = loadUsers();
        const user = users.find(u => u.id === decoded.id);
        if (!user || !user.active) return res.status(401).json({ error: 'Conta inativa' });
        if (user.plan !== 'unlimited' && user.plan_expires && new Date(user.plan_expires) < new Date()) {
            return res.status(403).json({ error: 'Plano expirado', expired: true });
        }
        req.user = user;
        next();
    } catch (e) {
        logger.warn('Invalid JWT token attempt', { ip: req.ip });
        res.status(401).json({ error: 'Token inválido' });
    }
}
function adminMiddleware(req, res, next) {
    if (req.user?.role !== 'admin') {
        logger.warn('Unauthorized admin access attempt', { userId: req.user?.id, ip: req.ip });
        return res.status(403).json({ error: 'Acesso restrito' });
    }
    next();
}

// ── Plan helpers ──────────────────────────────────────────
const PLANS = {
    trial: { name: 'Trial 7 dias', days: 7, price: 0 },
    monthly: { name: 'Mensal', days: 30, price: 29.90 },
    semiannual: { name: 'Semestral', days: 180, price: 149.90 },
    annual: { name: 'Anual', days: 365, price: 249.90 },
    premium: { name: 'Premium', days: 30, price: 49.90 },
    unlimited: { name: 'Ilimitado', days: null, price: null }
};
function calcExpiry(planKey) {
    const plan = PLANS[planKey];
    if (!plan || !plan.days) return null;
    const d = new Date(); d.setDate(d.getDate() + plan.days); return d.toISOString();
}

// ── UZapi helpers ─────────────────────────────────────────
// Headers padrão para todas as chamadas à UZapi
const uzHeaders = () => ({ 'sessionkey': UZAPI_TOKEN, 'Content-Type': 'application/json' });

// Helpers de endpoint por sessão
const uzUrl = (session, path) => `${UZAPI_URL}/api/${session}${path}`;

// Mapeia estado UZapi → estado compatível com o sistema
function mapUzStatus(data) {
    // UZapi retorna: { status: 'CONNECTED' | 'DISCONNECTED' | 'QRCODE' | ... }
    const raw = (data?.status || data?.state || '').toUpperCase();
    let state = 'disconnected';
    if (raw === 'CONNECTED' || raw === 'OPEN') state = 'open';
    else if (raw === 'QRCODE' || raw === 'UNPAIRED') state = 'connecting';
    return { instance: { state }, state };
}

// ── Validation helpers ────────────────────────────────────
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validTime(t) { return TIME_REGEX.test(t); }

// ── AUTH ──────────────────────────────────────────────────
app.post('/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const users = loadUsers();
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
        logger.warn('Login attempt: user not found', { email, ip: req.ip });
        return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    if (!bcrypt.compareSync(password, user.password)) {
        logger.warn('Login attempt: wrong password', { email, ip: req.ip });
        return res.status(401).json({ error: 'Senha incorreta' });
    }
    if (!user.active) {
        logger.warn('Login attempt: inactive account', { email, ip: req.ip });
        return res.status(401).json({ error: 'Conta desativada' });
    }
    if (user.role !== 'admin' && user.approved === false) {
        logger.warn('Login attempt: not approved', { email, ip: req.ip });
        return res.status(403).json({ error: 'Sua conta está aguardando aprovação do administrador. Você será notificado quando for aprovada.', pending_approval: true });
    }
    if (user.plan !== 'unlimited' && user.plan_expires && new Date(user.plan_expires) < new Date()) {
        logger.warn('Login attempt: expired plan', { email });
        return res.status(403).json({ error: 'Seu plano expirou. Entre em contato com o suporte.', expired: true });
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    logger.info('User logged in', { userId: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, plan_expires: user.plan_expires, instance_name: user.instance_name, instances: user.instances || [], max_instances: user.max_instances || 1, chatbot_enabled: !!user.chatbot_enabled } });
});

app.get('/auth/me', authMiddleware, (req, res) => {
    const { password, ...safe } = req.user; res.json(safe);
});

app.post('/auth/change-password', authMiddleware, async (req, res) => {
    const { current, newPassword } = req.body;
    if (!current || !newPassword) return res.status(400).json({ error: 'Campos obrigatórios' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Nova senha deve ter pelo menos 8 caracteres' });
    const users = loadUsers();
    const u = users.find(u => u.id === req.user.id);
    if (!bcrypt.compareSync(current, u.password)) return res.status(400).json({ error: 'Senha atual incorreta' });
    u.password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    logger.info('Password changed', { userId: req.user.id });
    res.json({ success: true });
});

// ── ADMIN: user management ────────────────────────────────
app.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers().map(({ password, ...u }) => ({
        ...u,
        max_instances: u.max_instances || 1,
        instances: u.instances || []
    }));
    res.json(users);
});

app.post('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const { name, email, password, plan, instance_name } = req.body;
    if (!name || !email || !password || !plan || !instance_name)
        return res.status(400).json({ error: 'Preencha todos os campos incluindo nome da instância' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
    // Validar formato de email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Email inválido' });
    // Validar força da senha
    if (password.length < 8)
        return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    // Sanitizar instance_name — só letras, números e hífens
    if (!/^[a-zA-Z0-9-_]+$/.test(instance_name))
        return res.status(400).json({ error: 'Nome de instância inválido (use apenas letras, números e hífens)' });
    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Email já cadastrado' });
    if (users.find(u => u.instance_name === instance_name))
        return res.status(400).json({ error: 'Nome de instância já em uso' });

    try {
        await axios.post(uzUrl(instance_name, '/start-session'), {
            session: instance_name,
            sessionkey: UZAPI_TOKEN
        }, { headers: uzHeaders() });
        logger.info('UZapi session created', { instance_name });
    } catch (e) {
        logger.warn('UZapi session create skipped (may already exist)', { instance_name, msg: e.response?.data?.message || e.message });
    }

    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan, plan_expires: calcExpiry(plan),
        instance_name, created_at: new Date().toISOString(), active: true
    };
    users.push(user); saveUsers(users);
    logger.info('User created', { userId: user.id, email, plan, instance_name, createdBy: req.user.id });
    const { password: _, ...safe } = user;
    res.json({ success: true, user: safe });
});

app.put('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    const { plan, active, name, instance_name, max_instances, chatbot_enabled } = req.body;
    if (name) users[idx].name = name;
    if (instance_name) users[idx].instance_name = instance_name;
    if (plan !== undefined) {
        if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
        users[idx].plan = plan;
        users[idx].plan_expires = calcExpiry(plan);
    }
    if (active !== undefined) users[idx].active = active;
    if (max_instances !== undefined) users[idx].max_instances = parseInt(max_instances) || 1;
    if (chatbot_enabled !== undefined) users[idx].chatbot_enabled = !!chatbot_enabled;
    saveUsers(users);
    logger.info('User updated', { targetUserId: req.params.id, changes: { plan, active, name }, updatedBy: req.user.id });
    res.json({ success: true });
});

app.delete('/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user?.instance_name && user.role !== 'admin') {
        try {
            await axios.post(uzUrl(user.instance_name, '/close-session'), {}, { headers: uzHeaders() }).catch(() => {});
            await axios.delete(uzUrl(user.instance_name, '/delete-session'), { headers: uzHeaders() });
            logger.info('UZapi session deleted', { instance_name: user.instance_name });
        } catch (e) {
            logger.warn('Could not delete UZapi session', { instance_name: user.instance_name, err: e.message });
        }
    }
    saveUsers(users.filter(u => u.id !== req.params.id));
    logger.info('User deleted', { targetUserId: req.params.id, email: user.email, deletedBy: req.user.id });
    res.json({ success: true });
});

app.get('/admin/plans', (req, res) => res.json(PLANS));

// ── BACKUP & EXPORT ───────────────────────────────────────
app.get('/admin/backup', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const users = loadUsers().map(({ password, ...u }) => u);
    const backup = { exported_at: new Date().toISOString(), schedules: db.schedules, history: db.history, users };
    logger.info('Backup downloaded', { by: req.user.id });
    res.setHeader('Content-Disposition', `attachment; filename=wa-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json(backup);
});

app.get('/admin/export-csv', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const lines = ['Usuário,Destinatários,Mensagem,Horário,Frequência,Ativo,Enviados'];
    db.schedules.forEach(s => {
        const names = (s.recipients || []).map(r => r.name).join(' | ');
        const msg = (s.message || '').replace(/"/g, '""');
        lines.push(`"${s.userEmail || ''}","${names}","${msg}","${s.time}","${s.frequency}","${s.active}","${s.sent_count || 0}"`);
    });
    logger.info('CSV exported', { by: req.user.id, rows: db.schedules.length });
    res.setHeader('Content-Disposition', `attachment; filename=agendamentos-${new Date().toISOString().split('T')[0]}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\n'));
});

app.get('/admin/export-history-csv', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const lines = ['Destinatário,Tipo,Mensagem,Enviado em,Status,Erro'];
    db.history.forEach(h => {
        const msg = (h.message || '').replace(/"/g, '""');
        const err = (h.error || '').replace(/"/g, '""');
        lines.push(`"${h.recipient_name || ''}","${h.recipient_type || ''}","${msg}","${h.sent_at || ''}","${h.status || ''}","${err}"`);
    });
    logger.info('History CSV exported', { by: req.user.id, rows: db.history.length });
    res.setHeader('Content-Disposition', `attachment; filename=historico-${new Date().toISOString().split('T')[0]}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\n'));
});

// ── UPLOAD ────────────────────────────────────────────────
// Rate limit para uploads — máx 20 por minuto por usuário
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Muitos uploads. Aguarde um momento.' },
    keyGenerator: (req) => req.user?.id || req.ip
});
app.post('/api/upload', authMiddleware, uploadLimiter, (req, res, next) => {
    req.setTimeout(120000); // 2 minutos de timeout para uploads
    res.setTimeout(120000);
    next();
}, upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo' });
    const url = `${APP_URL}/uploads/${req.file.filename}`;
    logger.info('File uploaded', { userId: req.user.id, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
    res.json({ url, isVideo: req.file.mimetype.startsWith('video/') });
});

// Multer error handler
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Arquivo muito grande (máx 50MB)' });
    if (err.message?.includes('Tipo de arquivo')) return res.status(400).json({ error: err.message });
    next(err);
});


// ── ADMIN: grupos de um usuário ──────────────────────────
app.get('/admin/users/:id/groups', authMiddleware, adminMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const inst = user.instance_name;
    if (!inst) return res.json([]);
    try {
        const r = await axios.get(uzUrl(inst, '/groups'), { headers: uzHeaders() });
        const groups = Array.isArray(r.data) ? r.data : (r.data?.groups || []);
        const result = groups.map(g => ({
            id: g.id,
            name: g.subject || g.name || g.id,
            participants: g.size || g.participants?.length || 0,
        }));
        logger.info('Admin fetched user groups', { adminId: req.user.id, targetUserId: req.params.id, inst, count: result.length });
        res.json(result);
    } catch (e) {
        logger.error('Admin fetch groups failed', { inst, err: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ── ADMIN: entrar em um grupo via ID ─────────────────────
app.post('/admin/join-group', authMiddleware, adminMiddleware, async (req, res) => {
    // UZapi não suporta joinGroup via API — use o WhatsApp diretamente
    res.status(400).json({ error: 'Funcionalidade não suportada pela UZapi. Use o link de convite diretamente no WhatsApp.' });
});


// ── WHATSAPP (per-user instance) ──────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.json({ instance: { state: 'no_instance' }, instance_name: null });
    try {
        const r = await axios.get(uzUrl(inst, '/status-session'), { headers: uzHeaders() });
        res.json({ ...mapUzStatus(r.data), instance_name: inst });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: inst });
    }
});

app.get('/api/qrcode', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.status(400).json({ error: 'Nenhuma instância configurada' });

    // Verificar se já está conectada
    try {
        const statusCheck = await axios.get(uzUrl(inst, '/status-session'), { headers: uzHeaders() });
        const mapped = mapUzStatus(statusCheck.data);
        if (mapped.state === 'open') {
            logger.info('UZapi QR: instance already connected', { inst });
            return res.json({ instance: { state: 'open' }, state: 'open' });
        }
    } catch {
        // Sessão pode não existir — continua
    }

    async function ensureSession() {
        try {
            await axios.post(uzUrl(inst, '/start-session'), {
                session: inst, sessionkey: UZAPI_TOKEN
            }, { headers: uzHeaders() });
            logger.info('UZapi session ensured for QR', { inst });
        } catch (e) {
            logger.debug('UZapi start-session on QR (may exist)', { inst, msg: e.response?.data?.message || e.message });
        }
    }

    try {
        await ensureSession();
        await new Promise(r => setTimeout(r, 1500));
        const r = await axios.get(uzUrl(inst, '/qrcode'), { headers: uzHeaders() });
        // UZapi retorna { qrcode: 'data:image/png;base64,...' } ou { base64: '...' }
        const qr = r.data?.qrcode || r.data?.base64 || r.data;
        res.json({ qrcode: { base64: qr }, base64: qr });
    } catch (e) {
        logger.error('QR code fetch failed', { inst, err: e.message });
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

app.post('/api/disconnect', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.status(400).json({ error: 'Nenhuma instância' });
    try {
        await axios.post(uzUrl(inst, '/close-session'), {}, { headers: uzHeaders() });
        logger.info('WhatsApp disconnected', { inst, userId: req.user.id });
        res.json({ success: true });
    } catch (e) {
        logger.error('Disconnect failed', { inst, err: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ── MULTI-INSTANCE ───────────────────────────────────────

// List user's instances
app.get('/api/instances', authMiddleware, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    // Include legacy instance_name if exists and not already in list
    if (user.instance_name && !instances.find(i => i.name === user.instance_name)) {
        instances.unshift({ name: user.instance_name, label: 'Principal', connected: false });
    }
    res.json({ instances, max_instances: user.max_instances || 1 });
});

// Add a new instance
app.post('/api/instances', authMiddleware, async (req, res) => {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Label obrigatório' });
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const maxInst = user.max_instances || 1;

    // Check if legacy instance_name counts
    const totalUsed = instances.length + (user.instance_name ? 1 : 0);
    if (totalUsed >= maxInst) {
        return res.status(400).json({ error: `Limite de ${maxInst} instância(s) atingido. Contate o administrador.` });
    }

    // Generate unique instance name
    const instName = `${user.id.slice(-6)}-${Date.now()}`;
    try {
        await axios.post(uzUrl(instName, '/start-session'), {
            session: instName, sessionkey: UZAPI_TOKEN
        }, { headers: uzHeaders() });
    } catch (e) {
        logger.warn('UZapi session create warn', { instName, msg: e.response?.data?.message || e.message });
    }

    instances.push({ name: instName, label, connected: false });
    user.instances = instances;
    saveUsers(users);
    logger.info('Instance added', { userId: user.id, instName, label });
    res.json({ success: true, instance: { name: instName, label } });
});

// Remove an instance
app.delete('/api/instances/:name', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const instName = req.params.name;

    // Don't allow removing legacy primary instance
    if (instName === user.instance_name) {
        return res.status(400).json({ error: 'Não é possível remover a instância principal' });
    }

    const idx = instances.findIndex(i => i.name === instName);
    if (idx === -1) return res.status(404).json({ error: 'Instância não encontrada' });

    try {
        await axios.delete(uzUrl(instName, '/delete-session'), { headers: uzHeaders() });
    } catch (e) { logger.warn('Could not delete uzapi session', { instName }); }

    instances.splice(idx, 1);
    user.instances = instances;
    saveUsers(users);
    res.json({ success: true });
});

// Get QR for a specific instance
app.get('/api/instances/:name/qrcode', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso a esta instância' });

    try {
        // 1. Verificar se a instância já está conectada
        let instanceExists = false;
        try {
            const statusCheck = await axios.get(uzUrl(instName, '/status-session'), { headers: uzHeaders() });
            const mapped = mapUzStatus(statusCheck.data);
            instanceExists = true;
            if (mapped.state === 'open') {
                logger.info('Instance already connected, skipping QR', { instName });
                return res.json({ instance: { state: 'open' }, state: 'open' });
            }
        } catch {
            instanceExists = false;
        }

        // 2. Só cria se não existe
        if (!instanceExists) {
            logger.info('UZapi session does not exist, creating', { instName });
            await axios.post(uzUrl(instName, '/start-session'), {
                session: instName, sessionkey: UZAPI_TOKEN
            }, { headers: uzHeaders() }).catch(() => { });
        }

        // 3. Buscar QR code
        await new Promise(r => setTimeout(r, 1500));
        const r = await axios.get(uzUrl(instName, '/qrcode'), { headers: uzHeaders() });
        const qr = r.data?.qrcode || r.data?.base64 || r.data;
        res.json({ qrcode: { base64: qr }, base64: qr });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

// Get status of a specific instance
app.get('/api/instances/:name/status', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });

    try {
        const r = await axios.get(uzUrl(instName, '/status-session'), { headers: uzHeaders() });
        res.json({ ...mapUzStatus(r.data), instance_name: instName });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: instName });
    }
});

// Disconnect a specific instance  
app.post('/api/instances/:name/disconnect', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });

    // Tenta fechar sessão — se falhar ainda retorna sucesso
    try {
        await axios.post(uzUrl(instName, '/close-session'), {}, { headers: uzHeaders() });
    } catch (e) {
        logger.warn('Disconnect close-session failed, trying delete', { instName, err: e.message });
        try {
            await axios.delete(uzUrl(instName, '/delete-session'), { headers: uzHeaders() });
            await axios.post(uzUrl(instName, '/start-session'), {
                session: instName, sessionkey: UZAPI_TOKEN
            }, { headers: uzHeaders() });
        } catch (e2) {
            logger.warn('Disconnect fallback also failed', { instName, err: e2.message });
        }
    }
    // Sempre retorna sucesso — a UI vai atualizar o status
    res.json({ success: true });
});

// ADMIN: set max_instances for a user
app.put('/admin/users/:id/max-instances', authMiddleware, adminMiddleware, (req, res) => {
    const { max_instances } = req.body;
    if (!max_instances || max_instances < 1) return res.status(400).json({ error: 'Valor inválido' });
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    users[idx].max_instances = parseInt(max_instances);
    saveUsers(users);
    logger.info('Max instances updated', { targetUserId: req.params.id, max_instances, by: req.user.id });
    res.json({ success: true });
});

// Get groups for a specific instance
app.get('/api/instances/:name/groups', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });

    try {
        const r = await axios.get(uzUrl(instName, '/groups'), { headers: uzHeaders() });
        const groups = Array.isArray(r.data) ? r.data : (r.data?.groups || []);
        groups.sort((a, b) => {
            const ta = a.lastMessageTimestamp || a.creation || 0;
            const tb = b.lastMessageTimestamp || b.creation || 0;
            return tb - ta;
        });
        res.json(groups);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
    // Allow overriding instance via query param (for multi-instance)
    const requestedInst = req.query.instance;
    let inst = req.user.instance_name;
    if (requestedInst) {
        const users = loadUsers();
        const user = users.find(u => u.id === req.user.id);
        const instances = user.instances || [];
        const hasAccess = requestedInst === user.instance_name || instances.find(i => i.name === requestedInst);
        if (hasAccess) inst = requestedInst;
    }
    if (!inst) return res.json([]);
    try {
        const r = await axios.get(uzUrl(inst, '/groups'), { headers: uzHeaders() });
        const groups = Array.isArray(r.data) ? r.data : (r.data?.groups || []);

        // Ordena por mensagem mais recente
        groups.sort((a, b) => {
            const ta = a.lastMessageTimestamp || a.creation || 0;
            const tb = b.lastMessageTimestamp || b.creation || 0;
            return tb - ta;
        });

        res.json(groups);
    } catch (e) {
        logger.error('Fetch groups failed', { inst, err: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/contacts', authMiddleware, async (req, res) => {
    // Allow overriding instance via query param (for multi-instance)
    const requestedInst = req.query.instance;
    let inst = req.user.instance_name;
    if (requestedInst) {
        // Verify user has access to this instance
        const users = loadUsers();
        const user = users.find(u => u.id === req.user.id);
        const instances = user.instances || [];
        const hasAccess = requestedInst === user.instance_name || instances.find(i => i.name === requestedInst);
        if (hasAccess) inst = requestedInst;
    }
    if (!inst) return res.json([]);

    const mapContacts = (arr) => arr
        .filter(c => (c.remoteJid || c.id || '').includes('@s.whatsapp.net'))
        .map(c => {
            const jid = c.remoteJid || c.id || '';
            const phone = jid.replace('@s.whatsapp.net', '');
            const name = c.pushName || c.name || c.notify || null;
            return { id: jid, name: name || phone, hasName: !!name, phone };
        })
        .sort((a, b) => {
            if (a.hasName && !b.hasName) return -1;
            if (!a.hasName && b.hasName) return 1;
            return (a.name || '').localeCompare(b.name || '');
        })
        .slice(0, 500);

    // UZapi: GET /api/{session}/contacts
    try {
        const r = await axios.get(uzUrl(inst, '/contacts'), { headers: uzHeaders() });
        const raw = Array.isArray(r.data) ? r.data : (r.data?.contacts || r.data?.data || []);
        logger.info('contacts from UZapi', { inst, total: raw.length });
        const result = mapContacts(raw);
        if (result.length > 0) {
            logger.info('Contacts fetched', { inst, count: result.length });
            return res.json(result);
        }
        return res.json([]);
    } catch (e) {
        logger.error('Fetch contacts failed', { inst, err: e.message });
        return res.json([]);
    }
});

// ── SCHEDULES (per-user) ──────────────────────────────────
app.get('/api/schedules', authMiddleware, (req, res) => {
    const db = loadDB();
    const schedules = req.user.role === 'admin'
        ? db.schedules
        : db.schedules.filter(s => s.userId === req.user.id || !s.userId);
    res.json(schedules);
});

app.post('/api/schedules', authMiddleware, async (req, res) => {
    const { recipients, message, media_url, media_type, media_texts, extra_medias, media_delay_ms, time, frequency, schedule_date, send_delay, instance_name, timezone, time_variation, weekly_days } = req.body;
    if (!recipients?.length || (!message && !media_url) || !time)
        return res.status(400).json({ error: 'Campos obrigatórios: recipients, mensagem ou mídia, time' });
    if (!validTime(time))
        return res.status(400).json({ error: 'Formato de horário inválido. Use HH:MM (ex: 08:30)' });

    // Expandir listas em grupos individuais
    const db = loadDB();
    const expandedRecipients = [];
    for (const r of recipients) {
        if (r.type === 'list') {
            const userList = (db.lists || []).find(l => l.id === r.id && l.userId === req.user.id);
            if (userList && userList.items?.length) {
                userList.items.forEach(item => {
                    if (!expandedRecipients.some(e => e.id === item.id)) {
                        expandedRecipients.push(item);
                    }
                });
            }
        } else {
            expandedRecipients.push(r);
        }
    }
    const finalRecipients = expandedRecipients.length ? expandedRecipients : recipients;

    const schedule = {
        id: Date.now(),
        userId: req.user.id,
        userEmail: req.user.email,
        instance_name: instance_name || req.user.instance_name,
        timezone: timezone || TIMEZONE,
        recipients: finalRecipients, message,
        media_url: media_url || '',
        media_type: media_type || '',
        media_texts: media_texts || [],
        extra_medias: extra_medias || [],
        media_delay_ms: media_delay_ms || 0,
        time,
        time_variation: parseInt(time_variation) || 0,
        frequency: frequency || 'daily',
        weekly_days: weekly_days || [],
        schedule_date: schedule_date || '',
        send_delay: send_delay || 'random',
        active: true,
        created_at: new Date().toISOString(),
        last_sent: null,
        sent_count: 0
    };
    db.schedules.push(schedule);
    await saveDB(db);
    logger.info('Schedule created', { scheduleId: schedule.id, userId: req.user.id, time, time_variation: schedule.time_variation, frequency, recipients: recipients.length });
    res.json({ id: schedule.id, success: true });
});

app.put('/api/schedules/:id', authMiddleware, async (req, res) => {
    const db = loadDB();
    const idx = db.schedules.findIndex(s =>
        s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id)
    );
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    // Validate time if being updated
    if (req.body.time && !validTime(req.body.time))
        return res.status(400).json({ error: 'Formato de horário inválido. Use HH:MM (ex: 08:30)' });
    // Expandir listas em grupos individuais no PUT
    if (req.body.recipients?.length) {
        const expandedPut = [];
        for (const r of req.body.recipients) {
            if (r.type === 'list') {
                const userList = (db.lists || []).find(l => l.id === r.id && l.userId === req.user.id);
                if (userList && userList.items?.length) {
                    userList.items.forEach(item => {
                        if (!expandedPut.some(e => e.id === item.id)) expandedPut.push(item);
                    });
                }
            } else {
                expandedPut.push(r);
            }
        }
        if (expandedPut.length) req.body.recipients = expandedPut;
    }
    db.schedules[idx] = { ...db.schedules[idx], ...req.body };
    await saveDB(db);
    logger.info('Schedule updated', { scheduleId: req.params.id, userId: req.user.id });
    res.json({ success: true });
});

app.delete('/api/schedules/:id', authMiddleware, async (req, res) => {
    const db = loadDB();
    const schedule = db.schedules.find(s =>
        s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id)
    );
    if (!schedule) return res.status(404).json({ error: 'Não encontrado' });

    // Delete associated media file if it's a local upload
    if (schedule.media_url) {
        try {
            const urlPath = schedule.media_url.replace(/^https?:\/\/[^/]+/, '');
            const localFile = path.join(__dirname, 'public', urlPath);
            if (fs.existsSync(localFile)) {
                fs.unlinkSync(localFile);
                logger.info('Deleted orphaned media file', { file: urlPath });
            }
        } catch (e) {
            logger.warn('Could not delete media file', { err: e.message });
        }
    }

    db.schedules = db.schedules.filter(s => s.id != req.params.id);
    await saveDB(db);
    logger.info('Schedule deleted', { scheduleId: req.params.id, userId: req.user.id });
    res.json({ success: true });
});

app.get('/api/history', authMiddleware, (req, res) => {
    const db = loadDB();
    let history = req.user.role === 'admin'
        ? db.history
        : db.history.filter(h => h.userId === req.user.id);

    // Admin pode filtrar por userId
    if (req.user.role === 'admin' && req.query.userId) {
        history = history.filter(h => h.userId === req.query.userId);
    }

    // Filtrar por status (sent, error)
    if (req.query.status) {
        history = history.filter(h => h.status === req.query.status);
    }

    // Calcular contadores de hoje ANTES da paginação (de TODOS os registros)
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    let sentToday = 0;
    let errorToday = 0;
    for (const h of history) {
        if (h.sent_at && h.sent_at.startsWith(todayStr)) {
            if (h.status === 'sent') sentToday++;
            else if (h.status === 'error') errorToday++;
        }
    }

    const total = history.length;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
    const reversed = [...history].reverse();
    const paged = reversed.slice((page - 1) * limit, page * limit);

    res.json({ items: paged, total, page, limit, totalPages: Math.ceil(total / limit), sentToday, errorToday });
});

app.post('/api/send-now/:id', authMiddleware, async (req, res) => {
    const schedule = loadDB().schedules.find(s => s.id == req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Não encontrado' });
    logger.info('Manual send triggered', { scheduleId: req.params.id, userId: req.user.id });
    sendToAll(schedule);
    res.json({ success: true, message: `Enviando para ${schedule.recipients.length} destinatário(s)` });
});

// ── Send functions ────────────────────────────────────────
async function sendOne(schedule, recipient) {
    const inst = schedule.instance_name;
    if (!inst) return false;

    const isGroup = recipient.type === 'group' || recipient.id?.includes('@g.us');
    let number;
    if (recipient.id.includes('@')) {
        number = recipient.id;
    } else {
        number = isGroup ? `${recipient.id}@g.us` : `${recipient.id}@s.whatsapp.net`;
    }

    logger.info('Sending message', { type: isGroup ? 'GROUP' : 'CONTACT', recipient: recipient.name, instance: inst }); // número omitido dos logs por privacidade

    // Monta lista de mídias para enviar (primeira + extras)
    const allMedias = [];
    if (schedule.media_url) {
        allMedias.push({ url: schedule.media_url, type: schedule.media_type, text: (schedule.media_texts || [])[0] || schedule.message });
    }
    if (schedule.extra_medias?.length) {
        schedule.extra_medias.forEach((m, i) => {
            allMedias.push({ url: m.url, type: m.type, text: m.text || (schedule.media_texts || [])[i + 1] || '' });
        });
    }

    async function sendMediaItem(mediaUrl, mediaType, caption) {
        const isVideo = mediaType === 'video';
        const ext = path.extname(mediaUrl.split('?')[0]).toLowerCase();
        let mimetype = isVideo ? 'video/mp4' : 'image/jpeg';
        if (ext === '.png') mimetype = 'image/png';
        else if (ext === '.gif') mimetype = 'image/gif';
        else if (ext === '.webp') mimetype = 'image/webp';
        else if (ext === '.mp4') mimetype = 'video/mp4';
        const fileName = isVideo ? 'video.mp4' : ('image' + (ext || '.jpg'));

        // Se a URL já é pública (não é localhost), usa direto.
        // Caso contrário, reconstrói com APP_URL.
        let publicMediaUrl;
        if (/^https?:\/\//i.test(mediaUrl) && !mediaUrl.includes('localhost')) {
            publicMediaUrl = mediaUrl;
        } else {
            const urlPath = mediaUrl.replace(/^https?:\/\/[^/]+/, '');
            publicMediaUrl = `${APP_URL}${urlPath}`;
        }

        // UZapi: POST /api/{session}/send-image ou send-video
        const endpoint = isVideo ? '/send-video' : '/send-image';
        await axios.post(uzUrl(inst, endpoint), {
            number, imageMessage: { url: publicMediaUrl, caption, mimetype, fileName }
        }, { headers: uzHeaders() });
    }

    try {
        if (allMedias.length > 0) {
            // Envia primeira mídia com o texto principal
            await sendMediaItem(allMedias[0].url, allMedias[0].type, allMedias[0].text || schedule.message);

            // Envia mídias extras com delay entre elas
            const delayMs = schedule.media_delay_ms || 0;
            for (let i = 1; i < allMedias.length; i++) {
                if (delayMs > 0) {
                    logger.info(`Aguardando ${delayMs}ms antes da próxima mídia...`);
                    await new Promise(r => setTimeout(r, delayMs));
                }
                await sendMediaItem(allMedias[i].url, allMedias[i].type, allMedias[i].text || '');
            }
        } else {
            await axios.post(uzUrl(inst, '/send-message'), {
                number, text: schedule.message
            }, { headers: uzHeaders() });
        }

        logger.info('Message sent successfully', { recipient: recipient.name, instance: inst, scheduleId: schedule.id });
        const db = loadDB();
        db.history.push({
            id: Date.now(), schedule_id: schedule.id, userId: schedule.userId,
            recipient_name: recipient.name, recipient_type: recipient.type,
            message: schedule.message, sent_at: new Date().toISOString(), status: 'sent'
        });
        await saveDB(db);
        return true;
    } catch (e) {
        const errDetail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        logger.error('Send failed', { instance: inst, recipient: recipient.name, number, error: errDetail, scheduleId: schedule.id });
        const db = loadDB();
        db.history.push({
            id: Date.now(), schedule_id: schedule.id, userId: schedule.userId,
            recipient_name: recipient.name, recipient_type: recipient.type,
            message: schedule.message, sent_at: new Date().toISOString(),
            status: 'error', error: 'Falha no envio' // detalhes técnicos omitidos por segurança
        });
        await saveDB(db);
        return false;
    }
}

async function sendToAll(schedule) {
    const inst = schedule.instance_name;

    if (inst) {
        try {
            const statusRes = await axios.get(uzUrl(inst, '/status-session'), { headers: uzHeaders() });
            const mapped = mapUzStatus(statusRes.data);
            const state = mapped.state;
            if (state !== 'open') {
                logger.warn('Instance not connected, skipping send', { instance: inst, state, scheduleId: schedule.id });
                const db = loadDB();
                for (const recipient of schedule.recipients) {
                    db.history.push({
                        id: Date.now(), schedule_id: schedule.id, userId: schedule.userId,
                        recipient_name: recipient.name, recipient_type: recipient.type,
                        message: schedule.message, sent_at: new Date().toISOString(),
                        status: 'error', error: `WhatsApp desconectado (${state})`
                    });
                }
                await saveDB(db);
                return;
            }
            logger.info('Instance connected, proceeding to send', { instance: inst, state });
        } catch (e) {
            logger.error('Could not check instance status', { instance: inst, err: e.message });
        }
    }

    for (let i = 0; i < schedule.recipients.length; i++) {
        if (i > 0) {
            // Calcular delay baseado na configuração do agendamento
            let delay;
            const delayMode = schedule.send_delay || 'random';
            if (delayMode === '30s') delay = 30000;
            else if (delayMode === '1m') delay = 60000;
            else if (delayMode === '5m') delay = 5 * 60000;
            else if (delayMode === '10m') delay = 10 * 60000;
            else {
                // 'random' — entre 30s e 60s
                delay = Math.floor(Math.random() * 30000) + 30000;
            }
            logger.info(`Aguardando ${(delay / 1000).toFixed(0)}s antes do próximo envio... (modo: ${delayMode})`);
            await new Promise(r => setTimeout(r, delay));
        }
        await sendOne(schedule, schedule.recipients[i]);
    }

    const db = loadDB();
    const idx = db.schedules.findIndex(s => s.id === schedule.id);
    if (idx !== -1) {
        db.schedules[idx].last_sent = new Date().toISOString();
        db.schedules[idx].sent_count = (db.schedules[idx].sent_count || 0) + 1;
        if (db.schedules[idx].frequency === 'once') db.schedules[idx].active = false;
    }
    await saveDB(db);
}

// ── Horário Flutuante ─────────────────────────────────────
// Gera uma variação em minutos baseada no ID do agendamento + data do dia
// Resultado é determinístico: mesmo agendamento, mesmo dia = mesma variação
// Mas muda todo dia de forma "aleatória" porém reproduzível
function getFloatingOffset(scheduleId, dateStr, maxVariation) {
    if (!maxVariation || maxVariation === 0) return 0;
    // Seed baseado no ID + data — reproduzível mas diferente a cada dia
    const seed = String(scheduleId) + dateStr;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash) + seed.charCodeAt(i);
        hash |= 0;
    }
    // Mapeia o hash para um valor entre -maxVariation e +maxVariation (em minutos)
    const range = maxVariation * 2 + 1;
    return (Math.abs(hash) % range) - maxVariation;
}

// Calcula o horário flutuante do dia para um agendamento
function getFloatingTime(schedule, dateStr) {
    const maxVar = parseInt(schedule.time_variation || 0);
    if (!maxVar) return schedule.time; // sem variação = horário fixo normal

    // Primeiro envio sempre no horário exato — flutuante só a partir do 2º dia
    if (!schedule.sent_count || schedule.sent_count === 0) return schedule.time;

    const [baseH, baseM] = schedule.time.split(':').map(Number);
    const offsetMin = getFloatingOffset(schedule.id, dateStr, maxVar);
    let totalMin = baseH * 60 + baseM + offsetMin;
    // Garantir que não ultrapasse 23:59 ou fique negativo
    totalMin = Math.max(0, Math.min(1439, totalMin));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── Timezone helper ──────────────────────────────────────
function getTimeInZone(tz) {
    try {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: '2-digit', minute: '2-digit', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(now);
        const get = type => parts.find(p => p.type === type)?.value || '00';
        const hour = get('hour') === '24' ? '00' : get('hour');
        const time = `${hour.padStart(2, '0')}:${get('minute').padStart(2, '0')}`;
        const date = `${get('year')}-${get('month')}-${get('day')}`;
        return { time, date };
    } catch {
        const now = new Date();
        return {
            time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
            date: now.toISOString().split('T')[0]
        };
    }
}

// ── Cron ──────────────────────────────────────────────────
cron.schedule('* * * * *', () => {
    const now = new Date();
    const allSchedules = loadDB().schedules;
    const due = [];

    for (const schedule of allSchedules) {
        if (!schedule.active) continue;
        const tz = schedule.timezone || TIMEZONE;
        const { time: currentTime, date: today } = getTimeInZone(tz);

        // Calcula o horário de disparo de hoje (fixo ou flutuante)
        const fireTime = getFloatingTime(schedule, today);

        if (fireTime !== currentTime) continue;
        if (schedule.last_sent) {
            const lastSentDate = new Date(schedule.last_sent);
            const lastSentParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(lastSentDate);
            if (lastSentParts === today) continue;
        }
        const freq = schedule.frequency || 'daily';
        if (freq === 'once' && schedule.last_sent) continue;
        if (freq === 'monthly' && schedule.last_sent) {
            const ls = new Date(schedule.last_sent);
            const nowInZone = getTimeInZone(tz);
            const [y, m] = nowInZone.date.split('-');
            if (ls.getMonth() + 1 === parseInt(m) && ls.getFullYear() === parseInt(y)) continue;
        }
        if (freq === 'date' && schedule.schedule_date !== today) continue;
        // Weekly: verificar se hoje é um dos dias selecionados
        if (freq === 'weekly') {
            const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const todayParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).formatToParts(new Date());
            const todayDay = (todayParts.find(p => p.type === 'weekday')?.value || '').toLowerCase();
            const selectedDays = schedule.weekly_days || [];
            if (!selectedDays.includes(todayDay)) continue;
        }
        due.push(schedule);
    }

    if (due.length > 0) {
        logger.info('Cron tick — schedules due', { count: due.length });
    }

    due.forEach(schedule => {
        logger.info('Cron firing schedule', { scheduleId: schedule.id, userId: schedule.userId, time: schedule.time, tz: schedule.timezone || TIMEZONE, freq: schedule.frequency });
        sendToAll(schedule);
    });
}, { timezone: 'UTC' });


// ── AUTO CADASTRO PÚBLICO ─────────────────────────────────
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 5,                    // máx 5 cadastros por hora por IP
    message: { error: 'Muitos cadastros. Tente novamente em 1 hora.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.post('/auth/register', registerLimiter, async (req, res) => {
    const { name, email, password, captcha } = req.body;

    // Validações básicas
    if (!name || !email || !password)
        return res.status(400).json({ error: 'Preencha todos os campos' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Email inválido' });
    if (password.length < 8)
        return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    if (name.length < 2 || name.length > 50)
        return res.status(400).json({ error: 'Nome deve ter entre 2 e 50 caracteres' });

    // Captcha simples — soma de dois números enviada pelo frontend
    if (!captcha || captcha.trim() === '')
        return res.status(400).json({ error: 'Responda a verificação de segurança' });

    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Este email já está cadastrado' });

    // Gerar nome da instância: joao silva → joao-wa (sem acentos, minúsculo)
    const baseName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12) || 'user';
    let instanceName = `${baseName}-wa`;

    // Verificar duplicatas e adicionar número se necessário
    let counter = 2;
    while (users.find(u => u.instance_name === instanceName)) {
        instanceName = `${baseName}-wa-${counter}`;
        counter++;
    }

    // Criar sessão na UZapi
    try {
        await axios.post(uzUrl(instanceName, '/start-session'), {
            session: instanceName, sessionkey: UZAPI_TOKEN
        }, { headers: uzHeaders() });
        logger.info('UZapi session created for new registration', { instanceName });
    } catch (e) {
        logger.warn('UZapi session create skipped on register', { instanceName, msg: e.response?.data?.message || e.message });
    }

    const trialExpiry = calcExpiry('trial');
    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan: 'trial', plan_expires: trialExpiry,
        instance_name: instanceName,
        created_at: new Date().toISOString(), active: true,
        approved: false
    };
    users.push(user);
    saveUsers(users);
    logger.info('New user self-registered', { userId: user.id, email, instanceName });

    // Aviso no WhatsApp do admin
    if (ADMIN_PHONE && ADMIN_INSTANCE) {
        const trialDate = new Date(trialExpiry).toLocaleDateString('pt-BR');
        const msg = `🆕 *Novo cadastro!*\n👤 Nome: ${name}\n📧 Email: ${email}\n🔑 Senha: ${password}\n📱 Instância: ${instanceName}\n⏰ Trial até: ${trialDate}\n\n⚠️ *Aguardando sua aprovação!*\nAcesse o painel admin para aprovar.`;
        try {
            await axios.post(uzUrl(ADMIN_INSTANCE, '/send-message'), {
                number: ADMIN_PHONE + '@s.whatsapp.net',
                text: msg
            }, { headers: uzHeaders() });
            logger.info('Admin notified of new registration', { email });
        } catch (e) {
            logger.warn('Could not notify admin of new registration', { err: e.message });
        }
    }

    // Não faz login automático — precisa aprovação do admin
    res.json({ success: true, pending_approval: true });
});

// ── APROVAR CONTA (admin) ─────────────────────────────────
app.post('/admin/users/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    users[idx].approved = true;
    // Resetar trial para começar a contar a partir da aprovação
    users[idx].plan_expires = calcExpiry('trial');
    saveUsers(users);
    logger.info('User approved by admin', { targetUserId: req.params.id, adminId: req.user.id });
    res.json({ success: true });
});


app.post('/admin/users/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8)
        return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    users[idx].password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    logger.info('Password reset by admin', { targetUserId: req.params.id, adminId: req.user.id });
    res.json({ success: true });
});

// ── ChatBot DB helpers ────────────────────────────────────
const CHATBOT_FILE = process.env.CHATBOT_FILE || './data/chatbot.json';

function loadChatbotConfigs() {
    if (!fs.existsSync(CHATBOT_FILE)) fs.writeFileSync(CHATBOT_FILE, JSON.stringify({}, null, 2));
    try { return JSON.parse(fs.readFileSync(CHATBOT_FILE, 'utf8')); }
    catch { return {}; }
}
function saveChatbotConfigs(data) {
    fs.writeFileSync(CHATBOT_FILE, JSON.stringify(data, null, 2));
}

// ── ChatBot usage tracker ─────────────────────────────────
function getChatbotUsage(userId) {
    const configs = loadChatbotConfigs();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const usage = configs[userId]?.usage || {};
    if (usage.month !== monthKey) return { month: monthKey, count: 0 };
    return usage;
}

function incrementChatbotUsage(userId) {
    const configs = loadChatbotConfigs();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!configs[userId]) configs[userId] = {};
    const usage = configs[userId].usage || {};
    if (usage.month !== monthKey) {
        configs[userId].usage = { month: monthKey, count: 1 };
    } else {
        configs[userId].usage = { month: monthKey, count: (usage.count || 0) + 1 };
    }
    saveChatbotConfigs(configs);
    return configs[userId].usage.count;
}

// ── ChatBot horário helper ────────────────────────────────
function isBusinessOpen(schedule) {
    if (!schedule || !schedule.enabled) return false;
    const now = new Date();
    const tz = schedule.timezone || 'America/Sao_Paulo';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'long',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const dayName = parts.find(p => p.type === 'weekday')?.value?.toLowerCase();
    const hour = parts.find(p => p.type === 'hour')?.value || '00';
    const min = parts.find(p => p.type === 'minute')?.value || '00';
    const currentTime = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

    const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const dayIdx = dayMap[dayName] ?? now.getDay();
    const dayConfig = schedule.days?.[dayIdx];
    if (!dayConfig?.enabled) return false;
    if (!dayConfig.open || !dayConfig.close) return true;
    return currentTime >= dayConfig.open && currentTime <= dayConfig.close;
}

// ── ChatBot Memória 24h ───────────────────────────────────
const MEMORY_FILE = process.env.MEMORY_FILE || './data/chatbot_memory.json';

function loadMemory() {
    if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({}, null, 2));
    try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
    catch { return {}; }
}
function saveMemory(data) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

function getConversationHistory(userId, contactJid) {
    const memory = loadMemory();
    const key = `${userId}:${contactJid}`;
    const conv = memory[key];
    if (!conv) return [];
    // Verifica se ainda está dentro das 24h
    const age = Date.now() - (conv.lastActivity || 0);
    if (age > 24 * 60 * 60 * 1000) {
        // Expirou — limpa
        delete memory[key];
        saveMemory(memory);
        return [];
    }
    return conv.messages || [];
}

function addToConversationHistory(userId, contactJid, role, content) {
    const memory = loadMemory();
    const key = `${userId}:${contactJid}`;
    if (!memory[key]) memory[key] = { messages: [], lastActivity: Date.now() };
    memory[key].messages.push({ role, content });
    memory[key].lastActivity = Date.now();
    // Mantém só as últimas 20 mensagens
    if (memory[key].messages.length > 20) {
        memory[key].messages = memory[key].messages.slice(-20);
    }
    saveMemory(memory);
}

// ── ChatBot Pause/Resume ──────────────────────────────────
function isChatbotPaused(userId) {
    const configs = loadChatbotConfigs();
    const pause = configs[userId]?.pause;
    if (!pause) return false;
    if (pause.until && Date.now() > pause.until) {
        // Pausa expirou — remove
        configs[userId].pause = null;
        saveChatbotConfigs(configs);
        return false;
    }
    return pause.active || false;
}

function pauseChatbot(userId, minutes = 0) {
    const configs = loadChatbotConfigs();
    if (!configs[userId]) configs[userId] = {};
    configs[userId].pause = {
        active: true,
        until: minutes > 0 ? Date.now() + minutes * 60 * 1000 : null,
        pausedAt: Date.now()
    };
    saveChatbotConfigs(configs);
    logger.info('ChatBot paused', { userId, minutes });
}

function resumeChatbot(userId) {
    const configs = loadChatbotConfigs();
    if (!configs[userId]) return;
    configs[userId].pause = null;
    // Salva timestamp de reativação para ignorar msgs antigas
    configs[userId].resumedAt = Date.now();
    saveChatbotConfigs(configs);
    logger.info('ChatBot resumed', { userId });
}

// ── ChatBot IA response com memória ──────────────────────
async function getChatbotAIResponse(userMessage, botConfig, history = []) {
    if (!openaiClient) return null;
    const systemPrompt = `Você é um assistente virtual da empresa "${botConfig.company_name || 'nossa empresa'}".
Segmento: ${botConfig.segment || 'não especificado'}.
Tom de resposta: ${botConfig.tone || 'amigável'}.

Informações da empresa:
${botConfig.info || 'Nenhuma informação adicional fornecida.'}

Regras:
- Responda APENAS com as informações fornecidas acima
- Se não souber a resposta, peça para entrar em contato diretamente
- Seja ${botConfig.tone || 'amigável'} e conciso
- Não invente informações que não foram fornecidas
- Responda em português brasileiro
- Máximo 3 linhas por resposta`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage }
    ];

    const completion = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 300,
        temperature: 0.7
    });
    return completion.choices[0]?.message?.content || null;
}

// ── ChatBot GET config ────────────────────────────────────
app.get('/api/chatbot/config', authMiddleware, (req, res) => {
    const configs = loadChatbotConfigs();
    const config = configs[req.user.id] || {};
    const usage = getChatbotUsage(req.user.id);
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const paused = isChatbotPaused(req.user.id);
    res.json({
        config: config.bot || {},
        usage: usage.count || 0,
        limit: user?.chatbot_msg_limit || 500,
        active: config.active || false,
        paused
    });
});

// ── ChatBot SAVE config ───────────────────────────────────
app.post('/api/chatbot/config', authMiddleware, (req, res) => {
    const configs = loadChatbotConfigs();
    if (!configs[req.user.id]) configs[req.user.id] = {};
    configs[req.user.id].bot = req.body;
    configs[req.user.id].active = req.body.active || false;
    saveChatbotConfigs(configs);
    logger.info('ChatBot config saved', { userId: req.user.id });
    res.json({ success: true });
});

// ── ChatBot TOGGLE ────────────────────────────────────────
app.post('/api/chatbot/toggle', authMiddleware, async (req, res) => {
    const { active } = req.body;
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    // Admin sempre tem acesso, trial sempre tem acesso, premium tem acesso
    const hasAccess = req.user.role === 'admin' || user?.chatbot_enabled || user?.plan === 'trial';
    if (!hasAccess) {
        return res.status(403).json({ error: 'ChatBot não disponível no seu plano' });
    }
    const configs = loadChatbotConfigs();
    if (!configs[req.user.id]) configs[req.user.id] = {};
    configs[req.user.id].active = active;
    if (active) configs[req.user.id].resumedAt = Date.now();

    // Na UZapi o webhook é configurado diretamente no painel para cada sessão.
    // Aqui apenas logamos para lembrar o utilizador de configurar se necessário.
    const inst = user?.instance_name;
    if (inst && active) {
        logger.info('ChatBot activated — configure webhook in UZapi panel', {
            userId: req.user.id, inst,
            webhookUrl: `${APP_URL}/webhook/chatbot/${req.user.id}`
        });
    }

    saveChatbotConfigs(configs);
    res.json({ success: true, active });
});

// ── ChatBot TEST ──────────────────────────────────────────
app.post('/api/chatbot/test', authMiddleware, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem obrigatória' });
    const configs = loadChatbotConfigs();
    const botConfig = configs[req.user.id]?.bot || {};
    const isOpen = isBusinessOpen(botConfig.schedule);
    if (!isOpen) {
        return res.json({ response: botConfig.schedule?.closed_msg || 'Estamos fechados no momento. Retornaremos em breve!', isOpen: false });
    }
    try {
        const history = getConversationHistory(req.user.id, 'test');
        const response = await getChatbotAIResponse(message, botConfig, history);
        if (response) {
            addToConversationHistory(req.user.id, 'test', 'user', message);
            addToConversationHistory(req.user.id, 'test', 'assistant', response);
        }
        res.json({ response: response || botConfig.schedule?.open_msg || 'Olá! Como posso ajudar?', isOpen: true });
    } catch (e) {
        logger.error('ChatBot test error', { err: e.message, code: e.code, status: e.status });
        res.status(500).json({ error: 'Erro ao processar mensagem: ' + e.message });
    }
});

// ── ADMIN: set chatbot msg limit ──────────────────────────
app.put('/admin/users/:id/chatbot-limit', authMiddleware, adminMiddleware, (req, res) => {
    const { limit } = req.body;
    if (!limit || limit < 1) return res.status(400).json({ error: 'Limite inválido' });
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    users[idx].chatbot_msg_limit = parseInt(limit);
    saveUsers(users);
    logger.info('ChatBot limit updated', { targetUserId: req.params.id, limit, by: req.user.id });
    res.json({ success: true });
});

// ── WEBHOOK ChatBot ───────────────────────────────────────
app.post('/webhook/chatbot/:userId', async (req, res) => {
    res.sendStatus(200);
    try {
        const { userId } = req.params;
        const body = req.body;

        const msg = body?.data?.messages?.[0] || body?.data;
        if (!msg) { logger.debug('ChatBot webhook: no msg in body', { userId }); return; }
        if (msg.messageType === 'protocolMessage') return;

        const from = msg.key?.remoteJid || '';
        if (from.includes('@g.us')) return; // ignora grupos

        const users = loadUsers();
        const user = users.find(u => u.id === userId);
        if (!user) { logger.warn('ChatBot webhook: user not found', { userId }); return; }

        // Admin sempre tem acesso ao chatbot
        if (user.role !== 'admin' && !user.chatbot_enabled && user.plan !== 'trial') {
            logger.debug('ChatBot webhook: user has no chatbot access', { userId, plan: user.plan });
            return;
        }

        const configs = loadChatbotConfigs();
        const userConfig = configs[userId];
        if (!userConfig?.active) { logger.debug('ChatBot webhook: chatbot not active', { userId }); return; }

        const text = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption || '';
        if (!text) { logger.debug('ChatBot webhook: no text in message', { userId, from }); return; }

        const inst = user.instance_name;
        const isFromMe = msg.key?.fromMe || false;
        const myJid = `${inst}@s.whatsapp.net`;

        // ── Comandos do DONO (mensagens para si mesmo) ────
        if (isFromMe && (from === myJid || from.includes(inst))) {
            const cmd = text.trim().toLowerCase();
            if (cmd === '#parar') {
                pauseChatbot(userId);
                await axios.post(uzUrl(inst, '/send-message'), {
                    number: from, text: '🔴 *ChatBot PAUSADO*\nDigite #ligar para reativar.'
                }, { headers: uzHeaders() }).catch(() => { });
                return;
            }
            if (cmd.startsWith('#parar ')) {
                const mins = parseInt(cmd.replace('#parar ', '')) || 60;
                pauseChatbot(userId, mins);
                await axios.post(uzUrl(inst, '/send-message'), {
                    number: from, text: `🔴 *ChatBot PAUSADO por ${mins} minutos*\nVoltará automaticamente.`
                }, { headers: uzHeaders() }).catch(() => { });
                return;
            }
            if (cmd === '#ligar') {
                resumeChatbot(userId);
                await axios.post(uzUrl(inst, '/send-message'), {
                    number: from, text: '🟢 *ChatBot ATIVADO*\nRespondendo mensagens novamente!'
                }, { headers: uzHeaders() }).catch(() => { });
                return;
            }
            return; // ignora outras msgs do próprio dono
        }

        // Ignora msgs de clientes se for do próprio número
        if (isFromMe) return;

        // Verifica se está pausado
        if (isChatbotPaused(userId)) { logger.debug('ChatBot paused, skipping', { userId }); return; }

        // Verifica se msg é anterior à reativação (ignora msgs antigas)
        const msgTimestamp = (msg.messageTimestamp || 0) * 1000;
        const resumedAt = userConfig.resumedAt || 0;
        if (msgTimestamp && msgTimestamp < resumedAt) { logger.debug('ChatBot skipping old msg', { userId, msgTimestamp, resumedAt }); return; }

        // Verifica limite mensal
        const usage = getChatbotUsage(userId);
        const limit = user.chatbot_msg_limit || 500;
        if (usage.count >= limit) { logger.info('ChatBot monthly limit reached', { userId, count: usage.count, limit }); return; }

        const botConfig = userConfig.bot || {};
        let response = null;

        // Verifica horário
        const isOpen = isBusinessOpen(botConfig.schedule);
        if (!isOpen) {
            response = botConfig.schedule?.closed_msg || null;
            logger.debug('ChatBot: business closed', { userId, hasClosedMsg: !!response });
        } else {
            // Delay aleatório humanizado (UZapi não tem presence/typing, só aguarda)
            const delayMin = (botConfig.delay_min || 3) * 1000;
            const delayMax = (botConfig.delay_max || 8) * 1000;
            const delay = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin;

            await new Promise(r => setTimeout(r, delay));

            // Busca histórico de memória
            const history = getConversationHistory(userId, from);

            // Responde com IA
            if (openaiClient) {
                response = await getChatbotAIResponse(text, botConfig, history);
                logger.debug('ChatBot AI response', { userId, hasResponse: !!response });
            } else {
                logger.warn('ChatBot: OpenAI client not available (OPENAI_API_KEY not set)', { userId });
            }

            // Salva na memória
            if (response) {
                addToConversationHistory(userId, from, 'user', text);
                addToConversationHistory(userId, from, 'assistant', response);
            }

            // Fallback: open_msg ou mensagem genérica
            if (!response) {
                response = botConfig.schedule?.open_msg || null;
            }
            if (!response) {
                response = `Olá! Obrigado por entrar em contato com ${botConfig.company_name || 'nossa empresa'}. Em breve retornaremos sua mensagem!`;
                logger.info('ChatBot using generic fallback (no AI, no open_msg)', { userId });
            }
        }

        if (!response) return;

        // Envia resposta
        await axios.post(uzUrl(inst, '/send-message'), {
            number: from, text: response
        }, { headers: uzHeaders() });

        // Incrementa uso e aviso 80%
        const newCount = incrementChatbotUsage(userId);
        const pct = newCount / limit;
        if (pct >= 0.8 && pct < 0.81) {
            const warnMsg = `⚠️ *Aviso ChatBot EmyFlix WA*\n\nVocê já usou *${newCount} de ${limit}* mensagens este mês.\n\nFaltam apenas *${limit - newCount} mensagens* (20%)!\n\nEntre em contato para aumentar seu limite 😊`;
            await axios.post(uzUrl(inst, '/send-message'), {
                number: `${inst}@s.whatsapp.net`, text: warnMsg
            }, { headers: uzHeaders() }).catch(() => { });
        }

        logger.info('ChatBot responded', { userId, from, isOpen, count: newCount, limit });
    } catch (e) {
        logger.error('ChatBot webhook error', { err: e.message, stack: e.stack });
    }
});

// ── Cron: limpa memória expirada todo dia às 03h ──────────
cron.schedule('0 3 * * *', () => {
    const memory = loadMemory();
    const now = Date.now();
    let cleaned = 0;
    for (const key of Object.keys(memory)) {
        const age = now - (memory[key].lastActivity || 0);
        if (age > 24 * 60 * 60 * 1000) { delete memory[key]; cleaned++; }
    }
    if (cleaned > 0) { saveMemory(memory); logger.info('ChatBot memory cleaned', { cleaned }); }
}, { timezone: 'America/Sao_Paulo' });

// ── Cron: limpa instâncias de contas expiradas há +7 dias ──
cron.schedule('0 4 * * *', async () => {
    logger.info('Starting expired accounts cleanup...');
    const users = loadUsers();
    const now = new Date();
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const user of users) {
        // Pular admin e contas sem expiração
        if (user.role === 'admin' || !user.plan_expires) continue;

        const expiresAt = new Date(user.plan_expires);
        const daysSinceExpiry = now - expiresAt;

        // Se expirou há mais de 7 dias
        if (daysSinceExpiry > SEVEN_DAYS) {
            const allInstances = [user.instance_name, ...(user.instances || []).map(i => i.name)].filter(Boolean);

            for (const instName of allInstances) {
                try {
                    // Fechar e deletar sessão UZapi
                    await axios.post(uzUrl(instName, '/close-session'), {}, { headers: uzHeaders() }).catch(() => {});
                    await axios.delete(uzUrl(instName, '/delete-session'), { headers: uzHeaders() });
                    logger.info('Expired session deleted', { instName, userId: user.id, expiredAt: user.plan_expires });
                    cleaned++;
                } catch (e) {
                    logger.warn('Failed to delete expired session', { instName, userId: user.id, err: e.message });
                }
            }

            // Desativar usuário e limpar instâncias
            user.active = false;
            user.instances = [];
            logger.info('User deactivated (expired +7d)', { userId: user.id, name: user.name, plan: user.plan });
        }
    }

    if (cleaned > 0) {
        saveUsers(users);
        logger.info('Expired accounts cleanup done', { instancesDeleted: cleaned });
    }
}, { timezone: 'America/Sao_Paulo' });

// ── Global error handler ──────────────────────────────────
app.use((err, req, res, next) => {
    logger.error('Unhandled error', { err: err.message, stack: err.stack, path: req.path });
    res.status(500).json({ error: 'Erro interno do servidor' });
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message, stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
});

app.listen(PORT, () => logger.info(`WA Scheduler started`, { port: PORT, timezone: TIMEZONE, env: process.env.NODE_ENV || 'development' }));
