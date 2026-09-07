const API = '';
let groups = [], contacts = [], selectedRecipients = [];
let schedules = [], currentTab = 'groups', dashFilter = 'all';
let userInstances = [], currentQRInstance = null;

// ── Auth ─────────────────────────────────────────────────
const TOKEN = localStorage.getItem('wa_token');
const CURRENT_USER = JSON.parse(localStorage.getItem('wa_user') || '{}');
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

document.addEventListener('DOMContentLoaded', () => {
    if (CURRENT_USER.name) {
        const userEl = document.getElementById('user-name');
        if (userEl) userEl.textContent = CURRENT_USER.name;
    }
    if (CURRENT_USER.role === 'admin') {
        const adminNav = document.getElementById('admin-nav');
        if (adminNav) adminNav.style.display = '';
    }
    checkStatus();
    updateTZPreview('America/Sao_Paulo');
    loadGroups();
    loadContacts();
    loadSchedules();
    loadHistory();
    loadInstanceSelector();
    setInterval(checkStatus, 30000);
});

// ── Navigation ──────────────────────────────────────────
function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const targetPage = document.getElementById('page-' + page);
    if (targetPage) targetPage.classList.add('active');

    const pages = ['dashboard', 'schedule', 'history', 'connect', 'admin'];
    const idx = pages.indexOf(page);
    if (idx >= 0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');

    if (page === 'history') loadHistory();
    if (page === 'dashboard') loadSchedules();
    if (page === 'schedule') resetForm();
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

// ── Mobile Menu ──────────────────────────────────────────
function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.toggle('open');
    if (overlay) overlay.classList.toggle('open');
}

function closeMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
}

// ── Status (sidebar) ─────────────────────────────────────
async function checkStatus() {
    try {
        const data = await (await authFetch(`${API}/api/status`)).json();
        const ok = data.instance?.state === 'open';
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (dot) dot.className = `status-dot ${ok ? 'connected' : 'disconnected'}`;
        if (text) text.textContent = ok ? 'Conectado ✓' : 'Desconectado';
    } catch { }
}

// ── Multi-instance selector (for schedule form) ───────────
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

async function loadGroupsForInstance(instName) {
    groups = []; contacts = [];
    renderRecipients();
    const container = document.getElementById('recipient-list');
    if (container) container.innerHTML = '<div class="loading">Carregando destinatários...</div>';

    try {
        const r = await authFetch(`${API}/api/groups?instance=${encodeURIComponent(instName)}`);
        const raw = await r.json();
        groups = Array.isArray(raw) ? raw : [];
        const grpEl = document.getElementById('stat-groups');
        if (grpEl) grpEl.textContent = groups.length;
        if (currentTab === 'groups') renderRecipients();
    } catch (e) {
        if (currentTab === 'groups' && container)
            container.innerHTML = `<div class="empty" style="color:#f87171">Erro ao carregar grupos: ${e.message}</div>`;
    }

    try {
        const rc = await authFetch(`${API}/api/contacts?instance=${encodeURIComponent(instName)}`);
        contacts = await rc.json();
        if (!Array.isArray(contacts)) contacts = [];
        const cntEl = document.getElementById('stat-contacts');
        if (cntEl) cntEl.textContent = contacts.length;
        if (currentTab === 'contacts') renderRecipients();
    } catch { contacts = []; }
}

