const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createExecutionStore, summarize, validateEdit, diagnostic } = require('../execution-store');
const user = { id: 'u1', role: 'user', instance_name: 'wa1' };
const plan = { max_recipients: 5, max_schedules: 2 };
const original = { id: 1, userId: 'u1', userEmail: 'u@example.com', active: true,
    created_at: '2026-09-01', last_sent: '2026-09-15', sent_count: 5,
    instance_name: 'wa1', recipients: [{ id: 'a', name: 'A', type: 'group' }],
    message: 'old', media_url: '', media_type: '', media_texts: [], extra_medias: [],
    media_delay_ms: 0, frequency: 'daily', schedule_date: '', time: '10:00', timezone: 'Europe/London' };
const edit = body => validateEdit(original, body, user, plan, [original]);
test('edits real fields without changing identity or past execution metadata', () => {
    const next = edit({ time: '13:00', message: 'new', id: 99, userId: 'other', last_sent: null, sent_count: 0 });
    assert.equal(next.time, '13:00'); assert.equal(next.message, 'new');
    for (const key of ['id', 'userId', 'last_sent', 'sent_count']) assert.equal(next[key], original[key]);
});
test('replace media, caption, recipients and later remove all media', () => {
    const next = edit({ media_url: 'https://example.com/a.jpg', media_type: 'image', media_texts: ['caption'],
        extra_medias: [{ url: 'https://example.com/b.mp4', type: 'video', text: 'video' }],
        recipients: [{ id: 'b', name: 'B', type: 'group' }] });
    assert.equal(next.recipients[0].id, 'b');
    assert.equal(next.media_texts[0], 'caption');
    assert.equal(validateEdit(next, { media_url: '', media_texts: [], extra_medias: [] }, user, plan, [next]).extra_medias.length, 0);
});
test('reject invalid schedule fields and foreign WhatsApp', () => {
    for (const body of [{ time: '25:00' }, { timezone: 'bad' }, { recipients: [] }, { instance_name: 'foreign' },
        { active: 'yes' }, { extra_medias: 'bad' }, { message: '', media_url: '' }, { frequency: 'bad' }])
        assert.throws(() => edit(body));
});
test('quota is enforced when editing, excluding the schedule itself', () => {
    assert.equal(edit({ time: '11:00' }).id, 1);
    assert.throws(() => validateEdit(original, {}, user, plan, [original, { id: 2, userId: 'u1', active: true }, { id: 3, userId: 'u1', active: true }]));
});
test('durable runs, snapshot isolation and restart interruption without replay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-executions-test-'));
    const filename = path.join(dir, 'executions.json');
    const store = createExecutionStore(filename);
    const schedule = structuredClone(original);
    const id = store.create(schedule, '2026-09-16');
    schedule.message = 'changed';
    store.update(id, { status: 'sending' });
    store.result(id, { recipient_id: 'a', status: 'accepted' });
    assert.equal(store.list()[0].snapshot.message, 'old');
    const restored = createExecutionStore(filename);
    assert.equal(restored.list()[0].status, 'interrupted');
    assert.equal(summarize(restored.list()[0]).accepted, 1);
    fs.rmSync(dir, { recursive: true });
});
test('processed progress does not falsely count failures as successful', () => {
    const row = summarize({ snapshot: { ...original, recipients: [1, 2] }, results: [{ status: 'accepted' }, { status: 'error' }] });
    assert.equal(row.progress, 100); assert.equal(row.accepted, 1);
    assert.equal(row.results, undefined); assert.equal(row.snapshot, undefined);
});
test('diagnostic excludes credentials and raw response and distinguishes uncertainty', () => {
    const info = diagnostic({ code: 'ETIMEDOUT', response: { status: 504, data: { apikey: 'SECRET' } } });
    assert(!JSON.stringify(info).includes('SECRET'));
    assert(info.reason.includes('incerta'));
    assert(diagnostic({ response: { data: 'not a participant' } }).reason.includes('não participa'));
});

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function routeHarness() {
    const routes = {};
    let db = { schedules: [structuredClone(original)], history: [] };
    const busy = new Set();
    const store = { list: () => [], };
    const context = { app: Object.fromEntries(['get', 'post', 'put', 'delete'].map(method =>
        [method, (url, ...handlers) => { routes[method + ' ' + url] = handlers; }])),
        authMiddleware() {}, adminMiddleware() {}, loadDB: () => structuredClone(db), saveDB: async next => { db = structuredClone(next); },
        queuedScheduleIds: busy, validateEdit, validTime: t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t),
        getUserPlan: () => plan, executions: store, summarize, getTimeInZone: () => ({ date: '2026-09-16' }), TIMEZONE: 'UTC' };
    vm.runInNewContext(server.slice(server.indexOf("app.get('/api/schedules'"), server.indexOf("app.post('/api/upload'")), context);
    return { routes, busy, db: () => db, async call(key, body = {}, who = user) {
        let status = 200, data;
        const res = { status(n) { status = n; return this; }, json(v) { data = v; } };
        await routes[key].at(-1)({ user: who, body, params: { id: '1' }, query: {} }, res);
        return { status, data };
    } };
}
test('PUT persists changes and GET reads them back', async () => {
    const h = routeHarness();
    assert.equal((await h.call('put /api/schedules/:id', { time: '14:25', message: 'saved' })).status, 200);
    const result = await h.call('get /api/schedules');
    assert.equal(result.data[0].time, '14:25'); assert.equal(h.db().schedules[0].message, 'saved');
});
test('pause only changes status and supports legacy recipient records', async () => {
    const h = routeHarness();
    h.db().schedules[0].recipients = [{ id: 'legacy-group' }];
    const result = await h.call('put /api/schedules/:id', { active: false });
    assert.equal(result.status, 200);
    assert.equal(result.data.active, false);
    assert.equal(h.db().schedules[0].active, false);
    assert.deepEqual(h.db().schedules[0].recipients, [{ id: 'legacy-group' }]);
});
test('busy edit/delete rejected by server; foreign owner cannot edit', async () => {
    const h = routeHarness();
    h.busy.add('1');
    assert.equal((await h.call('put /api/schedules/:id', { message: 'bad' })).status, 409);
    assert.equal((await h.call('delete /api/schedules/:id')).status, 409);
    assert.equal(h.db().schedules[0].message, 'old');
    h.busy.clear();
    assert.equal((await h.call('put /api/schedules/:id', {}, { ...user, id: 'other' })).status, 404);
});
test('stale form rejected; raw history admin only; no immediate send route or client function', async () => {
    const h = routeHarness();
    assert.equal((await h.call('put /api/schedules/:id', { expected_updated_at: 'stale' })).status, 409);
    assert.equal((await h.call('get /api/history')).status, 403);
    assert.equal(h.routes['get /api/executions/:id'][1].name, 'adminMiddleware');
    const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    assert(!/sendNow|send-now|Enviar agora/.test(client + server));
});

