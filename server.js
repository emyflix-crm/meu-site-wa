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
let helmet;
try { helmet = require('helmet'); } catch { helmet = null; }

// ── Config & Secrets ──────────────────────────────────────
const PORT             = process.env.PORT || 3001;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const APP_URL          = process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_INSTANCE   = process.env.ADMIN_INSTANCE || 'teste-nascimento';
const ADMIN_PHONE      = process.env.ADMIN_PHONE || '447840414670';
const JWT_SECRET       = process.env.JWT_SECRET || 'super_secret_jwt_key_at_least_32_characters_long_123';
const TIMEZONE         = process.env.TZ || 'America/Sao_Paulo';

const DB_FILE     = process.env.DB_FILE    || './data.json';
const USERS_FILE  = process.env.USERS_FILE || './users.json';
const LOGS_DIR    = process.env.LOGS_DIR   || './logs';
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

// ── Logger setup ──────────────────────────────────────────
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
                    return `${timestamp} [${level}] ${message}${extra}`;
                })
            )
        }),
        new winston.transports.DailyRotateFile({
            dirname: LOGS_DIR,
            filename: 'app-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '14d',
            maxSize: '20m',
            zippedArchive: true
        }),
        new winston.transports.DailyRotateFile({
            dirname: LOGS_DIR,
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '30d',
            maxSize: '10m',
            zippedArchive: true
        })
    ]
});

// Fail fast on missing critical secrets in production
if (!EVOLUTION_API_URL && process.env.NODE_ENV === 'production') {
    logger.error('EVOLUTION_API_URL env var is required'); process.exit(1);
}
if (!EVOLUTION_API_KEY && process.env.NODE_ENV === 'production') {
    logger.error('EVOLUTION_API_KEY env var is required'); process.exit(1);
}
if (JWT_SECRET.length < 32) {
    logger.error('JWT_SECRET deve ter pelo menos 32 caracteres para segurança'); process.exit(1);
}

// ── File setup ────────────────────────────────────────────
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIMETYPES = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/quicktime'
]);

const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
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
let dbWriteQueue = Promise.resolve();
function queueDBWrite(fn) {
    dbWriteQueue = dbWriteQueue.then(fn).catch(err => logger.error('DB write queue error', { err: err.message }));
    return dbWriteQueue;
}

function loadDB() {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ schedules: [], history: [] }, null, 2));
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { logger.error('Failed to parse DB file', { err: e.message }); return { schedules: [], history: [] }; }
}
function saveDB(data) {
    return queueDBWrite(() => {
        if (data.history && data.history.length > 2000) {
            data.history = data.history.slice(-2000);
        }
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    });
}

function loadUsers() {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) {
        const admin = {
            id: 'admin', name: 'Admin', email: 'admin@wascheduler.com',
            password: bcrypt.hashSync('Admin123!', 10),
            role: 'admin', plan: 'unlimited', plan_expires: null,
            created_at: new Date().toISOString(), active: true,
            max_instances: 5, instances: []
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
        logger.info('Created default admin user');
    }
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
    catch (e) { logger.error('Failed to parse users file', { err: e.message }); return []; }
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── Express app ───────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));

if (helmet) app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static file servers
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use(morgan('combined', {
    stream: { write: msg => logger.http(msg.trim()) }
}));

// Route shortcuts
app.get('/app.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Rate limiting ─────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        logger.warn('Rate limit hit on login', { ip: req.ip, email: req.body?.email });
        res.status(429).json(options.message);
    }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
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
    trial:      { name: 'Trial 7 dias',  days: 7,   price: 0      },
    monthly:    { name: 'Mensal',        days: 30,  price: 29.90  },
    semiannual: { name: 'Semestral',     days: 180, price: 149.90 },
    annual:     { name: 'Anual',         days: 365, price: 249.90 },
    unlimited:  { name: 'Ilimitado',     days: null, price: null  }
};
function calcExpiry(planKey) {
    const plan = PLANS[planKey];
    if (!plan || !plan.days) return null;
    const d = new Date(); d.setDate(d.getDate() + plan.days); return d.toISOString();
}