// ── Multi-instance management page ───────────────────────
async function loadInstancesList() {
    const el = document.getElementById('instances-list');
    if (!el) return;
    el.innerHTML = '<div class="loading">Carregando instâncias...</div>';
    try {
        const r = await authFetch(`${API}/api/instances`);
        const data = await r.json();
        userInstances = data.instances || [];
        const maxInst = data.max_instances || 1;

        if (!userInstances.length) {
            el.innerHTML = `<div class="empty">Nenhum WhatsApp configurado.<br>
                <button class="btn btn-primary" style="margin-top:12px" onclick="showAddInstanceModal()">➕ Adicionar WhatsApp</button></div>`;
            return;
        }

        const statusPromises = userInstances.map(inst =>
            authFetch(`${API}/api/instances/${inst.name}/status`)
                .then(res => res.json())
                .then(d => ({ name: inst.name, connected: d?.instance?.state === 'open' || d?.state === 'open' }))
                .catch(() => ({ name: inst.name, connected: false }))
        );
        const statuses = await Promise.all(statusPromises);

        el.innerHTML = `<p style="font-size:12px;color:var(--text3);margin-bottom:16px">
            📱 ${userInstances.length} de ${maxInst} WhatsApp(s) configurado(s)
        </p>` +
        userInstances.map(inst => {
            const st = statuses.find(s => s.name === inst.name);
            const connected = st?.connected;
            return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--bg3);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:12px;height:12px;border-radius:50%;background:${connected ? '#22c55e' : '#ef4444'};flex-shrink:0;"></div>
                    <div>
                        <div style="font-weight:600;font-size:14px;">${inst.label || inst.name}</div>
                        <div style="font-size:11px;color:var(--text3);">${connected ? '🟢 Conectado' : '🔴 Desconectado'} · ${inst.name}</div>
                    </div>
                </div>
                <div style="display:flex;gap:8px;">
                    ${!connected ? `<button class="btn btn-primary" style="font-size:12px;padding:6px 14px" onclick="openQRModal('${inst.name}','${(inst.label||inst.name).replace(/'/g,"\\'")}')">📱 Conectar</button>` : ''}
                    ${connected ? `<button class="btn btn-secondary" style="font-size:12px;padding:6px 14px" onclick="disconnectInstance('${inst.name}')">🔌 Desconectar</button>` : ''}
                    ${inst.name !== CURRENT_USER.instance_name ? `<button class="btn btn-danger" style="font-size:12px;padding:6px 14px" onclick="removeInstance('${inst.name}')">🗑️</button>` : ''}
                </div>
            </div>`;
        }).join('');

        const firstConnected = statuses.find(s => s.connected);
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (dot) dot.className = `status-dot ${firstConnected ? 'connected' : 'disconnected'}`;
        if (text) text.textContent = firstConnected ? 'Conectado ✓' : 'Desconectado';

    } catch (e) {
        el.innerHTML = `<div class="empty" style="color:#ef4444">Erro: ${e.message}</div>`;
    }
}

function showAddInstanceModal() {
    const modal = document.getElementById('add-instance-modal');
    if (modal) modal.style.display = 'flex';
}
function closeAddInstanceModal() {
    const modal = document.getElementById('add-instance-modal');
    if (modal) modal.style.display = 'none';
    const labelInp = document.getElementById('new-inst-label');
    if (labelInp) labelInp.value = '';
}

async function addInstance() {
    const labelInp = document.getElementById('new-inst-label');
    const label = labelInp ? labelInp.value.trim() : '';
    if (!label) { showToast('Digite um nome para identificar o WhatsApp', 'error'); return; }
    try {
        const r = await authFetch(`${API}/api/instances`, {
            method: 'POST',
            body: JSON.stringify({ label })
        });
        const data = await r.json();
        if (data.success) {
            closeAddInstanceModal();
            showToast('✅ WhatsApp criado! Escaneie o QR Code.', 'success');
            await loadInstancesList();
            openQRModal(data.instance.name, data.instance.label);
        } else {
            showToast(data.error || 'Erro ao criar', 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function removeInstance(instName) {
    if (!confirm('Remover este WhatsApp? Ele será desconectado.')) return;
    try {
        const r = await authFetch(`${API}/api/instances/${instName}`, { method: 'DELETE' });
        const data = await r.json();
        if (data.success) {
            showToast('🗑️ Removido', 'success');
            loadInstancesList();
            loadInstanceSelector();
        } else showToast(data.error || 'Erro', 'error');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function disconnectInstance(instName) {
    if (!confirm('Desconectar este WhatsApp?')) return;
    try {
        await authFetch(`${API}/api/instances/${instName}/disconnect`, { method: 'POST' });
        showToast('🔌 Desconectado', 'success');
        loadInstancesList();
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

// ── QR Modal ─────────────────────────────────────────────
function openQRModal(instName, label) {
    currentQRInstance = instName;
    const modal = document.getElementById('qr-modal');
    if (modal) modal.style.display = 'flex';
    document.getElementById('qr-modal-title').textContent = '📱 ' + (label || instName);
    document.getElementById('qr-modal-inst').textContent = 'Instância: ' + instName;
    document.getElementById('qr-modal-connected').style.display = 'none';
    document.getElementById('qr-modal-area').style.display = 'block';
    document.getElementById('qr-modal-img').src = '';
    loadQRForInstance(instName);
}

function closeQRModal() {
    const modal = document.getElementById('qr-modal');
    if (modal) modal.style.display = 'none';
    currentQRInstance = null;
    loadInstancesList();
    loadInstanceSelector();
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
        } else if (data.instance?.state === 'open' || data.state === 'open' || data.alreadyConnected) {
            document.getElementById('qr-modal-area').style.display = 'none';
            document.getElementById('qr-modal-connected').style.display = 'block';
        } else {
            showToast(data.error || 'Não foi possível obter QR code', 'error');
        }
    } catch (e) {
        showToast('Erro ao carregar QR: ' + e.message, 'error');
    }
}

// ── Load groups & contacts (primary instance) ─────────────
async function loadGroups() {
    const container = document.getElementById('recipient-list');
    try {
        const statusData = await (await authFetch(`${API}/api/status`)).json();
        const connected = statusData.instance?.state === 'open';
        if (!connected) {
            groups = [];
            const stGrp = document.getElementById('stat-groups');
            if (stGrp) stGrp.textContent = '0';
            if (currentTab === 'groups' && container) {
                container.innerHTML = `<div class="empty" style="color:#f87171">
                    ⚠️ WhatsApp desconectado.<br>
                    <button class="btn btn-primary" style="font-size:12px;padding:6px 14px;margin-top:8px" onclick="showPage('connect')">📱 Conectar agora</button>
                </div>`;
            }
            return;
        }
        const r = await authFetch(`${API}/api/groups`);
        const raw = await r.json();
        groups = Array.isArray(raw) ? raw : [];
        const stGrp = document.getElementById('stat-groups');
        if (stGrp) stGrp.textContent = groups.length;
        if (groups.length === 0 && currentTab === 'groups' && container) {
            container.innerHTML = `<div class="empty">Nenhum grupo encontrado nesta conta.</div>`;
            return;
        }
        renderRecipients();
    } catch (e) {
        groups = [];
        if (currentTab === 'groups' && container) {
            container.innerHTML = `<div class="empty" style="color:#f87171">❌ Erro de conexão: ${e.message}</div>`;
        }
    }
}

async function loadContacts() {
    try {
        const r = await authFetch(`${API}/api/contacts`);
        contacts = await r.json();
        if (!Array.isArray(contacts)) contacts = [];
        const stCnt = document.getElementById('stat-contacts');
        if (stCnt) stCnt.textContent = contacts.length;
    } catch { contacts = []; }
}

// ── Recipient selector ────────────────────────────────────
function switchRecipientTab(tab, btn) {
    currentTab = tab;
    document.querySelectorAll('.rec-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('recipient-search').value = '';
    if (tab === 'groups' && groups.length === 0) loadGroups();
    else if (tab === 'contacts' && contacts.length === 0) loadContacts().then(renderRecipients);
    else renderRecipients();
}

function filterRecipients() { renderRecipients(); }

function renderRecipients() {
    const q = document.getElementById('recipient-search')?.value?.toLowerCase() || '';
    const container = document.getElementById('recipient-list');
    if (!container) return;

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

function toggleRecipient(id, name, type) {
    const exists = selectedRecipients.findIndex(r => r.id === id);
    if (exists >= 0) selectedRecipients.splice(exists, 1);
    else selectedRecipients.push({ id, name, type });
    renderRecipients();
    updateSelectedTags();
}

function removeRecipient(id) {
    selectedRecipients = selectedRecipients.filter(r => r.id !== id);
    renderRecipients();
    updateSelectedTags();
}

function updateSelectedTags() {
    const countEl = document.getElementById('selected-count');
    if (countEl) countEl.textContent = `${selectedRecipients.length} selecionado${selectedRecipients.length !== 1 ? 's' : ''}`;
    const tagsEl = document.getElementById('selected-tags');
    if (tagsEl) {
        tagsEl.innerHTML = selectedRecipients.map(r =>
            `<span class="tag">${r.type === 'group' ? '👥' : '👤'} ${escHtml(r.name)}<button type="button" onclick="removeRecipient('${r.id}')">✕</button></span>`
        ).join('');
    }
}

// ── Frequency & Delay ─────────────────────────────────────
function selectFreq(freq, el) {
    el.closest('.frequency-options').querySelectorAll('.freq-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('schedule-frequency').value = freq;
    document.getElementById('date-picker-wrap').style.display = freq === 'date' ? 'block' : 'none';
}
function selectDelay(delay, el) {
    el.closest('.frequency-options').querySelectorAll('.freq-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('schedule-delay').value = delay;
}

// ── File upload (múltiplas mídias) ───────────────────────
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
    showToast('⏳ Enviando arquivo...', 'success');
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
            showToast('✅ ' + file.name + ' adicionado!', 'success');
        }
    } catch (e) { showToast('Erro ao carregar arquivo', 'error'); }
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

    listEl.innerHTML = mediaItems.map((m, i) => {
        const header = `<div style="display:flex;align-items:center;gap:10px;${i > 0 ? 'margin-bottom:8px;' : ''}">
            <span style="font-size:18px">${m.type === 'video' ? '🎥' : '🖼️'}</span>
            <span style="font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                <span style="font-size:11px;color:${i === 0 ? 'var(--primary)' : 'var(--text3)'};margin-right:4px;">${i+1}ª</span>${escHtml(m.name)}
            </span>
            <button type="button" onclick="removeMedia(${i})"
                style="background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:'Inter',sans-serif">
                ✕ Remover
            </button>
        </div>`;
        const body = i === 0
            ? `<div style="font-size:11px;color:var(--text3);margin-top:4px;">💬 Usa a mensagem principal como legenda</div>`
            : `<textarea placeholder="Legenda para esta mídia (opcional)" rows="2"
                oninput="mediaItems[${i}].text = this.value"
                style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none;resize:vertical;font-family:'Inter',sans-serif;margin-top:6px;">${escHtml(m.text)}</textarea>`;
        return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;">${header}${body}</div>`;
    }).join('');
}

