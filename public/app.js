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

    const pages = ['dashboard', 'schedule', 'campaigns', 'history', 'connect', 'plans', 'admin'];
    const idx = pages.indexOf(page);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');

    if (page === 'history') loadHistory();
    if (page === 'dashboard') loadSchedules();
    if (page === 'campaigns') initCampaignsPage();
    if (page === 'plans') updateCustomPlan();
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


function updateCustomPlan() {
    const whatsappInput = document.getElementById('custom-whatsapps');
    const groupsInput = document.getElementById('custom-groups');
    if (!whatsappInput || !groupsInput) return;

    const whatsapps = Number(whatsappInput.value);
    const groups = Number(groupsInput.value);
    const schedules = whatsapps * 2;
    const price = 19.90 + (whatsapps * 25) + (Math.ceil(groups / 50) * 5);
    const priceText = price.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const priceEl = document.getElementById('custom-plan-price');
    const summaryEl = document.getElementById('custom-plan-summary');
    const linkEl = document.getElementById('custom-plan-link');

    if (priceEl) priceEl.innerHTML = 'R$ ' + priceText + '<span style="font-size:12px;color:var(--text3);font-weight:400;">/mês</span>';
    if (summaryEl) summaryEl.innerHTML = '✓ ' + whatsapps + ' WhatsApp' + (whatsapps > 1 ? 's' : '') + ' &nbsp; • &nbsp; até ' + groups.toLocaleString('pt-BR') + ' grupos &nbsp; • &nbsp; ' + schedules + ' agendamentos ativos';

    const message = 'Olá! Quero solicitar um plano personalizado do EmyFlix WA com ' + whatsapps + ' WhatsApp' + (whatsapps > 1 ? 's' : '') + ', até ' + groups + ' grupos e ' + schedules + ' agendamentos ativos. Valor mostrado: R$ ' + priceText + ' por mês.';
    if (linkEl) linkEl.href = 'https://wa.me/447404200049?text=' + encodeURIComponent(message);
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
function getActiveInstance() {
    const sel = document.getElementById('schedule-instance');
    if (sel && sel.value) return sel.value;
    if (CURRENT_USER.instance_name) return CURRENT_USER.instance_name;
    if (CURRENT_USER.instances && CURRENT_USER.instances.length > 0) return CURRENT_USER.instances[0].name;
    if (CURRENT_USER.role === 'admin') return 'teste-nascimento';
    return '';
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
            if (CURRENT_USER.role === 'admin') {
                userInstances = [{ name: 'teste-nascimento', label: 'Principal (Admin)', connected: true }];
            } else {
                sel.innerHTML = '<option value="">Nenhum WhatsApp conectado</option>';
                return;
            }
        }
        userInstances.forEach(inst => {
            const opt = document.createElement('option');
            opt.value = inst.name;
            opt.textContent = `${inst.label || inst.name} ${inst.connected ? '🟢' : '⚪'}`;
            sel.appendChild(opt);
        });

        let targetInst = CURRENT_USER.instance_name;
        if (!targetInst && CURRENT_USER.role === 'admin') targetInst = 'teste-nascimento';
        if (!targetInst && userInstances.length > 0) targetInst = userInstances[0].name;

        if (targetInst) {
            sel.value = targetInst;
            if (!sel.value && sel.options.length > 0) sel.selectedIndex = 0;
        }

        const chosenInst = sel.value || getActiveInstance();
        if (chosenInst) loadGroupsForInstance(chosenInst);
    } catch { }
}

function onInstanceChange() {
    const instName = document.getElementById('schedule-instance')?.value || getActiveInstance();
    if (!instName) return;
    selectedRecipients = [];
    updateSelectedTags();
    loadGroupsForInstance(instName);
}

