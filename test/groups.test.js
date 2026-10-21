const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function groupRouteHarness({ cachedCount = 100, chatCount = 44, completeCount = 0 } = {}) {
    const routes = {};
    const oldGroups = Array.from({ length: cachedCount }, (_, index) => ({
        id: `old-${index}@g.us`, name: `Grupo antigo ${index}`, subject: `Grupo antigo ${index}`, hasName: true
    }));
    let db = { groupsCache: { wa1: { groups: oldGroups, updatedAt: '2026-01-01T00:00:00.000Z' } } };
    let saveCount = 0;
    const chats = Array.from({ length: chatCount }, (_, index) => ({
        remoteJid: `${index < cachedCount ? `old-${index}` : `chat-${index}`}@g.us`, subject: `Chat ${index}`
    }));
    const complete = Array.from({ length: completeCount }, (_, index) => ({
        id: `full-${index}@g.us`, subject: `Grupo completo ${index}`
    }));
    const context = {
        app: { get(url, ...handlers) { routes[url] = handlers; } },
        authMiddleware() {}, ADMIN_INSTANCE: 'admin-wa', EVOLUTION_API_URL: 'http://evolution',
        GROUP_DISK_CACHE_TTL_MS: 120000,
        loadDB: () => structuredClone(db),
        saveDB: next => { saveCount++; db = structuredClone(next); },
        loadUsers: () => [], evoHeaders: () => ({}),
        getCache: () => null, setCache() {},
        logger: { info() {}, warn() {} },
        axios: {
            post: async () => ({ data: chats }),
            get: async url => {
                if (url.includes('/group/fetchAllGroups/')) {
                    if (!completeCount) throw new Error('Evolution timeout');
                    return { data: complete };
                }
                return { data: {} };
            }
        }
    };
    vm.runInNewContext(
        server.slice(server.indexOf("app.get('/api/groups'"), server.indexOf("app.get('/api/contacts'")),
        context
    );
    return {
        db: () => db,
        saveCount: () => saveCount,
        async call() {
            let status = 200;
            let data;
            const req = { user: { id: 'admin', role: 'admin' }, query: { instance: 'wa1', refresh: 'true' } };
            const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
            await routes['/api/groups'].at(-1)(req, res);
            return { status, data };
        }
    };
}

test('a partial recent-chat fallback never replaces a larger complete group cache', async () => {
    const harness = groupRouteHarness({ cachedCount: 100, chatCount: 44, completeCount: 0 });
    const response = await harness.call();
    assert.equal(response.status, 200);
    assert.equal(response.data.length, 100);
    assert.equal(harness.db().groupsCache.wa1.groups.length, 100);
    assert.equal(harness.saveCount(), 0);
});

test('a successful complete group fetch replaces the stale cache', async () => {
    const harness = groupRouteHarness({ cachedCount: 44, chatCount: 44, completeCount: 120 });
    const response = await harness.call();
    assert.equal(response.status, 200);
    assert.equal(response.data.length, 120);
    assert.equal(harness.db().groupsCache.wa1.groups.length, 120);
    assert.equal(harness.db().groupsCache.wa1.source, 'fetchAllGroups');
    assert.equal(harness.saveCount(), 1);
});