function removeMedia(i) {
    mediaItems.splice(i, 1);
    renderMediaList();
}

function clearMedia() {
    mediaItems = [];
    const fileInp = document.getElementById('media-file');
    if (fileInp) fileInp.value = '';
    renderMediaList();
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

function getMediaDelayMs() {
    if (mediaDelayMode === 'immediate') return 0;
    const val = parseInt(document.getElementById('delay-value')?.value || '0') || 0;
    const unit = document.getElementById('delay-unit')?.value || 'seconds';
    if (unit === 'seconds') return val * 1000;
    if (unit === 'minutes') return val * 60 * 1000;
    if (unit === 'hours') return val * 3600 * 1000;
    return 0;
}

// ── Timezone selector ────────────────────────────────────
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
    } else {
        btn.classList.remove('active');
    }
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
        const dateStr = now.toLocaleDateString('pt-BR', { timeZone: tz });
        el.textContent = `🕐 Agora em ${tz}: ${timeStr} — ${dateStr}`;
        el.style.color = 'var(--text3)';
    } catch {
        el.textContent = '⚠️ Fuso inválido';
        el.style.color = '#ef4444';
    }
}

// ── Create schedule ───────────────────────────────────────
async function createSchedule(e) {
    e.preventDefault();
    if (!selectedRecipients.length) { showToast('Selecione pelo menos um destinatário!', 'error'); return; }
    const instance_name = document.getElementById('schedule-instance')?.value || CURRENT_USER.instance_name;
    if (!instance_name) { showToast('Selecione um WhatsApp para envio!', 'error'); return; }
    const time = document.getElementById('schedule-time').value;
    const message = document.getElementById('schedule-message').value;
    if (message && message.length > 4096) { showToast('Mensagem muito longa (máx 4096 caracteres)!', 'error'); return; }
    if (!message && !mediaItems.length) { showToast('Digite uma mensagem ou adicione uma mídia!', 'error'); return; }

    const media_url = mediaItems.length ? mediaItems[0].url : '';
    const media_type = mediaItems.length ? mediaItems[0].type : '';
    const extra_medias = mediaItems.slice(1).map(m => ({ url: m.url, type: m.type, text: m.text }));
    const media_texts = mediaItems.map(m => m.text);
    const media_delay_ms = getMediaDelayMs();
    const frequency = document.getElementById('schedule-frequency').value;
    const schedule_date = document.getElementById('schedule-date')?.value || '';
    const send_delay = document.getElementById('schedule-delay')?.value || 'random';
    const timezone = document.getElementById('schedule-timezone')?.value || 'America/Sao_Paulo';
    if (frequency === 'date' && !schedule_date) { showToast('Selecione uma data!', 'error'); return; }

    const btn = document.getElementById('submit-btn');
    btn.disabled = true; btn.textContent = 'Criando...';
    try {
        const res = await authFetch(`${API}/api/schedules`, {
            method: 'POST',
            body: JSON.stringify({ recipients: selectedRecipients, message, media_url, media_type, media_texts, extra_medias, media_delay_ms, time, frequency, schedule_date, send_delay, instance_name, timezone })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`✅ Agendamento criado para ${selectedRecipients.length} destinatário(s)!`, 'success');
            resetForm();
            loadSchedules();
            setTimeout(() => showPage('dashboard'), 1000);
        } else showToast(data.error || 'Erro', 'error');
    } catch { showToast('Erro ao criar agendamento', 'error'); }
    btn.disabled = false; btn.textContent = '⚡ Criar Agendamento';
}