// ── Evolution API helper ──────────────────────────────────
const evoHeaders = () => ({ 'apikey': EVOLUTION_API_KEY, 'Content-Type': 'application/json' });

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
    if (user.plan !== 'unlimited' && user.plan_expires && new Date(user.plan_expires) < new Date()) {
        logger.warn('Login attempt: expired plan', { email });
        return res.status(403).json({ error: 'Seu plano expirou. Entre em contato com o suporte.', expired: true });
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    logger.info('User logged in', { userId: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, plan_expires: user.plan_expires, instance_name: user.instance_name, instances: user.instances || [], max_instances: user.max_instances || 1 } });
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Email inválido' });
    if (password.length < 8)
        return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    if (!/^[a-zA-Z0-9-_]+$/.test(instance_name))
        return res.status(400).json({ error: 'Nome de instância inválido (use apenas letras, números e hífens)' });
    
    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Email já cadastrado' });
    if (users.find(u => u.instance_name === instance_name))
        return res.status(400).json({ error: 'Nome de instância já em uso' });

    if (EVOLUTION_API_URL) {
        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName: instance_name, qrcode: true, integration: 'WHATSAPP-BAILEYS'
            }, { headers: evoHeaders() });
            logger.info('Evolution instance created', { instance_name });
        } catch (e) {
            logger.warn('Evolution instance create skipped (may already exist)', { instance_name, msg: e.response?.data?.message || e.message });
        }
    }

    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan, plan_expires: calcExpiry(plan),
        instance_name, instances: [{ name: instance_name, label: 'Principal', connected: false }],
        max_instances: 1, created_at: new Date().toISOString(), active: true
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
    const { plan, active, name, instance_name, max_instances } = req.body;
    if (name) users[idx].name = name;
    if (instance_name) users[idx].instance_name = instance_name;
    if (plan !== undefined) {
        if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
        users[idx].plan = plan;
        users[idx].plan_expires = calcExpiry(plan);
    }
    if (active !== undefined) users[idx].active = active;
    if (max_instances !== undefined) users[idx].max_instances = parseInt(max_instances) || 1;
    saveUsers(users);
    logger.info('User updated', { targetUserId: req.params.id, changes: { plan, active, name }, updatedBy: req.user.id });
    res.json({ success: true });
});

app.delete('/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user?.instance_name && user.role !== 'admin' && EVOLUTION_API_URL) {
        try {
            await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${user.instance_name}`, { headers: evoHeaders() });
            logger.info('Evolution instance deleted', { instance_name: user.instance_name });
        } catch (e) {
            logger.warn('Could not delete Evolution instance', { instance_name: user.instance_name, err: e.message });
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
    (db.schedules || []).forEach(s => {
        const names = (s.recipients || []).map(r => r.name).join(' | ');
        const msg = (s.message || '').replace(/"/g, '""');
        lines.push(`"${s.userEmail || ''}","${names}","${msg}","${s.time}","${s.frequency}","${s.active}","${s.sent_count || 0}"`);
    });
    logger.info('CSV exported', { by: req.user.id, rows: (db.schedules || []).length });
    res.setHeader('Content-Disposition', `attachment; filename=agendamentos-${new Date().toISOString().split('T')[0]}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\n'));
});

