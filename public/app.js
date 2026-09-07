const API = '';
let groups = [], contacts = [], campaigns = [];
let selectedRecipients = [];
let schedules = [], currentTab = 'groups', dashFilter = 'all';
let userInstances = [], currentQRInstance = null;

// ── Auth & Plan Quota ─────────────────────────────────────
const TOKEN = localStorage.getItem('wa_token');
let CURRENT_USER = JSON.parse(localStorage.getItem('wa_user') || '{}');
if (!TOKEN) window.location.href = '/login.html';

function authHeaders() { return { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }; }
async function authFetch(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
    if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        if (data.expired || res.status === 401) {
            localStorage.removeItem('wa_token');
            window.location.href = '/login.html';
        }
        return res;
    }
    return res;
}

document.addEventListener('DOMContentLoaded', async () => {
    // Sincroniza dados mais recentes do usuário e limites do plano
    try {
        const meRes = await authFetch('/auth/me');
        if (meRes.ok) {
            const meData = await meRes.json();
            CURRENT_USER = { ...CURRENT_USER, ...meData };
            localStorage.setItem('wa_user', JSON.stringify(CURRENT_USER));
        }
    } catch {}

    if (CURRENT_USER.name) {
        const userEl = document.getElementById('user-name');
        if (userEl) userEl.textContent = CURRENT_USER.name;
    }
    if (CURRENT_USER.role === 'admin') {
        const adminNav = document.getElementById('admin-nav');
        if (adminNav) adminNav.style.display = '';
    }

    renderTrialBanner();
    checkStatus();
    updateTZPreview('America/Sao_Paulo');
    loadInstanceSelector();
    loadCampaigns();
    loadSchedules();
    loadHistory();
    updateLivePreview();
    setInterval(checkStatus, 25000);
});

// ── Banner do Plano / Teste / Limites ─────────────────────
function renderTrialBanner() {
    const textEl = document.getElementById('trial-days-text');
    if (!textEl) return;

    const maxG = CURRENT_USER.max_recipients || 50;
    const maxS = CURRENT_USER.max_schedules || 2;
    const maxI = CURRENT_USER.max_instances || 1;
    const planName = CURRENT_USER.plan_name || (CURRENT_USER.plan === 'start' ? 'Plano Start' : CURRENT_USER.plan === 'pro' ? 'Plano Pro' : CURRENT_USER.plan === 'diamond' ? 'Plano Diamante' : 'Plano Básico');

    if (CURRENT_USER.plan === 'unlimited' || CURRENT_USER.role === 'admin') {
        textEl.textContent = '👑 Modo Administrador (Acesso e Limites Ilimitados)';
        const banner = document.getElementById('trial-banner');
        if (banner) banner.style.background = 'rgba(37, 211, 102, 0.08)';
        return;
    }

    if (CURRENT_USER.plan === 'trial') {
        const expiry = new Date(CURRENT_USER.plan_expires);
        const now = new Date();
        const diffDays = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
        if (diffDays <= 0) {
            textEl.textContent = '⚠️ Seu teste de 7 dias expirou! Faça upgrade para continuar.';
            textEl.style.color = '#ef4444';
        } else {
            textEl.textContent = `⚡ Teste Grátis (${diffDays} dias restantes) • Limite: até ${maxG} grupos por envio`;
        }
    } else {
        textEl.textContent = `⭐ ${planName} • Limite: ${maxG} grupos por agendamento • Máx. ${maxS} agendamentos • ${maxI} WhatsApp(s)`;
    }
}

// ── Navigation ───────────────────────────────────────────
function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    const pages = ['dashboard', 'schedule', 'campaigns', 'history', 'connect', 'admin'];
    const idx = pages.indexOf(page);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');

    if (page === 'history') loadHistory();
    if (page === 'dashboard') loadSchedules();
    if (page === 'campaigns') renderCampaignsPage();
    if (page === 'schedule') {
        loadCampaigns();
        updateLivePreview();
    }
    if (page === 'connect') loadInstancesList();
    if (page === 'admin') {
        loadAdminUsers();
        loadAdminHistory();
    }
    closeMobileMenu();
}

function doLogout() {
    localStorage.removeItem('wa_token');
    localStorage.removeItem('wa_user');
    window.location.href = '/login.html';
}

function toggleMobileMenu() {
    document.getElementById('sidebar')?.classList.toggle('open');
    document.getElementById('sidebar-overlay')?.classList.toggle('open');
}
function closeMobileMenu() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('open');
}

// ── Status ───────────────────────────────────────────────
async function checkStatus() {
    try {
        const data = await (await authFetch(`${API}/api/status`)).json();
        const ok = data.instance?.state === 'open';
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        const dashAlert = document.getElementById('dash-connect-alert');
        if (dot) dot.className = `status-dot ${ok ? 'connected' : 'disconnected'}`;
        if (text) text.textContent = ok ? 'Conectado ✓' : 'Desconectado';
        if (dashAlert) dashAlert.style.display = ok ? 'none' : 'flex';
    } catch { }
}