function resetForm() {
    selectedRecipients = [];
    updateSelectedTags();
    renderRecipients();
    mediaItems = [];
    clearMedia();
    document.getElementById('schedule-time').value = '';
    document.getElementById('schedule-message').value = '';
    document.getElementById('schedule-frequency').value = 'daily';
    document.getElementById('date-picker-wrap').style.display = 'none';
    document.getElementById('schedule-delay').value = 'random';
    const freqGroups = document.querySelectorAll('.frequency-options');
    if (freqGroups[0]) freqGroups[0].querySelectorAll('.freq-option').forEach((e, i) => e.classList.toggle('selected', i === 0));
    if (freqGroups[1]) freqGroups[1].querySelectorAll('.freq-option').forEach((e, i) => e.classList.toggle('selected', i === 1));
    loadInstanceSelector();
    document.querySelectorAll('.tz-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    const tzInput = document.getElementById('schedule-timezone');
    if (tzInput) tzInput.value = 'America/Sao_Paulo';
    const tzPreview = document.getElementById('tz-preview');
    if (tzPreview) tzPreview.textContent = '';
    const customTZ = document.getElementById('custom-timezone');
    if (customTZ) { customTZ.style.display = 'none'; customTZ.value = ''; }
}

// ── Dashboard ─────────────────────────────────────────────
function filterDashboard(filter, btn) {
    dashFilter = filter;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const titles = { all: 'Todos os Agendamentos', group: 'Agendamentos para Grupos', contact: 'Agendamentos para Contatos' };
    document.getElementById('dash-title').textContent = titles[filter];
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
        list.innerHTML = '<div class="empty">Nenhum agendamento cadastrado.<br><br><button class="btn btn-primary" onclick="showPage(\'schedule\')">+ Criar agendamento</button></div>';
        return;
    }
    const freqLabel = { daily: '🔁 Diário', once: '1️⃣ Somente 1×', monthly: '📅 Mensal', date: '📆 Data fixa' };
    list.innerHTML = filtered.map(s => {
        const names = s.recipients?.map(r => `${r.type === 'group' ? '👥' : '👤'} ${r.name}`).join(', ') || '';
        const totalMin = s.recipients?.length > 1 ? ` (~${s.recipients.length} min)` : '';
        return `<div class="schedule-item">
            <div class="schedule-time">${s.time}</div>
            <div class="schedule-info">
                <div class="schedule-group">${s.recipients?.length || 1} destinatário(s): <span style="color:var(--text2);font-weight:400">${escHtml(names.substring(0, 70))}${names.length > 70 ? '...' : ''}</span></div>
                <div class="schedule-message">${escHtml((s.message || '').substring(0, 80))}${(s.message || '').length > 80 ? '...' : ''}</div>
                <div class="schedule-meta">
                    ${s.active ? '<span class="badge badge-green">✓ Ativo</span>' : '<span class="badge badge-yellow">⏸ Pausado</span>'}
                    <span class="badge badge-blue">${freqLabel[s.frequency] || '🔁 Diário'}</span>
                    ${s.schedule_date ? `<span class="badge badge-purple">📆 ${s.schedule_date}</span>` : ''}
                    ${s.media_url ? `<span class="badge badge-blue">${s.media_type === 'video' ? '🎥' : '🖼️'} Mídia</span>` : ''}
                    ${s.instance_name ? `<span class="badge" style="color:var(--text3)">📱 ${escHtml(s.instance_name)}</span>` : ''}
                    ${s.timezone ? `<span class="badge" style="color:var(--text3)">🌍 ${s.timezone.split('/')[1] || s.timezone}</span>` : ''}
                    <span class="badge" style="color:var(--text3)">⏱${totalMin || ' 1 dest.'}</span>
                    ${s.last_sent ? `<span class="badge" style="color:var(--text3)">Enviado ${formatDate(s.last_sent)}</span>` : ''}
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
    showToast('⚡ Disparando mensagens...', 'success');
    try {
        const data = await (await authFetch(`${API}/api/send-now/${id}`, { method: 'POST' })).json();
        showToast(data.message || '✅ Enviando!', 'success');
        setTimeout(() => loadHistory(), 3000);
    } catch { showToast('Erro ao enviar', 'error'); }
}

async function toggleSchedule(id, active) {
    const s = schedules.find(s => s.id === id); if (!s) return;
    await authFetch(`${API}/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ ...s, active: !active }) });
    showToast(active ? '⏸ Pausado' : '▶️ Ativado', 'success');
    loadSchedules();
}