app.get('/admin/export-history-csv', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const lines = ['Data,Usuário,Destinatário,Tipo,Status,Mensagem,Erro'];
    (db.history || []).forEach(h => {
        const msg = (h.message || '').replace(/"/g, '""');
        const err = (h.error || '').replace(/"/g, '""');
        lines.push(`"${h.sent_at || ''}","${h.userId || ''}","${h.recipient_name || ''}","${h.recipient_type || ''}","${h.status || ''}","${msg}","${err}"`);
    });
    logger.info('History CSV exported', { by: req.user.id, rows: (db.history || []).length });
    res.setHeader('Content-Disposition', `attachment; filename=historico-${new Date().toISOString().split('T')[0]}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\n'));
});

// ── UPLOAD ────────────────────────────────────────────────
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Muitos uploads. Aguarde um momento.' },
    keyGenerator: (req) => String(req.user?.id || req.ip)
});
app.post('/api/upload', authMiddleware, uploadLimiter, upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `${APP_URL}/uploads/${req.file.filename}`;
    logger.info('File uploaded', { userId: req.user.id, filename: req.file.filename, size: req.file.size, mimetype: req.file.mimetype });
    res.json({ url, isVideo: req.file.mimetype.startsWith('video/') });
});

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
    if (!inst || !EVOLUTION_API_URL) return res.json([]);
    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/group/fetchAllGroups/${inst}?getParticipants=false`, { headers: evoHeaders() });
        const groups = Array.isArray(r.data) ? r.data : [];
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
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: 'groupId obrigatório' });
    if (!EVOLUTION_API_URL) return res.status(500).json({ error: 'EVOLUTION_API_URL não configurado' });

    const adminPhone = ADMIN_PHONE + '@s.whatsapp.net';

    try {
        const users = loadUsers();
        let inviteCode = null;
        let ownerInst = null;

        for (const u of users) {
            if (!u.instance_name || u.role === 'admin') continue;
            try {
                const inv = await axios.get(
                    `${EVOLUTION_API_URL}/group/inviteCode/${u.instance_name}?groupJid=${groupId}`,
                    { headers: evoHeaders() }
                );
                const code = inv.data?.inviteCode || inv.data?.code || inv.data?.invite_code;
                if (code) { inviteCode = code; ownerInst = u.instance_name; break; }
            } catch { continue; }
        }

        if (inviteCode) {
            const joinRes = await axios.post(
                `${EVOLUTION_API_URL}/group/acceptInviteCode/${ADMIN_INSTANCE}`,
                { inviteCode },
                { headers: evoHeaders() }
            );
            logger.info('Admin joined group via invite', { adminId: req.user.id, groupId, ownerInst, joinRes: joinRes.data });
            res.json({ success: true, pending: false, message: 'Entrou no grupo com sucesso!' });
        } else {
            const r2 = await axios.post(
                `${EVOLUTION_API_URL}/group/updateParticipant/${ADMIN_INSTANCE}`,
                { groupJid: groupId, action: 'add', participants: [adminPhone] },
                { headers: evoHeaders() }
            );
            const status = r2.data?.[0]?.status;
            logger.info('Admin join group fallback', { adminId: req.user.id, groupId, status });
            if (status === 408) {
                res.json({ success: true, pending: true, message: 'Solicitação enviada! Aguardando aprovação do admin.' });
            } else {
                res.json({ success: true, pending: false, message: 'Entrou no grupo com sucesso!' });
            }
        }
    } catch (e) {
        const errMsg = e.response?.data?.message || e.message;
        logger.error('Admin join group failed', { groupId, err: errMsg });
        res.status(500).json({ error: errMsg });
    }
});

// ── WHATSAPP (per-user instance) ──────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.json({ instance: { state: 'no_instance' }, instance_name: null });
    if (!EVOLUTION_API_URL) return res.json({ instance: { state: 'disconnected' }, instance_name: inst });
    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders() });
        res.json({ ...r.data, instance_name: inst });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: inst });
    }
});

app.get('/api/qrcode', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.status(400).json({ error: 'Nenhuma instância configurada' });
    if (!EVOLUTION_API_URL) return res.status(500).json({ error: 'EVOLUTION_API_URL não configurado' });

    async function ensureInstance() {
        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName: inst, qrcode: true, integration: 'WHATSAPP-BAILEYS'
            }, { headers: evoHeaders() });
            logger.info('Instance ensured/created for QR', { inst });
        } catch (e) {
            logger.debug('Instance create on QR (may exist)', { inst, msg: e.response?.data?.message || e.message });
        }
    }

    try {
        try {
            const stateRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders() });
            if (stateRes.data?.instance?.state === 'open') {
                return res.json({ alreadyConnected: true, instance: stateRes.data.instance });
            }
        } catch (stateErr) {}

        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${inst}`, { headers: evoHeaders() });
        res.json(r.data);
    } catch (e) {
        if (e.response?.status === 404 || e.response?.status === 400) {
            await ensureInstance();
            await new Promise(r => setTimeout(r, 1500));
            try {
                const r2 = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${inst}`, { headers: evoHeaders() });
                res.json(r2.data);
            } catch (e2) {
                logger.error('QR code fetch failed after instance create', { inst, err: e2.message });
                res.status(500).json({ error: e2.response?.data?.message || e2.message });
            }
        } else {
            logger.error('QR code fetch failed', { inst, err: e.message });
            res.status(500).json({ error: e.response?.data?.message || e.message });
        }
    }
});