// ── GRUPOS COM CACHE INSTANTÂNEO & SYNC SILENCIOSO ────────
async function loadGroupsForInstance(instName, forceRefresh = false) {
    if (!instName) instName = getActiveInstance();
    if (!instName) return;

    const container = document.getElementById('recipient-list');
    const cacheKey = `wa_cache_groups_${instName}`;
    const cachedData = localStorage.getItem(cacheKey);

    // 1. CARREGAMENTO INSTANTÂNEO (0ms): se já tiver salvo no navegador, exibe na hora!
    if (cachedData) {
        try {
            const parsed = JSON.parse(cachedData);
            if (Array.isArray(parsed) && parsed.length > 0) {
                groups = parsed;
                const grpEl = document.getElementById('stat-groups');
                if (grpEl) grpEl.textContent = groups.length;
                if (currentTab === 'groups') renderRecipients();

                // Se não foi um clique manual no botão "Atualizar", faz sync silencioso em segundo plano
                if (!forceRefresh) {
                    syncGroupsInBackground(instName, cacheKey);
                    return;
                }
            }
        } catch {}
    }

    if (currentTab === 'groups') {
        container.innerHTML = '<div class="loading">🔄 Carregando grupos do WhatsApp...</div>';
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
        } else if (raw.error) {
            if (!groups.length && currentTab === 'groups') {
                container.innerHTML = `<div class="empty" style="color:#f87171">⚠️ ${escHtml(raw.error)}<br><button type="button" class="btn btn-secondary" style="margin-top:10px;font-size:12px;" onclick="forceRefreshDest()">🔄 Tentar novamente</button></div>`;
            }
        }
    } catch (e) {
        if (!groups.length && currentTab === 'groups') {
            container.innerHTML = `<div class="empty" style="color:#f87171">Erro ao carregar grupos: ${e.message}<br><button type="button" class="btn btn-secondary" style="margin-top:10px;font-size:12px;" onclick="forceRefreshDest()">🔄 Tentar novamente</button></div>`;
        }
    }
}

async function syncGroupsInBackground(instName, cacheKey) {
    try {
        const r = await authFetch(`${API}/api/groups?instance=${encodeURIComponent(instName)}`);
        const raw = await r.json();
        if (Array.isArray(raw) && raw.length > 0) {
            groups = raw;
            localStorage.setItem(cacheKey, JSON.stringify(groups));
            const grpEl = document.getElementById('stat-groups');
            if (grpEl) grpEl.textContent = groups.length;
            if (currentTab === 'groups') renderRecipients();
        }
    } catch {}
}

async function forceRefreshDest() {
    const instName = getActiveInstance();
    if (!instName) {
        showToast('Selecione um WhatsApp primeiro!', 'error');
        return;
    }
    showToast('🔄 Buscando grupos na Evolution API...', 'warning');
    await loadGroupsForInstance(instName, true);
    showToast(`✅ ${groups.length} grupos sincronizados!`, 'success');
}

// ── CAMPANHAS ─────────────────────────────────────────────
let campGroups = [];           // grupos carregados para a página de campanhas
let campSelectedGroups = [];   // grupos selecionados na criação de campanha

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

// INICIALIZA a página de campanhas (chamada pelo showPage)
async function initCampaignsPage() {
    campSelectedGroups = [];
    // Popula o seletor de instância da página de campanhas
    const campSel = document.getElementById('camp-instance-select');
    if (campSel) {
        try {
            const r = await authFetch(`${API}/api/instances`);
            const data = await r.json();
            const insts = data.instances || [];
            campSel.innerHTML = '';
            if (!insts.length) {
                if (CURRENT_USER.role === 'admin') {
                    const opt = document.createElement('option');
                    opt.value = 'teste-nascimento';
                    opt.textContent = 'Principal (Admin) 🟢';
                    campSel.appendChild(opt);
                } else {
                    campSel.innerHTML = '<option value="">Nenhum WhatsApp conectado</option>';
                }
            } else {
                insts.forEach(inst => {
                    const opt = document.createElement('option');
                    opt.value = inst.name;
                    opt.textContent = `${inst.label || inst.name} ${inst.connected ? '🟢' : '⚪'}`;
                    campSel.appendChild(opt);
                });
            }
            // Define instância padrão
            let targetInst = CURRENT_USER.instance_name;
            if (!targetInst && CURRENT_USER.role === 'admin') targetInst = 'teste-nascimento';
            if (!targetInst && insts.length > 0) targetInst = insts[0].name;
            if (targetInst) campSel.value = targetInst;
        } catch {
            campSel.innerHTML = '<option value="">Erro ao carregar</option>';
        }
    }
    // Carrega grupos e campanhas
    loadCampGroups();
    await loadCampaigns();
    renderCampaignsPage();
}