async function deleteSchedule(id) {
    if (!confirm('Deletar este agendamento?')) return;
    await authFetch(`${API}/api/schedules/${id}`, { method: 'DELETE' });
    showToast('🗑️ Deletado', 'success');
    loadSchedules();
}

// ── History ───────────────────────────────────────────────
async function loadHistory() {
    try {
        const r = await authFetch(`${API}/api/history`);
        const history = await r.json();
        const today = new Date().toDateString();
        const sentToday = history.filter(h => h.status === 'sent' && new Date(h.sent_at).toDateString() === today).length;
        const statEl = document.getElementById('stat-sent');
        if (statEl) statEl.textContent = sentToday;
        const list = document.getElementById('history-list');
        if (!list) return;
        if (!Array.isArray(history) || !history.length) {
            list.innerHTML = '<div class="empty">Nenhuma mensagem enviada ainda</div>';
            return;
        }
        const errors = history.filter(h => h.status === 'error');
        const banner = errors.length > 0
            ? `<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#f87171">
                ⚠️ <strong>${errors.length} envio(s) com erro</strong>. Verifique se o WhatsApp está conectado.
               </div>` : '';
        list.innerHTML = banner + history.map(h => {
            const isError = h.status === 'error';
            const errorDetail = isError && h.error ? `<div style="font-size:11px;color:#f87171;margin-top:3px">⚠️ ${escHtml(h.error)}</div>` : '';
            return `<div class="history-item" style="${isError ? 'border-left:3px solid #ef4444;' : ''}">
                <div class="history-status ${h.status}">${isError ? '❌' : '✅'}</div>
                <div class="history-info">
                    <div class="history-group">${h.recipient_type === 'group' ? '👥' : '👤'} ${escHtml(h.recipient_name || '—')}</div>
                    <div class="history-message">${escHtml((h.message || '').substring(0, 100))}${(h.message || '').length > 100 ? '...' : ''}</div>
                    ${errorDetail}
                </div>
                <div class="history-time">${formatDate(h.sent_at)}</div>
            </div>`;
        }).join('');
    } catch (e) {
        const list = document.getElementById('history-list');
        if (list) list.innerHTML = `<div class="empty" style="color:#f87171">❌ Erro: ${e.message}</div>`;
    }
}

