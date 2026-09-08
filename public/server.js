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

// ── Planos & Limites Padrão ───────────────────────────────
const PLANS = {
    trial: {
        name: 'Trial 7 Dias',
        days: 7,
        max_instances: 1,
        max_schedules: 1,
        max_recipients: 25,
        price: 0
    },
    start: {
        name: 'Plano Start',
        days: 30,
        max_instances: 1,
        max_schedules: 2,
        max_recipients: 50,
        price: 39.90
    },
    pro: {
        name: 'Plano Pro',
        days: 30,
        max_instances: 2,
        max_schedules: 4,
        max_recipients: 150,
        price: 79.90
    },
    diamond: {
        name: 'Plano Diamante',
        days: 30,
        max_instances: 4,
        max_schedules: 8,
        max_recipients: 400,
        price: 149.90
    },
    unlimited: {
        name: 'Admin Ilimitado',
        days: null,
        max_instances: 999,
        max_schedules: 9999,
        max_recipients: 99999,
        price: null
    }
};

function calcExpiry(planKey) {
    const plan = PLANS[planKey];
    if (!plan || !plan.days) return null;
    const d = new Date(); d.setDate(d.getDate() + plan.days); return d.toISOString();
}

function getUserPlan(user) {
    if (!user) return PLANS.trial;
    if (user.role === 'admin' || user.plan === 'unlimited') return PLANS.unlimited;
    if (PLANS[user.plan]) return PLANS[user.plan];
    if (user.plan === 'semiannual') return PLANS.pro;
    if (user.plan === 'annual') return PLANS.diamond;
    if (user.plan === 'monthly') return PLANS.start;
    return PLANS.trial;
}

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
        if (ALLOWED_MIMETYPES.has(file.mimetype)) cb(null, true);
        else cb(new Error(`Tipo de arquivo não permitido: ${file.mimetype}`));
    }
});

// ── DB helpers with write queue ───────────────────────────
let dbWriteQueue = Promise.resolve();
function queueDBWrite(fn) {
    dbWriteQueue = dbWriteQueue.then(fn).catch(err => logger.error('DB write queue error', { err: err.message }));
    return dbWriteQueue;
}

function loadDB() {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ schedules: [], history: [], campaigns: [], groupsCache: {} }, null, 2));
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!data.campaigns) data.campaigns = [];
        if (!data.groupsCache) data.groupsCache = {};
        return data;
    } catch (e) {
        logger.error('Failed to parse DB file', { err: e.message });
        return { schedules: [], history: [], campaigns: [], groupsCache: {} };
    }
}
function saveDB(data) {
    return queueDBWrite(() => {
        if (data.history && data.history.length > 2000) data.history = data.history.slice(-2000);
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
            instance_name: ADMIN_INSTANCE,
            max_instances: 999, max_schedules: 9999, max_recipients: 99999,
            instances: [{ name: ADMIN_INSTANCE, label: 'Principal (Admin)', connected: false }]
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2));
    }
    try {
        const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        let modified = false;
        users.forEach(u => {
            if (u.role === 'admin') {
                if (!u.instance_name) { u.instance_name = ADMIN_INSTANCE; modified = true; }
                if (!u.plan) { u.plan = 'unlimited'; modified = true; }
                if (!u.max_instances) { u.max_instances = 999; modified = true; }
                if (!u.max_schedules) { u.max_schedules = 9999; modified = true; }
                if (!u.max_recipients) { u.max_recipients = 99999; modified = true; }
                if (!u.instances || !u.instances.length) {
                    u.instances = [{ name: ADMIN_INSTANCE, label: 'Principal (Admin)', connected: false }];
                    modified = true;
                }
            } else {
                const plan = getUserPlan(u);
                if (u.max_instances === undefined) { u.max_instances = plan.max_instances; modified = true; }
                if (u.max_schedules === undefined) { u.max_schedules = plan.max_schedules; modified = true; }
                if (u.max_recipients === undefined) { u.max_recipients = plan.max_recipients; modified = true; }
            }
        });
        if (modified) saveUsers(users);
        return users;
    } catch (e) {
        return [];
    }
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── In-Memory Fast Cache for Groups & Contacts ─────────────
const memoryCache = new Map();
function getCache(key) {
    const item = memoryCache.get(key);
    if (item && item.expiresAt > Date.now()) return item.data;
    return null;
}
function setCache(key, data, ttlMs = 40000) {
    memoryCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Express app ───────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));