// CARREGA GRUPOS para a página de campanhas (com cache)
async function loadCampGroups(forceRefresh = false) {
    const sel = document.getElementById('camp-instance-select');
    let instName = sel ? sel.value : getActiveInstance();
    if (!instName) instName = getActiveInstance();
    if (!instName) return;

    const container = document.getElementById('camp-groups-list');
    const cacheKey = `wa_cache_groups_${instName}`;

    // Cache instantâneo
    if (!forceRefresh) {
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
            try {
                const parsed = JSON.parse(cachedData);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    campGroups = parsed;
                    renderCampGroups();
                    // Sync silencioso em background
                    syncCampGroupsBg(instName, cacheKey);
                    return;
                }
            } catch {}
        }
    }

    if (container) container.innerHTML = '<div class="loading">🔄 Carregando grupos...</div>';

    try {
        const r = await authFetch(`${API}/api/groups?instance=${encodeURIComponent(instName)}${forceRefresh ? '&refresh=true' : ''}`);
        const raw = await r.json();
        if (Array.isArray(raw)) {
            campGroups = raw;
            localStorage.setItem(cacheKey, JSON.stringify(campGroups));
            renderCampGroups();
            if (forceRefresh) showToast(`✅ ${campGroups.length} grupos carregados!`, 'success');
        } else {
            if (container) container.innerHTML = `<div class="empty" style="color:#f87171;">⚠️ ${escHtml(raw.error || 'Erro ao carregar')}<br><button type="button" class="btn btn-secondary" style="margin-top:10px;font-size:12px;" onclick="loadCampGroups(true)">🔄 Tentar novamente</button></div>`;
        }
    } catch (e) {
        if (container) container.innerHTML = `<div class="empty" style="color:#f87171;">Erro: ${e.message}<br><button type="button" class="btn btn-secondary" style="margin-top:10px;font-size:12px;" onclick="loadCampGroups(true)">🔄 Tentar novamente</button></div>`;
    }
}

async function syncCampGroupsBg(instName, cacheKey) {
    try {
        const r = await authFetch(`${API}/api/groups?instance=${encodeURIComponent(instName)}`);
        const raw = await r.json();
        if (Array.isArray(raw) && raw.length > 0) {
            campGroups = raw;
            localStorage.setItem(cacheKey, JSON.stringify(campGroups));
            renderCampGroups();
        }
    } catch {}
}

// RENDERIZA a lista de grupos com checkboxes
function renderCampGroups() {
    const container = document.getElementById('camp-groups-list');
    if (!container) return;

    const searchVal = (document.getElementById('camp-group-search')?.value || '').toLowerCase();
    const filtered = campGroups.filter(g => g.name.toLowerCase().includes(searchVal));

    if (!filtered.length) {
        container.innerHTML = searchVal
            ? `<div class="empty" style="font-size:13px;">Nenhum grupo encontrado para "${escHtml(searchVal)}"</div>`
            : `<div class="empty" style="font-size:13px;">Nenhum grupo disponível. Conecte seu WhatsApp primeiro!</div>`;
        return;
    }

    container.innerHTML = `
        <div style="padding:6px 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);margin-bottom:4px;">
            <span style="font-size:12px;color:var(--text3);">${filtered.length} grupo${filtered.length !== 1 ? 's' : ''} encontrado${filtered.length !== 1 ? 's' : ''}</span>
            <button type="button" onclick="campSelectAll()" style="background:none;border:none;color:var(--primary);cursor:pointer;font-size:12px;font-weight:600;">
                ${campSelectedGroups.length === filtered.length ? '✖ Desmarcar Todos' : '☑ Selecionar Todos'}
            </button>
        </div>
    ` + filtered.map(g => {
        const isSelected = campSelectedGroups.some(sg => sg.id === g.id);
        return `<div class="camp-group-item ${isSelected ? 'selected' : ''}" onclick="toggleCampGroup('${g.id}')">
            <div class="camp-check">${isSelected ? '✓' : ''}</div>
            <div style="flex:1;overflow:hidden;">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(g.name)}</div>
            </div>
        </div>`;
    }).join('');

    updateCampSelectedUI();
}

// TOGGLE seleção de grupo
function toggleCampGroup(groupId) {
    const group = campGroups.find(g => g.id === groupId);
    if (!group) return;

    const idx = campSelectedGroups.findIndex(sg => sg.id === groupId);
    if (idx >= 0) {
        campSelectedGroups.splice(idx, 1);
    } else {
        // Checar limite do plano
        const maxG = CURRENT_USER.max_recipients || 25;
        if (CURRENT_USER.role !== 'admin' && campSelectedGroups.length >= maxG) {
            showToast(`⚠️ Seu plano permite no máximo ${maxG} grupos por campanha. Faça upgrade!`, 'warning');
            return;
        }
        campSelectedGroups.push({ id: group.id, name: group.name });
    }
    renderCampGroups();
}