// ── Multi-Instance Selector ──────────────────────────────
async function loadInstanceSelector() {
    try {
        const r = await authFetch(`${API}/api/instances`);
        const data = await r.json();
        userInstances = data.instances || [];
        const sel = document.getElementById('schedule-instance');
        if (!sel) return;
        sel.innerHTML = '';
        if (!userInstances.length) {
            sel.innerHTML = '<option value="">Nenhum WhatsApp conectado</option>';
            return;
        }
        userInstances.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.name;
            opt.textContent = `${inst.label || inst.name} ${inst.connected ? '🟢' : '⚪'}`;
            sel.appendChild(opt);
        });

        if (CURRENT_USER.instance_name) sel.value = CURRENT_USER.instance_name;
        const defaultInst = sel.value;
        if (defaultInst) loadGroupsForInstance(defaultInst);
    } catch { }
}

function onInstanceChange() {
    const instName = document.getElementById('schedule-instance')?.value;
    if (!instName) return;
    selectedRecipients = [];
    updateSelectedTags();
    loadGroupsForInstance(instName);
}

// ── GRUPOS COM CACHE INSTANTÂNEO ──────────────────────────
async function loadGroupsForInstance(instName, forceRefresh = false) {
    const container = document.getElementById('recipient-list');
    const cacheKey = `wa_cache_groups_${instName}`;
    const cachedData = localStorage.getItem(cacheKey);

    if (cachedData && !forceRefresh) {
        try {
            groups = JSON.parse(cachedData);
            const grpEl = document.getElementById('stat-groups');
            if (grpEl) grpEl.textContent = groups.length;
            if (currentTab === 'groups') renderRecipients();
        } catch {}
    } else if (currentTab === 'groups') {
        container.innerHTML = '<div class="loading">Carregando grupos do WhatsApp...</div>';
    }

    try {
        const r = await authFetch(`${API}/api/groups?instance=${encodeURIComponent(instName)}${forceRefresh ? '&refresh=true' : ''}`);
        const raw = await r.json();
        if (Array.isArray(raw)) {
            groups = raw;
            localStorage.setItem(cacheKey, JSON.stringify(groups));
            const grpEl = document.getElementById('stat-groups');
            if (grpEl) grpEl.textContent = groups.length;
            if (currentTab === 'groups') renderRecipients();
        }
    } catch (e) {
        if (!groups.length && currentTab === 'groups') {
            container.innerHTML = `<div class="empty" style="color:#f87171">Erro ao carregar grupos: ${e.message}</div>`;
        }
    }
}

async function forceRefreshDest() {
    const instName = document.getElementById('schedule-instance')?.value || CURRENT_USER.instance_name;
    if (!instName) return;
    showToast('🔄 Atualizando lista de grupos...', 'warning');
    await loadGroupsForInstance(instName, true);
    showToast('✅ Grupos atualizados!', 'success');
}

// ── CAMPANHAS ─────────────────────────────────────────────
async function loadCampaigns() {
    try {
        const r = await authFetch(`${API}/api/campaigns`);
        campaigns = await r.json();
        if (!Array.isArray(campaigns)) campaigns = [];
        const campEl = document.getElementById('stat-campaigns');
        if (campEl) campEl.textContent = campaigns.length;
        if (currentTab === 'campaigns') renderRecipients();
    } catch { campaigns = []; }
}

function openSaveAsCampaignModal() {
    if (!selectedRecipients.length) {
        showToast('Selecione pelo menos um grupo primeiro!', 'error');
        return;
    }
    const modal = document.getElementById('modal-campaign');
    const tagsEl = document.getElementById('campaign-modal-tags');
    tagsEl.innerHTML = selectedRecipients.map(r => `<span class="tag">${escHtml(r.name)}</span>`).join('');
    document.getElementById('campaign-name-input').value = '';
    modal.style.display = 'flex';
}
function closeCampaignModal() { document.getElementById('modal-campaign').style.display = 'none'; }