app.post('/api/disconnect', authMiddleware, async (req, res) => {
    const inst = req.user.instance_name;
    if (!inst) return res.status(400).json({ error: 'Nenhuma instância' });
    if (!EVOLUTION_API_URL) return res.json({ success: true });
    try {
        await axios.delete(`${EVOLUTION_API_URL}/instance/logout/${inst}`, { headers: evoHeaders() });
        logger.info('WhatsApp disconnected', { inst, userId: req.user.id });
        res.json({ success: true });
    } catch (e) {
        logger.error('Disconnect failed', { inst, err: e.message });
        res.status(500).json({ error: e.message });
    }
});

// ── MULTI-INSTANCE ───────────────────────────────────────
app.get('/api/instances', authMiddleware, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    if (user.instance_name && !instances.find(i => i.name === user.instance_name)) {
        instances.unshift({ name: user.instance_name, label: 'Principal', connected: false });
    }
    res.json({ instances, max_instances: user.max_instances || 1 });
});

app.post('/api/instances', authMiddleware, async (req, res) => {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Label obrigatório' });
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const maxInst = user.max_instances || 1;

    const totalUsed = instances.length + (user.instance_name && !instances.find(i => i.name === user.instance_name) ? 1 : 0);
    if (totalUsed >= maxInst) {
        return res.status(400).json({ error: `Limite de ${maxInst} instância(s) atingido. Contate o administrador.` });
    }

    const instName = `${user.id.slice(-6)}-${Date.now()}`;
    if (EVOLUTION_API_URL) {
        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName: instName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
            }, { headers: evoHeaders() });
        } catch (e) {
            logger.warn('Instance create warn', { instName, msg: e.response?.data?.message || e.message });
        }
    }

    instances.push({ name: instName, label, connected: false });
    user.instances = instances;
    saveUsers(users);
    logger.info('Instance added', { userId: user.id, instName, label });
    res.json({ success: true, instance: { name: instName, label } });
});

app.delete('/api/instances/:name', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const instName = req.params.name;

    if (instName === user.instance_name) {
        return res.status(400).json({ error: 'Não é possível remover a instância principal' });
    }

    const idx = instances.findIndex(i => i.name === instName);
    if (idx === -1) return res.status(404).json({ error: 'Instância não encontrada' });

    if (EVOLUTION_API_URL) {
        try {
            await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${instName}`, { headers: evoHeaders() });
        } catch (e) { logger.warn('Could not delete evo instance', { instName }); }
    }

    instances.splice(idx, 1);
    user.instances = instances;
    saveUsers(users);
    res.json({ success: true });
});

app.get('/api/instances/:name/qrcode', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso a esta instância' });
    if (!EVOLUTION_API_URL) return res.status(500).json({ error: 'Evolution API não configurada' });

    try {
        try {
            const stateRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instName}`, { headers: evoHeaders() });
            const state = stateRes.data?.instance?.state;
            if (state === 'open') {
                return res.json({ alreadyConnected: true, instance: stateRes.data.instance });
            }
        } catch (stateErr) {}

        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
            instanceName: instName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
        }, { headers: evoHeaders() }).catch(() => {});
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${instName}`, { headers: evoHeaders() });
        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

app.get('/api/instances/:name/status', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });
    if (!EVOLUTION_API_URL) return res.json({ instance: { state: 'disconnected' }, instance_name: instName });

    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instName}`, { headers: evoHeaders() });
        res.json({ ...r.data, instance_name: instName });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: instName });
    }
});

app.post('/api/instances/:name/disconnect', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });

    if (EVOLUTION_API_URL) {
        try {
            await axios.delete(`${EVOLUTION_API_URL}/instance/logout/${instName}`, { headers: evoHeaders() });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    res.json({ success: true });
});

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