if (helmet) app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use(morgan('combined', { stream: { write: msg => logger.http(msg.trim()) } }));

app.get('/app.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' } });
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 200, message: { error: 'Muitas requisições. Aguarde um momento.' } });
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
        if (user.role !== 'admin' && user.plan !== 'unlimited' && user.plan_expires && new Date(user.plan_expires) < new Date()) {
            return res.status(403).json({ error: 'Seu plano expirou. Entre em contato para renovar.', expired: true });
        }
        req.user = user;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Token inválido' });
    }
}
function adminMiddleware(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito' });
    next();
}

const evoHeaders = () => ({ 'apikey': EVOLUTION_API_KEY, 'Content-Type': 'application/json' });
const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validTime(t) { return TIME_REGEX.test(t); }

// ── AUTH ──────────────────────────────────────────────────
app.post('/auth/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const users = loadUsers();
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Email ou senha incorretos' });
    }
    if (!user.active) return res.status(401).json({ error: 'Conta desativada' });
    if (user.role !== 'admin' && user.plan !== 'unlimited' && user.plan_expires && new Date(user.plan_expires) < new Date()) {
        return res.status(403).json({ error: 'Seu plano expirou. Entre em contato com o suporte.', expired: true });
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    const planInfo = getUserPlan(user);
    res.json({
        token,
        user: {
            id: user.id, name: user.name, email: user.email, role: user.role,
            plan: user.plan, plan_name: planInfo.name, plan_expires: user.plan_expires,
            instance_name: user.instance_name || (user.role === 'admin' ? ADMIN_INSTANCE : null),
            instances: user.instances || [],
            max_instances: user.role === 'admin' ? 999 : (user.max_instances || planInfo.max_instances),
            max_schedules: user.role === 'admin' ? 9999 : (user.max_schedules || planInfo.max_schedules),
            max_recipients: user.role === 'admin' ? 99999 : (user.max_recipients || planInfo.max_recipients)
        }
    });
});

app.get('/auth/me', authMiddleware, (req, res) => {
    const { password, ...safe } = req.user;
    const planInfo = getUserPlan(req.user);
    res.json({
        ...safe,
        instance_name: req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null),
        plan_name: planInfo.name,
        max_instances: req.user.role === 'admin' ? 999 : (req.user.max_instances || planInfo.max_instances),
        max_schedules: req.user.role === 'admin' ? 9999 : (req.user.max_schedules || planInfo.max_schedules),
        max_recipients: req.user.role === 'admin' ? 99999 : (req.user.max_recipients || planInfo.max_recipients),
        onboarding_completed: req.user.onboarding_completed || false,
        responsible_use_accepted: req.user.responsible_use_accepted || false
    });
});