// SELECIONAR/DESMARCAR TODOS
function campSelectAll() {
    const searchVal = (document.getElementById('camp-group-search')?.value || '').toLowerCase();
    const filtered = campGroups.filter(g => g.name.toLowerCase().includes(searchVal));

    if (campSelectedGroups.length === filtered.length) {
        campSelectedGroups = [];
    } else {
        const maxG = CURRENT_USER.max_recipients || 25;
        if (CURRENT_USER.role !== 'admin' && filtered.length > maxG) {
            campSelectedGroups = filtered.slice(0, maxG).map(g => ({ id: g.id, name: g.name }));
            showToast(`⚠️ Seu plano permite máx. ${maxG} grupos. Foram selecionados os primeiros ${maxG}.`, 'warning');
        } else {
            campSelectedGroups = filtered.map(g => ({ id: g.id, name: g.name }));
        }
    }
    renderCampGroups();
}

// REMOVER grupo selecionado via tag
function removeCampGroup(groupId) {
    campSelectedGroups = campSelectedGroups.filter(sg => sg.id !== groupId);
    renderCampGroups();
}

// ATUALIZA UI de selecionados (counter + tags)
function updateCampSelectedUI() {
    const countEl = document.getElementById('camp-selected-count');
    const tagsEl = document.getElementById('camp-selected-tags');
    if (countEl) countEl.textContent = campSelectedGroups.length;
    if (tagsEl) {
        if (!campSelectedGroups.length) {
            tagsEl.innerHTML = '<span style="color:var(--text3);font-size:12px;font-style:italic;">Nenhum grupo selecionado</span>';
        } else {
            tagsEl.innerHTML = campSelectedGroups.map(g =>
                `<span class="camp-selected-tag">${escHtml(g.name)} <span class="tag-remove" onclick="event.stopPropagation();removeCampGroup('${g.id}')">✕</span></span>`
            ).join('');
        }
    }
}

// SALVAR campanha direto pela página de campanhas
async function saveCampDirect() {
    const name = document.getElementById('camp-create-name')?.value.trim();
    if (!name) { showToast('📝 Dê um nome para a campanha!', 'error'); return; }
    if (!campSelectedGroups.length) { showToast('👥 Selecione pelo menos um grupo!', 'error'); return; }

    const btn = document.getElementById('btn-save-camp-direct');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando...'; }

    try {
        const r = await authFetch(`${API}/api/campaigns`, {
            method: 'POST', body: JSON.stringify({ name, recipients: campSelectedGroups })
        });
        const data = await r.json();
        if (data.success) {
            showToast(`✅ Campanha "${name}" criada com ${campSelectedGroups.length} grupos!`, 'success');
            campSelectedGroups = [];
            document.getElementById('camp-create-name').value = '';
            await loadCampaigns();
            renderCampaignsPage();
            renderCampGroups();
        } else showToast(data.error || 'Erro ao salvar', 'error');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }

    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar Campanha'; }
}

// MODAL de salvar como campanha (da página de agendamento — mantém compatibilidade)
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
        } else showToast(data.error || 'Erro', 'error');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

function openCreateCampaignModal() {
    showPage('campaigns'); // Agora redireciona para a própria página de campanhas!
}

async function deleteCampaign(id) {
    if (!confirm('Excluir esta campanha?')) return;
    try {
        await authFetch(`${API}/api/campaigns/${id}`, { method: 'DELETE' });
        showToast('🗑️ Campanha removida', 'success');
        await loadCampaigns();
        renderCampaignsPage();
    } catch {}
}