test('real sending loop persists mixed results and keeps accepted separate from processed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-engine-test-'));
    const executions = createExecutionStore(path.join(dir, 'runs.json'));
    const schedule = { ...structuredClone(original), frequency: 'once', recipients: [
        { id: 'a', name: 'A', type: 'group' }, { id: 'b', name: 'B', type: 'group' }] };
    let db = { schedules: [schedule] };
    let calls = 0;
    const context = { executions, ADMIN_INSTANCE: '', EVOLUTION_API_URL: 'http://fake',
        axios: { get: async () => ({ data: { instance: { state: 'open' } } }) }, evoHeaders: () => ({}),
        loadDB: () => structuredClone(db), saveDB: async next => { db = structuredClone(next); },
        sendOne: async () => ({ status: ++calls === 1 ? 'accepted' : 'error', media: [] }),
        setTimeout: fn => fn() };
    vm.runInNewContext(server.slice(server.indexOf('async function sendToAll('), server.indexOf('// ── CRON ENGINE')), context);
    const id = executions.create(schedule, '2026-09-16');
    await context.sendToAll(schedule, id);
    assert.equal(calls, 2);
    assert.equal(executions.list()[0].status, 'finished');
    assert.equal(summarize(executions.list()[0]).accepted, 1);
    assert.equal(summarize(executions.list()[0]).progress, 100);
    assert.equal(db.schedules[0].active, false);
    fs.rmSync(dir, { recursive: true });
});

test('same WhatsApp jobs serialize, duplicate enqueue is ignored, other WhatsApp can proceed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-queue-test-'));
    const releases = [];
    const started = [];
    const context = { require: () => ({ createExecutionStore, summarize, validateEdit, diagnostic }),
        path, DB_FILE: path.join(dir, 'db.json'), ADMIN_INSTANCE: '',
        getTimeInZone: () => ({ date: '2026-09-16' }), logger: { error() {} },
        sendToAll: s => { started.push(s.id); return new Promise(resolve => releases.push(resolve)); } };
    vm.runInNewContext(server.slice(server.indexOf('const instanceQueues ='), server.indexOf('async function sendToAll(')), context);
    const first = context.enqueueSchedule(original);
    context.enqueueSchedule(original);
    const second = context.enqueueSchedule({ ...original, id: 2 });
    const third = context.enqueueSchedule({ ...original, id: 3, instance_name: 'other' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [1, 3]);
    releases[0](); releases[1]();
    await first; await third;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [1, 3, 2]);
    releases[2](); await second;
    fs.rmSync(dir, { recursive: true });
});