// Onboarding status update
app.put('/api/user/onboarding', authMiddleware, async (req, res) => {
    try {
        const { step } = req.body; // 'responsible_use' or 'onboarding_complete'
        const users = loadUsers();
        const user = users.find(u => u.id === req.user.id);
        if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
        
        if (step === 'responsible_use') {
            user.responsible_use_accepted = true;
        } else if (step === 'onboarding_complete') {
            user.onboarding_completed = true;
        }
        
        saveUsers(users);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/plans', (req, res) => res.json(PLANS));

// ── CAMPANHAS ─────────────────────────────────────────────
app.get('/api/campaigns', authMiddleware, (req, res) => {
    const db = loadDB();
    const campaigns = (db.campaigns || []).filter(c => c.userId === req.user.id || req.user.role === 'admin');
    res.json(campaigns);
});

app.post('/api/campaigns', authMiddleware, (req, res) => {
    const { name, recipients } = req.body;
    if (!name || !recipients?.length) return res.status(400).json({ error: 'Nome e destinatários são obrigatórios' });
    const db = loadDB();
    const campaign = { id: Date.now().toString(), userId: req.user.id, name: name.trim(), recipients, created_at: new Date().toISOString() };
    db.campaigns.push(campaign);
    saveDB(db);
    res.json({ success: true, campaign });
});

app.delete('/api/campaigns/:id', authMiddleware, (req, res) => {
    const db = loadDB();
    const idx = (db.campaigns || []).findIndex(c => c.id === req.params.id && (c.userId === req.user.id || req.user.role === 'admin'));
    if (idx === -1) return res.status(404).json({ error: 'Campanha não encontrada' });
    db.campaigns.splice(idx, 1);
    saveDB(db);
    res.json({ success: true });
});

// ── FAST GROUPS & CONTACTS ────────────────────────────────
app.get('/api/groups', authMiddleware, async (req, res) => {
    const requestedInst = req.query.instance;
    const forceRefresh = req.query.refresh === 'true';

    // Determina a instância correta (admin tem livre acesso)
    let inst = req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null);
    if (requestedInst) {
        if (req.user.role === 'admin') {
            inst = requestedInst;
        } else {
            const users = loadUsers();
            const user = users.find(u => u.id === req.user.id);
            const instances = user?.instances || [];
            if (requestedInst === user?.instance_name || instances.find(i => i.name === requestedInst)) {
                inst = requestedInst;
            }
        }
    }

    if (!inst) inst = ADMIN_INSTANCE;
    if (!inst || !EVOLUTION_API_URL) return res.json([]);

    const cacheKey = `groups_${inst}`;
    const db = loadDB();
    if (!db.groupsCache) db.groupsCache = {};
    const diskCached = db.groupsCache[inst];

    // 1. Se não for refresh forçado, retorna INSTANTANEAMENTE (0ms) do cache
    if (!forceRefresh) {
        const memCached = getCache(cacheKey);
        if (memCached) return res.json(memCached);
        if (diskCached && Array.isArray(diskCached.groups) && diskCached.groups.length > 0) {
            setCache(cacheKey, diskCached.groups, 300000); // 5 min
            return res.json(diskCached.groups);
        }
    }

    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/group/fetchAllGroups/${inst}?getParticipants=false`, {
            headers: evoHeaders(), timeout: 15000
        });
        const groups = Array.isArray(r.data) ? r.data : [];
        groups.sort((a, b) => (b.lastMessageTimestamp || b.creation || 0) - (a.lastMessageTimestamp || a.creation || 0));
        setCache(cacheKey, groups, 300000); // 5 min em memória
        db.groupsCache[inst] = { groups, updatedAt: new Date().toISOString() };
        saveDB(db);
        res.json(groups);
    } catch (e) {
        // Se a chamada falhou mas tínhamos cache no disco, retorna ele sem travar o cliente!
        if (diskCached && Array.isArray(diskCached.groups) && diskCached.groups.length > 0) {
            return res.json(diskCached.groups);
        }
        res.status(500).json({ error: 'WhatsApp desconectado ou sincronizando na Evolution API: ' + e.message });
    }
});

app.get('/api/contacts', authMiddleware, async (req, res) => {
    const requestedInst = req.query.instance;
    const forceRefresh = req.query.refresh === 'true';
    let inst = req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null);
    if (requestedInst) {
        if (req.user.role === 'admin') inst = requestedInst;
        else {
            const users = loadUsers();
            const user = users.find(u => u.id === req.user.id);
            const instances = user?.instances || [];
            if (requestedInst === user?.instance_name || instances.find(i => i.name === requestedInst)) inst = requestedInst;
        }
    }
    if (!inst || !EVOLUTION_API_URL) return res.json([]);

    const cacheKey = `contacts_${inst}`;
    if (!forceRefresh) {
        const cached = getCache(cacheKey);
        if (cached) return res.json(cached);
    }

    const mapContacts = (arr) => arr
        .filter(c => (c.remoteJid || c.id || '').includes('@s.whatsapp.net'))
        .map(c => {
            const jid = c.remoteJid || c.id || '';
            const phone = jid.replace('@s.whatsapp.net', '');
            const name = c.pushName || c.name || c.notify || null;
            return { id: jid, name: name || phone, hasName: !!name, phone };
        })
        .sort((a, b) => (a.hasName && !b.hasName ? -1 : !a.hasName && b.hasName ? 1 : (a.name || '').localeCompare(b.name || '')))
        .slice(0, 500);

    try {
        const r = await axios.post(`${EVOLUTION_API_URL}/chat/findContacts/${inst}`, { where: {} }, { headers: evoHeaders(), timeout: 8000 });
        const raw = Array.isArray(r.data) ? r.data : (r.data?.contacts || r.data?.data || []);
        const result = mapContacts(raw);
        if (result.length > 0) return res.json(result);
    } catch (e) {}

    try {
        const r2 = await axios.post(`${EVOLUTION_API_URL}/chat/findChats/${inst}`, { where: {} }, { headers: evoHeaders(), timeout: 8000 });
        const chats = Array.isArray(r2.data) ? r2.data : (r2.data?.chats || r2.data?.data || []);
        return res.json(mapContacts(chats));
    } catch (e) {
        res.json([]);
    }
});

// ── STATUS & QRCODE ───────────────────────────────────────
app.get('/api/status', authMiddleware, async (req, res) => {
    let inst = req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null);
    if (!inst) return res.json({ instance: { state: 'no_instance' }, instance_name: null });
    if (!EVOLUTION_API_URL) return res.json({ instance: { state: 'disconnected' }, instance_name: inst });
    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders(), timeout: 5000 });
        res.json({ ...r.data, instance_name: inst });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: inst });
    }
});

app.get('/api/qrcode', authMiddleware, async (req, res) => {
    let inst = req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null);
    if (!inst) return res.status(400).json({ error: 'Nenhuma instância configurada' });
    if (!EVOLUTION_API_URL) return res.status(500).json({ error: 'EVOLUTION_API_URL não configurado' });

    try {
        const stateRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders(), timeout: 5000 });
        if (stateRes.data?.instance?.state === 'open') {
            return res.json({ alreadyConnected: true, instance: stateRes.data.instance });
        }
    } catch (stateErr) {
        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
            instanceName: inst, qrcode: true, integration: 'WHATSAPP-BAILEYS'
        }, { headers: evoHeaders() }).catch(() => {});
    }

    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${inst}`, { headers: evoHeaders(), timeout: 10000 });
        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

app.post('/api/disconnect', authMiddleware, async (req, res) => {
    let inst = req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null);
    if (!inst || !EVOLUTION_API_URL) return res.json({ success: true });
    try {
        await axios.delete(`${EVOLUTION_API_URL}/instance/logout/${inst}`, { headers: evoHeaders() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── MULTI-INSTANCE (COM LIVRE ACESSO PARA ADMIN) ──────────
app.get('/api/instances', authMiddleware, (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    let instances = user?.instances || [];

    // Se for admin, garante que a instância ADMIN_INSTANCE apareça
    if (user?.role === 'admin' && ADMIN_INSTANCE && !instances.find(i => i.name === ADMIN_INSTANCE)) {
        instances.unshift({ name: ADMIN_INSTANCE, label: 'Principal (Admin)', connected: false });
    } else if (user?.instance_name && !instances.find(i => i.name === user.instance_name)) {
        instances.unshift({ name: user.instance_name, label: 'Principal', connected: false });
    }

    const planInfo = getUserPlan(user);
    const maxInst = user?.role === 'admin' ? 999 : (user?.max_instances || planInfo.max_instances || 1);
    res.json({ instances, max_instances: maxInst });
});

app.post('/api/instances', authMiddleware, async (req, res) => {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Nome do WhatsApp é obrigatório' });
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const planInfo = getUserPlan(user);
    const maxInst = user.role === 'admin' ? 999 : (user.max_instances || planInfo.max_instances || 1);

    const totalUsed = instances.length + (user.instance_name && !instances.find(i => i.name === user.instance_name) ? 1 : 0);
    if (user.role !== 'admin' && totalUsed >= maxInst) {
        return res.status(400).json({
            error: `Seu ${planInfo.name} permite no máximo ${maxInst} WhatsApp(s) conectado(s). Faça upgrade para conectar mais números!`
        });
    }

    const instName = `${user.id.slice(-6)}-${Date.now()}`;
    if (EVOLUTION_API_URL) {
        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
            instanceName: instName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
        }, { headers: evoHeaders() }).catch(() => {});
    }

    instances.push({ name: instName, label, connected: false });
    user.instances = instances;
    saveUsers(users);
    res.json({ success: true, instance: { name: instName, label } });
});

app.delete('/api/instances/:name', authMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.user.id);
    const instances = user.instances || [];
    const instName = req.params.name;

    if (instName === user.instance_name && user.role !== 'admin') {
        return res.status(400).json({ error: 'Não é possível remover o WhatsApp principal' });
    }

    const idx = instances.findIndex(i => i.name === instName);
    if (idx === -1) return res.status(404).json({ error: 'Instância não encontrada' });

    if (EVOLUTION_API_URL) {
        await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${instName}`, { headers: evoHeaders() }).catch(() => {});
    }

    instances.splice(idx, 1);
    user.instances = instances;
    saveUsers(users);
    res.json({ success: true });
});

app.get('/api/instances/:name/qrcode', authMiddleware, async (req, res) => {
    const instName = req.params.name;
    if (!EVOLUTION_API_URL) return res.status(500).json({ error: 'Evolution API não configurada' });
    try {
        const stateRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instName}`, { headers: evoHeaders() });
        if (stateRes.data?.instance?.state === 'open') {
            return res.json({ alreadyConnected: true, instance: stateRes.data.instance });
        }
    } catch {}

    await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
        instanceName: instName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
    }, { headers: evoHeaders() }).catch(() => {});

    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connect/${instName}`, { headers: evoHeaders() });
        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

app.get('/api/instances/:name/status', authMiddleware, async (req, res) => {
    const instName = req.params.name;
    if (!EVOLUTION_API_URL) return res.json({ instance: { state: 'disconnected' }, instance_name: instName });
    try {
        const r = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instName}`, { headers: evoHeaders() });
        res.json({ ...r.data, instance_name: instName });
    } catch {
        res.json({ instance: { state: 'disconnected' }, instance_name: instName });
    }
});