function renderCampaignsPage() {
    const el = document.getElementById('campaigns-list');
    const countEl = document.getElementById('camp-saved-count');
    if (!el) return;
    if (countEl) countEl.textContent = `${campaigns.length} campanha${campaigns.length !== 1 ? 's' : ''}`;

    if (!campaigns.length) {
        el.innerHTML = `<div class="empty" style="padding:24px;">
            <span style="font-size:36px;">📭</span><br>
            Nenhuma campanha criada ainda.<br>
            <p style="font-size:12px;color:var(--text3);margin-top:6px;">Crie sua primeira campanha usando o formulário acima! ☝️</p>
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
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
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
    const isAdmin = CURRENT_USER.role === 'admin' || CURRENT_USER.plan === 'unlimited';
    const maxG = isAdmin ? 99999 : (CURRENT_USER.max_recipients || 50);
    const countEl = document.getElementById('selected-count');
    if (countEl) {
        countEl.textContent = isAdmin 
            ? `👑 ${selectedRecipients.length} selecionados (Acesso Livre)` 
            : `${selectedRecipients.length}/${maxG} grupos`;
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
    const previewTitle = document.getElementById('preview-target-title');
    const phoneScreen = document.getElementById('phone-screen');

    if (previewTitle) {
        if (!selectedRecipients.length) previewTitle.textContent = 'Destinatários';
        else if (selectedRecipients.length === 1) previewTitle.textContent = selectedRecipients[0].name;
        else previewTitle.textContent = `${selectedRecipients[0].name} (+${selectedRecipients.length - 1})`;
    }

    // Gera preview completo dentro do phone-screen
    if (phoneScreen) {
        let bubblesHtml = '';

        // Se tem mídias, mostra cada mídia como um bubble separado com sua legenda
        if (mediaItems.length > 0) {
            mediaItems.forEach((m, i) => {
                const caption = m.text || '';
                let formattedCaption = '';
                if (caption.trim()) {
                    formattedCaption = escHtml(caption)
                        .replace(/\*([^\*]+)\*/g, '<b>$1</b>')
                        .replace(/_([^_]+)_/g, '<i>$1</i>');
                }
                bubblesHtml += `<div class="phone-bubble" style="margin-bottom:8px;">`;
                if (m.type === 'image') {
                    bubblesHtml += `<img src="${escHtml(m.url)}" class="phone-bubble-img" style="display:block;width:100%;border-radius:8px 8px ${formattedCaption ? '0 0' : '8px 8px'};margin-bottom:${formattedCaption ? '6px' : '0'};" alt="Foto ${i+1}">`;
                } else {
                    bubblesHtml += `<div style="background:rgba(0,0,0,0.3);border-radius:8px;padding:20px;text-align:center;margin-bottom:${formattedCaption ? '6px' : '0'};"><span style="font-size:32px;">🎥</span><div style="font-size:11px;color:#ccc;margin-top:4px;">${escHtml(m.name)}</div></div>`;
                }
                if (formattedCaption) {
                    bubblesHtml += `<div style="white-space:pre-wrap;padding:0 4px;font-size:13px;">${formattedCaption}</div>`;
                }
                bubblesHtml += `<div class="phone-bubble-meta"><span>${time}</span><span class="check-blue">✓✓</span></div></div>`;
            });
        }

        // Bubble da mensagem principal (se houver texto)
        if (msg.trim() || !mediaItems.length) {
            let formattedMsg = '';
            if (!msg.trim()) {
                formattedMsg = '<span style="color:#8696a0;font-style:italic;">Sua mensagem vai aparecer aqui exatamente como no WhatsApp...</span>';
            } else {
                formattedMsg = escHtml(msg)
                    .replace(/\*([^\*]+)\*/g, '<b>$1</b>')
                    .replace(/_([^_]+)_/g, '<i>$1</i>');
            }
            bubblesHtml += `<div class="phone-bubble">
                <div style="white-space:pre-wrap;">${formattedMsg}</div>
                <div class="phone-bubble-meta"><span>${time}</span><span class="check-blue">✓✓</span></div>
            </div>`;
        }

        phoneScreen.innerHTML = bubblesHtml;
    }

    const sumRec = document.getElementById('summary-recipients');
    const sumTime = document.getElementById('summary-time');
    const sumFreq = document.getElementById('summary-freq');
    const sumDur = document.getElementById('summary-duration');
    const sumEnd = document.getElementById('summary-end-time');

    const isAdmin = CURRENT_USER.role === 'admin' || CURRENT_USER.plan === 'unlimited';
    const maxG = isAdmin ? 99999 : (CURRENT_USER.max_recipients || 50);
    if (sumRec) sumRec.textContent = isAdmin
        ? `${selectedRecipients.length} selecionados (Livre Acesso)`
        : `${selectedRecipients.length} de ${maxG} permitidos`;
    if (sumTime) sumTime.textContent = time !== '--:--' ? time : 'Não definido';

    const freqVal = document.getElementById('schedule-frequency')?.value || 'daily';
    const freqLabels = { daily: 'Diário', once: 'Somente 1x', monthly: 'Mensal', date: 'Data Fixa' };
    if (sumFreq) sumFreq.textContent = freqLabels[freqVal] || freqVal;

    const count = selectedRecipients.length;
    const intervals = Math.max(0, count - 1);
    const minSeconds = intervals * 30;
    const avgSeconds = intervals * 45;
    const maxSeconds = intervals * 60;
    const formatDuration = seconds => {
        if (seconds < 60) return seconds + 's';
        const totalMinutes = Math.ceil(seconds / 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return hours ? hours + 'h' + String(minutes).padStart(2, '0') : totalMinutes + 'min';
    };

    if (sumDur) {
        if (count <= 1) sumDur.textContent = count ? 'Envio imediato' : '~0 min';
        else sumDur.textContent = formatDuration(minSeconds) + ' a ' + formatDuration(maxSeconds) + ' (média ' + formatDuration(avgSeconds) + ')';
    }

    if (sumEnd) {
        if (time === '--:--' || count === 0) {
            sumEnd.textContent = 'Não definido';
        } else {
            const [hour, minute] = time.split(':').map(Number);
            const startMinutes = (hour * 60) + minute;
            const endMinutesTotal = startMinutes + Math.ceil(avgSeconds / 60);
            const daysLater = Math.floor(endMinutesTotal / 1440);
            const endMinutes = endMinutesTotal % 1440;
            const endHour = String(Math.floor(endMinutes / 60)).padStart(2, '0');
            const endMinute = String(endMinutes % 60).padStart(2, '0');
            sumEnd.textContent = endHour + ':' + endMinute + (daysLater ? ' (+' + daysLater + ' dia)' : '');
        }
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
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:8px;overflow:hidden;flex:1;">
                    ${m.type === 'image' ? `<img src="${escHtml(m.url)}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;" alt="">` : `<span style="font-size:24px;">🎥</span>`}
                    <span style="font-size:12.5px;font-weight:500;text-overflow:ellipsis;overflow:hidden;white-space:nowrap">${escHtml(m.name)}</span>
                </div>
                <button type="button" class="btn btn-danger" style="font-size:11px;padding:3px 8px;flex-shrink:0;" onclick="removeMedia(${i})">✕</button>
            </div>
            <textarea
                rows="2"
                placeholder="✏️ Legenda para esta ${m.type === 'video' ? 'vídeo' : 'foto'} (opcional)..."
                style="width:100%;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:12.5px;color:var(--text);resize:vertical;font-family:inherit;"
                oninput="updateMediaText(${i}, this.value)"
            >${escHtml(m.text || '')}</textarea>
        </div>
    `).join('');
}