test('editor with mocked DOM loads values and submits PUT with modified payload', async () => {
    const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', style: {}, options: [{ value: 'wa1' }],
            reset() {}, add(o) { this.options.push(o); } });
        return elements.get(id);
    };
    let written;
    const context = { API: '', CURRENT_USER: user, editingSchedule: null, selectedRecipients: [], mediaItems: [],
        mediaDelayMode: 'immediate', currentTab: 'groups', Option: function(text, value) { return { text, value }; },
        document: { getElementById: element, querySelector: element, querySelectorAll: () => [] },
        showPage() {}, showToast() {}, renderMediaList() {}, updateSelectedTags() {}, updateTZPreview() {},
        selectMediaDelay() {}, loadGroupsForInstance: async () => {}, renderRecipients() {}, loadSchedules() {},
        setTimeout() {},
        authFetch: async (url, options) => {
            if (!options) return { ok: true, json: async () => [{ ...original, media_url: 'https://example.com/a.jpg', media_type: 'image', media_texts: ['old caption'] }] };
            written = { url, ...options }; return { json: async () => ({ success: true }) };
        } };
    vm.runInNewContext(client.slice(client.indexOf('async function createSchedule('), client.indexOf('// ── Dashboard & Schedules')), context);
    await context.editSchedule(1);
    assert.equal(element('schedule-time').value, '10:00');
    assert.equal(context.mediaItems[0].text, 'old caption');
    element('schedule-time').value = '16:30';
    element('schedule-message').value = 'updated';
    context.mediaItems = [{ url: 'https://example.com/replaced.jpg', type: 'image', text: 'new caption' }];
    context.selectedRecipients = [{ id: 'b', name: 'B', type: 'group' }];
    await context.createSchedule({ preventDefault() {} });
    assert.equal(written.method, 'PUT'); assert.equal(written.url, '/api/schedules/1');
    const body = JSON.parse(written.body);
    assert.equal(body.time, '16:30'); assert.equal(body.message, 'updated');
    assert.equal(body.recipients[0].id, 'b'); assert.equal(body.media_texts[0], 'new caption');
    assert.equal(body.media_url, 'https://example.com/replaced.jpg');
    assert.equal(context.editingSchedule, null);
});

function crmRouteHarness() {
    const routes = {};
    let db = { crmClients: [], messageTemplates: [] };
    const sent = [];
    const context = {
        app: Object.fromEntries(['get', 'post', 'put', 'delete'].map(method =>
            [method, (url, ...handlers) => { routes[method + ' ' + url] = handlers; }])),
        authMiddleware() {}, adminMiddleware() {},
        loadDB: () => structuredClone(db),
        saveDB: next => { db = structuredClone(next); },
        EVOLUTION_API_URL: 'http://evolution', evoHeaders: () => ({ apikey: 'hidden' }),
        axios: { post: async (url, body) => { sent.push({ url, body }); return { data: { key: { id: 'ok' } } }; } },
        logger: { warn() {} }
    };
    vm.runInNewContext(server.slice(server.indexOf('const CRM_STATUSES'), server.indexOf('// ── FAST GROUPS')), context);
    return {
        routes,
        db: () => db, sent,
        async call(key, body = {}, id = '') {
            let status = 200, data;
            const res = { status(n) { status = n; return this; }, json(v) { data = v; } };
            await routes[key].at(-1)({ user: { id: 'admin', role: 'admin' }, body, params: { id } }, res);
            return { status, data };
        }
    };
}