// ── SCHEDULES (LIVRE ACESSO PARA ADMIN) ───────────────────
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
        return res.status(400).json({ error: 'Formato de horário inválido. Use HH:MM' });

    const db = loadDB();
    const planInfo = getUserPlan(req.user);

    // ADMIN TEM ACESSO 100% LIVRE SEM LIMITES
    if (req.user.role !== 'admin') {
        const maxRecipients = req.user.max_recipients || planInfo.max_recipients;
        const maxSchedules = req.user.max_schedules || planInfo.max_schedules;

        if (recipients.length > maxRecipients) {
            return res.status(400).json({
                error: `Seu ${planInfo.name} permite no máximo ${maxRecipients} grupos por agendamento (você selecionou ${recipients.length}). Faça upgrade para enviar a mais grupos!`
            });
        }

        const activeSchedulesCount = db.schedules.filter(s => s.userId === req.user.id && s.active).length;
        if (activeSchedulesCount >= maxSchedules) {
            return res.status(400).json({
                error: `Limite atingido! Seu ${planInfo.name} permite até ${maxSchedules} agendamento(s) ativo(s). Pause ou exclua um agendamento antigo, ou faça upgrade!`
            });
        }
    }

    const schedule = {
        id: Date.now(),
        userId: req.user.id,
        userEmail: req.user.email,
        instance_name: instance_name || req.user.instance_name || (req.user.role === 'admin' ? ADMIN_INSTANCE : null),
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
    res.json({ id: schedule.id, success: true });
});

