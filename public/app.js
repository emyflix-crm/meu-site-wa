const API = '';
let groups = [], contacts = [], campaigns = [];
let selectedRecipients = [];
let editingSchedule = null;
let historyTimer = null;
let schedules = [], currentTab = 'groups', dashFilter = 'all';
let userInstances = [], currentQRInstance = null;
let crmClients = [], crmTemplates = [], templatePickerClientId = null;
let crmContacts = [], crmVisibleContacts = [], crmExpiryFilter = 'today', crmClientPage = 1;

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
        const crmNav = document.getElementById('crm-nav');
        if (crmNav) crmNav.style.display = '';
        const scheduleTemplateButton = document.getElementById('schedule-template-button');
        if (scheduleTemplateButton) scheduleTemplateButton.style.display = '';
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
function showPage(page, preserveEdit = false) {
    if ((page === 'admin' || page === 'crm') && CURRENT_USER.role !== 'admin') {
        showToast('Acesso exclusivo do administrador.', 'error');
        return;
    }
    clearInterval(historyTimer);
    if (editingSchedule && !preserveEdit) resetScheduleEditor();
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    const pages = ['dashboard', 'schedule', 'campaigns', 'history', 'connect', 'plans', 'crm', 'admin'];
    const idx = pages.indexOf(page);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');

    if (page === 'history') {
        loadHistory();
        historyTimer = setInterval(() => { if (!document.hidden) loadHistory(); }, 10000);
    }
    if (page === 'dashboard') loadSchedules();
    if (page === 'campaigns') initCampaignsPage();
    if (page === 'plans') updateCustomPlan();
    if (page === 'schedule') {
        loadCampaigns();
        updateLivePreview();
    }
    if (page === 'connect') loadInstancesList();
    if (page === 'crm') loadCrmDashboard();
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
    if (currentTab === 'contacts') {
        showToast('🔄 Sincronizando contatos e conversas...', 'warning');
        await loadContactsForInstance(instName, true);
        showToast(`✅ ${contacts.length} contatos sincronizados!`, 'success');
        return;
    }
    if (currentTab === 'campaigns') {
        showToast('🔄 Atualizando campanhas...', 'warning');
        await loadCampaigns();
        showToast(`✅ ${campaigns.length} campanhas atualizadas!`, 'success');
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

async function loadContactsForInstance(instName, forceRefresh = false) {
    const container = document.getElementById('recipient-list');
    container.innerHTML = '<div class="loading">Carregando contatos...</div>';
    try {
        const r = await authFetch(`${API}/api/contacts?instance=${encodeURIComponent(instName)}${forceRefresh ? '&refresh=true' : ''}`);
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

function clearAllRecipients() {
    if (!selectedRecipients.length) return;
    selectedRecipients = [];
    renderRecipients();
    updateSelectedTags();
    showToast('Todos os destinatários foram desmarcados.', 'success');
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
    const clearBtn = document.getElementById('btn-clear-recipients');
    if (clearBtn) clearBtn.style.display = selectedRecipients.length ? 'inline-flex' : 'none';
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
    const media_delay_ms = mediaDelayMode === 'immediate' ? 0 :
        Number(document.getElementById('delay-value').value) * (document.getElementById('delay-unit').value === 'minutes' ? 60000 : 1000);
    const frequency = document.getElementById('schedule-frequency').value;
    const schedule_date = document.getElementById('schedule-date')?.value || '';
    const send_delay = 'random';
    const timezone = document.getElementById('schedule-timezone')?.value || 'America/Sao_Paulo';

    const btn = document.getElementById('submit-btn');
    btn.disabled = true; btn.textContent = editingSchedule ? 'Salvando alterações...' : 'Criando Agendamento...';
    try {
        const res = await authFetch(`${API}/api/schedules${editingSchedule ? '/' + editingSchedule.id : ''}`, {
            method: editingSchedule ? 'PUT' : 'POST',
            body: JSON.stringify({ recipients: selectedRecipients, message, media_url, media_type, media_texts, extra_medias, media_delay_ms, time, frequency, schedule_date, send_delay, instance_name, timezone,
                ...(editingSchedule ? { expected_updated_at: editingSchedule.updated_at || editingSchedule.created_at } : {}) })
        });
        const data = await res.json();
        if (data.success) {
            showToast(editingSchedule ? 'Alterações salvas para os próximos envios.' : 'Agendamento criado!', 'success');
            resetScheduleEditor();
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
    btn.disabled = false; btn.textContent = editingSchedule ? 'Salvar alterações' : 'Criar Agendamento';
}

function resetScheduleEditor() {
    editingSchedule = null;
    document.getElementById('schedule-form').reset();
    selectedRecipients = [];
    mediaItems = [];
    document.querySelector('#page-schedule h1').textContent = 'Criar Agendamento';
    document.getElementById('submit-btn').textContent = 'Criar Agendamento';
    document.querySelectorAll('.freq-option').forEach((el, i) => el.classList.toggle('selected', i === 0));
    document.getElementById('schedule-frequency').value = 'daily';
    document.getElementById('date-picker-wrap').style.display = 'none';
    document.getElementById('schedule-timezone').value = 'America/Sao_Paulo';
    document.querySelectorAll('.tz-btn').forEach((el, i) => el.classList.toggle('active', i === 0));
    document.getElementById('custom-timezone').style.display = 'none';
    selectMediaDelay('immediate');
    updateTZPreview('America/Sao_Paulo');
    renderMediaList();
    updateSelectedTags();
}

async function editSchedule(id) {
    const response = await authFetch(API + '/api/schedules');
    if (!response.ok) return showToast('Não foi possível carregar o agendamento.', 'error');
    const latest = await response.json();
    const s = latest.find(item => item.id === id);
    if (!s) return showToast('Agendamento não encontrado.', 'error');
    if (s.busy) return showToast('Aguarde este agendamento sair da fila e terminar o envio.', 'warning');
    editingSchedule = JSON.parse(JSON.stringify(s));
    showPage('schedule', true);
    document.querySelector('#page-schedule h1').textContent = 'Editar Agendamento';
    document.getElementById('submit-btn').textContent = 'Salvar alterações';
    const instance = document.getElementById('schedule-instance');
    if (![...instance.options].some(o => o.value === s.instance_name))
        instance.add(new Option(s.instance_name, s.instance_name));
    instance.value = s.instance_name;
    selectedRecipients = JSON.parse(JSON.stringify(s.recipients || []));
    document.getElementById('schedule-message').value = s.message || '';
    document.getElementById('schedule-time').value = s.time;
    document.getElementById('schedule-frequency').value = s.frequency;
    document.querySelectorAll('.freq-option').forEach(el => el.classList.toggle('selected', el.getAttribute('onclick').includes("'" + s.frequency + "'")));
    document.getElementById('schedule-date').value = s.schedule_date || '';
    document.getElementById('date-picker-wrap').style.display = s.frequency === 'date' ? 'block' : 'none';
    document.getElementById('schedule-timezone').value = s.timezone || 'America/Sao_Paulo';
    document.getElementById('custom-timezone').value = s.timezone || 'America/Sao_Paulo';
    document.getElementById('custom-timezone').style.display = 'block';
    document.querySelectorAll('.tz-btn').forEach(el => el.classList.remove('active'));
    updateTZPreview(s.timezone || 'America/Sao_Paulo');
    mediaItems = s.media_url ? [{ url: s.media_url, type: s.media_type, text: s.media_texts?.[0] ?? '', name: 'Mídia atual' }] : [];
    mediaItems.push(...(s.extra_medias || []).map((m, i) => ({ ...m, text: m.text ?? s.media_texts?.[i + 1] ?? '', name: 'Mídia atual' })));
    mediaDelayMode = s.media_delay_ms ? 'custom' : 'immediate';
    document.getElementById('delay-value').value = (s.media_delay_ms || 5000) / 1000;
    document.getElementById('delay-unit').value = 'seconds';
    selectMediaDelay(mediaDelayMode);
    renderMediaList();
    updateSelectedTags();
    currentTab = 'groups';
    document.getElementById('recipient-search').value = '';
    document.querySelectorAll('.rec-tab').forEach((el, i) => el.classList.toggle('active', i === 0));
    await loadGroupsForInstance(s.instance_name);
    renderRecipients();
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
                <button class="btn btn-icon" title="Editar" onclick="editSchedule(${s.id})" ${s.busy ? 'disabled' : ''}>✎</button>
                <button class="btn btn-icon" title="${s.active ? 'Pausar' : 'Ativar'}" onclick="toggleSchedule(${s.id},${s.active})">${s.active ? '⏸' : '▶️'}</button>
                <button class="btn btn-icon" title="Deletar" onclick="deleteSchedule(${s.id})">🗑️</button>
            </div>
        </div>`;
    }).join('');
}

async function toggleSchedule(id, active) {
    const s = schedules.find(s => s.id === id); if (!s) return;
    const r = await authFetch(`${API}/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ active: !active }) });
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
    const response = await authFetch(`${API}/api/schedules/${id}`, { method: 'DELETE' });
    if (!response.ok) return showToast((await response.json()).error || 'Não foi possível excluir.', 'warning');
    showToast('🗑️ Removido', 'success');
    loadSchedules();
}

// ── Histórico ─────────────────────────────────────────────
async function loadHistory() {
    try {
        const date = document.getElementById('history-date')?.value || '';
        const r = await authFetch(`${API}/api/executions?date=${encodeURIComponent(date || new Date().toLocaleDateString('en-CA'))}`);
        if (!r.ok) throw new Error('Não foi possível carregar o acompanhamento.');
        const { rows: allRows } = await r.json();
        const statusFilter = document.getElementById('history-status-filter')?.value || '';
        const query = (document.getElementById('history-search')?.value || '').toLowerCase();
        const rows = allRows.filter(run => (!statusFilter || run.status === statusFilter) &&
            [run.userEmail, run.instance_name, run.time].some(value => String(value || '').toLowerCase().includes(query)));
        const statEl = document.getElementById('stat-sent');
        if (statEl && (!date || date === new Date().toLocaleDateString('en-CA'))) {
            statEl.textContent = allRows.reduce((n, run) => n + run.accepted, 0);
        }
        const setHistoryStat = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
        setHistoryStat('history-stat-scheduled', allRows.filter(run => run.status === 'scheduled' || run.status === 'queued').length);
        setHistoryStat('history-stat-running', allRows.filter(run => run.status === 'sending').length);
        setHistoryStat('history-stat-finished', allRows.filter(run => run.status === 'finished').length);
        setHistoryStat('history-stat-errors', allRows.filter(run => ['blocked', 'interrupted', 'untracked'].includes(run.status)).length);
        const list = document.getElementById('history-list');
        if (!list) return;
        if (!rows.length) {
            list.innerHTML = '<div class="empty">Nenhuma execução registrada neste dia. Registros anteriores à atualização continuam no histórico administrativo.</div>';
            return;
        }
        const states = { scheduled: ['Aguardando', 'waiting'], paused: ['Pausado', 'paused'], queued: ['Na fila', 'running'],
            sending: ['Em andamento', 'running'], finished: ['Concluído', 'success'], blocked: ['Não iniciado', 'danger'],
            interrupted: ['Interrompido', 'danger'], untracked: ['Sem execução', 'paused'] };
        list.innerHTML = `<div class="responsive-table"><table class="app-table history-table"><thead><tr>
            <th>Horário</th><th>Conta</th><th>Instância</th><th>Destinatários</th><th>Progresso</th><th>Status</th><th>Ações</th>
        </tr></thead><tbody>${rows.map(run => {
            const [label, tone] = states[run.status] || ['A verificar', 'paused'];
            const progress = Number(run.progress || 0);
            return `<tr>
                <td data-label="Horário"><strong>${escHtml(run.time)}</strong><small>${escHtml(run.timezone || '')}</small></td>
                <td data-label="Conta"><strong>${escHtml(run.userEmail ? run.userEmail.split('@')[0] : 'Campanha')}</strong><small>${escHtml(run.userEmail || '')}</small></td>
                <td data-label="Instância"><strong>${escHtml(run.instance_name || '—')}</strong></td>
                <td data-label="Destinatários"><strong>${run.total}</strong><small>${run.accepted} aceitos pela API</small></td>
                <td data-label="Progresso"><div class="progress-label"><span>${progress}%</span></div><div class="progress-track"><span class="progress-fill ${tone}" style="width:${Math.max(0, Math.min(100, progress))}%"></span></div></td>
                <td data-label="Status"><span class="status-pill ${tone}"><i></i>${label}</span></td>
                <td data-label="Ações">${CURRENT_USER.role === 'admin' && run.id ? `<button type="button" class="table-action" data-execution="${escHtml(run.id)}" title="Ver diagnóstico">•••</button>` : '<span class="muted">—</span>'}</td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
        list.querySelectorAll('[data-execution]').forEach(btn => btn.onclick = () => openExecutionDetails(btn.dataset.execution));
    } catch (e) {
        const list = document.getElementById('history-list');
        if (list) list.textContent = 'Não foi possível atualizar o acompanhamento. Tente novamente.';
    }
}

async function openExecutionDetails(id) {
    if (CURRENT_USER.role !== 'admin') return;
    const response = await authFetch(API + '/api/executions/' + encodeURIComponent(id));
    if (!response.ok) return showToast('Não foi possível carregar os detalhes.', 'error');
    const run = await response.json();
    const dialog = document.getElementById('execution-details');
    const content = document.getElementById('execution-details-content');
    content.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = 'Diagnóstico da execução';
    content.append(title);
    const summary = document.createElement('p');
    summary.textContent = [run.snapshot.userEmail, run.snapshot.instance_name, run.started_at, run.finished_at].filter(Boolean).join(' · ');
    content.append(summary);
    const message = document.createElement('p');
    message.textContent = run.snapshot.message || '(Somente mídia)';
    content.append(message);
    if (run.diagnostic) {
        const note = document.createElement('p'); note.textContent = run.diagnostic; content.append(note);
    }
    const media = [run.snapshot.media_url, ...(run.snapshot.extra_medias || []).map(m => m.url)].filter(Boolean);
    for (const url of media) {
        if (!/^https?:\/\//i.test(url)) continue;
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir mídia ';
        content.append(link);
    }
    const search = document.createElement('input');
    search.placeholder = 'Buscar grupo ou contato'; content.append(search);
    const results = document.createElement('div'); content.append(results);
    function render() {
        results.replaceChildren();
        for (const recipient of run.snapshot.recipients.filter(r => (r.name || r.id).toLowerCase().includes(search.value.toLowerCase()))) {
            const result = run.results.find(r => r.recipient_id === recipient.id);
            const row = document.createElement('div');
            row.style.cssText = 'padding:12px 0;border-bottom:1px solid var(--border);white-space:pre-wrap';
            row.textContent = (recipient.name || recipient.id) + '\n' +
                (result ? JSON.stringify(result, null, 2) : 'Sem tentativa registrada nesta execução.');
            results.append(row);
        }
    }
    search.oninput = render; render();
    if (!dialog.open) dialog.showModal();
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

// ── CRM privado do administrador ─────────────────────────
const CRM_STATUS_META = {
    lead: { label: 'Novo contato', color: '#3b82f6', icon: '🔵' },
    trial: { label: 'Em teste', color: '#a855f7', icon: '🟣' },
    active: { label: 'Cliente ativo', color: '#22c55e', icon: '🟢' },
    expiring: { label: 'Vence em breve', color: '#f59e0b', icon: '🟠' },
    overdue: { label: 'Pagamento pendente', color: '#ef4444', icon: '🔴' },
    cancelled: { label: 'Cancelado', color: '#64748b', icon: '⚫' }
};

async function loadCrmDashboard() {
    if (CURRENT_USER.role !== 'admin') return;
    try {
        const [clientsRes, templatesRes] = await Promise.all([
            authFetch(`${API}/api/admin/crm/clients`),
            authFetch(`${API}/api/admin/crm/templates`)
        ]);
        if (!clientsRes.ok || !templatesRes.ok) throw new Error('Não foi possível carregar o CRM');
        crmClients = await clientsRes.json();
        crmTemplates = await templatesRes.json();
        await setupCrmInstanceSelector();
        renderCrmStats();
        renderCrmClients();
        renderCrmExpiry();
        renderCrmChart();
        renderCrmTemplates();
        if (!document.getElementById('crm-client-start')?.value) resetCrmClientForm();
    } catch (error) {
        const clientsEl = document.getElementById('crm-clients-list');
        const templatesEl = document.getElementById('crm-templates-list');
        if (clientsEl) clientsEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Não foi possível carregar os clientes.</p></div>';
        if (templatesEl) templatesEl.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>Não foi possível carregar as mensagens.</p></div>';
    }
}

async function setupCrmInstanceSelector() {
    const select = document.getElementById('crm-instance-select');
    if (!select) return;
    if (!userInstances.length) {
        try {
            const response = await authFetch(`${API}/api/instances`);
            const data = await response.json();
            userInstances = data.instances || [];
        } catch {}
    }
    if (!userInstances.length && CURRENT_USER.role === 'admin') {
        userInstances = [{ name: CURRENT_USER.instance_name || 'teste-nascimento', label: 'Principal (Admin)', connected: true }];
    }
    const previous = select.value || localStorage.getItem('crm_active_instance') || CURRENT_USER.instance_name || userInstances[0]?.name || '';
    select.innerHTML = userInstances.map(instance => `<option value="${escHtml(instance.name)}">${escHtml(instance.label || instance.name)} ${instance.connected ? '🟢' : '🔴'}</option>`).join('');
    if (previous) select.value = previous;
    if (!select.value && select.options.length) select.selectedIndex = 0;
    onCrmInstanceChange(false);
}

function getCrmInstance() {
    return document.getElementById('crm-instance-select')?.value || CURRENT_USER.instance_name || '';
}

function onCrmInstanceChange(clearContact = true) {
    const name = getCrmInstance();
    if (name) localStorage.setItem('crm_active_instance', name);
    const instance = userInstances.find(item => item.name === name);
    const status = document.getElementById('crm-instance-status');
    if (status) {
        status.textContent = instance?.connected === false ? '● Desconectado' : '● Conectado';
        status.style.color = instance?.connected === false ? '#ef4444' : 'var(--primary)';
    }
    refreshCrmInstanceStatus(name);
    const hidden = document.getElementById('crm-client-instance');
    if (hidden && (!hidden.value || clearContact)) hidden.value = name;
    if (clearContact) {
        crmContacts = [];
        const phone = document.getElementById('crm-client-phone');
        if (phone) phone.value = '';
        const jid = document.getElementById('crm-client-contact-jid');
        if (jid) jid.value = '';
    }
}

async function refreshCrmInstanceStatus(name) {
    if (!name) return;
    const status = document.getElementById('crm-instance-status');
    try {
        const response = await authFetch(`${API}/api/instances/${encodeURIComponent(name)}/status`);
        const data = await response.json();
        const connected = data.instance?.state === 'open';
        const instance = userInstances.find(item => item.name === name);
        if (instance) instance.connected = connected;
        if (status && getCrmInstance() === name) {
            status.textContent = connected ? '● Conectado' : '● Desconectado';
            status.style.color = connected ? 'var(--primary)' : '#ef4444';
        }
        const option = document.querySelector(`#crm-instance-select option[value="${CSS.escape(name)}"]`);
        if (option && instance) option.textContent = `${instance.label || instance.name} ${connected ? '🟢' : '🔴'}`;
    } catch {
        if (status && getCrmInstance() === name) {
            status.textContent = '● Não foi possível verificar';
            status.style.color = '#f59e0b';
        }
    }
}

function crmDateValue(value) {
    if (!value) return '';
    const date = new Date(value + 'T12:00:00');
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR');
}

function crmMoney(client) {
    const symbols = { BRL: 'R$', GBP: '£', EUR: '€', USD: '$' };
    return `${symbols[client.currency] || client.currency || 'R$'} ${Number(client.price || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderCrmStats() {
    const el = document.getElementById('crm-stats');
    if (!el) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const inFiveDays = new Date(today); inFiveDays.setDate(inFiveDays.getDate() + 5);
    const expiring = crmClients.filter(client => {
        if (!client.renewal_date || client.status === 'cancelled') return false;
        const date = new Date(client.renewal_date + 'T00:00:00');
        return date >= today && date <= inFiveDays;
    }).length;
    const monthlyGbp = crmClients
        .filter(client => client.status === 'active' && client.currency === 'GBP')
        .reduce((sum, client) => sum + Number(client.price || 0), 0);
    const cards = [
        ['👥', crmClients.length, 'Total de clientes', '#a78bfa'],
        ['🟢', crmClients.filter(c => c.status === 'active').length, 'Ativos', '#22c55e'],
        ['⏳', expiring, 'Vencem em 5 dias', '#f59e0b'],
        ['📈', '£ ' + monthlyGbp.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), 'Receita mensal', '#38bdf8']
    ];
    el.innerHTML = cards.map(card => `<div class="crm-stat"><div style="font-size:20px">${card[0]}</div><strong style="color:${card[3]}">${card[1]}</strong><span>${card[2]}</span></div>`).join('');
}

function crmDaysUntil(value) {
    if (!value) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const date = new Date(value + 'T00:00:00');
    if (Number.isNaN(date.getTime())) return null;
    return Math.round((date - today) / 86400000);
}

function crmDisplayStatus(client) {
    if (client.status === 'cancelled') return CRM_STATUS_META.cancelled;
    const days = crmDaysUntil(client.renewal_date);
    if (days !== null && days < 0) return { label: 'Expirado', color: '#ef4444', icon: '●' };
    if (days === 0) return { label: 'Vence hoje', color: '#f59e0b', icon: '●' };
    if (days !== null && days <= 5) return { label: `Vence em ${days} dia${days === 1 ? '' : 's'}`, color: '#f59e0b', icon: '●' };
    return CRM_STATUS_META[client.status] || CRM_STATUS_META.lead;
}

function setCrmExpiryFilter(filter, button) {
    crmExpiryFilter = filter;
    document.querySelectorAll('.crm-expiry-tabs button').forEach(item => item.classList.toggle('active', item === button));
    renderCrmExpiry();
}

function renderCrmExpiry() {
    const el = document.getElementById('crm-expiry-list');
    if (!el) return;
    const filtered = crmClients.filter(client => {
        if (client.status === 'cancelled') return false;
        const days = crmDaysUntil(client.renewal_date);
        if (days === null) return false;
        if (crmExpiryFilter === 'today') return days === 0;
        if (crmExpiryFilter === 'five') return days >= 1 && days <= 5;
        return days < 0;
    }).sort((a, b) => String(a.renewal_date).localeCompare(String(b.renewal_date)));
    if (!filtered.length) {
        el.innerHTML = '<div class="empty" style="padding:22px;font-size:11px">Nenhum cliente nesta categoria.</div>';
        return;
    }
    el.innerHTML = filtered.slice(0, 8).map(client => {
        const status = crmDisplayStatus(client);
        return `<div class="crm-expiry-row"><div><strong>${escHtml(client.name)}</strong><div style="color:var(--text3);margin-top:2px">+${escHtml(client.phone || '')}</div></div><span style="color:${status.color}">${status.icon} ${status.label}</span><button class="btn btn-primary" style="font-size:9px;padding:5px 8px" onclick="openClientTemplatePicker('${client.id}')" ${client.phone ? '' : 'disabled'}>💬 Mensagem</button></div>`;
    }).join('');
}

function renderCrmChart() {
    const svg = document.getElementById('crm-chart');
    if (!svg) return;
    const days = Array.from({ length: 14 }, (_, index) => {
        const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (13 - index));
        return date;
    });
    const key = date => date.toISOString().slice(0, 10);
    const created = days.map(date => crmClients.filter(client => String(client.created_at || '').slice(0, 10) === key(date)).length);
    const renewals = days.map(date => crmClients.filter(client => client.renewal_date === key(date)).length);
    const max = Math.max(1, ...created, ...renewals);
    const points = values => values.map((value, index) => `${20 + index * (660 / 13)},${175 - value * (135 / max)}`).join(' ');
    const labels = days.filter((_date, index) => index % 3 === 0 || index === 13).map((date, index) => {
        const originalIndex = days.indexOf(date);
        return `<text x="${20 + originalIndex * (660 / 13)}" y="202" fill="#64748b" font-size="9" text-anchor="middle">${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</text>`;
    }).join('');
    svg.innerHTML = `<defs><linearGradient id="crmArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38bdf8" stop-opacity=".35"/><stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/></linearGradient></defs>
        <line class="crm-chart-grid" x1="20" y1="175" x2="680" y2="175"/><line class="crm-chart-grid" x1="20" y1="108" x2="680" y2="108"/><line class="crm-chart-grid" x1="20" y1="40" x2="680" y2="40"/>
        <polyline points="${points(created)}" class="crm-chart-line"/><polyline points="${points(renewals)}" fill="none" stroke="#22c55e" stroke-width="3"/>${labels}
        <text x="25" y="18" fill="#38bdf8" font-size="10">● Novos clientes</text><text x="125" y="18" fill="#22c55e" font-size="10">● Vencimentos</text>`;
}

function renderCrmClients() {
    const el = document.getElementById('crm-clients-list');
    if (!el) return;
    const search = (document.getElementById('crm-search')?.value || '').trim().toLowerCase();
    const status = document.getElementById('crm-status-filter')?.value || '';
    const filtered = crmClients.filter(client => {
        const haystack = [client.name, client.phone, client.plan, ...(client.tags || [])].join(' ').toLowerCase();
        return (!search || haystack.includes(search)) && (!status || client.status === status);
    });
    if (!filtered.length) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><p>Nenhum cliente encontrado.</p><small>Cadastre o primeiro cliente para começar seu CRM.</small></div>';
        return;
    }
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    crmClientPage = Math.min(Math.max(1, crmClientPage), totalPages);
    const rows = filtered.slice((crmClientPage - 1) * pageSize, crmClientPage * pageSize).map(client => {
        const meta = crmDisplayStatus(client);
        return `<tr>
            <td>${escHtml(client.name)}</td>
            <td>${client.phone ? '+' + escHtml(client.phone) : 'Não informado'}<div style="font-size:9px;color:var(--text3)">${escHtml(client.instance_name || 'Sem instância')}</div></td>
            <td>${escHtml(client.plan || '—')}</td><td>${crmMoney(client)}</td><td>${crmDateValue(client.renewal_date) || '—'}</td>
            <td><span class="crm-status-pill" style="color:${meta.color};background:${meta.color}18">${meta.icon} ${meta.label}</span></td>
            <td style="white-space:nowrap"><button class="btn btn-primary" style="font-size:10px;padding:5px 7px" onclick="openClientTemplatePicker('${client.id}')" ${client.phone ? '' : 'disabled'} title="Enviar mensagem">💬</button> <button class="btn btn-secondary" style="font-size:10px;padding:5px 7px" onclick="openCrmClientModal('${client.id}')" title="Editar">✏️</button> <button class="btn btn-danger" style="font-size:10px;padding:5px 7px" onclick="deleteCrmClient('${client.id}')" title="Excluir">🗑️</button></td>
        </tr>`;
    }).join('');
    const pages = Array.from({ length: Math.min(totalPages, 7) }, (_, index) => index + 1).map(page => `<button class="btn ${page === crmClientPage ? 'btn-primary' : 'btn-secondary'}" style="font-size:9px;padding:4px 8px" onclick="crmClientPage=${page};renderCrmClients()">${page}</button>`).join('');
    el.innerHTML = `<table class="crm-table"><thead><tr><th>Cliente</th><th>WhatsApp</th><th>Plano</th><th>Valor</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table><div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;font-size:10px;color:var(--text3)"><span>Mostrando ${(crmClientPage - 1) * pageSize + 1} a ${Math.min(crmClientPage * pageSize, filtered.length)} de ${filtered.length}</span><div style="display:flex;gap:4px">${pages}</div></div>`;
}

function renderCrmTemplates() {
    const el = document.getElementById('crm-templates-list');
    if (!el) return;
    if (!crmTemplates.length) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>Nenhuma mensagem pronta.</p><small>Crie modelos para vendas, testes, cobrança e renovação.</small></div>';
        return;
    }
    el.innerHTML = crmTemplates.map(template => `<div style="padding:15px 18px;border-bottom:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;gap:10px;"><div><strong>${template.favorite ? '⭐ ' : ''}${escHtml(template.name)}</strong><div style="font-size:10.5px;color:var(--primary);margin-top:3px;">${escHtml(template.category || 'Geral')}</div></div><div style="display:flex;gap:5px;"><button class="btn btn-secondary" style="font-size:10px;padding:4px 7px;" onclick="openCrmTemplateModal('${template.id}')">✏️</button><button class="btn btn-danger" style="font-size:10px;padding:4px 7px;" onclick="deleteCrmTemplate('${template.id}')">🗑️</button></div></div>
        <p style="font-size:12px;color:var(--text2);white-space:pre-wrap;margin-top:9px;line-height:1.45;max-height:64px;overflow:hidden;">${escHtml(template.message)}</p>
    </div>`).join('');
}

function openCrmClientModal(id = '') {
    const client = crmClients.find(item => item.id === id);
    if (!client) {
        resetCrmClientForm();
        document.getElementById('crm-client-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    document.getElementById('crm-client-id').value = client?.id || '';
    document.getElementById('crm-client-form-title').textContent = '✏️ Editar cliente';
    document.getElementById('crm-client-name').value = client?.name || '';
    document.getElementById('crm-client-phone').value = client?.phone || '';
    document.getElementById('crm-client-phone').readOnly = true;
    document.getElementById('crm-client-contact-jid').value = client?.contact_jid || '';
    document.getElementById('crm-client-instance').value = client?.instance_name || getCrmInstance();
    document.getElementById('crm-client-status').value = client?.status || 'lead';
    document.getElementById('crm-client-plan').value = client?.plan || '';
    document.getElementById('crm-client-duration').value = String(client?.duration_months || 1);
    document.getElementById('crm-client-price').value = client?.price || '';
    document.getElementById('crm-client-currency').value = client?.currency || 'GBP';
    document.getElementById('crm-client-start').value = client?.start_date || '';
    document.getElementById('crm-client-renewal').value = client?.renewal_date || '';
    document.getElementById('crm-client-tags').value = (client?.tags || []).join(', ');
    document.getElementById('crm-client-notes').value = client?.notes || '';
    document.getElementById('crm-client-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeCrmClientModal() { resetCrmClientForm(); }

function resetCrmClientForm() {
    const today = new Date();
    const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    document.getElementById('crm-client-id').value = '';
    document.getElementById('crm-client-form-title').textContent = '➕ Cadastrar cliente';
    document.getElementById('crm-client-name').value = '';
    document.getElementById('crm-client-phone').value = '';
    document.getElementById('crm-client-phone').readOnly = true;
    document.getElementById('crm-client-contact-jid').value = '';
    document.getElementById('crm-client-instance').value = getCrmInstance();
    document.getElementById('crm-client-status').value = 'active';
    document.getElementById('crm-client-plan').value = '';
    document.getElementById('crm-client-duration').value = '1';
    document.getElementById('crm-client-price').value = '';
    document.getElementById('crm-client-currency').value = 'GBP';
    document.getElementById('crm-client-start').value = localToday;
    document.getElementById('crm-client-tags').value = '';
    document.getElementById('crm-client-notes').value = '';
    calculateCrmRenewal();
}

function calculateCrmRenewal() {
    const start = document.getElementById('crm-client-start')?.value;
    const months = Number(document.getElementById('crm-client-duration')?.value || 1);
    const target = document.getElementById('crm-client-renewal');
    if (!start || !target) return;
    const [year, month, day] = start.split('-').map(Number);
    const lastDay = new Date(year, month - 1 + months + 1, 0).getDate();
    const result = new Date(year, month - 1 + months, Math.min(day, lastDay));
    target.value = new Date(result.getTime() - result.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function openCrmContactPicker() {
    const instance = getCrmInstance();
    if (!instance) return showToast('Selecione uma instância do WhatsApp primeiro.', 'error');
    document.getElementById('crm-contact-instance-label').textContent = `Contatos de: ${userInstances.find(item => item.name === instance)?.label || instance}`;
    document.getElementById('crm-contact-search').value = '';
    document.getElementById('modal-crm-contact').style.display = 'flex';
    await loadCrmContacts(false);
}

function closeCrmContactPicker() {
    document.getElementById('modal-crm-contact').style.display = 'none';
}

async function loadCrmContacts(force = false) {
    const instance = getCrmInstance();
    const list = document.getElementById('crm-contact-list');
    if (!instance || !list) return;
    list.innerHTML = '<div class="loading">🔄 Carregando contatos do WhatsApp...</div>';
    try {
        const response = await authFetch(`${API}/api/contacts?instance=${encodeURIComponent(instance)}${force ? '&refresh=true' : ''}`);
        const data = await response.json();
        if (!response.ok || !Array.isArray(data)) throw new Error(data.error || 'Não foi possível carregar os contatos');
        crmContacts = data;
        renderCrmContactPicker();
        if (force) showToast(`✅ ${crmContacts.length} contatos atualizados.`, 'success');
    } catch (error) {
        list.innerHTML = `<div class="empty" style="padding:24px;color:#f87171">${escHtml(error.message)}</div>`;
    }
}

function renderCrmContactPicker() {
    const list = document.getElementById('crm-contact-list');
    if (!list) return;
    const search = (document.getElementById('crm-contact-search')?.value || '').trim().toLowerCase();
    crmVisibleContacts = crmContacts.filter(contact => !search || [contact.name, contact.phone].join(' ').toLowerCase().includes(search)).slice(0, 300);
    if (!crmVisibleContacts.length) {
        list.innerHTML = '<div class="empty" style="padding:24px">Nenhum contato encontrado. Você pode digitar o número manualmente.</div>';
        return;
    }
    list.innerHTML = crmVisibleContacts.map((contact, index) => `<button type="button" class="crm-contact-row" onclick="chooseCrmContact(${index})"><span><strong>${escHtml(contact.name || contact.phone)}</strong><small style="display:block;color:var(--text3);margin-top:3px">+${escHtml(contact.phone || '')}</small></span><span style="color:var(--primary)">Selecionar ›</span></button>`).join('');
}

function chooseCrmContact(index) {
    const contact = crmVisibleContacts[index];
    if (!contact) return;
    document.getElementById('crm-client-phone').value = contact.phone || '';
    document.getElementById('crm-client-phone').readOnly = true;
    document.getElementById('crm-client-contact-jid').value = contact.id || (contact.phone ? `${contact.phone}@s.whatsapp.net` : '');
    document.getElementById('crm-client-instance').value = getCrmInstance();
    const name = document.getElementById('crm-client-name');
    if (!name.value.trim() || name.value.trim() === document.getElementById('crm-client-phone').value) name.value = contact.hasName ? contact.name : name.value;
    closeCrmContactPicker();
    showToast('✅ Contato selecionado.', 'success');
}

function enableCrmManualPhone() {
    closeCrmContactPicker();
    const input = document.getElementById('crm-client-phone');
    input.readOnly = false;
    input.value = '';
    document.getElementById('crm-client-contact-jid').value = '';
    document.getElementById('crm-client-instance').value = getCrmInstance();
    input.focus();
}

async function saveCrmClient() {
    const id = document.getElementById('crm-client-id').value;
    const payload = {
        name: document.getElementById('crm-client-name').value,
        phone: document.getElementById('crm-client-phone').value,
        status: document.getElementById('crm-client-status').value,
        plan: document.getElementById('crm-client-plan').value,
        price: document.getElementById('crm-client-price').value,
        currency: document.getElementById('crm-client-currency').value,
        start_date: document.getElementById('crm-client-start').value,
        renewal_date: document.getElementById('crm-client-renewal').value,
        duration_months: Number(document.getElementById('crm-client-duration').value || 1),
        instance_name: document.getElementById('crm-client-instance').value || getCrmInstance(),
        contact_jid: document.getElementById('crm-client-contact-jid').value,
        tags: document.getElementById('crm-client-tags').value,
        notes: document.getElementById('crm-client-notes').value
    };
    const button = document.getElementById('crm-client-save');
    button.disabled = true;
    try {
        const response = await authFetch(`${API}/api/admin/crm/clients${id ? '/' + id : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Não foi possível salvar o cliente.', 'error');
        resetCrmClientForm();
        showToast(id ? '✅ Cliente atualizado.' : '✅ Cliente adicionado ao CRM.', 'success');
        await loadCrmDashboard();
    } catch { showToast('Erro de comunicação ao salvar o cliente.', 'error'); }
    finally { button.disabled = false; }
}

async function deleteCrmClient(id) {
    const client = crmClients.find(item => item.id === id);
    if (!client || !confirm(`Excluir ${client.name} do CRM? Esta ação não afeta a conta ou os agendamentos do cliente.`)) return;
    const response = await authFetch(`${API}/api/admin/crm/clients/${id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Não foi possível excluir.', 'error');
    showToast('Cliente removido do CRM.', 'success');
    await loadCrmDashboard();
}

function openCrmTemplateModal(id = '') {
    const template = crmTemplates.find(item => item.id === id);
    document.getElementById('crm-template-id').value = template?.id || '';
    document.getElementById('crm-template-modal-title').textContent = template ? '✏️ Editar mensagem pronta' : '📝 Nova mensagem pronta';
    document.getElementById('crm-template-name').value = template?.name || '';
    document.getElementById('crm-template-category').value = template?.category || '';
    document.getElementById('crm-template-message').value = template?.message || '';
    document.getElementById('crm-template-favorite').checked = Boolean(template?.favorite);
    document.getElementById('modal-crm-template').style.display = 'flex';
}

function closeCrmTemplateModal() { document.getElementById('modal-crm-template').style.display = 'none'; }

async function saveCrmTemplate() {
    const id = document.getElementById('crm-template-id').value;
    const payload = {
        name: document.getElementById('crm-template-name').value,
        category: document.getElementById('crm-template-category').value,
        message: document.getElementById('crm-template-message').value,
        favorite: document.getElementById('crm-template-favorite').checked
    };
    const button = document.getElementById('crm-template-save');
    button.disabled = true;
    try {
        const response = await authFetch(`${API}/api/admin/crm/templates${id ? '/' + id : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
        const data = await response.json();
        if (!response.ok) return showToast(data.error || 'Não foi possível salvar a mensagem.', 'error');
        closeCrmTemplateModal();
        showToast(id ? '✅ Mensagem atualizada.' : '✅ Mensagem pronta criada.', 'success');
        await loadCrmDashboard();
    } catch { showToast('Erro de comunicação ao salvar a mensagem.', 'error'); }
    finally { button.disabled = false; }
}

async function deleteCrmTemplate(id) {
    const template = crmTemplates.find(item => item.id === id);
    if (!template || !confirm(`Excluir a mensagem pronta “${template.name}”?`)) return;
    const response = await authFetch(`${API}/api/admin/crm/templates/${id}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return showToast(data.error || 'Não foi possível excluir.', 'error');
    showToast('Mensagem pronta removida.', 'success');
    await loadCrmDashboard();
}

function fillCrmTemplate(template, client) {
    const values = {
        nome: client?.name || '{nome}',
        plano: client?.plan || '{plano}',
        valor: client ? crmMoney(client) : '{valor}',
        vencimento: client ? (crmDateValue(client.renewal_date) || 'data a combinar') : '{vencimento}'
    };
    return template.message.replace(/\{(nome|plano|valor|vencimento)\}/gi, (_, key) => values[key.toLowerCase()]);
}

async function ensureCrmTemplates() {
    if (crmTemplates.length) return true;
    try {
        const response = await authFetch(`${API}/api/admin/crm/templates`);
        if (!response.ok) return false;
        crmTemplates = await response.json();
        return true;
    } catch { return false; }
}

async function openScheduleTemplatePicker() {
    if (CURRENT_USER.role !== 'admin') return showToast('As mensagens prontas estão em teste somente para o administrador.', 'warning');
    templatePickerClientId = null;
    await ensureCrmTemplates();
    document.getElementById('schedule-template-search').value = '';
    renderScheduleTemplatePicker();
    document.getElementById('modal-schedule-template').style.display = 'flex';
}

async function openClientTemplatePicker(clientId) {
    templatePickerClientId = clientId;
    await ensureCrmTemplates();
    document.getElementById('schedule-template-search').value = '';
    renderScheduleTemplatePicker();
    document.getElementById('modal-schedule-template').style.display = 'flex';
}

function closeScheduleTemplatePicker() {
    document.getElementById('modal-schedule-template').style.display = 'none';
    templatePickerClientId = null;
}

function renderScheduleTemplatePicker() {
    const el = document.getElementById('schedule-template-list');
    if (!el) return;
    const search = (document.getElementById('schedule-template-search')?.value || '').toLowerCase();
    const filtered = crmTemplates.filter(template => [template.name, template.category, template.message].join(' ').toLowerCase().includes(search));
    if (!filtered.length) {
        el.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><p>Nenhuma mensagem pronta encontrada.</p></div>';
        return;
    }
    el.innerHTML = filtered.map(template => `<button type="button" onclick="useCrmTemplate('${template.id}')" style="width:100%;text-align:left;background:var(--bg3);border:1px solid var(--border);border-radius:11px;padding:13px;margin-bottom:8px;color:var(--text);cursor:pointer;"><strong>${template.favorite ? '⭐ ' : ''}${escHtml(template.name)}</strong><span style="font-size:10px;color:var(--primary);margin-left:6px;">${escHtml(template.category || 'Geral')}</span><div style="font-size:11.5px;color:var(--text2);white-space:pre-wrap;margin-top:6px;max-height:48px;overflow:hidden;">${escHtml(template.message)}</div></button>`).join('');
}

async function useCrmTemplate(templateId) {
    const template = crmTemplates.find(item => item.id === templateId);
    if (!template) return;
    if (templatePickerClientId) {
        const client = crmClients.find(item => item.id === templatePickerClientId);
        if (!client?.phone) return showToast('Cadastre o WhatsApp do cliente.', 'error');
        if (!client?.instance_name) return showToast('Edite o cliente e selecione a instância de envio.', 'error');
        const message = fillCrmTemplate(template, client);
        if (!confirm(`Enviar “${template.name}” para ${client.name} pelo WhatsApp ${client.instance_name}?`)) return;
        const response = await authFetch(`${API}/api/admin/crm/clients/${client.id}/send`, {
            method: 'POST',
            body: JSON.stringify({ message })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return showToast(data.error || 'Não foi possível enviar a mensagem.', 'error');
        closeScheduleTemplatePicker();
        showToast('✅ Mensagem enviada pelo WhatsApp conectado.', 'success');
        await loadCrmDashboard();
        return;
    }
    const messageField = document.getElementById('schedule-message');
    if (messageField) messageField.value = template.message;
    updateLivePreview();
    closeScheduleTemplatePicker();
    showToast('Mensagem copiada. Revise as variáveis antes de agendar.', 'success');
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

        renderAdminUsers();
    } catch (e) {
        el.innerHTML = `<div class="empty" style="color:#f87171">Erro ao carregar clientes: ${e.message}</div>`;
    }
}

function renderAdminUsers() {
    const el = document.getElementById('admin-users-list');
    if (!el || !Array.isArray(adminUsersList)) return;
    const query = (document.getElementById('admin-users-search')?.value || '').trim().toLowerCase();
    const status = document.getElementById('admin-users-status')?.value || '';
    const filtered = adminUsersList.filter(u => {
        const connected = u.connection_status === 'connected';
        const matchesStatus = !status || (status === 'connected' ? connected : !connected);
        const haystack = [u.name, u.email, u.instance_name].join(' ').toLowerCase();
        return matchesStatus && (!query || haystack.includes(query));
    });
    const setStat = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    setStat('admin-stat-total', adminUsersList.length);
    setStat('admin-stat-connected', adminUsersList.filter(u => u.connection_status === 'connected').length);
    setStat('admin-stat-disconnected', adminUsersList.filter(u => u.connection_status !== 'connected').length);
    setStat('admin-stat-trial', adminUsersList.filter(u => (u.plan || 'trial') === 'trial').length);
    if (!filtered.length) {
        el.innerHTML = '<div class="empty">Nenhum cliente encontrado com esses filtros.</div>';
        return;
    }
    el.innerHTML = `<div class="responsive-table"><table class="app-table admin-table"><thead><tr>
        <th>Cliente</th><th>Instância WhatsApp</th><th>Plano</th><th>Uso / Limites</th><th>Expiração</th><th>Status</th><th>Ações</th>
    </tr></thead><tbody>${filtered.map(u => {
            const isAdmin = u.role === 'admin';
            const planKey = u.plan || 'trial';
            const planTitle = u.plan_name || (
                planKey === 'trial' ? 'Trial 7 dias' : planKey === 'start' ? 'Start' :
                planKey === 'pro' ? 'Plano Pro' : planKey === 'diamond' ? 'Diamante' : 'Admin'
            );
            const expires = u.plan_expires ? new Date(u.plan_expires).toLocaleDateString('pt-BR') : 'Sem expiração';
            const connected = u.connection_status === 'connected';
            return `<tr>
                <td data-label="Cliente"><div class="client-cell"><span class="client-avatar ${isAdmin ? 'admin' : ''}">${isAdmin ? 'A' : escHtml((u.name || 'C')[0].toUpperCase())}</span><div><strong>${escHtml(u.name)}</strong><small>${escHtml(u.email)}</small></div></div></td>
                <td data-label="Instância"><div class="instance-cell"><span class="wa-icon ${connected ? 'connected' : 'disconnected'}">◉</span><div><strong>${escHtml(u.instance_name || 'N/A')}</strong><small>EmyFlix WA</small></div></div></td>
                <td data-label="Plano"><span class="plan-pill ${escHtml(planKey)}">${escHtml(planTitle)}</span></td>
                <td data-label="Uso / Limites"><div class="limit-grid"><span><b>${u.max_schedules}</b> agendamentos</span><span><b>${u.max_recipients}</b> grupos</span></div></td>
                <td data-label="Expiração"><span>${expires}</span></td>
                <td data-label="Status"><span class="status-pill ${connected ? 'success' : 'danger'}"><i></i>${connected ? 'Conectado' : 'Desconectado'}</span></td>
                <td data-label="Ações"><button type="button" class="table-action" data-admin-menu="${escHtml(u.id)}" title="Abrir ações">•••</button></td>
            </tr>`;
        }).join('')}</tbody></table></div>`;
    el.querySelectorAll('[data-admin-menu]').forEach(button => {
        button.onclick = event => openAdminActions(event, button.dataset.adminMenu);
    });
}

function openAdminActions(event, userId) {
    event.stopPropagation();
    document.querySelectorAll('.admin-actions-popover').forEach(node => node.remove());
    const user = adminUsersList.find(item => item.id === userId);
    if (!user) return;
    const menu = document.createElement('div');
    menu.className = 'admin-actions-popover';
    menu.innerHTML = `<button type="button" data-edit>Editar e limites</button>${user.role !== 'admin' ? '<button type="button" class="danger" data-delete>Excluir cliente</button>' : ''}`;
    document.body.appendChild(menu);
    const rect = event.currentTarget.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 12, rect.bottom + 6)}px`;
    menu.style.left = `${Math.max(12, rect.right - menu.offsetWidth)}px`;
    menu.querySelector('[data-edit]').onclick = () => { menu.remove(); openAdminEditModal(userId); };
    const deleteButton = menu.querySelector('[data-delete]');
    if (deleteButton) deleteButton.onclick = () => { menu.remove(); deleteAdminUser(userId, user.name || 'cliente'); };
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
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