// ── Admin Panel ───────────────────────────────────────────
async function loadAdminUsers() {
    const el = document.getElementById('admin-users-list');
    if (!el) return;
    el.innerHTML = '<div class="loading">Carregando usuários...</div>';
    try {
        const r = await authFetch('/admin/users');
        const users = await r.json();
        if (!users?.length) { el.innerHTML = '<p style="color:var(--text3);padding:16px">Nenhum usuário cadastrado.</p>'; return; }
        el.innerHTML = users.map(u => {
            const statusColor = u.active ? '#22c55e' : '#ef4444';
            const planLabel = { trial: '🟡 Trial', monthly: '🔵 Mensal', semiannual: '🟣 Semestral', annual: '🟠 Anual', unlimited: '⚡ Ilimitado' }[u.plan] || u.plan;
            const expires = u.plan_expires ? new Date(u.plan_expires).toLocaleDateString('pt-BR') : '—';
            const maxInst = u.max_instances || 1;
            const totalInst = (u.instances?.length || 0) + (u.instance_name && !u.instances?.some(i => i.name === u.instance_name) ? 1 : 0);
            return `<div style="border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--bg3)">
                <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                    <div style="display:flex;align-items:center;gap:10px">
                        <div style="width:10px;height:10px;border-radius:50%;background:${statusColor};flex-shrink:0"></div>
                        <div>
                            <div style="font-weight:600;font-size:14px">${escHtml(u.name)}</div>
                            <div style="font-size:11px;color:var(--text3)">${escHtml(u.email)}</div>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                        <span style="font-size:11px;background:var(--bg2);padding:3px 8px;border-radius:6px">${planLabel}</span>
                        <span style="font-size:11px;background:var(--bg2);padding:3px 8px;border-radius:6px">📅 ${expires}</span>
                        <span style="font-size:11px;background:var(--bg2);padding:3px 8px;border-radius:6px">📱 ${totalInst}/${maxInst} WA</span>
                    </div>
                </div>
                <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <button class="btn btn-secondary" style="font-size:12px;padding:6px 12px"
                        onclick="openGroupsModal('${u.id}', '${escHtml(u.name).replace(/'/g, "\\'")}', '${escHtml(u.instance_name || '').replace(/'/g, "\\'")}')">
                        👥 Ver Grupos
                    </button>
                    <div style="display:flex;align-items:center;gap:6px;margin-left:auto">
                        <span style="font-size:12px;color:var(--text3)">Limite WhatsApps:</span>
                        <input type="number" min="1" max="10" value="${maxInst}" 
                            style="width:52px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--text);font-size:12px;text-align:center"
                            onchange="setMaxInstances('${u.id}', this.value)">
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = `<p style="color:#ef4444;padding:16px">Erro: ${e.message}</p>`;
    }
}

async function setMaxInstances(userId, value) {
    const max = parseInt(value);
    if (!max || max < 1) return;
    try {
        const r = await authFetch(`/admin/users/${userId}/max-instances`, {
            method: 'PUT',
            body: JSON.stringify({ max_instances: max })
        });
        const data = await r.json();
        if (data.success) showToast(`✅ Limite atualizado para ${max} WhatsApp(s)`, 'success');
        else showToast(data.error || 'Erro', 'error');
    } catch (e) { showToast('Erro: ' + e.message, 'error'); }
}

async function openGroupsModal(userId, userName, instanceName) {
    const modal = document.getElementById('admin-groups-modal');
    if (modal) modal.style.display = 'block';
    document.getElementById('modal-user-name').textContent = '👥 Grupos de ' + userName;
    document.getElementById('modal-user-instance').textContent = 'Instância: ' + (instanceName || '—');
    const listEl = document.getElementById('modal-groups-list');
    listEl.innerHTML = '<div class="loading">Buscando grupos...</div>';
    try {
        const gr = await authFetch('/admin/users/' + userId + '/groups');
        const grps = await gr.json();
        if (!grps?.length) {
            listEl.innerHTML = '<p style="color:var(--text3);padding:8px">Nenhum grupo encontrado (WhatsApp pode estar desconectado).</p>';
            return;
        }
        listEl.innerHTML = `<p style="font-size:12px;color:var(--text3);margin-bottom:12px">📋 ${grps.length} grupos</p>` +
            grps.map(g => `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--bg3)">
                <div style="font-weight:600;font-size:14px;margin-bottom:2px">💬 ${escHtml(g.name)}</div>
                <div style="font-size:11px;color:var(--text3);margin-bottom:10px">👥 ${g.participants} participantes</div>
                <button class="btn btn-primary" style="font-size:12px;padding:6px 14px" onclick="joinGroup('${g.id}', this)">➕ Entrar no grupo</button>
            </div>`).join('');
    } catch (e) {
        listEl.innerHTML = `<p style="color:#ef4444;padding:8px">Erro: ${e.message}</p>`;
    }
}

function closeGroupsModal() {
    const modal = document.getElementById('admin-groups-modal');
    if (modal) modal.style.display = 'none';
}

async function joinGroup(groupId, btn) {
    btn.disabled = true; btn.textContent = '⏳ Entrando...';
    try {
        const resp = await authFetch('/admin/join-group', {
            method: 'POST',
            body: JSON.stringify({ groupId })
        });
        const res = await resp.json();
        if (res.pending) {
            btn.textContent = '⏳ Aguardando aprovação'; btn.style.background = '#ca8a04';
            showToast('⏳ Solicitação enviada!', 'warning');
        } else {
            btn.textContent = '✅ Entrou!'; btn.style.background = '#16a34a';
            showToast('✅ Entrou no grupo!', 'success');
        }
    } catch (e) {
        btn.disabled = false; btn.textContent = '➕ Entrar no grupo';
        showToast('❌ Erro: ' + e.message, 'error');
    }
}

// ── Admin History ─────────────────────────────────────────
let adminFullHistory = [];

async function loadAdminHistory() {
    const listEl = document.getElementById('admin-history-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">Carregando histórico geral...</div>';
    try {
        const r = await authFetch('/api/history');
        adminFullHistory = await r.json();

        const select = document.getElementById('admin-history-filter');
        if (select) {
            const usersMap = {};
            adminFullHistory.forEach(h => { if (h.userId) usersMap[h.userId] = h.recipient_name || h.userId; });
            select.innerHTML = '<option value="">— Todos os clientes —</option>' +
                Object.keys(usersMap).map(uid => `<option value="${uid}">${escHtml(usersMap[uid])} (${uid})</option>`).join('');
        }

        renderAdminHistory(adminFullHistory);
    } catch (e) {
        listEl.innerHTML = `<p style="color:#ef4444;padding:16px">Erro: ${e.message}</p>`;
    }
}

function filterAdminHistory() {
    const filterUserId = document.getElementById('admin-history-filter')?.value;
    const filtered = filterUserId ? adminFullHistory.filter(h => h.userId === filterUserId) : adminFullHistory;
    renderAdminHistory(filtered);
}

function renderAdminHistory(list) {
    const listEl = document.getElementById('admin-history-list');
    if (!listEl) return;
    if (!list.length) {
        listEl.innerHTML = '<p style="color:var(--text3);padding:16px">Nenhum envio registrado.</p>';
        return;
    }
    listEl.innerHTML = list.map(h => {
        const isError = h.status === 'error';
        return `<div class="history-item" style="${isError ? 'border-left:3px solid #ef4444;' : ''}">
            <div class="history-status ${h.status}">${isError ? '❌' : '✅'}</div>
            <div class="history-info">
                <div class="history-group">${h.recipient_type === 'group' ? '👥' : '👤'} ${escHtml(h.recipient_name || '—')}</div>
                <div class="history-message">${escHtml((h.message || '').substring(0, 100))}</div>
                ${isError && h.error ? `<div style="font-size:11px;color:#f87171;margin-top:3px">⚠️ ${escHtml(h.error)}</div>` : ''}
            </div>
            <div class="history-time">${formatDate(h.sent_at)}</div>
        </div>`;
    }).join('');
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
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