test('admin CRM creates, edits and removes clients without touching schedules', async () => {
    const h = crmRouteHarness();
    const created = await h.call('post /api/admin/crm/clients', {
        name: 'Hannah', phone: '+44 7404 200049', contact_jid: '447404200049@s.whatsapp.net',
        instance_name: 'teste-nascimento', duration_months: 3, status: 'trial', plan: 'Premium',
        price: '25.50', currency: 'GBP', renewal_date: '2026-09-30', tags: 'Londres, IPTV'
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.client.phone, '447404200049');
    assert.equal(created.data.client.contact_jid, '447404200049@s.whatsapp.net');
    assert.equal(created.data.client.instance_name, 'teste-nascimento');
    assert.equal(created.data.client.duration_months, 3);
    assert.equal(created.data.client.owner_id, 'admin');
    const id = created.data.client.id;
    const updated = await h.call('put /api/admin/crm/clients/:id', { ...created.data.client, status: 'active', price: 30 }, id);
    assert.equal(updated.data.client.status, 'active');
    assert.equal(updated.data.client.price, 30);
    assert.equal((await h.call('get /api/admin/crm/clients')).data.length, 1);
    assert.equal((await h.call('delete /api/admin/crm/clients/:id', {}, id)).status, 200);
    assert.equal(h.db().crmClients.length, 0);
    assert.equal(h.db().schedules, undefined);
});

test('CRM sends one reviewed template through the WhatsApp instance saved on the client', async () => {
    const h = crmRouteHarness();
    const created = await h.call('post /api/admin/crm/clients', {
        name: 'Sergio', phone: '447700123456', contact_jid: '447700123456@s.whatsapp.net',
        instance_name: 'principal-admin', duration_months: 1, status: 'active'
    });
    const id = created.data.client.id;
    const result = await h.call('post /api/admin/crm/clients/:id/send', { message: 'Seu plano vence em 5 dias.' }, id);
    assert.equal(result.status, 200);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].url, /sendText\/principal-admin$/);
    assert.equal(h.sent[0].body.number, '447700123456@s.whatsapp.net');
    assert.equal(h.sent[0].body.text, 'Seu plano vence em 5 dias.');
});

test('admin-only message templates validate content and persist variables', async () => {
    const h = crmRouteHarness();
    assert.equal((await h.call('post /api/admin/crm/templates', { name: '', message: '' })).status, 400);
    const created = await h.call('post /api/admin/crm/templates', {
        name: 'Renovação', category: 'Cobrança', message: 'Olá {nome}, seu plano {plano} vence em {vencimento}.', favorite: true
    });
    assert.equal(created.status, 200);
    assert(created.data.template.message.includes('{nome}'));
    assert.equal(h.routes['get /api/admin/crm/templates'][1].name, 'adminMiddleware');
    assert.equal(h.routes['post /api/admin/crm/clients'][1].name, 'adminMiddleware');
    assert.equal((await h.call('get /api/admin/crm/templates')).data[0].favorite, true);
});

test('CRM appears only for admins and messages integrate with scheduling', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    assert.match(html, /id="crm-nav" style="display:none"/);
    assert.match(client, /page === 'crm'\) && CURRENT_USER\.role !== 'admin'/);
    assert.match(html, /openScheduleTemplatePicker\(\)/);
    assert.match(client, /schedule-message/);
    assert.match(client, /https:\/\/wa\.me\//);
    assert.match(html, /id="crm-instance-select"/);
    assert.match(html, /\{dias_restantes\}/);
    assert.match(html, /openCrmContactPicker\(\)/);
    assert.match(client, /\/api\/admin\/crm\/clients\/\$\{client\.id\}\/send/);
});

test('CRM template expiry variable uses natural singular, plural and expired phrases', () => {
    const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const start = client.indexOf('function crmDaysUntil');
    const end = client.indexOf('function crmDisplayStatus', start);
    const context = {};
    vm.runInNewContext(client.slice(start, end), context);
    const today = new Date('2026-09-20T12:00:00');
    assert.equal(context.crmExpiryPhrase('2026-09-20', today), 'vence hoje');
    assert.equal(context.crmExpiryPhrase('2026-09-21', today), 'vence amanhã');
    assert.equal(context.crmExpiryPhrase('2026-09-25', today), 'vence em 5 dias');
    assert.equal(context.crmExpiryPhrase('2026-09-19', today), 'venceu ontem');
    assert.equal(context.crmExpiryPhrase('2026-09-18', today), 'venceu há 2 dias');
    assert.equal(context.crmExpiryPhrase('', today), 'tem o vencimento a combinar');
});