app.put('/api/schedules/:id', authMiddleware, (req, res) => {
    const db = loadDB();
    const idx = db.schedules.findIndex(s => s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id));
    if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
    if (req.body.time && !validTime(req.body.time)) return res.status(400).json({ error: 'Formato HH:MM inválido' });

    if (req.body.active === true && db.schedules[idx].active === false && req.user.role !== 'admin') {
        const planInfo = getUserPlan(req.user);
        const maxSchedules = req.user.max_schedules || planInfo.max_schedules;
        const activeCount = db.schedules.filter(s => s.userId === req.user.id && s.active).length;
        if (activeCount >= maxSchedules) {
            return res.status(400).json({ error: `Limite de ${maxSchedules} agendamento(s) ativos atingido. Faça upgrade de plano!` });
        }
    }

    db.schedules[idx] = { ...db.schedules[idx], ...req.body };
    saveDB(db);
    res.json({ success: true });
});

app.delete('/api/schedules/:id', authMiddleware, (req, res) => {
    const db = loadDB();
    const schedule = db.schedules.find(s => s.id == req.params.id && (req.user.role === 'admin' || s.userId === req.user.id));
    if (!schedule) return res.status(404).json({ error: 'Não encontrado' });

    if (schedule.media_url) {
        try {
            const fileName = path.basename(schedule.media_url.split('?')[0]);
            const localFile = path.join(UPLOADS_DIR, fileName);
            if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
        } catch (e) {}
    }

    db.schedules = db.schedules.filter(s => s.id != req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/history', authMiddleware, (req, res) => {
    const db = loadDB();
    const history = req.user.role === 'admin' ? db.history : db.history.filter(h => h.userId === req.user.id);
    res.json(history.slice(-200).reverse());
});

app.post('/api/send-now/:id', authMiddleware, async (req, res) => {
    const schedule = loadDB().schedules.find(s => s.id == req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Não encontrado' });
    sendToAll(schedule);
    res.json({ success: true, message: `Disparando para ${schedule.recipients.length} destinatário(s)` });
});

app.post('/api/upload', authMiddleware, upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    const url = `${APP_URL}/uploads/${req.file.filename}`;
    res.json({ url, isVideo: req.file.mimetype.startsWith('video/') });
});

// ── SEND ENGINE ───────────────────────────────────────────
async function sendOne(schedule, recipient) {
    const inst = schedule.instance_name || ADMIN_INSTANCE;
    if (!inst) return false;

    const isGroup = recipient.type === 'group' || recipient.id?.includes('@g.us');
    let number = recipient.id.includes('@') ? recipient.id : (isGroup ? `${recipient.id}@g.us` : `${recipient.id}@s.whatsapp.net`);

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
        const publicMediaUrl = mediaUrl.startsWith('http') ? mediaUrl : `${APP_URL}${mediaUrl.startsWith('/') ? '' : '/'}${mediaUrl}`;

        await axios.post(`${EVOLUTION_API_URL}/message/sendMedia/${inst}`, {
            number, mediatype: isVideo ? 'video' : 'image', mimetype, caption, media: publicMediaUrl, fileName
        }, { headers: evoHeaders() });
    }

    try {
        if (allMedias.length > 0) {
            await sendMediaItem(allMedias[0].url, allMedias[0].type, allMedias[0].text || schedule.message);
            const delayMs = schedule.media_delay_ms || 0;
            for (let i = 1; i < allMedias.length; i++) {
                if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
                await sendMediaItem(allMedias[i].url, allMedias[i].type, allMedias[i].text || '');
            }
        } else {
            await axios.post(`${EVOLUTION_API_URL}/message/sendText/${inst}`, { number, text: schedule.message }, { headers: evoHeaders() });
        }

        const db = loadDB();
        db.history.push({
            id: Date.now(), schedule_id: schedule.id, userId: schedule.userId,
            recipient_name: recipient.name, recipient_type: recipient.type,
            message: schedule.message, sent_at: new Date().toISOString(), status: 'sent'
        });
        await saveDB(db);
        return true;
    } catch (e) {
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
    const inst = schedule.instance_name || ADMIN_INSTANCE;
    if (inst && EVOLUTION_API_URL) {
        try {
            const statusRes = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${inst}`, { headers: evoHeaders() });
            const state = statusRes.data?.instance?.state || statusRes.data?.state;
            if (state !== 'open' && state !== 'connected') {
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
        } catch (e) {}
    }

    for (let i = 0; i < schedule.recipients.length; i++) {
        if (i > 0) {
            let delay;
            const delayMode = schedule.send_delay || 'random';
            if (delayMode === '30s')     delay = 30000;
            else if (delayMode === '1m') delay = 60000;
            else if (delayMode === '5m') delay = 5 * 60000;
            else if (delayMode === '10m') delay = 10 * 60000;
            else delay = Math.floor(Math.random() * 30000) + 30000;
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

// ── CRON ENGINE ───────────────────────────────────────────
function getTimeInZone(tz) {
    try {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(now);
        const get = type => parts.find(p => p.type === type)?.value || '00';
        const hour = get('hour') === '24' ? '00' : get('hour');
        return {
            time: `${hour.padStart(2,'0')}:${get('minute').padStart(2,'0')}`,
            date: `${get('year')}-${get('month')}-${get('day')}`
        };
    } catch {
        const now = new Date();
        return {
            time: `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`,
            date: now.toISOString().split('T')[0]
        };
    }
}

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

    due.forEach(schedule => sendToAll(schedule));
}, { timezone: 'UTC' });

// ── ADMIN COMPLETO: GESTÃO TOTAL DE CLIENTES E LIMITES ────
app.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers().map(({ password, ...u }) => {
        const planInfo = getUserPlan(u);
        return {
            ...u,
            plan_name: planInfo.name,
            max_instances: u.role === 'admin' ? 999 : (u.max_instances || planInfo.max_instances || 1),
            max_schedules: u.role === 'admin' ? 9999 : (u.max_schedules || planInfo.max_schedules || 2),
            max_recipients: u.role === 'admin' ? 99999 : (u.max_recipients || planInfo.max_recipients || 50),
            instances: u.instances || []
        };
    });
    res.json(users);
});

app.post('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    const { name, email, password, plan, instance_name, max_instances, max_schedules, max_recipients } = req.body;
    if (!name || !email || !password || !plan)
        return res.status(400).json({ error: 'Preencha todos os campos obrigatórios' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
    if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });

    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Email já cadastrado' });

    const inst = instance_name || `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-wa`;
    if (EVOLUTION_API_URL) {
        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
            instanceName: inst, qrcode: true, integration: 'WHATSAPP-BAILEYS'
        }, { headers: evoHeaders() }).catch(() => {});
    }

    const planInfo = PLANS[plan];
    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan, plan_expires: calcExpiry(plan),
        instance_name: inst, instances: [{ name: inst, label: 'Principal', connected: false }],
        max_instances: parseInt(max_instances) || planInfo.max_instances,
        max_schedules: parseInt(max_schedules) || planInfo.max_schedules,
        max_recipients: parseInt(max_recipients) || planInfo.max_recipients,
        created_at: new Date().toISOString(), active: true
    };
    users.push(user);
    saveUsers(users);
    const { password: _, ...safe } = user;
    res.json({ success: true, user: safe });
});

app.put('/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { plan, active, name, instance_name, max_instances, max_schedules, max_recipients, plan_expires, password } = req.body;
    if (name) users[idx].name = name;
    if (instance_name) users[idx].instance_name = instance_name;
    if (active !== undefined) users[idx].active = active;

    // Se forneceu nova senha diretamente
    if (password && password.length >= 8) {
        users[idx].password = bcrypt.hashSync(password, 10);
    }

    // Se mudou o plano, aplica os limites padrão do plano
    if (plan !== undefined) {
        if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
        users[idx].plan = plan;
        users[idx].plan_expires = calcExpiry(plan);
        users[idx].max_instances = PLANS[plan].max_instances;
        users[idx].max_schedules = PLANS[plan].max_schedules;
        users[idx].max_recipients = PLANS[plan].max_recipients;
    }

    // Permite que o ADMIN customize limites específicos livremente para qualquer cliente!
    if (max_instances !== undefined) users[idx].max_instances = parseInt(max_instances) || 1;
    if (max_schedules !== undefined) users[idx].max_schedules = parseInt(max_schedules) || 2;
    if (max_recipients !== undefined) users[idx].max_recipients = parseInt(max_recipients) || 50;
    if (plan_expires !== undefined) users[idx].plan_expires = plan_expires;

    saveUsers(users);
    const { password: _, ...safe } = users[idx];
    res.json({ success: true, user: safe });
});

app.delete('/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Não é possível excluir o usuário administrador principal' });

    // Exclui a instância na Evolution API
    if (user?.instance_name && EVOLUTION_API_URL) {
        await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${user.instance_name}`, { headers: evoHeaders() }).catch(() => {});
    }

    // Remove agendamentos e campanhas deste cliente
    const db = loadDB();
    db.schedules = (db.schedules || []).filter(s => s.userId !== req.params.id);
    db.campaigns = (db.campaigns || []).filter(c => c.userId !== req.params.id);
    saveDB(db);

    saveUsers(users.filter(u => u.id !== req.params.id));
    res.json({ success: true });
});