app.get('/api/instances/:name/groups', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instName = req.params.name;
    const instances = user.instances || [];
    const hasAccess = instName === user.instance_name || instances.find(i => i.name === instName);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso' });
    if (!EVOLUTION_API_URL) return res.json([]);

    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/group/fetchAllGroups/${instName}?getParticipants=false`, { headers: evoHeaders() });
        const groups = Array.isArray(r.data) ? r.data : [];
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
    const requestedInst = req.query.instance;
    let inst = req.user.instance_name;
    if (requestedInst) {
        const users = loadUsers();
        const user = users.find(u => u.id === req.user.id);
        const instances = user.instances || [];
        const hasAccess = requestedInst === user.instance_name || instances.find(i => i.name === requestedInst);
        if (hasAccess) inst = requestedInst;
    }
    if (!inst || !EVOLUTION_API_URL) return res.json([]);
    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/group/fetchAllGroups/${inst}?getParticipants=false`, { headers: evoHeaders() });
        const groups = Array.isArray(r.data) ? r.data : [];
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
    const requestedInst = req.query.instance;
    let inst = req.user.instance_name;
    if (requestedInst) {
        const users = loadUsers();
        const user = users.find(u => u.id === req.user.id);
        const instances = user.instances || [];
        const hasAccess = requestedInst === user.instance_name || instances.find(i => i.name === requestedInst);
        if (hasAccess) inst = requestedInst;
    }
    if (!inst || !EVOLUTION_API_URL) return res.json([]);

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

    try {
        const r = await axios.post(
            `${EVOLUTION_API_URL}/chat/findContacts/${inst}`,
            { where: {} },
            { headers: evoHeaders() }
        );
        const raw = Array.isArray(r.data) ? r.data : (r.data?.contacts || r.data?.data || []);
        const result = mapContacts(raw);
        if (result.length > 0) return res.json(result);
    } catch (e) { logger.warn('findContacts failed', { inst, err: e.message }); }

    try {
        const r2 = await axios.post(
            `${EVOLUTION_API_URL}/chat/findChats/${inst}`,
            { where: {} },
            { headers: evoHeaders() }
        );
        const chats = Array.isArray(r2.data) ? r2.data : (r2.data?.chats || r2.data?.data || []);
        return res.json(mapContacts(chats));
    } catch (e) { logger.error('Both contact endpoints failed', { inst, err: e.message }); }

    res.json([]);
});

// ── SCHEDULES (per-user) ──────────────────────────────────
app.get('/api/schedules', authMiddleware, (req, res) => {
    const db = loadDB();
    const schedules = req.user.role === 'admin'
        ? db.schedules
        : db.schedules.filter(s => s.userId === req.user.id || !s.userId);
    res.json(schedules);
});

app.post('/api/schedules', authMiddleware, (req, res) => {
    const { recipients, message, media_url, media_type, media_texts, extra_medias, media_delay_ms, time, frequency, schedule_date, send_delay, instance_name, timezone } = req.body;
    if (!recipients?.length || (!message && !media_url) || !time)
        return res.status(400).json({ error: 'Campos obrigatórios: destinatários, mensagem ou mídia, horário' });
    if (!validTime(time))
        return res.status(400).json({ error: 'Formato de horário inválido. Use HH:MM (ex: 08:30)' });
    
    const db = loadDB();
    const schedule = {
        id: Date.now(),
        userId: req.user.id,
        userEmail: req.user.email,
        instance_name: instance_name || req.user.instance_name,
        timezone: timezone || TIMEZONE,
        recipients, message: message || '',
        media_url: media_url || '',
        media_type: media_type || '',
        media_texts: media_texts || [],
        extra_medias: extra_medias || [],
        media_delay_ms: media_delay_ms || 0,
        time,
        frequency: frequency || 'daily',
        schedule_date: schedule_date || '',
        send_delay: send_delay || 'random',
        active: true,
        created_at: new Date().toISOString(),
        last_sent: null,
        sent_count: 0
    };
    db.schedules.push(schedule);
    saveDB(db);
    logger.info('Schedule created', { scheduleId: schedule.id, userId: req.user.id, time, frequency, recipients: recipients.length });
    res.json({ id: schedule.id, success: true });
});

