'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    daysUntil,
    buildCrmDailyReport,
    splitWhatsAppText,
    shouldSendDailyReport
} = require('../crm-report');

test('calcula dias usando datas civis sem depender do fuso horário', () => {
    assert.equal(daysUntil('2026-09-25', '2026-09-26'), -1);
    assert.equal(daysUntil('2026-09-26', '2026-09-26'), 0);
    assert.equal(daysUntil('2026-10-01', '2026-09-26'), 5);
});

test('relatório inclui nomes, planos e vencimentos até cinco dias', () => {
    const clients = [
        { name: 'Diego', plan: 'Mensal', renewal_date: '2026-09-24', status: 'active' },
        { name: 'Daniel', plan: 'Trimestral', renewal_date: '2026-09-26', status: 'active' },
        { name: 'Jhonatan', plan: 'Anual', renewal_date: '2026-09-27', status: 'active' },
        { name: 'Amanda', plan: 'Mensal', renewal_date: '2026-10-01', status: 'active' },
        { name: 'Muito distante', plan: 'Mensal', renewal_date: '2026-10-02', status: 'active' },
        { name: 'Cancelado', plan: 'Mensal', renewal_date: '2026-09-20', status: 'cancelled' }
    ];

    const report = buildCrmDailyReport(clients, '2026-09-26');
    assert.deepEqual(report.counts, { expired: 1, today: 1, upcoming: 2, total: 4 });
    assert.match(report.text, /Diego/);
    assert.match(report.text, /Daniel/);
    assert.match(report.text, /Jhonatan/);
    assert.match(report.text, /Amanda/);
    assert.match(report.text, /Plano: Trimestral/);
    assert.match(report.text, /26\/09\/2026/);
    assert.doesNotMatch(report.text, /Muito distante/);
    assert.doesNotMatch(report.text, /Cancelado/);
});

test('divide relatório grande em mensagens numeradas', () => {
    const chunks = splitWhatsAppText('Primeiro bloco\n\nSegundo bloco\n\nTerceiro bloco', 20);
    assert.equal(chunks.length, 3);
    assert.match(chunks[0], /Parte 1\/3/);
    assert.match(chunks[2], /Parte 3\/3/);
});

test('não repete relatório já enviado, exceto no envio forçado', () => {
    assert.equal(shouldSendDailyReport(undefined), true);
    assert.equal(shouldSendDailyReport({ status: 'failed' }), true);
    assert.equal(shouldSendDailyReport({ status: 'sent' }), false);
    assert.equal(shouldSendDailyReport({ status: 'sent' }, true), true);
});