test('contacts merge Evolution contacts and chats, prefer saved names and remove duplicates', async () => {
    const routes = {};
    let cached;
    const context = {
        app: { get(url, ...handlers) { routes[url] = handlers; } },
        authMiddleware() {}, ADMIN_INSTANCE: 'admin-wa', EVOLUTION_API_URL: 'http://evolution',
        loadUsers: () => [], evoHeaders: () => ({}),
        getCache: () => null, setCache: (_key, value) => { cached = value; },
        logger: { warn() {} },
        axios: { post: async url => {
            if (url.includes('findContacts')) return { data: [
                { remoteJid: '447700100001@s.whatsapp.net', pushName: '', contactName: 'Maria Salva' },
                { remoteJid: '447700100002@s.whatsapp.net', pushName: '—' }
            ] };
            return { data: [
                { remoteJid: '447700100001@s.whatsapp.net', name: 'Maria da conversa' },
                { remoteJid: '447700100002@s.whatsapp.net', pushName: 'João Conversa' }
            ] };
        } }
    };
    vm.runInNewContext(server.slice(server.indexOf("app.get('/api/contacts'"), server.indexOf('// ── STATUS & QRCODE')), context);
    let response;
    await routes['/api/contacts'].at(-1)(
        { query: { instance: 'admin-wa', refresh: 'true' }, user: { id: 'admin', role: 'admin' } },
        { json(value) { response = value; } }
    );
    assert.equal(response.length, 2);
    assert.equal(response.find(c => c.phone === '447700100001').name, 'Maria Salva');
    assert.equal(response.find(c => c.phone === '447700100002').name, 'João Conversa');
    assert.deepEqual(cached, response);
});

test('instance list refreshes the real Evolution connection state', async () => {
    let handler;
    const context = {
        app: { get(url, ...handlers) { if (url === '/api/instances') handler = handlers.at(-1); } },
        authMiddleware() {},
        loadUsers: () => [{ id: 'admin', role: 'admin', instances: [
            { name: 'admin-wa', label: 'Principal (Admin)', connected: false }
        ] }],
        ADMIN_INSTANCE: 'admin-wa', EVOLUTION_API_URL: 'http://evolution',
        getUserPlan: () => ({ max_instances: 1 }), evoHeaders: () => ({}),
        axios: { get: async () => ({ data: { instance: { state: 'open' } } }) }
    };
    vm.runInNewContext(
        server.slice(server.indexOf("app.get('/api/instances'"), server.indexOf("app.post('/api/instances'")),
        context
    );
    let response;
    await handler(
        { user: { id: 'admin', role: 'admin' } },
        { json(value) { response = value; } }
    );
    assert.equal(response.instances[0].connected, true);
});

test('destination refresh follows the selected tab and forces contact reload', () => {
    const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    const refreshBlock = client.slice(client.indexOf('async function forceRefreshDest'), client.indexOf('// ── CAMPANHAS'));
    assert.match(refreshBlock, /currentTab === 'contacts'/);
    assert.match(refreshBlock, /loadContactsForInstance\(instName, true\)/);
    assert.match(client, /refresh=true/);
});

test('group refresh uses the complete Evolution list even when chats return only some groups', async () => {
    const routes = {};
    let db = { groupsCache: {} };
    let cached;
    const context = {
        app: { get(url, ...handlers) { routes[url] = handlers; } },
        authMiddleware() {}, ADMIN_INSTANCE: 'admin-wa', EVOLUTION_API_URL: 'http://evolution',
        GROUP_DISK_CACHE_TTL_MS: 120000,
        loadUsers: () => [], loadDB: () => structuredClone(db), saveDB: next => { db = structuredClone(next); },
        getCache: () => null, setCache: (_key, value) => { cached = value; }, evoHeaders: () => ({}),
        logger: { info() {}, warn() {} },
        axios: {
            post: async () => ({ data: [
                { remoteJid: '111111111111111111@g.us', name: 'Grupo com conversa', unreadCount: 2 }
            ] }),
            get: async url => {
                if (url.includes('fetchAllGroups')) return { data: [
                    { id: '111111111111111111@g.us', subject: 'Nome oficial do grupo' },
                    { id: '222222222222222222@g.us', subject: 'Grupo sem conversa recente' }
                ] };
                return { data: {} };
            }
        }
    };
    vm.runInNewContext(server.slice(server.indexOf("app.get('/api/groups'"), server.indexOf("app.get('/api/contacts'")), context);
    let status = 200, response;
    await routes['/api/groups'].at(-1)(
        { query: { instance: 'admin-wa', refresh: 'true' }, user: { id: 'admin', role: 'admin' } },
        { status(value) { status = value; return this; }, json(value) { response = value; } }
    );
    assert.equal(status, 200);
    assert.equal(response.length, 2);
    assert.equal(response.find(g => g.id.startsWith('111')).name, 'Nome oficial do grupo');
    assert.equal(response.find(g => g.id.startsWith('222')).name, 'Grupo sem conversa recente');
    assert.equal(cached.length, 2);
    assert.equal(db.groupsCache['admin-wa'].groups.length, 2);
});