app.put('/api/schedules/:id', authMiddleware, (req, res) => {
    const db = loadDB();
    const idx = db.schedules.findIndex(s =>
        s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id)
    );
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    if (req.body.time && !validTime(req.body.time))
        return res.status(400).json({ error: 'Formato de horário inválido. Use HH:MM (ex: 08:30)' });
    
    db.schedules[idx] = { ...db.schedules[idx], ...req.body };
    saveDB(db);
    logger.info('Schedule updated', { scheduleId: req.params.id, userId: req.user.id });
    res.json({ success: true });
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
    const db = loadDB();
    const schedule = db.schedules.find(s =>
        s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id)
    );
    if (!schedule) return res.status(404).json({ error: 'Não encontrado' });

    // Safe delete of associated media file
    if (schedule.media_url) {
        try {
            const fileName = path.basename(schedule.media_url.split('?')[0]);
            const localFile = path.join(UPLOADS_DIR, fileName);
            if (fs.existsSync(localFile)) {
                fs.unlinkSync(localFile);
                logger.info('Deleted orphaned media file', { file: fileName });
            }
        } catch (e) {
            logger.warn('Could not delete media file', { err: e.message });
        }
    }

    db.schedules = db.schedules.filter(s => s.id != req.params.id);
    saveDB(db);
    logger.info('Schedule deleted', { scheduleId: req.params.id, userId: req.user.id });
    res.json({ success: true });
});

