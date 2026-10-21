const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function createExecutionStore(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    let runs = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    if (!Array.isArray(runs)) throw new Error('Invalid execution store');
    function persist() {
        const temp = filename + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(runs));
        fs.renameSync(temp, filename);
    }
    // Never replay uncertain sends automatically after a restart.
    for (const run of runs) {
        if (['queued', 'sending'].includes(run.status)) {
            run.status = 'interrupted';
            run.finished_at = new Date().toISOString();
        }
    }
    persist();
    return {
        list: () => JSON.parse(JSON.stringify(runs)),
        create(schedule, date) {
            const run = {
                id: randomUUID(), schedule_id: schedule.id, userId: schedule.userId,
                date, status: 'queued', created_at: new Date().toISOString(),
                snapshot: JSON.parse(JSON.stringify(schedule)), results: []
            };
            runs.push(run);
            persist();
            return run.id;
        },
        update(id, patch) {
            const run = runs.find(r => r.id === id);
            if (!run) throw new Error('Execution not found');
            Object.assign(run, patch);
            persist();
        },
        result(id, result) {
            const run = runs.find(r => r.id === id);
            if (!run) throw new Error('Execution not found');
            run.results.push(result);
            persist();
        }
    };
}

function summarize(run) {
    const total = run.snapshot.recipients.length;
    const accepted = run.results.filter(r => r.status === 'accepted').length;
    const processed = run.results.length;
    return {
        id: run.id, schedule_id: run.schedule_id, date: run.date, status: run.status,
        time: run.snapshot.time, timezone: run.snapshot.timezone,
        instance_name: run.snapshot.instance_name, total, accepted, processed,
        progress: total ? Math.floor(processed * 100 / total) : 0,
        created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at
    };
}

function validateEdit(current, body, user, plan, allSchedules) {
    const allowed = ['recipients', 'message', 'media_url', 'media_type', 'media_texts',
        'extra_medias', 'media_delay_ms', 'time', 'frequency', 'schedule_date',
        'instance_name', 'timezone', 'active'];
    const patch = Object.fromEntries(allowed.filter(k => Object.hasOwn(body, k)).map(k => [k, body[k]]));
    const next = { ...current, ...patch, send_delay: 'random' };
    if (!Array.isArray(next.recipients) || !next.recipients.length ||
        next.recipients.some(r => !r || typeof r.id !== 'string' || !['group', 'contact'].includes(r.type)) ||
        new Set(next.recipients.map(r => r.id)).size !== next.recipients.length) throw new Error('Selecione destinatários válidos, sem duplicatas.');
    if (typeof next.message !== 'string' || typeof next.media_url !== 'string' ||
        (!next.message.trim() && !next.media_url)) throw new Error('Informe uma mensagem ou mídia.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.time)) throw new Error('Horário inválido.');
    if (!['daily', 'once', 'monthly', 'date'].includes(next.frequency)) throw new Error('Frequência inválida.');
    if (next.frequency === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(next.schedule_date) ||
        Number.isNaN(Date.parse(next.schedule_date)))) throw new Error('Data inválida.');
    try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }).format(); }
    catch { throw new Error('Fuso horário inválido.'); }
    if (typeof next.active !== 'boolean' || !Array.isArray(next.extra_medias) ||
        !Array.isArray(next.media_texts) || next.media_texts.some(t => typeof t !== 'string') ||
        next.extra_medias.some(m => !m || typeof m.url !== 'string' || !['image', 'video'].includes(m.type)) ||
        !Number.isFinite(next.media_delay_ms) || next.media_delay_ms < 0 || next.media_delay_ms > 3600000)
        throw new Error('Configuração de mídia inválida.');
    if (user.role !== 'admin') {
        const instances = [user.instance_name, ...(user.instances || []).map(i => typeof i === 'string' ? i : i.name)];
        if (!next.instance_name || !instances.includes(next.instance_name)) throw new Error('WhatsApp não pertence à sua conta.');
        const active = allSchedules.filter(s => s.userId === user.id && s.id !== current.id && s.active).length;
        if (next.active && active >= (user.max_schedules || plan.max_schedules)) throw new Error('Limite de agendamentos ativos atingido.');
    }
    return next;
}
function diagnostic(error) {
    const raw = JSON.stringify(error.response?.data || '').toLowerCase();
    let reason = 'A API não confirmou o envio. A causa exata não foi identificada.';
    if (raw.includes('not a participant') || raw.includes('not-participant'))
        reason = 'A API informou que o número não participa do grupo.';
    else if (raw.includes('not an admin') || raw.includes('admin required'))
        reason = 'A API informou que é necessária permissão de administrador.';
    else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
        reason = 'Tempo de resposta excedido. Entrega incerta; não reenviar automaticamente.';
    return { http_status: error.response?.status || null,
        code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : null, reason };
}
module.exports = { createExecutionStore, summarize, validateEdit, diagnostic };