app.post('/admin/users/:id/reset-password', authMiddleware, adminMiddleware, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Senha mínima de 8 caracteres' });
    const users = loadUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    users[idx].password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    res.json({ success: true });
});

app.get('/admin/backup', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const users = loadUsers().map(({ password, ...u }) => u);
    res.setHeader('Content-Disposition', `attachment; filename=wa-backup-${new Date().toISOString().split('T')[0]}.json`);
    res.json({ exported_at: new Date().toISOString(), schedules: db.schedules, history: db.history, campaigns: db.campaigns, users });
});
app.get('/admin/export-csv', authMiddleware, adminMiddleware, (req, res) => {
    const db = loadDB();
    const lines = ['Usuário,Destinatários,Mensagem,Horário,Frequência,Ativo,Enviados'];
    (db.schedules || []).forEach(s => {
        const names = (s.recipients || []).map(r => r.name).join(' | ');
        const msg = (s.message || '').replace(/"/g, '""');
        lines.push(`"${s.userEmail || ''}","${names}","${msg}","${s.time}","${s.frequency}","${s.active}","${s.sent_count || 0}"`);
    });
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
    res.setHeader('Content-Disposition', `attachment; filename=historico-${new Date().toISOString().split('T')[0]}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + lines.join('\n'));
});

// ── AUTO REGISTRO ─────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos' });
    if (password.length < 8) return res.status(400).json({ error: 'Senha mínima de 8 caracteres' });

    const users = loadUsers();
    if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(400).json({ error: 'Email já cadastrado' });
    }

    const baseName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12) || 'user';
    let instanceName = `${baseName}-wa`;
    let counter = 2;
    while (users.find(u => u.instance_name === instanceName)) {
        instanceName = `${baseName}-wa-${counter++}`;
    }

    if (EVOLUTION_API_URL) {
        await axios.post(`${EVOLUTION_API_URL}/instance/create`, {
            instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS'
        }, { headers: evoHeaders() }).catch(() => {});
    }

    const trialExpiry = calcExpiry('trial');
    const trialLimits = PLANS.trial;
    const user = {
        id: Date.now().toString(), name, email,
        password: bcrypt.hashSync(password, 10),
        role: 'user', plan: 'trial', plan_expires: trialExpiry,
        instance_name: instanceName,
        instances: [{ name: instanceName, label: 'Principal', connected: false }],
        max_instances: trialLimits.max_instances,
        max_schedules: trialLimits.max_schedules,
        max_recipients: trialLimits.max_recipients,
        onboarding_completed: false,
        responsible_use_accepted: false,
        created_at: new Date().toISOString(), active: true
    };
    users.push(user);
    saveUsers(users);

    if (ADMIN_PHONE && ADMIN_INSTANCE && EVOLUTION_API_URL) {
        const trialDate = new Date(trialExpiry).toLocaleDateString('pt-BR');
        const msg = `🆕 *Novo cadastro no EmyFlix!*\n👤 Nome: ${name}\n📧 Email: ${email}\n📱 Instância: ${instanceName}\n⏰ Trial até: ${trialDate}`;
        axios.post(`${EVOLUTION_API_URL}/message/sendText/${ADMIN_INSTANCE}`, {
            number: ADMIN_PHONE + '@s.whatsapp.net', text: msg
        }, { headers: evoHeaders() }).catch(() => {});
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
        success: true, token,
        user: {
            id: user.id, name: user.name, email: user.email, role: user.role,
            plan: user.plan, plan_name: trialLimits.name, plan_expires: user.plan_expires,
            instance_name: instanceName,
            max_instances: trialLimits.max_instances,
            max_schedules: trialLimits.max_schedules,
            max_recipients: trialLimits.max_recipients
        }
    });
});

app.listen(PORT, () => logger.info(`WA Scheduler started on port ${PORT}`, { timezone: TIMEZONE }));
