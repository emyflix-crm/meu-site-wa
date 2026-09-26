'use strict';

function dateNumber(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysUntil(date, today) {
    const target = dateNumber(date);
    const start = dateNumber(today);
    if (target === null || start === null) return null;
    return Math.round((target - start) / 86400000);
}

function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || '—');
}

function clientLines(client, days) {
    const plan = client.plan ? `\nPlano: ${client.plan}` : '';
    if (days < 0) return `• *${client.name}*\nVenceu em ${formatDate(client.renewal_date)}\nAtrasado há ${Math.abs(days)} dia${Math.abs(days) === 1 ? '' : 's'}${plan}`;
    if (days === 0) return `• *${client.name}*\nVencimento: ${formatDate(client.renewal_date)}${plan}`;
    return `• *${client.name}*\nVence em ${days} dia${days === 1 ? '' : 's'}\nData: ${formatDate(client.renewal_date)}${plan}`;
}

function buildCrmDailyReport(clients, today) {
    const eligible = (clients || [])
        .filter(client => client && client.name && client.renewal_date && client.status !== 'cancelled')
        .map(client => ({ client, days: daysUntil(client.renewal_date, today) }))
        .filter(item => item.days !== null && item.days <= 5)
        .sort((a, b) => a.days - b.days || String(a.client.name).localeCompare(String(b.client.name), 'pt-BR'));
    const expired = eligible.filter(item => item.days < 0);
    const todayList = eligible.filter(item => item.days === 0);
    const upcoming = eligible.filter(item => item.days > 0);
    const section = (title, items, emptyText) => [
        title,
        items.length ? items.map(item => clientLines(item.client, item.days)).join('\n\n') : emptyText
    ].join('\n\n');

    const text = [
        '📋 *RELATÓRIO DIÁRIO EMYFLIX*',
        `📅 ${formatDate(today)}`,
        section(`🔴 *CLIENTES VENCIDOS: ${expired.length}*`, expired, 'Nenhum cliente vencido.'),
        section(`🟠 *VENCEM HOJE: ${todayList.length}*`, todayList, 'Nenhum vencimento hoje.'),
        section(`🟡 *VENCEM NOS PRÓXIMOS 5 DIAS: ${upcoming.length}*`, upcoming, 'Nenhum vencimento nos próximos 5 dias.'),
        ['📊 *RESUMO*', `Vencidos: ${expired.length}`, `Vencem hoje: ${todayList.length}`,
            `Próximos do vencimento: ${upcoming.length}`, `Total para verificar: ${eligible.length}`].join('\n')
    ].join('\n\n');

    return { text, counts: { expired: expired.length, today: todayList.length, upcoming: upcoming.length, total: eligible.length } };
}

function splitWhatsAppText(text, maxLength = 3500) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let current = '';
    for (const paragraph of text.split('\n\n')) {
        const next = current ? `${current}\n\n${paragraph}` : paragraph;
        if (next.length <= maxLength) current = next;
        else {
            if (current) chunks.push(current);
            current = paragraph;
        }
    }
    if (current) chunks.push(current);
    return chunks.map((chunk, index) => chunks.length > 1 ? `*Parte ${index + 1}/${chunks.length}*\n\n${chunk}` : chunk);
}

function shouldSendDailyReport(log, force = false) {
    if (force) return true;
    return !log || log.status !== 'sent';
}

module.exports = { daysUntil, formatDate, buildCrmDailyReport, splitWhatsAppText, shouldSendDailyReport };