function removeMedia(i) {
    mediaItems.splice(i, 1);
    renderMediaList();
    updateLivePreview();
}

function updateMediaText(index, text) {
    if (mediaItems[index]) {
        mediaItems[index].text = text;
        updateLivePreview();
    }
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
    const send_delay = 'random';
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
            showToast(`✅ Agendamento criado! Se o WhatsApp estiver ocupado, ele aguardará na fila.`, 'success');
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

// ── Admin Panel Completo & Gestão de Limites ─────────────
let adminUsersList = [];
let adminHistoryData = [];

async function loadAdminUsers() {
    const el = document.getElementById('admin-users-list');
    if (!el) return;
    el.innerHTML = '<div class="loading">Carregando clientes...</div>';
    try {
        const r = await authFetch('/admin/users');
        adminUsersList = await r.json();
        if (!Array.isArray(adminUsersList) || !adminUsersList.length) {
            el.innerHTML = '<div class="empty">Nenhum cliente cadastrado ainda.</div>';
            return;
        }

        // Atualiza filtro de clientes no histórico geral do admin
        const filterSel = document.getElementById('admin-history-filter');
        if (filterSel) {
            const currentVal = filterSel.value;
            filterSel.innerHTML = '<option value="">— Todos os Clientes —</option>' +
                adminUsersList.map(u => `<option value="${u.id}">${escHtml(u.name)} (${escHtml(u.email)})</option>`).join('');
            filterSel.value = currentVal;
        }

        el.innerHTML = adminUsersList.map(u => {
            const isAdmin = u.role === 'admin';
            const isActive = u.active !== false;
            const planKey = u.plan || 'trial';
            const planBadgeClass = {
                trial: 'badge-yellow',
                start: 'badge-blue',
                pro: 'badge-purple',
                diamond: 'badge-green',
                unlimited: 'badge-green'
            }[planKey] || 'badge-blue';

            const planTitle = u.plan_name || (
                planKey === 'trial' ? '⚡ Trial (7 dias)' :
                planKey === 'start' ? '🥉 Start' :
                planKey === 'pro' ? '🚀 Pro' :
                planKey === 'diamond' ? '💎 Diamante' :
                '👑 Admin Ilimitado'
            );

            const expires = u.plan_expires ? new Date(u.plan_expires).toLocaleDateString('pt-BR') : 'Sem expiração';

            return `
            <div class="admin-user-card" style="border:1px solid var(--border);border-radius:14px;padding:16px 20px;margin-bottom:12px;background:var(--bg3);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
                <div style="display:flex;align-items:center;gap:12px;min-width:240px;">
                    <div style="width:42px;height:42px;border-radius:50%;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
                        ${isAdmin ? '👑' : '👤'}
                    </div>
                    <div>
                        <div style="font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px;">
                            <span>${escHtml(u.name)}</span>
                            <span class="badge ${isActive ? 'badge-green' : 'badge-yellow'}" style="font-size:10px;">
                                ${isActive ? '● Ativo' : '● Bloqueado'}
                            </span>
                            <span class="badge ${planBadgeClass}" style="font-size:10px;">${planTitle}</span>
                        </div>
                        <div style="font-size:12px;color:var(--text3);margin-top:2px;">
                            ✉️ ${escHtml(u.email)} • 📱 Instância: <code>${escHtml(u.instance_name || 'N/A')}</code>
                        </div>
                        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:11.5px;">
                            <span style="background:var(--bg2);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--text2);">
                                📱 <b>${u.max_instances}</b> WA(s)
                            </span>
                            <span style="background:var(--bg2);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--text2);">
                                📅 <b>${u.max_schedules}</b> Agendamentos
                            </span>
                            <span style="background:var(--bg2);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--primary);font-weight:600;">
                                👥 Limite: <b>${u.max_recipients}</b> grupos
                            </span>
                            <span style="background:var(--bg2);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--text3);">
                                ⏰ Expira: ${expires}
                            </span>
                        </div>
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button type="button" class="btn btn-primary" style="font-size:12px;padding:6px 14px;" onclick="openAdminEditModal('${u.id}')">
                        ✏️ Editar & Limites
                    </button>
                    ${!isAdmin ? `
                    <button type="button" class="btn btn-danger" style="font-size:12px;padding:6px 12px;" onclick="deleteAdminUser('${u.id}', '${(u.name||'').replace(/'/g,"\\'")}')">
                        🗑️ Excluir
                    </button>
                    ` : `
                    <span style="font-size:11px;color:var(--text3);font-style:italic;">Admin Principal</span>
                    `}
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = `<div class="empty" style="color:#f87171">Erro ao carregar clientes: ${e.message}</div>`;
    }
}

function openAdminEditModal(userId) {
    const u = adminUsersList.find(item => item.id === userId);
    if (!u) {
        showToast('Cliente não encontrado', 'error');
        return;
    }
    document.getElementById('admin-edit-id').value = u.id;
    document.getElementById('admin-edit-name').value = u.name || '';
    document.getElementById('admin-edit-instance').value = u.instance_name || '';
    document.getElementById('admin-edit-plan').value = u.plan || 'start';
    document.getElementById('admin-edit-max-instances').value = u.max_instances || 1;
    document.getElementById('admin-edit-max-schedules').value = u.max_schedules || 2;
    document.getElementById('admin-edit-max-recipients').value = u.max_recipients || 50;
    document.getElementById('admin-edit-active').value = u.active !== false ? 'true' : 'false';
    document.getElementById('admin-edit-password').value = '';

    const modal = document.getElementById('modal-admin-edit');
    if (modal) modal.style.display = 'flex';
}

function closeAdminEditModal() {
    const modal = document.getElementById('modal-admin-edit');
    if (modal) modal.style.display = 'none';
}

function onAdminPlanChange(plan) {
    const maxInstInput = document.getElementById('admin-edit-max-instances');
    const maxSchedInput = document.getElementById('admin-edit-max-schedules');
    const maxRecInput = document.getElementById('admin-edit-max-recipients');

    const defaults = {
        trial: { inst: 1, sched: 1, rec: 25 },
        start: { inst: 1, sched: 2, rec: 50 },
        pro: { inst: 2, sched: 4, rec: 150 },
        diamond: { inst: 4, sched: 8, rec: 400 },
        unlimited: { inst: 999, sched: 9999, rec: 99999 }
    };

    const d = defaults[plan] || defaults.start;
    if (maxInstInput) maxInstInput.value = d.inst;
    if (maxSchedInput) maxSchedInput.value = d.sched;
    if (maxRecInput) maxRecInput.value = d.rec;
}

async function saveAdminEdit() {
    const id = document.getElementById('admin-edit-id').value;
    if (!id) return;
    const name = document.getElementById('admin-edit-name').value.trim();
    const instance_name = document.getElementById('admin-edit-instance').value.trim();
    const plan = document.getElementById('admin-edit-plan').value;
    const max_instances = parseInt(document.getElementById('admin-edit-max-instances').value) || 1;
    const max_schedules = parseInt(document.getElementById('admin-edit-max-schedules').value) || 2;
    const max_recipients = parseInt(document.getElementById('admin-edit-max-recipients').value) || 50;
    const active = document.getElementById('admin-edit-active').value === 'true';
    const password = document.getElementById('admin-edit-password').value.trim();

    if (!name) { showToast('Nome é obrigatório!', 'error'); return; }

    try {
        const body = { name, instance_name, plan, max_instances, max_schedules, max_recipients, active };
        if (password) {
            if (password.length < 8) { showToast('A nova senha deve ter no mínimo 8 caracteres!', 'error'); return; }
            body.password = password;
        }

        const r = await authFetch(`/admin/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(body)
        });
        const data = await r.json();
        if (data.success) {
            showToast('✅ Cliente e limites atualizados com sucesso!', 'success');
            closeAdminEditModal();
            loadAdminUsers();
        } else {
            showToast(data.error || 'Erro ao salvar cliente', 'error');
        }
    } catch (e) {
        showToast('Erro de conexão: ' + e.message, 'error');
    }
}