async function saveCampaignFromModal() {
    const name = document.getElementById('campaign-name-input').value.trim();
    if (!name) { showToast('Dê um nome para a campanha!', 'error'); return; }
    try {
        const r = await authFetch(`${API}/api/campaigns`, {
            method: 'POST', body: JSON.stringify({ name, recipients: selectedRecipients })
        });
        const data = await r.json();
        if (data.success) {
            showToast(`✅ Campanha "${name}" criada com sucesso!`, 'success');
            closeCampaignModal();
            await loadCampaigns();
            renderCampaignsPage();
        } else showToast(data.error || 'Erro', 'error');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

function openCreateCampaignModal() {
    showPage('schedule');
    switchRecipientTab('groups', document.querySelectorAll('.rec-tab')[0]);
    showToast('👉 Marque os grupos e clique em "Salvar como Campanha"!', 'warning');
}

async function deleteCampaign(id) {
    if (!confirm('Excluir esta campanha?')) return;
    try {
        await authFetch(`${API}/api/campaigns/${id}`, { method: 'DELETE' });
        showToast('🗑️ Campanha removida', 'success');
        loadCampaigns();
        renderCampaignsPage();
    } catch {}
}

function renderCampaignsPage() {
    const el = document.getElementById('campaigns-list');
    if (!el) return;
    if (!campaigns.length) {
        el.innerHTML = `<div class="empty">
            Nenhuma campanha criada ainda.<br>
            <p style="font-size:12px;color:var(--text3);margin-top:6px;">Agrupe grupos recorrentes para agendar tudo em 1 clique!</p>
            <button class="btn btn-primary" style="margin-top:14px;" onclick="openCreateCampaignModal()">➕ Criar Campanha</button>
        </div>`;
        return;
    }
    el.innerHTML = campaigns.map(c => {
        const names = (c.recipients || []).map(r => r.name).join(', ');
        return `<div class="campaign-card-item">
            <div class="campaign-card-info">
                <div class="campaign-card-title">📢 ${escHtml(c.name)}</div>
                <div class="campaign-card-count">👥 ${(c.recipients || []).length} grupos</div>
                <div style="font-size:11.5px;color:var(--text3);margin-top:3px;max-width:550px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(names)}</div>
            </div>
            <div style="display:flex;gap:8px;">
                <button class="btn btn-primary" style="font-size:12px;" onclick="useCampaignForSchedule('${c.id}')">⚡ Agendar Nesta Lista</button>
                <button class="btn btn-danger" style="font-size:12px;" onclick="deleteCampaign('${c.id}')">🗑️</button>
            </div>
        </div>`;
    }).join('');
}

function useCampaignForSchedule(campaignId) {
    const c = campaigns.find(item => item.id === campaignId);
    if (!c) return;

    const maxG = CURRENT_USER.max_recipients || 50;
    if (CURRENT_USER.role !== 'admin' && (c.recipients || []).length > maxG) {
        showToast(`⚠️ Esta campanha tem ${(c.recipients || []).length} grupos, mas seu plano permite até ${maxG}. Faça upgrade!`, 'warning');
        return;
    }

    selectedRecipients = [...(c.recipients || [])];
    updateSelectedTags();
    showPage('schedule');
    showToast(`✅ ${selectedRecipients.length} grupos da campanha "${c.name}" selecionados!`, 'success');
}

// ── RECIPIENT SELECTOR TABS ───────────────────────────────
function switchRecipientTab(tab, btn) {
    currentTab = tab;
    document.querySelectorAll('.rec-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.getElementById('recipient-search').value = '';

    const instName = document.getElementById('schedule-instance')?.value || CURRENT_USER.instance_name;
    if (tab === 'groups') {
        if (!groups.length) loadGroupsForInstance(instName);
        else renderRecipients();
    } else if (tab === 'contacts') {
        loadContactsForInstance(instName);
    } else if (tab === 'campaigns') {
        renderRecipients();
    }
}

async function loadContactsForInstance(instName) {
    const container = document.getElementById('recipient-list');
    container.innerHTML = '<div class="loading">Carregando contatos...</div>';
    try {
        const r = await authFetch(`${API}/api/contacts?instance=${encodeURIComponent(instName)}`);
        contacts = await r.json();
        if (!Array.isArray(contacts)) contacts = [];
        renderRecipients();
    } catch {
        container.innerHTML = '<div class="empty">Nenhum contato encontrado.</div>';
    }
}

function filterRecipients() { renderRecipients(); }

function renderRecipients() {
    const q = document.getElementById('recipient-search')?.value?.toLowerCase() || '';
    const container = document.getElementById('recipient-list');
    if (!container) return;

    if (currentTab === 'campaigns') {
        const filteredCamps = campaigns.filter(c => !q || c.name.toLowerCase().includes(q));
        if (!filteredCamps.length) {
            container.innerHTML = `<div class="empty">Nenhuma campanha encontrada.<br>
                <button type="button" class="btn btn-primary" style="margin-top:10px;font-size:12px;" onclick="openCreateCampaignModal()">➕ Criar Campanha</button>
            </div>`;
            return;
        }
        container.innerHTML = filteredCamps.map(c => `
            <div class="campaign-card-item" style="cursor:pointer;" onclick="selectWholeCampaign('${c.id}')">
                <div class="campaign-card-info">
                    <div class="campaign-card-title">📢 ${escHtml(c.name)}</div>
                    <div class="campaign-card-count">👥 ${(c.recipients || []).length} grupos</div>
                </div>
                <button type="button" class="btn btn-primary" style="font-size:11.5px;padding:5px 12px;">✓ Selecionar Todos</button>
            </div>
        `).join('');
        return;
    }

    let list;
    if (currentTab === 'groups') {
        list = groups.filter(g => !q || (g.subject || g.name || '').toLowerCase().includes(q))
            .map(g => ({ id: g.id, name: g.subject || g.name || g.id, type: 'group' }));
    } else {
        list = contacts.filter(c => !q || (c.name || c.phone || '').toLowerCase().includes(q))
            .map(c => ({ id: c.id, name: c.name, phone: c.phone, hasName: c.hasName, type: 'contact' }));
    }

    if (!list.length) {
        container.innerHTML = `<div class="empty">${currentTab === 'groups' ? 'Nenhum grupo encontrado' : 'Nenhum contato encontrado'}</div>`;
        return;
    }

    container.innerHTML = list.map(item => {
        const isSelected = selectedRecipients.some(r => r.id === item.id);
        return `<div class="recipient-item ${isSelected ? 'selected' : ''}" onclick="toggleRecipient('${item.id}', '${(item.name || '').replace(/'/g, "\\'")}', '${item.type}')">
            <span class="recipient-icon">${item.type === 'group' ? '👥' : '👤'}</span>
            <div class="recipient-info">
                <div class="recipient-name" style="${item.hasName === false ? 'color:var(--text3);font-style:italic;' : ''}">${escHtml(item.name)}</div>
                ${item.hasName !== false && item.phone ? `<div class="recipient-sub">${escHtml(item.phone)}</div>` : ''}
            </div>
            ${isSelected ? '<span class="recipient-check">✓</span>' : ''}
        </div>`;
    }).join('');
}

function selectWholeCampaign(campaignId) {
    const c = campaigns.find(item => item.id === campaignId);
    if (!c) return;

    const maxG = CURRENT_USER.max_recipients || 50;
    const totalPotential = (c.recipients || []).length;
    if (CURRENT_USER.role !== 'admin' && totalPotential > maxG) {
        showToast(`⚠️ Seu plano permite no máximo ${maxG} grupos por agendamento. Esta campanha possui ${totalPotential}! Faça upgrade para enviar para mais.`, 'error');
        return;
    }

    (c.recipients || []).forEach(r => {
        if (!selectedRecipients.some(x => x.id === r.id)) {
            selectedRecipients.push(r);
        }
    });
    updateSelectedTags();
    showToast(`✅ ${c.recipients.length} grupos selecionados da campanha!`, 'success');
}

// ── TRAVA DO PLANO NA SELEÇÃO DE DESTINATÁRIOS ───────────
function toggleRecipient(id, name, type) {
    const exists = selectedRecipients.findIndex(r => r.id === id);
    if (exists >= 0) {
        selectedRecipients.splice(exists, 1);
    } else {
        const maxG = CURRENT_USER.max_recipients || 50;
        if (CURRENT_USER.role !== 'admin' && selectedRecipients.length >= maxG) {
            showToast(`⚠️ Limite do seu plano atingido (${maxG} grupos)! Faça upgrade para o próximo plano para enviar para mais!`, 'warning');
            return;
        }
        selectedRecipients.push({ id, name, type });
    }
    renderRecipients();
    updateSelectedTags();
}

function removeRecipient(id) {
    selectedRecipients = selectedRecipients.filter(r => r.id !== id);
    renderRecipients();
    updateSelectedTags();
}

function updateSelectedTags() {
    const maxG = CURRENT_USER.max_recipients || 50;
    const countEl = document.getElementById('selected-count');
    if (countEl) {
        countEl.textContent = `${selectedRecipients.length}/${maxG} grupos`;
    }
    const tagsEl = document.getElementById('selected-tags');
    if (tagsEl) {
        tagsEl.innerHTML = selectedRecipients.map(r =>
            `<span class="tag">${r.type === 'group' ? '👥' : '👤'} ${escHtml(r.name)}<button type="button" onclick="removeRecipient('${r.id}')">✕</button></span>`
        ).join('');
    }
    const saveBtn = document.getElementById('btn-save-as-campaign');
    if (saveBtn) saveBtn.style.display = selectedRecipients.length >= 2 ? 'inline-flex' : 'none';
    updateLivePreview();
}

// ── LIVE WHATSAPP PREVIEW ─────────────────────────────────
function updateLivePreview() {
    const msg = document.getElementById('schedule-message')?.value || '';
    const time = document.getElementById('schedule-time')?.value || '--:--';
    const previewText = document.getElementById('preview-text');
    const previewTime = document.getElementById('preview-time-display');
    const previewTitle = document.getElementById('preview-target-title');
    const previewImg = document.getElementById('preview-img');

    if (previewText) {
        if (!msg.trim()) {
            previewText.innerHTML = '<span style="color:#8696a0;font-style:italic;">Sua mensagem vai aparecer aqui exatamente como no WhatsApp...</span>';
        } else {
            let formatted = escHtml(msg)
                .replace(/\*([^\*]+)\*/g, '<b>$1</b>')
                .replace(/_([^_]+)_/g, '<i>$1</i>');
            previewText.innerHTML = formatted;
        }
    }

    if (previewTime) previewTime.textContent = time;

    if (previewTitle) {
        if (!selectedRecipients.length) previewTitle.textContent = 'Destinatários';
        else if (selectedRecipients.length === 1) previewTitle.textContent = selectedRecipients[0].name;
        else previewTitle.textContent = `${selectedRecipients[0].name} (+${selectedRecipients.length - 1})`;
    }

    if (previewImg) {
        if (mediaItems.length > 0 && mediaItems[0].type === 'image') {
            previewImg.src = mediaItems[0].url;
            previewImg.style.display = 'block';
        } else {
            previewImg.style.display = 'none';
        }
    }

    const sumRec = document.getElementById('summary-recipients');
    const sumTime = document.getElementById('summary-time');
    const sumFreq = document.getElementById('summary-freq');
    const sumDur = document.getElementById('summary-duration');

    const maxG = CURRENT_USER.max_recipients || 50;
    if (sumRec) sumRec.textContent = `${selectedRecipients.length} de ${maxG} permitidos`;
    if (sumTime) sumTime.textContent = time !== '--:--' ? time : 'Não definido';

    const freqVal = document.getElementById('schedule-frequency')?.value || 'daily';
    const freqLabels = { daily: 'Diário', once: 'Somente 1x', monthly: 'Mensal', date: 'Data Fixa' };
    if (sumFreq) sumFreq.textContent = freqLabels[freqVal] || freqVal;

    if (sumDur) {
        const count = selectedRecipients.length;
        const durMin = Math.ceil((count * 45) / 60);
        sumDur.textContent = count <= 1 ? 'Instantâneo (~30s)' : `~${durMin} minuto(s)`;
    }
}

// ── Frequência & Intervalo ────────────────────────────────
function selectFreq(freq, el) {
    el.closest('.frequency-options').querySelectorAll('.freq-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('schedule-frequency').value = freq;
    document.getElementById('date-picker-wrap').style.display = freq === 'date' ? 'block' : 'none';
    updateLivePreview();
}
function selectDelay(delay, el) {
    el.closest('.frequency-options').querySelectorAll('.freq-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('schedule-delay').value = delay;
}

// ── Upload ────────────────────────────────────────────────
let mediaItems = [];
let mediaDelayMode = 'immediate';

function handleFileSelect(e) { uploadFile(e.target.files[0]); }
function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
}

async function uploadFile(file) {
    if (!file) return;
    const area = document.getElementById('upload-area');
    if (area) area.classList.add('uploading');
    showToast('⏳ Fazendo upload do arquivo...', 'success');
    const fd = new FormData();
    fd.append('media', file);
    try {
        const res = await fetch(`${API}/api/upload`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + TOKEN },
            body: fd
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast('Erro: ' + (err.error || res.status), 'error');
            if (area) area.classList.remove('uploading');
            return;
        }
        const data = await res.json();
        if (data.url) {
            mediaItems.push({ url: data.url, type: data.isVideo ? 'video' : 'image', text: '', name: file.name });
            const fileInp = document.getElementById('media-file');
            if (fileInp) fileInp.value = '';
            renderMediaList();
            updateLivePreview();
            showToast('✅ ' + file.name + ' adicionado!', 'success');
        }
    } catch { showToast('Erro no upload', 'error'); }
    if (area) area.classList.remove('uploading');
}

function renderMediaList() {
    const listEl = document.getElementById('media-list');
    const delayWrap = document.getElementById('media-delay-wrap');
    if (!listEl) return;
    if (!mediaItems.length) {
        listEl.style.display = 'none';
        if (delayWrap) delayWrap.style.display = 'none';
        return;
    }
    listEl.style.display = 'block';
    if (delayWrap) delayWrap.style.display = mediaItems.length >= 2 ? 'block' : 'none';

    listEl.innerHTML = mediaItems.map((m, i) => `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="display:flex;align-items:center;gap:8px;overflow:hidden;">
                <span>${m.type === 'video' ? '🎥' : '🖼️'}</span>
                <span style="font-size:12.5px;font-weight:500;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">${escHtml(m.name)}</span>
            </div>
            <button type="button" class="btn btn-danger" style="font-size:11px;padding:3px 8px;" onclick="removeMedia(${i})">✕</button>
        </div>
    `).join('');
}

function removeMedia(i) {
    mediaItems.splice(i, 1);
    renderMediaList();
    updateLivePreview();
}

function selectMediaDelay(mode) {
    mediaDelayMode = mode;
    const btnImm = document.getElementById('delay-btn-immediate');
    const btnCus = document.getElementById('delay-btn-custom');
    const customWrap = document.getElementById('delay-custom-wrap');
    if (!btnImm || !btnCus) return;

    if (mode === 'immediate') {
        btnImm.style.border = '1px solid var(--primary)';
        btnImm.style.background = 'var(--primary-glow)';
        btnImm.style.color = 'var(--primary)';
        btnCus.style.border = '1px solid var(--border)';
        btnCus.style.background = 'var(--bg3)';
        btnCus.style.color = 'var(--text2)';
        if (customWrap) customWrap.style.display = 'none';
    } else {
        btnCus.style.border = '1px solid var(--primary)';
        btnCus.style.background = 'var(--primary-glow)';
        btnCus.style.color = 'var(--primary)';
        btnImm.style.border = '1px solid var(--border)';
        btnImm.style.background = 'var(--bg3)';
        btnImm.style.color = 'var(--text2)';
        if (customWrap) customWrap.style.display = 'flex';
    }
}

// ── Timezone ──────────────────────────────────────────────
function selectTimezone(tz, btn) {
    document.querySelectorAll('.tz-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('schedule-timezone').value = tz;
    document.getElementById('custom-timezone').style.display = 'none';
    updateTZPreview(tz);
}

function toggleCustomTZ(btn) {
    const inp = document.getElementById('custom-timezone');
    const isHidden = inp.style.display === 'none';
    inp.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
        document.querySelectorAll('.tz-btn:not(.tz-custom-btn)').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        inp.focus();
    } else btn.classList.remove('active');
}

function onCustomTZ(inp) {
    const tz = inp.value.trim();
    document.getElementById('schedule-timezone').value = tz;
    updateTZPreview(tz);
}

function updateTZPreview(tz) {
    const el = document.getElementById('tz-preview');
    if (!el) return;
    try {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
        el.textContent = `🕐 Agora em ${tz}: ${timeStr}`;
        el.style.color = 'var(--text3)';
    } catch {
        el.textContent = '⚠️ Fuso inválido';
        el.style.color = '#ef4444';
    }
}

// ── CREATE SCHEDULE (COM VALIDAÇÃO DE COTAS DO PLANO) ─────
async function createSchedule(e) {
    e.preventDefault();
    if (!selectedRecipients.length) { showToast('Selecione pelo menos um grupo ou contato!', 'error'); return; }

    const maxG = CURRENT_USER.max_recipients || 50;
    if (CURRENT_USER.role !== 'admin' && selectedRecipients.length > maxG) {
        showToast(`⚠️ Seu plano permite até ${maxG} grupos por envio (você selecionou ${selectedRecipients.length}). Faça upgrade!`, 'error');
        return;
    }

    const instance_name = document.getElementById('schedule-instance')?.value || CURRENT_USER.instance_name;
    if (!instance_name) { showToast('Selecione um WhatsApp para envio!', 'error'); return; }
    const time = document.getElementById('schedule-time').value;
    const message = document.getElementById('schedule-message').value;
    if (!message && !mediaItems.length) { showToast('Digite uma mensagem ou anexe uma foto/vídeo!', 'error'); return; }

    const media_url = mediaItems.length ? mediaItems[0].url : '';
    const media_type = mediaItems.length ? mediaItems[0].type : '';
    const extra_medias = mediaItems.slice(1).map(m => ({ url: m.url, type: m.type, text: m.text }));
    const media_texts = mediaItems.map(m => m.text);
    const media_delay_ms = mediaDelayMode === 'immediate' ? 0 : 5000;
    const frequency = document.getElementById('schedule-frequency').value;
    const schedule_date = document.getElementById('schedule-date')?.value || '';
    const send_delay = document.getElementById('schedule-delay')?.value || 'random';
    const timezone = document.getElementById('schedule-timezone')?.value || 'America/Sao_Paulo';

    const btn = document.getElementById('submit-btn');
    btn.disabled = true; btn.textContent = 'Criando Agendamento...';
    try {
        const res = await authFetch(`${API}/api/schedules`, {
            method: 'POST',
            body: JSON.stringify({ recipients: selectedRecipients, message, media_url, media_type, media_texts, extra_medias, media_delay_ms, time, frequency, schedule_date, send_delay, instance_name, timezone })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ Agendamento criado para ${selectedRecipients.length} grupo(s)!`, 'success');
            document.getElementById('schedule-time').value = '';
            document.getElementById('schedule-message').value = '';
            mediaItems = [];
            renderMediaList();
            loadSchedules();
            setTimeout(() => showPage('dashboard'), 900);
        } else {
            showToast(data.error || 'Erro ao criar', 'error');
        }
    } catch { showToast('Erro de comunicação', 'error'); }
    btn.disabled = false; btn.textContent = '⚡ Criar Agendamento';
}

// ── Dashboard & Schedules ─────────────────────────────────
function filterDashboard(filter, btn) {
    dashFilter = filter;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderSchedules();
}

async function loadSchedules() {
    try {
        const r = await authFetch(`${API}/api/schedules`);
        schedules = await r.json();
        const activeEl = document.getElementById('stat-active');
        if (activeEl) activeEl.textContent = schedules.filter(s => s.active).length;
        renderSchedules();
    } catch { }
}

function renderSchedules() {
    const list = document.getElementById('schedules-list');
    if (!list) return;
    let filtered = schedules;
    if (dashFilter !== 'all') filtered = schedules.filter(s => s.recipients?.some(r => r.type === dashFilter));
    if (!filtered.length) {
        list.innerHTML = '<div class="empty">Nenhum agendamento ativo no momento.<br><button class="btn btn-primary" style="margin-top:12px;" onclick="showPage(\'schedule\')">+ Criar Primeiro Agendamento</button></div>';
        return;
    }
    const freqLabel = { daily: '🔁 Diário', once: '1️⃣ Somente 1×', monthly: '📅 Mensal', date: '📆 Data fixa' };
    list.innerHTML = filtered.map(s => {
        const names = s.recipients?.map(r => `${r.type === 'group' ? '👥' : '👤'} ${r.name}`).join(', ') || '';
        return `<div class="schedule-item">
            <div class="schedule-time">${s.time}</div>
            <div class="schedule-info">
                <div class="schedule-group">${s.recipients?.length || 1} destinatário(s): <span style="color:var(--text2);font-weight:400">${escHtml(names.substring(0, 70))}${names.length > 70 ? '...' : ''}</span></div>
                <div class="schedule-message">${escHtml((s.message || '').substring(0, 80))}${(s.message || '').length > 80 ? '...' : ''}</div>
                <div class="schedule-meta">
                    ${s.active ? '<span class="badge badge-green">✓ Ativo</span>' : '<span class="badge badge-yellow">⏸ Pausado</span>'}
                    <span class="badge badge-blue">${freqLabel[s.frequency] || '🔁 Diário'}</span>
                    ${s.media_url ? `<span class="badge badge-purple">📎 Mídia</span>` : ''}
                    <span class="badge" style="color:var(--text3)">📱 ${escHtml(s.instance_name || '')}</span>
                </div>
            </div>
            <div class="schedule-actions">
                <button class="btn btn-icon" title="Enviar agora" onclick="sendNow(${s.id})">⚡</button>
                <button class="btn btn-icon" title="${s.active ? 'Pausar' : 'Ativar'}" onclick="toggleSchedule(${s.id},${s.active})">${s.active ? '⏸' : '▶️'}</button>
                <button class="btn btn-icon" title="Deletar" onclick="deleteSchedule(${s.id})">🗑️</button>
            </div>
        </div>`;
    }).join('');
}

async function sendNow(id) {
    showToast('⚡ Disparando mensagem...', 'success');
    try {
        const data = await (await authFetch(`${API}/api/send-now/${id}`, { method: 'POST' })).json();
        showToast(data.message || '✅ Enviando!', 'success');
        setTimeout(() => loadHistory(), 3000);
    } catch { showToast('Erro no envio', 'error'); }
}

async function toggleSchedule(id, active) {
    const s = schedules.find(s => s.id === id); if (!s) return;
    const r = await authFetch(`${API}/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ ...s, active: !active }) });
    const data = await r.json();
    if (data.error) {
        showToast(data.error, 'warning');
        return;
    }
    showToast(active ? '⏸ Agendamento Pausado' : '▶️ Agendamento Ativado', 'success');
    loadSchedules();
}

async function deleteSchedule(id) {
    if (!confirm('Excluir este agendamento?')) return;
    await authFetch(`${API}/api/schedules/${id}`, { method: 'DELETE' });
    showToast('🗑️ Removido', 'success');
    loadSchedules();
}

// ── Histórico ─────────────────────────────────────────────
async function loadHistory() {
    try {
        const r = await authFetch(`${API}/api/history`);
        const history = await r.json();
        const statEl = document.getElementById('stat-sent');
        if (statEl) {
            const today = new Date().toDateString();
            statEl.textContent = history.filter(h => h.status === 'sent' && new Date(h.sent_at).toDateString() === today).length;
        }
        const list = document.getElementById('history-list');
        if (!list) return;
        if (!history.length) {
            list.innerHTML = '<div class="empty">Nenhum envio registrado ainda</div>';
            return;
        }
        list.innerHTML = history.map(h => `
            <div class="history-item">
                <div class="history-status ${h.status}">${h.status === 'sent' ? '✅' : '❌'}</div>
                <div class="history-info">
                    <div class="history-group">${h.recipient_type === 'group' ? '👥' : '👤'} ${escHtml(h.recipient_name || '—')}</div>
                    <div class="history-message">${escHtml((h.message || '').substring(0, 90))}</div>
                </div>
                <div class="history-time">${formatDate(h.sent_at)}</div>
            </div>
        `).join('');
    } catch {}
}

// ── Instâncias & QR Code ──────────────────────────────────
async function loadInstancesList() {
    const el = document.getElementById('instances-list');
    if (!el) return;
    el.innerHTML = '<div class="loading">Carregando...</div>';
    try {
        const r = await authFetch(`${API}/api/instances`);
        const data = await r.json();
        userInstances = data.instances || [];
        const maxInst = data.max_instances || 1;

        const statuses = await Promise.all(userInstances.map(inst =>
            authFetch(`${API}/api/instances/${inst.name}/status`)
                .then(res => res.json())
                .then(d => ({ name: inst.name, connected: d?.instance?.state === 'open' || d?.state === 'open' }))
                .catch(() => ({ name: inst.name, connected: false }))
        ));

        el.innerHTML = `<p style="font-size:12px;color:var(--text3);margin-bottom:14px;">
            📱 ${userInstances.length} de ${maxInst} WhatsApp(s) permitidos pelo seu plano
        </p>` + userInstances.map(inst => {
            const st = statuses.find(s => s.name === inst.name);
            const connected = st?.connected;
            return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--bg3);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:12px;height:12px;border-radius:50%;background:${connected ? '#22c55e' : '#ef4444'};"></div>
                    <div>
                        <div style="font-weight:600;font-size:14px;">${escHtml(inst.label || inst.name)}</div>
                        <div style="font-size:11px;color:var(--text3);">${connected ? '🟢 Conectado' : '🔴 Desconectado'}</div>
                    </div>
                </div>
                <div style="display:flex;gap:8px;">
                    ${!connected ? `<button class="btn btn-primary" style="font-size:12px;" onclick="openQRModal('${inst.name}','${(inst.label||inst.name).replace(/'/g,"\\'")}')">📱 Conectar</button>` : ''}
                    ${connected ? `<button class="btn btn-secondary" style="font-size:12px;" onclick="disconnectInstance('${inst.name}')">🔌 Desconectar</button>` : ''}
                </div>
            </div>`;
        }).join('');
    } catch {}
}

function openQRModal(instName, label) {
    currentQRInstance = instName;
    const modal = document.getElementById('qr-modal');
    if (modal) modal.style.display = 'flex';
    document.getElementById('qr-modal-title').textContent = '📱 ' + (label || instName);
    document.getElementById('qr-modal-inst').textContent = 'Instância: ' + instName;
    document.getElementById('qr-modal-connected').style.display = 'none';
    document.getElementById('qr-modal-area').style.display = 'block';
    loadQRForInstance(instName);
}
function closeQRModal() {
    document.getElementById('qr-modal').style.display = 'none';
    currentQRInstance = null;
    loadInstancesList();
    checkStatus();
}
function refreshQRModal() {
    if (currentQRInstance) loadQRForInstance(currentQRInstance);
}
async function loadQRForInstance(instName) {
    try {
        const data = await (await authFetch(`${API}/api/instances/${instName}/qrcode`)).json();
        if (data.base64 || data.qrcode?.base64) {
            const base64 = data.base64 || data.qrcode?.base64;
            document.getElementById('qr-modal-img').src = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
            document.getElementById('qr-modal-area').style.display = 'block';
            document.getElementById('qr-modal-connected').style.display = 'none';
        } else if (data.alreadyConnected || data.instance?.state === 'open') {
            document.getElementById('qr-modal-area').style.display = 'none';
            document.getElementById('qr-modal-connected').style.display = 'block';
            checkStatus();
        }
    } catch {}
}

async function disconnectInstance(instName) {
    if (!confirm('Desconectar este WhatsApp?')) return;
    await authFetch(`${API}/api/instances/${instName}/disconnect`, { method: 'POST' });
    showToast('🔌 Desconectado', 'success');
    loadInstancesList();
    checkStatus();
}

function showAddInstanceModal() {
    const maxInst = CURRENT_USER.max_instances || 1;
    if (CURRENT_USER.role !== 'admin' && userInstances.length >= maxInst) {
        showToast(`⚠️ Limite de ${maxInst} WhatsApp(s) atingido! Faça upgrade para conectar mais números!`, 'warning');
        return;
    }
    document.getElementById('add-instance-modal').style.display = 'flex';
}
function closeAddInstanceModal() { document.getElementById('add-instance-modal').style.display = 'none'; }
async function addInstance() {
    const label = document.getElementById('new-inst-label')?.value.trim();
    if (!label) return;
    const r = await authFetch(`${API}/api/instances`, { method: 'POST', body: JSON.stringify({ label }) });
    const data = await r.json();
    if (data.success) {
        closeAddInstanceModal();
        loadInstancesList();
        loadInstanceSelector();
        openQRModal(data.instance.name, data.instance.label);
    } else {
        showToast(data.error || 'Erro', 'error');
    }
}

// ── Admin Panel ───────────────────────────────────────────
async function loadAdminUsers() {
    const el = document.getElementById('admin-users-list');
    if (!el) return;
    try {
        const users = await (await authFetch('/admin/users')).json();
        el.innerHTML = users.map(u => `
            <div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:10px;background:var(--bg3);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
                <div>
                    <strong style="font-size:14px;">${escHtml(u.name)}</strong>
                    <div style="font-size:11px;color:var(--text3);">${escHtml(u.email)} • ${u.max_instances} WAs • ${u.max_schedules} Agend. • Máx ${u.max_recipients} grupos</div>
                </div>
                <div style="font-size:12px;background:var(--bg2);padding:4px 10px;border-radius:6px;font-weight:600;">${u.plan_name || u.plan}</div>
            </div>
        `).join('');
    } catch {}
}

async function loadAdminHistory() {
    const el = document.getElementById('admin-history-list');
    if (!el) return;
    try {
        const history = await (await authFetch('/api/history')).json();
        el.innerHTML = history.slice(0, 30).map(h => `
            <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px;display:flex;justify-content:space-between;">
                <span>${h.status === 'sent' ? '✅' : '❌'} ${escHtml(h.recipient_name)}</span>
                <span style="color:var(--text3);">${formatDate(h.sent_at)}</span>
            </div>
        `).join('');
    } catch {}
}

// ── Utilities ─────────────────────────────────────────────
function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = `toast ${type} show`;
    setTimeout(() => { if (t) t.className = 'toast'; }, 3500);
}
function escHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
