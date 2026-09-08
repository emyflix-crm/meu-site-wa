// EmyFlix WA — Lucide Icons (SVG Inline)
// Sem dependências externas

const SVG_START = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">';
const SVG_END = '</svg>';

const ICONS = {
    'layout-dashboard': `${SVG_START}<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>${SVG_END}`,
    'calendar-plus': `${SVG_START}<path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="M16 19h6"/><path d="M19 16v6"/>${SVG_END}`,
    'megaphone': `${SVG_START}<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>${SVG_END}`,
    'clock': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>${SVG_END}`,
    'smartphone': `${SVG_START}<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>${SVG_END}`,
    'shield': `${SVG_START}<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>${SVG_END}`,
    'log-out': `${SVG_START}<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>${SVG_END}`,
    'users': `${SVG_START}<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>${SVG_END}`,
    'user': `${SVG_START}<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>${SVG_END}`,
    'send': `${SVG_START}<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>${SVG_END}`,
    'check-circle': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>${SVG_END}`,
    'x-circle': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>${SVG_END}`,
    'pause-circle': `${SVG_START}<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>${SVG_END}`,
    'play-circle': `${SVG_START}<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/>${SVG_END}`,
    'trash': `${SVG_START}<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>${SVG_END}`,
    'edit': `${SVG_START}<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>${SVG_END}`,
    'copy': `${SVG_START}<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>${SVG_END}`,
    'search': `${SVG_START}<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>${SVG_END}`,
    'refresh-cw': `${SVG_START}<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>${SVG_END}`,
    'plus': `${SVG_START}<path d="M5 12h14"/><path d="M12 5v14"/>${SVG_END}`,
    'arrow-right': `${SVG_START}<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>${SVG_END}`,
    'zap': `${SVG_START}<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>${SVG_END}`,
    'wifi': `${SVG_START}<path d="M5 13a10 10 0 0 1 14 0"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 20 0"/><line x1="12" x2="12.01" y1="20" y2="20"/>${SVG_END}`,
    'wifi-off': `${SVG_START}<line x1="2" x2="22" y1="2" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.82"/><path d="M12 20h.01"/>${SVG_END}`,
    'qr-code': `${SVG_START}<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>${SVG_END}`,
    'upload': `${SVG_START}<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>${SVG_END}`,
    'image': `${SVG_START}<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>${SVG_END}`,
    'video': `${SVG_START}<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>${SVG_END}`,
    'filter': `${SVG_START}<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>${SVG_END}`,
    'chevron-down': `${SVG_START}<path d="m6 9 6 6 6-6"/>${SVG_END}`,
    'info': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>${SVG_END}`,
    'alert-triangle': `${SVG_START}<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>${SVG_END}`,
    'star': `${SVG_START}<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>${SVG_END}`,
    'crown': `${SVG_START}<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/>${SVG_END}`,
    'diamond': `${SVG_START}<path d="M6 3h12l4 6-10 12L2 9Z"/><path d="M11 3 8 9l4 12"/><path d="M13 3l3 6-4 12"/>${SVG_END}`,
    'settings': `${SVG_START}<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>${SVG_END}`,
    'help-circle': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>${SVG_END}`,
    'eye': `${SVG_START}<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>${SVG_END}`,
    'eye-off': `${SVG_START}<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>${SVG_END}`,
    'menu': `${SVG_START}<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>${SVG_END}`,
    'x': `${SVG_START}<path d="M18 6 6 18"/><path d="m6 6 12 12"/>${SVG_END}`,
    'bar-chart': `${SVG_START}<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>${SVG_END}`,
    'message-circle': `${SVG_START}<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>${SVG_END}`,
    'link': `${SVG_START}<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>${SVG_END}`,
    'bell': `${SVG_START}<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>${SVG_END}`,
    'check': `${SVG_START}<path d="M20 6 9 17l-5-5"/>${SVG_END}`,
    'minus': `${SVG_START}<path d="M5 12h14"/>${SVG_END}`,
    'loader': `${SVG_START}<path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>${SVG_END}`,
    'globe': `${SVG_START}<circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/>${SVG_END}`,
    'hash': `${SVG_START}<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>${SVG_END}`
};

function icon(name, size = 18, extraClass = '') {
    const svg = ICONS[name];
    if (!svg) return '';
    const sizeStyle = \`width:\${size}px;height:\${size}px;\`;
    return \`<span class="icon \${extraClass}" style="display:inline-flex;align-items:center;justify-content:center;\${sizeStyle}flex-shrink:0;">\${svg}</span>\`;
}

if (typeof window !== 'undefined') {
    window.ICONS = ICONS;
    window.icon = icon;
}