async function deleteAdminUser(userId, userName) {
    if (!confirm(`⚠️ TEM CERTEZA que deseja excluir o cliente "${userName}"?\n\nTodos os agendamentos, histórico e WhatsApps deste cliente serão permanentemente excluídos!`)) {
        return;
    }

    try {
        const r = await authFetch(`/admin/users/${userId}`, { method: 'DELETE' });
        const data = await r.json();
        if (data.success) {
            showToast(`🗑️ Cliente "${userName}" excluído!`, 'success');
            loadAdminUsers();
        } else {
            showToast(data.error || 'Erro ao excluir', 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

function openAdminCreateModal() {
    document.getElementById('admin-create-name').value = '';
    document.getElementById('admin-create-email').value = '';
    document.getElementById('admin-create-password').value = '';
    document.getElementById('admin-create-instance').value = '';
    document.getElementById('admin-create-plan').value = 'start';
    const m = document.getElementById('modal-admin-create');
    if (m) m.style.display = 'flex';
}

function closeAdminCreateModal() {
    const m = document.getElementById('modal-admin-create');
    if (m) m.style.display = 'none';
}

async function submitAdminCreate() {
    const name = document.getElementById('admin-create-name').value.trim();
    const email = document.getElementById('admin-create-email').value.trim();
    const password = document.getElementById('admin-create-password').value.trim();
    const instance_name = document.getElementById('admin-create-instance').value.trim();
    const plan = document.getElementById('admin-create-plan').value;

    if (!name || !email || !password) {
        showToast('Nome, e-mail e senha são obrigatórios!', 'error');
        return;
    }
    if (password.length < 8) {
        showToast('A senha deve ter no mínimo 8 caracteres!', 'error');
        return;
    }

    const btn = document.getElementById('btn-admin-create-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Criando...'; }

    try {
        const r = await authFetch('/admin/users', {
            method: 'POST',
            body: JSON.stringify({ name, email, password, instance_name, plan })
        });
        const data = await r.json();
        if (data.success) {
            showToast(`✅ Cliente "${name}" criado com sucesso!`, 'success');
            closeAdminCreateModal();
            loadAdminUsers();
        } else {
            showToast(data.error || 'Erro ao criar cliente', 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✓ Criar Cliente'; }
    }
}

async function loadAdminHistory() {
    const el = document.getElementById('admin-history-list');
    if (!el) return;
    el.innerHTML = '<div class="loading">Carregando histórico geral...</div>';
    try {
        const r = await authFetch('/api/history');
        adminHistoryData = await r.json();
        filterAdminHistory();
    } catch (e) {
        el.innerHTML = `<div class="empty">Erro ao carregar histórico: ${e.message}</div>`;
    }
}

function filterAdminHistory() {
    const el = document.getElementById('admin-history-list');
    if (!el) return;
    const filterUserId = document.getElementById('admin-history-filter')?.value;
    let list = adminHistoryData || [];
    if (filterUserId) {
        list = list.filter(h => h.userId === filterUserId);
    }
    if (!list.length) {
        el.innerHTML = '<div class="empty">Nenhum disparo encontrado para o filtro selecionado.</div>';
        return;
    }
    el.innerHTML = list.slice(0, 50).map(h => `
        <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <span>${h.status === 'sent' ? '✅' : '❌'}</span>
                <div>
                    <div style="font-weight:600;">${escHtml(h.recipient_name || '—')}</div>
                    <div style="font-size:11px;color:var(--text3);">${escHtml((h.message || '').substring(0, 70))}</div>
                </div>
            </div>
            <div style="text-align:right;">
                <div style="color:var(--text3);font-size:11px;">${formatDate(h.sent_at)}</div>
                ${h.error ? `<div style="color:var(--danger);font-size:10.5px;">${escHtml(h.error)}</div>` : ''}
            </div>
        </div>
    `).join('');
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
