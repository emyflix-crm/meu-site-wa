'use strict';

function recipientCount(schedule) {
    return Array.isArray(schedule?.recipients) ? schedule.recipients.length : 0;
}

function runConsumesQuota(run) {
    return Boolean(run) && !['blocked', 'quota_blocked'].includes(run.status);
}

function executionUsage(runs, userId, date, excludeRunId = null) {
    return (runs || [])
        .filter(run => run.userId === userId && run.date === date && run.id !== excludeRunId && runConsumesQuota(run))
        .reduce((total, run) => total + recipientCount(run.snapshot), 0);
}

function scheduleReservesDate(schedule, date, runs = []) {
    const frequency = schedule?.frequency || 'daily';
    const dateRuns = (runs || []).filter(run => run.schedule_id === schedule.id && run.date === date);
    if (dateRuns.some(run => runConsumesQuota(run))) return true;
    // A connection pre-check blocked the whole execution before the first send.
    // Keep the schedule for tomorrow, but release today's reservation.
    if (dateRuns.some(run => run.status === 'blocked')) return false;
    if (frequency === 'daily') return true;
    if (frequency === 'date') return schedule.schedule_date === date;
    if (frequency === 'once') return !schedule.last_sent;
    if (frequency === 'monthly') {
        if (!schedule.last_sent) return true;
        const sentMonth = String(schedule.last_sent).slice(0, 7);
        return sentMonth !== String(date).slice(0, 7);
    }
    return false;
}

function dailyBonus(adjustments, userId, date) {
    return (adjustments || [])
        .filter(item => item.userId === userId && item.date === date)
        .reduce((total, item) => total + Math.max(0, Number(item.amount) || 0), 0);
}

function quotaSummary({ user, date, schedules = [], runs = [], adjustments = [], baseLimit, excludeScheduleId = null, replacement = null }) {
    const ownSchedules = schedules.filter(schedule => schedule.userId === user.id && schedule.id !== excludeScheduleId);
    if (replacement) ownSchedules.push(replacement);

    const existingIds = new Set(ownSchedules.map(schedule => String(schedule.id)));
    const reservedSchedules = ownSchedules.filter(schedule => scheduleReservesDate(schedule, date, runs));
    const reservedBySchedules = reservedSchedules.reduce((total, schedule) => total + recipientCount(schedule), 0);
    const consumedAfterDeletion = (runs || [])
        .filter(run => run.userId === user.id && run.date === date && runConsumesQuota(run) && !existingIds.has(String(run.schedule_id)))
        .reduce((total, run) => total + recipientCount(run.snapshot), 0);
    const bonus = dailyBonus(adjustments, user.id, date);
    const limit = Math.max(0, Number(baseLimit) || 0) + bonus;
    const committed = reservedBySchedules + consumedAfterDeletion;

    return {
        date,
        base_limit: Math.max(0, Number(baseLimit) || 0),
        bonus,
        limit,
        reserved: reservedBySchedules,
        consumed_after_deletion: consumedAfterDeletion,
        committed,
        available: Math.max(0, limit - committed),
        over_limit: Math.max(0, committed - limit)
    };
}

module.exports = {
    recipientCount,
    runConsumesQuota,
    executionUsage,
    scheduleReservesDate,
    dailyBonus,
    quotaSummary
};