app.get('/api/history', authMiddleware, (req, res) => {
    const db = loadDB();
    const history = req.user.role === 'admin'
        ? db.history
        : db.history.filter(h => h.userId === req.user.id);
    res.json(history.slice(-200).reverse());
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
    let number = recipient.id.includes('@')
        ? recipient.id
        : (isGroup ? `${recipient.id}@g.us` : `${recipient.id}@s.whatsapp.net`);

    logger.info('Sending message', { type: isGroup ? 'GROUP' : 'CONTACT', recipient: recipient.name, instance: inst });

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
        if (ext === '.png')  mimetype = 'image/png';
        else if (ext === '.gif')  mimetype = 'image/gif';
        else if (ext === '.webp') mimetype = 'image/webp';
        else if (ext === '.mp4')  mimetype = 'video/mp4';
        const fileName = isVideo ? 'video.mp4' : ('image' + (ext || '.jpg'));
        
        // Se a url for relativa ou do app, formata com APP_URL
        const publicMediaUrl = mediaUrl.startsWith('http') ? mediaUrl : `${APP_URL}${mediaUrl.startsWith('/') ? '' : '/'}${mediaUrl}`;
        await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${inst}`, {
            number, mediatype: isVideo ? 'video' : 'image',
            mimetype, caption, media: publicMediaUrl, fileName
        }, { headers: evoHeaders() });
    }

    try {
        if (allMedias.length > 0) {
            await sendMediaItem(allMedias[0].url, allMedias[0].type, allMedias[0].text || schedule.message);
            const delayMs = schedule.media_delay_ms || 0;
            for (let i = 1; i < allMedias.length; i++) {
                if (delayMs > 0) {
                    logger.info(`Aguardando ${delayMs}ms antes da próxima mídia...`);
                    await new Promise(r => setTimeout(r, delayMs));
                }
                await sendMediaItem(allMedias[i].url, allMedias[i].type, allMedias[i].text || '');
            }
        } else {
            await axios.post(`${EVOLUTION_API_URL}/message/sendText/${inst}`, {
                number, text: schedule.message
            }, { headers: evoHeaders() });
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
            status: 'error', error: 'Falha no envio via WhatsApp'
        });
        await saveDB(db);
        return false;
    }
}

async function sendToAll(schedule) {
    const inst = schedule.instance_name;

    if (inst && EVOLUTION_API_URL) {
        try {
            const statusRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders() });
            const state = statusRes.data?.instance?.state || statusRes.data?.state;
            if (state !== 'open' && state !== 'connected') {
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
            let delay;
            const delayMode = schedule.send_delay || 'random';
            if (delayMode === '30s')     delay = 30000;
            else if (delayMode === '1m') delay = 60000;
            else if (delayMode === '5m') delay = 5 * 60000;
            else if (delayMode === '10m') delay = 10 * 60000;
            else {
                delay = Math.floor(Math.random() * 30000) + 30000;
            }
            logger.info(`Aguardando ${(delay/1000).toFixed(0)}s antes do próximo envio... (modo: ${delayMode})`);
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
        const time = `${hour.padStart(2,'0')}:${get('minute').padStart(2,'0')}`;
        const date = `${get('year')}-${get('month')}-${get('day')}`;
        return { time, date };
    } catch {
        const now = new Date();
        return {
            time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
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
        if (schedule.time !== currentTime) continue;
        if (schedule.last_sent && new Date(schedule.last_sent).toDateString() === now.toDateString()) continue;
        const freq = schedule.frequency || 'daily';
        if (freq === 'once' && schedule.last_sent) continue;
        if (freq === 'monthly' && schedule.last_sent) {
            const ls = new Date(schedule.last_sent);
            const nowInZone = getTimeInZone(tz);
            const [y, m] = nowInZone.date.split('-');
            if (ls.getMonth() + 1 === parseInt(m) && ls.getFullYear() === parseInt(y)) continue;
        }
        if (freq === 'date' && schedule.schedule_date !== today) continue;
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
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Muitos cadastros. Tente novamente em 1 hora.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.post('/auth/register', registerLimiter, async (req, res) => {
    const { name, email, password, captcha } = req.body;

    if (!name || !email || !password)
        return res.status(400).json({ error: 'Preencha todos os campos' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: 'Email inválido' });
    if (password.length < 8)
        return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
    if (name.length < 2 || name.length > 50)
        return res.status(400).json({ error: 'Nome deve ter entre 2 e 50 caracteres' });

    if (!captcha || captcha.trim() === '')
        return res.status(400).json({ error: 'Responda a verificação de segurança' });

    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Este email já está cadastrado' });

    const baseName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12) || 'user';
    let instanceName = `${baseName}-wa`;

    let counter = 2;
    while (users.find(u => u.instance_name === instanceName)) {
        instanceName = `${baseName}-wa-${counter}`;
        counter++;
    }

    if (EVOLUTION_API_URL) {
        try {
            await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
                instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
            }, { headers: evoHeaders() });
            logger.info('Evolution instance created for new registration', { instanceName });
        } catch (e) {
            logger.warn('Evolution instance create skipped on register', { instanceName, msg: e.response?.data?.message || e.message });
        }
    }

    const trialExpiry = calcExpiry('trial');
    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan: 'trial', plan_expires: trialExpiry,
        instance_name: instanceName,
        instances: [{ name: instanceName, label: 'Principal', connected: false }],
        max_instances: 1,
        created_at: new Date().toISOString(), active: true
    };
    users.push(user);
    saveUsers(users);
    logger.info('New user self-registered', { userId: user.id, email, instanceName });

    if (ADMIN_PHONE && ADMIN_INSTANCE && EVOLUTION_API_URL) {
        const trialDate = new Date(trialExpiry).toLocaleDateString('pt-BR');
        const msg = `🆕 *Novo cadastro!*\n👤 Nome: ${name}\n📧 Email: ${email}\n📱 Instância: ${instanceName}\n⏰ Trial até: ${trialDate}`;
        try {
            await axios.post(`${EVOLUTION_API_URL}/message/sendText/${ADMIN_INSTANCE}`, {
                number: ADMIN_PHONE + '@s.whatsapp.net',
                text: msg
            }, { headers: evoHeaders() });
            logger.info('Admin notified of new registration', { email });
        } catch (e) {
            logger.warn('Could not notify admin of new registration', { err: e.message });
        }
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role, plan: user.plan, plan_expires: user.plan_expires, instance_name: instanceName } });
});

// ── REDEFINIR SENHA (admin) ───────────────────────────────
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
