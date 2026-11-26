// 全局状态
let accounts = [];
let availableRewards = [];
let autoScroll = true;
let eventSource = null;
let currentUser = null;
let currentAuthToken = localStorage.getItem("ctyun_auth_token") || sessionStorage.getItem("ctyun_auth_token") || "";
let allReceivedLogs = [];
// 【2026-09-25 用户要求·第六轮】已渲染日志行的注册表：行身份键 → HTMLElement。
// 为什么必须有它：SSE 在**每次连接/重连**都会重发最近 80 条历史，而旧代码里
// "非 isUpdate 分支"是无条件 appendChild —— 于是每重连一次就把同一批日志再画一遍，
// 用户看到的就是同一件事带着 x3353、x3354、x3355 … 一长串计数铺满屏幕。
let renderedLogLines = new Map();
// 【2026-09-24 用户要求·第三轮】默认显示「全部」，不再默认只显示「任务」分栏
let activeLogFilter = 'all';
let activePlatformFilter = 'all'; // 'all' | 'ctyun' | 'ydpc' | 'ecloud'
let activeAccountViewTab = 'all'; // 'all' | 'ctyun' | 'ydpc' | 'ecloud'
let currentAddPlatform = 'ctyun';  // 'ctyun' | 'ydpc' | 'ecloud'
// 移动公众两段式登录：需要短信验证时后端返回 pendingId，这里保存中间态
// （未声明时读取会抛 ReferenceError，故必须显式声明）
let pendingEcloudLogin = null; // { pendingId, branch, mobile, name, user, password, keepaliveInterval }
let authMode = "login";
let cachedPointsDetails = [];
let activeEditingAccId = null;
let currentCaptchaChallenge = null;
let qrPollingTimer = null;
let currentQrCodeId = '';
let smsCountdown = 0;
let currentPowerDesktopId = '';
let currentPowerAccountDesktops = [];

// 请求包装：单用户模式（2026-11-25）不再携带任何 token —— 后端固定 owner 'local'
async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  return fetch(url, options);
}

// 把 fetch 的网络层失败翻成人话：容器重启的那几秒、手机热点断了，浏览器只会抛
// TypeError: Failed to fetch，直接展示给用户等于什么都没说。
function netErrText(err) {
  const name = String((err && err.name) || "");
  const msg = String((err && err.message) || err || "");
  if (name === "AbortError") return "请求超过 12 秒未返回（面板可能正忙或在重启）";
  if (name === "TypeError" || /Failed to fetch|NetworkError|Load failed|network error|fetch failed/i.test(msg)) {
    return "连不上面板服务（可能正在重启或网络已断）";
  }
  return msg || "未知错误";
}

function isTransientNetErr(err) {
  const name = String((err && err.name) || "");
  return name === "TypeError" || name === "AbortError";
}

document.addEventListener("DOMContentLoaded", () => {
  allReceivedLogs = [];
  renderedLogLines.clear();
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = "";
  initLocalSession();
  // 首屏是「实例看板」，它的唯一数据源是 /api/resources；账号视图（/api/accounts + /api/status）
  // 按需懒加载，避免首屏与后台每 5 秒都多打一份 56KB 的账号列表。
  if (false) {
    loadStatus();
    loadAccounts();
  }
  setInterval(() => {
    if (boardActiveView !== "accounts") return; // 看板自己有 15s 刷新
    loadAccounts(true);
    loadStatus();
  }, 5000);

  window.addEventListener("focus", () => {
    if (boardActiveView !== "accounts") return;
    loadAccounts(true);
    loadStatus();
  });

  // 监听登录弹窗中的回车键，按回车直接提交登录！
  const authInputs = [document.getElementById("auth-username"), document.getElementById("auth-password")];
  authInputs.forEach(el => {
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAuth();
        }
      });
    }
  });
});

// 头像下拉菜单控制
function toggleUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  const btn = document.getElementById("header-avatar");
  if (btn && menu) btn.setAttribute("aria-expanded", menu.classList.contains("hidden") ? "false" : "true");
  hideSettingsMenu();
}

function hideUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.add("hidden");
  const btn = document.getElementById("header-avatar");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

// 系统设置下拉菜单控制
function toggleSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  hideUserMenu();
}

function hideSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

// 点击页面其他区域自动收起所有下拉菜单
document.addEventListener("click", (e) => {
  const userContainer = document.getElementById("user-dropdown-container");
  if (userContainer && !userContainer.contains(e.target)) {
    hideUserMenu();
  }
  const settingsContainer = document.getElementById("settings-dropdown-container");
  if (settingsContainer && !settingsContainer.contains(e.target)) {
    hideSettingsMenu();
  }
});

// 检查当前登录用户身份
// 单用户模式（阶段 1 起后端恒为 local）：首屏不再打 /api/auth/me，/api/resources 是唯一数据源。
// 这里只做既有 UI 需要的本地占位会话与面板解锁；账号视图真正要权限时后端也是同一个 local。
function initLocalSession() {
  currentUser = { userId: "local", username: "local", role: "admin", avatar: "" };
  const authBtn = document.getElementById("btn-auth-action");
  const loggedActionsGroup = document.getElementById("logged-actions-group");
  const statsGrid = document.getElementById("main-stats-grid");
  const sectionHeader = document.getElementById("main-section-header");
  const logPanel = document.getElementById("main-log-panel");
  const headerAvatar = document.getElementById("header-avatar");
  const dropdownUsername = document.getElementById("dropdown-username");
  const menuAdminUsers = document.getElementById("menu-admin-users");
  if (authBtn) authBtn.classList.add("hidden");
  if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
  if (statsGrid) statsGrid.classList.remove("hidden");
  if (sectionHeader) sectionHeader.classList.remove("hidden");
  if (logPanel) logPanel.classList.remove("hidden");
  if (headerAvatar) headerAvatar.innerText = "L";
  if (dropdownUsername) dropdownUsername.innerText = "local (管理员)";
  if (menuAdminUsers) menuAdminUsers.classList.remove("hidden");
  const versionBadge = document.getElementById("footer-version-badge");
  if (versionBadge) {
    versionBadge.style.color = "var(--accent)";
    versionBadge.style.cursor = "pointer";
    versionBadge.style.textDecoration = "underline";
    versionBadge.title = "点击查看版本更新说明";
    versionBadge.onclick = openReleaseNotesModal;
  }
  initLogStream();
}

async function checkCurrentUser() {
  const authBtn = document.getElementById("btn-auth-action");
  const logPanel = document.getElementById("main-log-panel");
  const loggedActionsGroup = document.getElementById("logged-actions-group");
  const statsGrid = document.getElementById("main-stats-grid");
  const sectionHeader = document.getElementById("main-section-header");
  const headerAvatar = document.getElementById("header-avatar");
  const dropdownUsername = document.getElementById("dropdown-username");
  const menuAdminUsers = document.getElementById("menu-admin-users");

  // 如果本地有持久化凭据，提前恢复界面，消除刷新时 1~2 秒由于异步网络导致的“白屏返回登录界面”闪烁等待！
  if (currentAuthToken) {
    if (authBtn) authBtn.classList.add("hidden");
    if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
    if (statsGrid) statsGrid.classList.remove("hidden");
    if (sectionHeader) sectionHeader.classList.remove("hidden");
    if (logPanel) logPanel.classList.remove("hidden");
  }

  try {
    const res = await authFetch("/api/auth/me");
    const data = await res.json();

    // 动态同步主标题与副标题名称
    if (data.systemTitle) {
      const titleEl = document.getElementById("main-system-title");
      if (titleEl) titleEl.innerText = data.systemTitle;
      document.title = `${data.systemTitle} - 多账号保活控制台`;
    }
    if (data.systemSubtitle) {
      const subtitleEl = document.querySelector(".title-group p");
      if (subtitleEl) subtitleEl.innerText = data.systemSubtitle;
    }

    if (data.isLoggedIn && data.user) {
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      
      // 更新头像首字母/个性化头像和下拉菜单用户名
      const avatarText = currentUser.avatar || (currentUser.username || "A")[0].toUpperCase();
      if (headerAvatar) headerAvatar.innerText = avatarText;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);

      const menuChangePwd = document.getElementById("menu-change-pwd");
      if (menuChangePwd) {
        menuChangePwd.innerText = isAdmin ? "🔒 修改密码/用户名" : "🔒 修改密码";
      }

      const settingsDropdown = document.getElementById("settings-dropdown-container");
      if (settingsDropdown) settingsDropdown.classList.toggle("hidden", !isAdmin);

      // 未登录按钮隐藏，已登录整组展开
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      // 登录状态：显示可点击的蓝色超链接版本号
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      initLogStream();
    } else {
      currentUser = null;
      if (authBtn) {
        authBtn.classList.remove("hidden");
        authBtn.innerText = "🔑 立即登录";
        authBtn.onclick = openAuthModal;
      }
      
      // 未登录时隐藏所有业务区、控制台与已登录菜单
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");

      // 未登录状态：纯灰白普通文本，无下划线，不可点击
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--text-muted)";
        versionBadge.style.cursor = "default";
        versionBadge.style.textDecoration = "none";
        versionBadge.title = "";
        versionBadge.onclick = null;
      }
    }
  } catch (e) {
    if (!currentAuthToken) {
      if (authBtn) authBtn.classList.remove("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");
    }
  }
}

// Toast 提示 (带自动容错与自愈容器)
function showToast(message, type = "info") {
  // 轮询失败时同一条错误每 15 秒刷一次，屏幕会被同一条红条糊满；
  // 3 秒内同样的 (type, 文案) 只留一条，且容器里最多 4 条。
  const now = Date.now();
  if (showToast._last && showToast._last.msg === message && showToast._last.type === type &&
      now - showToast._last.at < 3000) return;
  showToast._last = { msg: message, type: type, at: now };
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.style.whiteSpace = "pre-line"; // 支持换行多排显示
  toast.innerText = message;
  container.appendChild(toast);
  while (container.children.length > 4) container.removeChild(container.firstChild);
  setTimeout(() => {
    toast.remove();
  }, 4500);
}

// 模态框辅助
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// 1. 加载系统统计
async function loadStatus() {
  try {
    const res = await authFetch("/api/status");
    const data = await res.json();
    document.getElementById("stat-total").innerText = data.accountsTotal || 0;
    document.getElementById("stat-online").innerText = data.onlineKeepAlive || 0;
    document.getElementById("stat-signed").innerText = data.signedToday || 0;
    document.getElementById("stat-points").innerText = data.totalEarnedPoints || 0;
    cachedPointsDetails = data.pointsDetails || [];
  } catch (e) {
    console.error("加载状态异常:", e);
  }
}

// 打开每日已获得积分详细明细模态框 (展示各任务具体达成时间节点)
function openPointsDetailModal() {
  const sumEl = document.getElementById("modal-points-sum");
  const listEl = document.getElementById("points-detail-list");
  const totalEarned = document.getElementById("stat-points").innerText || "0";
  sumEl.innerText = totalEarned;
  listEl.innerHTML = "";

  if (!cachedPointsDetails || cachedPointsDetails.length === 0) {
    listEl.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px;">暂无云电脑今日积分明细</div>`;
    openModal("points-detail-modal");
    return;
  }

  cachedPointsDetails.forEach(acc => {
    const item = document.createElement("div");
    item.style.cssText = "background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow-sm);";

    let taskRows = (acc.tasks || []).map(t => {
      const isDone = t.completed || t.points > 0;
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:8px 0; border-bottom:1px dashed #e2e8f0;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:14px;">${isDone ? '✅' : '⏳'}</span>
            <span style="font-weight:600; color:#0f172a;">${escapeHtml(t.name)}</span>
            <span style="font-size:11px; font-weight:700; color:${isDone ? '#16a34a' : '#64748b'}; background:${isDone ? '#f0fdf4' : '#f1f5f9'}; padding:2px 8px; border-radius:9999px; border:1px solid ${isDone ? '#bbf7d0' : '#e2e8f0'};">
              ${isDone ? `+${t.points} 积分` : `进行中 (${t.progress || '0/1'})`}
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; font-size:12px;">
            <span style="color:var(--text-muted);">达成时间节点:</span>
            <span style="font-family:monospace; font-weight:600; color:${isDone ? '#2563eb' : '#94a3b8'}; background:${isDone ? '#eff6ff' : '#f8fafc'}; padding:2px 8px; border-radius:4px; border:1px solid ${isDone ? '#dbeafe' : '#f1f5f9'};">
              ${isDone ? `🕒 ${escapeHtml(t.completedAt || '今日已达成')}` : '等待今日达成'}
            </span>
          </div>
        </div>
      `;
    }).join("");

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--border);">
        <span style="font-size:14px; font-weight:700; color:#0f172a;">🖥️ ${escapeHtml(acc.accountName)}</span>
        <span style="font-size:13px; color:#16a34a; font-weight:700;">今日获得: +${acc.todayPoints}分 (总积分: ${acc.totalPoints})</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:2px;">
        ${taskRows}
      </div>
    `;
    listEl.appendChild(item);
  });

  openModal("points-detail-modal");
}

// 2. 加载多账号列表
async function loadAccounts(isSilent = false) {
  try {
    const res = await authFetch("/api/accounts");
    accounts = await res.json();
    renderAccounts();
    if (!isSilent) loadStatus();
  } catch (e) {
    if (!isSilent) showToast("加载账号列表失败: " + e.message, "error");
  }
}

function switchAccountViewTab(tab) {
  activeAccountViewTab = tab;
  const tabAll = document.getElementById("view-tab-all");
  const tabCt = document.getElementById("view-tab-ctyun");
  const tabYd = document.getElementById("view-tab-ydpc");
  const tabEc = document.getElementById("view-tab-ecloud");
  if (tabAll) tabAll.className = tab === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabCt) tabCt.className = tab === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabYd) tabYd.className = tab === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabEc) tabEc.className = tab === 'ecloud' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderAccounts();
}

// 记录每个卡片各折叠面板的展开/收起状态 (持久化到 localStorage)
function getDetailsStateKey(accId, panelKey) {
  return `ctyun_details_${accId}_${panelKey}`;
}

function isDetailsOpen(accId, panelKey, defaultOpen = true) {
  const saved = localStorage.getItem(getDetailsStateKey(accId, panelKey));
  if (saved === null) return defaultOpen;
  return saved === 'true';
}

function saveDetailsState(accId, panelKey, isOpen) {
  localStorage.setItem(getDetailsStateKey(accId, panelKey), String(isOpen));
}

// 获取当前网格的响应式列数
function getGridColumns() {
  const container = document.getElementById("accounts-container");
  if (!container) return 3;
  const style = window.getComputedStyle(container);
  const gridTemplateColumns = style.gridTemplateColumns;
  if (!gridTemplateColumns || gridTemplateColumns === "none") return 3;
  const cols = gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  return Math.max(1, cols);
}

// 缓存当前用户的网格插槽布局状态: array of (accId | null)
function getGridSlotsKey() {
  const uid = currentUser?.userId || 'u_admin';
  return `ctyun_grid_slots_${uid}_${activeAccountViewTab}`;
}

// 当前已配置的平台集合（三平台并行：ctyun / ydpc / ecloud）
// 只有 >=2 个平台并存时才展示平台视图 Tab 与筛选，单平台时自动隐藏以免视觉噪音。
function getPresentPlatforms() {
  const set = new Set();
  for (const a of (accounts || [])) {
    if (!a) continue;
    set.add(a.platform || 'ctyun');
  }
  return set;
}

function getFilteredAccounts() {
  const platforms = getPresentPlatforms();
  const multi = platforms.size >= 2;
  return (accounts || []).filter(acc => {
    if (!multi) return true; // 单一平台不过滤
    if (activeAccountViewTab === 'all') return true;
    if (activeAccountViewTab === 'ctyun') return acc.platform === 'ctyun' || !acc.platform;
    if (activeAccountViewTab === 'ydpc') return acc.platform === 'ydpc';
    if (activeAccountViewTab === 'ecloud') return acc.platform === 'ecloud';
    return true;
  });
}

function loadGridSlots(filteredAccs, cols) {
  const key = getGridSlotsKey();
  let savedSlots = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) savedSlots = JSON.parse(raw);
  } catch (e) {}

  const currentIds = new Set(filteredAccs.map(a => a.id));
  let slots = Array.isArray(savedSlots) ? [...savedSlots] : [];

  // 清理不存在于当前过滤列表的无效 ID
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] && !currentIds.has(slots[i])) {
      slots[i] = null;
    }
  }

  // 确保所有当前账号都已映射到插槽
  const placedIds = new Set(slots.filter(Boolean));
  for (const acc of filteredAccs) {
    if (!placedIds.has(acc.id)) {
      const emptyIdx = slots.indexOf(null);
      if (emptyIdx !== -1) {
        slots[emptyIdx] = acc.id;
      } else {
        slots.push(acc.id);
      }
      placedIds.add(acc.id);
    }
  }

  // 计算最后一个实际有卡片占用的插槽索引
  let lastOccupied = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i] && currentIds.has(slots[i])) {
      lastOccupied = i;
      break;
    }
  }

  // 约束总行数：以最高占用行与最少必要行对齐，杜绝末尾凭空多出空行
  const minRows = Math.ceil(filteredAccs.length / cols);
  const occupiedRows = lastOccupied >= 0 ? Math.ceil((lastOccupied + 1) / cols) : 0;
  const totalRows = Math.max(minRows, occupiedRows, 1);
  const totalSlots = totalRows * cols;

  if (slots.length > totalSlots) {
    slots = slots.slice(0, totalSlots);
  }
  while (slots.length < totalSlots) {
    slots.push(null);
  }

  return slots;
}

function saveGridSlots(slots) {
  const key = getGridSlotsKey();
  try {
    localStorage.setItem(key, JSON.stringify(slots));
  } catch (e) {}
}

function buildOfficialTasksHtml(m) {
  if (m.officialTasks && m.officialTasks.length > 0) {
    return m.officialTasks.map(t => {
      const isDone = t.status === 2 || (t.total > 0 && t.current >= t.total);
      const percent = Math.min(100, Math.round((t.current / (t.total || 1)) * 100));
      let progressText = `${t.current}/${t.total}`;
      if (t.name.includes('使用1小时')) {
        const mins = Math.floor(t.current / 60);
        progressText = `${mins}分钟 (${t.current}/3600秒)`;
      }

      return `
        <div style="background: #ffffff; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.02);">
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 5px; gap: 6px;">
            <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🎯 <b style="color:#0f172a;">${t.name}</b> <span style="color:#2563eb; font-weight:600;">(+${t.points}分)</span></span>
            <span style="color: ${isDone ? '#16a34a' : '#d97706'}; font-weight: 700; flex-shrink: 0; font-size: 11px;">
              ${isDone ? '✅ 已达成' : '⏳ ' + progressText}
            </span>
          </div>
          <div style="background: #e2e8f0; height: 5px; border-radius: 4px; overflow: hidden;">
            <div style="background: ${isDone ? '#16a34a' : '#2563eb'}; width: ${percent}%; height: 100%; transition: width 0.3s ease;"></div>
          </div>
        </div>
      `;
    }).join('');
  }
  return `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 6px 0;">正在同步天翼云官方任务中心数据...</div>`;
}

// 计算单账号多机周期的综合概览展示文本 (支持单机差异化周期精准动态呈现)
// 注：天翼云以「秒」为表达单位，移动爱家与移动公众以「分钟」为表达单位（各自习惯不同）。
function buildIntervalOverviewText(acc) {
  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  const useMinutes = isYdpc || isEcloud;
  const fallbackSec = isYdpc ? 600 : (isEcloud ? 300 : 30);
  const defaultIntervalSec = parseInt(acc.keepaliveInterval || acc.pulseIntervalSeconds) || fallbackSec;
  const items = isYdpc ? (acc.vms || []) : (acc.desktops || []);

  // 1. 若仅有 1 台云电脑，直接精准展示该主机的实际生效周期
  if (items.length === 1) {
    const singleSec = parseInt(items[0].keepaliveInterval) || defaultIntervalSec;
    return useMinutes ? `${Math.round(singleSec / 60)} 分钟` : `${singleSec}s`;
  }

  // 2. 若有多台云电脑
  if (items.length > 1) {
    const itemIntervals = items.map(it => parseInt(it.keepaliveInterval) || defaultIntervalSec);
    const allSame = itemIntervals.every(v => v === itemIntervals[0]);
    // 若多台云电脑设置的周期全部相同，直接统一展示该周期
    if (allSame) {
      return useMinutes ? `${Math.round(itemIntervals[0] / 60)} 分钟` : `${itemIntervals[0]}s`;
    }
    // 周期各不相同时，展示多机独立详情
    const parts = items.map(it => {
      const sec = parseInt(it.keepaliveInterval) || defaultIntervalSec;
      const rawName = String(it.vmName || it.machineName || it.desktopName || '主机');
      const shortName = rawName.slice(0, 4);
      return `${shortName} ${useMinutes ? Math.round(sec / 60) + '分' : sec + 's'}`;
    });
    return `多机独立 (${parts.join(' · ')})`;
  }

  return useMinutes ? `${Math.round(defaultIntervalSec / 60)} 分钟` : `${defaultIntervalSec}s`;
}

// ====================================================
// 📱 移动云：按主机维度的保活状态渲染
// ----------------------------------------------------
// 为什么需要：一个移动云账号下可挂多台云电脑，各机状态（运行/关机/时长耗尽/
// 单机保活开关/独立周期/数据面是否在场）可以完全不同。原来这里只有一行
// 账号级"当前动作"，既表达不了多机差异，又会长期停在「保活巡检待命中」。
// 现在逐台渲染；状态文字一律来自后端下发的 vm.keepAliveView（前端不臆造状态），
// 只有"距下次巡检"倒计时在本地按 nextDueAt 现算，保证 5 秒轮询下始终新鲜。
// ====================================================
const YDPC_TONE_COLORS = {
  ok: '#16a34a',     // 正常保活
  idle: '#0284c7',   // 等待/即将执行
  warn: '#d97706',   // 时长耗尽等需要注意
  off: '#94a3b8',    // 未参与/已关闭
  error: '#dc2626'   // 异常
};
const YDPC_TONE_DOTS = {
  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴'
};

// 剩余秒数 → 人类可读（秒 / 分钟 / 小时+分）
function formatYdpcRemainText(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

// 构造移动云"名下各主机当前动作"整块 HTML（逐台一行区，含状态/当前动作/时间与倒计时）
function buildYdpcVmMonitorHtml(acc) {
  const vms = acc.vms || acc.liveMetrics?.vms || [];
  if (!vms.length) {
    return '<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">暂未拉取到名下云主机，点击下方心跳或握手自动同步</div>';
  }

  return vms.map(vm => {
    const usid = String(vm.userServiceId || '');
    const vmName = vm.vmName || '移动云电脑';
    const view = vm.keepAliveView || null;

    // 后端视图缺失时降级：只展示能从 vm 直接读到的信息，绝不假装知道当前动作
    if (!view) {
      const running = String(vm.vmStatus || '').includes('运行') || vm.vmStatusCode === 1;
      return `
        <div class="vm-mon-row" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
          <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
            <span style="flex-shrink: 0;">${running ? '🟢' : '⚪'}</span>
            <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>
          </div>
          <div style="font-size: 11.5px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">当前动作: 等待后端状态同步…</div>
        </div>
      `;
    }

    const toneColor = YDPC_TONE_COLORS[view.tone] || '#64748b';
    const dot = YDPC_TONE_DOTS[view.tone] || '⚪';

    // 周期文本
    const intervalSec = parseInt(view.intervalSec) || 600;
    const intervalText = intervalSec >= 60 ? `${Math.round(intervalSec / 60)} 分钟` : `${intervalSec} 秒`;

    // 距下次巡检倒计时：仅"运行中 + 单机保活开着 + 已有保活记录"才是有效语义
    let nextText = '';
    if (view.running && view.keepaliveOn && view.nextDueAt > 0) {
      const remainSec = (view.nextDueAt - Date.now()) / 1000;
      nextText = remainSec <= 0
        ? ' · <b style="color: #0284c7;">即将巡检</b>'
        : ` · 距下次 <b style="color: #0f172a;">${formatYdpcRemainText(remainSec)}</b>`;
    }

    const timeLine = view.lastKeepAliveText
      ? `上次保活: <b style="color: #0f172a;">${escapeHtml(view.lastKeepAliveText)}</b> · 周期: <b>${intervalText}</b>${nextText}`
      : `周期: <b>${intervalText}</b>${nextText}`;

    const actionLine = view.lastActionText
      ? `最近动作: <span style="color: ${toneColor}; font-weight: 600;">${escapeHtml(view.lastActionText)}</span>`
      : '';

    // 【2026-09-25 用户要求】「上次保活: …」这一行会被 ellipsis 截断（卡片窄），
    // 用户要求鼠标悬停时能看到完整内容 ⇒ 用**去标签后的纯文本**做 title（title 属性不吃 HTML）。
    const timeLineFull = htmlToPlainTitle(timeLine + (actionLine ? ' · ' + actionLine : ''));

    // 【2026-09-24 用户要求·第四轮】「当前动作」后面的动作文字原先没写 font-size ⇒ 继承卡片正文字号
    // （.account-card 未声明 font-size，实际落到浏览器默认 16px），与 11.5px 的「当前动作:」标签一比就显大。
    // 此处显式对齐到 11.5px（颜色 / 字重不变）。
    //
    // 【2026-09-25 用户要求·第七轮】同一个"未声明字号"的坑也发生在**主机名**那一行：
    // 监视板块（.features-box）整体未声明 font-size，"云电脑省侧部署包高阶版月报 / 8C16G版云电脑月包 /
    // 我的电脑" 这类名称便以 16px 渲染，与周围 11 / 11.5 / 12px 的文字比明显偏大。
    // 现显式声明 12px —— 与「名下云主机」列表（.vm-device-item 本就是 12px）对齐，整卡字号重回一档。
    return `
      <div class="vm-mon-row" id="vm-mon-${acc.id}-${escapeHtml(usid)}" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
        <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0;">${dot}</span>
          <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0; padding-left: 16px;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span>
          <span title="${escapeHtml(view.actionText || '')}" style="font-size: 11.5px; color: ${toneColor}; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(view.actionText || '待命中')}</span>
        </div>
        <div title="${escapeHtml(timeLineFull)}" style="font-size: 11.5px; color: #475569; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${timeLine}${actionLine ? ' · ' + actionLine : ''}</div>
        ${view.hintText ? `<div style="font-size: 11px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(view.hintText)}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ====================================================
// 📡 移动公众：分层保活状态渲染
// ----------------------------------------------------
// 用户明令「移动爱家、移动公众、天翼云电脑，他们三个的保活代码机制不要重叠，各是各的，
// 日志也是」。因此本段**刻意不复用** buildYdpcVmMonitorHtml 的色调表 / 文案模板 /
// keepAliveView 字段（那是 userServiceId 主键 + 运行/关机语义）；移动公众自有：
//   - 主键 instanceId（与 ydpc 的 userServiceId 各自独立）
//   - 保活分层语义 L1 账号态 / L2 桌面登记（原 L3 占位层已于 2026-09-26 整层删除）
//   - 诚实性标注 claim:'none' —— HTTP 层探针成功 ≠ 云电脑不会被关机
// 视图数据一律来自后端下发的 desktop.keepAliveView（前端不臆造状态）。
// ====================================================
const ECLOUD_TONE_COLORS = {
  ok: '#16a34a',     // 探针通过（与移动爱家 ok 同色 —— 用户 2026-09-24：三平台「当前动作」文字颜色要一致）
  idle: '#0284c7',   // 等待/即将巡检
  warn: '#d97706',   // 需注意（如周期未到但上次异常）
  off: '#94a3b8',    // 未参与/已关闭
  error: '#dc2626',  // 异常
  unknown: '#7c3aed' // 尚未判定
};
const ECLOUD_TONE_DOTS = {
  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴', unknown: '🟣'
};
// 【2026-09-24 用户要求·第二轮】移动公众的账号头像原先单独覆写品牌色（旧紫 #7c3aed → 后改 #0369a1），
// 而另两平台头像都沿用 style.css 的 .account-avatar 默认浅色 → 被用户判为「搞特殊」。
// 现**不再覆写**：三平台头像统一走 .account-avatar 默认样式（原用于头像的那个强调色常量已一并移除）。

// 剩余秒数 → 人类可读（移动公众自有实现，与移动爱家的 formatYdpcRemainText 分开）
function formatEcloudRemainText(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

// 单机色调：关闭 > 异常 > 成功 > 待命
function ecloudViewTone(view) {
  if (!view) return 'unknown';
  if (!view.enabled) return 'off';
  const lvl = view.lastAction && view.lastAction.level;
  if (lvl === 'error') return 'error';
  if (lvl === 'warn') return 'warn';
  if (lvl === 'off') return 'off';
  if (lvl === 'ok') return 'ok';
  return 'idle';
}

// 【2026-09-24 用户要求】原「L1 账号态徽章」与「分层保活总览条」（L1/L2/L3 三行）
// 已从卡片移除 —— 卡片刻意只保留"账号下云电脑 + 逐台动作/保活状态"，
// 分层结论改由**日志流**承载（见 app/ecloud/ecloud_client.js 的 _logLayerSummary：
// L1 账号态 / L2 桌面登记的状态会在每轮巡检后写入 source='ECLOUD' 的日志）。
// 诚实性红线不变：L1/L2 只是 HTTP 层探针，探针成功 ≠ 云电脑不会被关机。

// 逐台云电脑"当前动作"整块 HTML（多机各自一行，状态全部来自后端 keepAliveView）
function buildEcloudDesktopMonitorHtml(acc) {
  const desktops = acc.desktops || acc.liveMetrics?.desktops || [];
  if (!desktops.length) {
    return '<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">暂未拉取到名下云主机，点击下方「同步桌面」或「立即保活」自动拉取</div>';
  }

  return desktops.map(d => {
    const iid = String(d.instanceId || '');
    const name = d.machineName || '移动公众云电脑';
    const view = d.keepAliveView || null;
    // 【2026-09-24 用户要求】逐台监视行做减法：不再显示「启用徽章」与厂商徽章 CMSSZTE（两枚一并删除）——
    // 这些信息在「名下云主机」列表里已有；本行只保留 圆点 + 名称 + 当前动作。

    // 视图缺失时降级：只陈述客观事实，绝不臆造"当前动作"
    if (!view) {
      return `
        <div class="ec-mon-row" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
          <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
            <span style="flex-shrink: 0;">🟣</span>
            <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</span>
          </div>
          <div style="font-size: 11.5px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">当前动作: 等待后端状态同步…</div>
        </div>
      `;
    }

    const tone = ecloudViewTone(view);
    const toneColor = ECLOUD_TONE_COLORS[tone] || '#64748b';
    const dot = ECLOUD_TONE_DOTS[tone] || '⚪';

    const intervalSec = parseInt(view.intervalSec) || 300;
    const intervalText = intervalSec >= 60 ? `${Math.round(intervalSec / 60)} 分钟` : `${intervalSec} 秒`;

    // 距下次巡检倒计时：仅"本机启用 + 已有保活记录"才是有效语义，否则不显示假倒计时
    let nextText = '';
    if (view.enabled && view.elapsedSec > 0 && view.remainSec >= 0) {
      nextText = view.remainSec <= 0
        ? ' · <b style="color: #0284c7;">即将巡检</b>'
        : ` · 距下次 <b style="color: #0f172a;">${formatEcloudRemainText(view.remainSec)}</b>`;
    }

    const lastText = view.elapsedSec > 0
      ? `上次保活: <b style="color: #0f172a;">${formatEcloudRemainText(view.elapsedSec)}前</b> · 周期: <b>${intervalText}</b>${nextText}`
      : `周期: <b>${intervalText}</b>${nextText}`;

    const actionText = (view.lastAction && view.lastAction.text) || (view.enabled ? '待巡检' : (view.disabledReason || '未参与巡检'));

    // 【2026-09-25 用户要求】同上：这一行会被 ellipsis 截断，悬停必须能看全 ⇒ title 用纯文本。
    const lastTextFull = htmlToPlainTitle(
      lastText + (view.uptime ? ` · 在线时长: ${view.uptime}` : '')
    );

    // 【2026-09-24 用户要求·第四轮】「当前动作」后面的动作文字显式对齐到 11.5px —— 原先未声明
    // font-size 会继承卡片正文字号（.account-card 未声明，实际是浏览器默认 16px），比 11.5px 的标签明显大。
    // 【2026-09-25 用户要求·第七轮】主机名同样补上显式 12px —— 理由与移动爱家监视行完全一致：
    // 这些 span 不写字号就会继承浏览器默认 16px，而周围是 11 / 11.5 / 12px，于是看着"字体偏大"。
    return `
      <div class="ec-mon-row" id="ec-mon-${acc.id}-${escapeHtml(iid)}" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
        <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0;">${dot}</span>
          <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(name)}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0; padding-left: 16px;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span>
          <span title="${escapeHtml(actionText)}" style="font-size: 11.5px; color: ${toneColor}; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(actionText)}</span>
        </div>
        <div title="${escapeHtml(lastTextFull)}" style="font-size: 11.5px; color: #475569; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${lastText}${view.uptime ? ` · 在线时长: <b>${escapeHtml(String(view.uptime))}</b>` : ''}</div>
        <div title="instanceId: ${escapeHtml(iid)}" style="font-size: 11px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">instanceId: ${escapeHtml(iid)}</div>
      </div>
    `;
  }).join('');
}

// 构造单个账号卡片 DOM 节点
function buildAccountCardElement(acc, slotIndex) {
  const card = document.createElement("div");
  card.className = "account-card";
  card.id = `acc-card-${acc.id}`;
  card.dataset.accId = acc.id;
  card.dataset.slot = slotIndex;
  card.draggable = true;

  // 绑定 HTML5 原生无损拖拽事件
  card.addEventListener("dragstart", handleCardDragStart);
  card.addEventListener("dragover", handleCardDragOver);
  card.addEventListener("dragleave", handleCardDragLeave);
  card.addEventListener("drop", handleCardDrop);
  card.addEventListener("dragend", handleCardDragEnd);

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  // 【2026-09-24 用户要求·第三轮】账号级「保活在线/离线待机」徽章（原 statusBadge）已删除，
  // 连带 isYdpcRealOnline 一并移除 —— 监视板块改为可折叠标题，不再显示该 logo。

  const fullPhone = escapeHtml(acc.user);
  const displayName = acc.name || acc.user;
  const isEditingThis = (activeEditingAccId === acc.id);
  const f = acc.features || {};
  const m = acc.liveMetrics || {};

  if (isEcloud) {
    // ====================================================
    // 📡 移动公众云电脑专属卡片呈现
    // ----------------------------------------------------
    // 版式参考移动爱家卡片（用户要求），但**渲染函数与数据字段完全独立**：
    // 主机主键是 instanceId、状态来自 desktop.keepAliveView（后端现算）、
    // 保活分层为 L1/L2/L3。任何一处复用移动爱家的模块都会破坏"机制与日志不重叠"。
    // ====================================================
    const desktops = acc.desktops || m.desktops || [];
    const desktopsCountText = desktops.length > 0 ? `名下云主机 (${desktops.length}台)` : '云主机';

    const isGlobalKeepAliveOff = f.keepAlive === false;

    let ecMultiStatusBadge = '';
    if (isGlobalKeepAliveOff) {
      ecMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
    } else {
      const anyKeepOn = desktops.some(d => d.keepaliveEnabled !== false);
      const allKeepOn = desktops.every(d => d.keepaliveEnabled !== false);
      if (allKeepOn && desktops.length > 1) {
        ecMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
      } else if (anyKeepOn) {
        ecMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
      } else {
        ecMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
      }
    }

    // 【2026-09-24 用户要求】原「侧车 ready / 引擎离线」小徽章已从卡片移除。
    // 侧车进程状态改为落日志流（ecloud_client.js 的 engine.on('exit') 会写错误日志）。
    // 【2026-09-24 用户要求·第三轮】账号级状态徽章（保活在线 / 部分降级 / 待短信验证 / 离线待机）
    // 亦已随「保活在线 logo」一并删除 —— 在线口径改由日志流承载，卡片不再重复声明。

    let desktopsHtml = '';
    if (desktops.length > 0) {
      desktopsHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ ${desktopsCountText}</span>
            <span id="acc-multi-status-${acc.id}">${ecMultiStatusBadge}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${desktops.map(d => {
              const iid = String(d.instanceId || '');
              const isKeepaliveOn = d.keepaliveEnabled !== false;

              // 【2026-09-28 修订】状态徽章改用**合成判定**（保留 keepAliveView.powerState）：
              //   依据优先级 = 在线时长探测(NO_UPTIME ⇒ 已关机) > 平台操作表(powerOnEnable) > 平台状态。
              //   单一信号都不可全信（实测：平台状态会滞后数小时；09-26 关机后"在线时长"还能继续计时）。
              //   title 里如实标注依据来源与平台原始 resourceStatus，便于对不上时排查。
              const view = d.keepAliveView || null;
              const powerState = String((view && view.powerState) || d.powerState || '').toLowerCase();
              const powerEvidence = (view && view.powerEvidence) || '平台状态';
              const statusRaw = escapeHtml(String(d.resourceStatus || '—'));
              const powerBadge = powerState === 'on'
                ? `<span class="badge badge-online" title="依据：${escapeHtml(powerEvidence)}；平台原始 resourceStatus: ${statusRaw}">运行中</span>`
                : (powerState === 'off'
                  ? `<span class="badge badge-offline" title="依据：${escapeHtml(powerEvidence)}；平台原始 resourceStatus: ${statusRaw}">已关机</span>`
                  : `<span class="badge" style="background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;" title="尚未取到运行状态（getDesktopStatus 未返回）">状态未知</span>`);

              // instanceId 很长（CCA-<32hex>）且整行会被 ellipsis 截断 ⇒ 悬停用 title 给出完整文本
              const iidLineText = `instanceId: ${iid || '—'}`;

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="ec-item-${acc.id}-${escapeHtml(iid)}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span style="font-size: 12px; color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(d.machineName || '移动公众云电脑')}</span>
                        ${d.originCompanyCode ? `<span class="badge" style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(d.originCompanyCode)}</span>` : ''}
                      </div>
                      <!-- instanceId 过长：整行省略号截断，鼠标悬停显示完整 ID -->
                      <div title="${escapeHtml(iidLineText)}" style="font-size: 11px; color: #64748b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(iidLineText)}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                      ${powerBadge}
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${escapeHtml(iid)}" onclick="toggleVmFeature('${acc.id}', '${escapeHtml(iid)}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关">⚡保活: ${keepText}</button>
                      <span class="pill-static" id="pill-interval-${acc.id}-${escapeHtml(iid)}" title="单台周期只读展示：要看板（实例）里改，或改账号级周期">${pillIntervalLabel(d.keepaliveInterval, acc.keepaliveInterval)}</span>
                      <!-- 【2026-09-28】单机自动开机守护开关：与账号级 features.autoBoot 构成双重把关
                           （沿用移动爱家设计；被平台强制关机后由守护自动拉起）。 -->
                      <button type="button" class="pill-toggle-btn ${d.autoBootEnabled !== false ? 'pill-on-keepalive' : 'pill-off-keepalive'}" id="pill-autoboot-${acc.id}-${escapeHtml(iid)}" onclick="toggleVmFeature('${acc.id}', '${escapeHtml(iid)}', 'autoBootEnabled', ${d.autoBootEnabled === false})" title="单台云电脑独立自动开机守护（需账号级「🛡️ 自动开机守护」同时开启；被平台强制关机后自动拉起，同机 10 分钟冷却）">🛡️守护: ${d.autoBootEnabled !== false ? '开' : '关'}</button>
                      <!-- 【2026-09-28】开机按钮接入：真实的平台 operate=available 通道（真机验证可受理）。
                           常驻可点（能力可见）；平台认为机器在运行时点击会得到平台原话的如实拒绝
                           （"当前状态为已开机，不允许进行如下操作:开机"），不会产生任何副作用。 -->
                      <button type="button" class="pill-toggle-btn pill-action-boot" id="pill-boot-${acc.id}-${escapeHtml(iid)}" onclick="bootEcloudDesktop('${acc.id}', '${escapeHtml(iid)}', '${escapeHtml(d.machineName || '')}')" title="${escapeHtml((view && view.powerOnHint) ? `平台开机操作提示：${view.powerOnHint}` : '通过平台官方 operate 通道开机（真机验证可受理；受理后约数十秒进入运行中）')}">🖥️ 开机</button>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      desktopsHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">暂未拉取到名下云主机，点击下方「同步桌面」自动拉取</div>`;
    }

    // 【2026-09-25 用户要求·第七轮】本栏目已更名为「名下云主机」，与移动爱家列表标题统一口径
    //（旧名见 git 历史，此处不再复述，避免注释措辞撞到"不得出现旧名"的反向断言）。
    // 说明留在 JS 注释里、不进 HTML 模板 —— 放进模板会变成真实 HTML 注释混在 DOM 中，
    // 也会让"反向断言扫到散文注释"的老问题复现（见回归网教训：注释措辞会撞自己的静态断言）。
    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <div class="account-name-row">
              <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
                <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
                <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
              </span>
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30">
            </div>
            <div class="account-phone">
              <span>${fullPhone}</span>
              <span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">移动公众</span>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑移动公众账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <!-- 🖥️ 名下云主机列表 -->
      ${desktopsHtml}

      <!-- 📡 移动公众专属：逐台保活监视（原先的 L1/L2/L3 分层总览条已按用户要求移入日志流） -->
      <!-- 【2026-09-24 用户要求·第三轮】账号级「保活在线」徽章已删除，
           本板块改为**可点击收起/展开**，折叠状态按账号持久化（与其它折叠盒同机制）。 -->
      <!-- 【2026-09-25 用户要求·第七轮】标题尾部那条「· xxx」后缀已按用户要求删掉，只留
           平台名 + 板块名，与移动爱家标题风格对齐（旧后缀原文见 git 历史与测试注释，此处不复述，
           否则会撞到"后缀必须删除"的反向断言）。删的只是**标题后缀文字**，
           "分层明细走日志流"这条事实与实现完全不变。 -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'ec-monitor') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'ec-monitor', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="color: #0369a1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">📡 移动公众 保活监视</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 3px;">
          <div id="acc-ec-mon-actions-${acc.id}" style="display: flex; flex-direction: column;">
            ${buildEcloudDesktopMonitorHtml(acc)}
          </div>
          <div id="acc-active-info-${acc.id}" style="font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b></div>
          <!-- 【2026-09-24 用户要求】原卡片底部的免责说明框已删除（卡片只留逐台状态）。
               口径前移到日志流：ecloud_client.js 的 _logLayerSummary() 每轮都会附带
               「说明: L1/L2 是 HTTP 层探针，成功不代表云电脑不会被关机」。 -->
        </div>
      </details>

      <!-- ⚙️ 分层自动化保活开关（独立于另两平台的分层命名） -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 分层自动化保活开关</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <!-- 【2026-09-28 用户要求】🛡️ 自动开机守护置于最前且**默认开启**：
               平台存在约 48 小时强制关机策略（真机实证两次），HTTP 保活拦不住 —— 拦不住就自动恢复。
               双开关（本开关 + 单机「🛡️守护」，均默认开启）+ 同机 10 分钟冷却。
               ⚠️ 口径一刀切默认开（与 ecloud_client 的 !== false 同源，公众版无底座分叉）；
               本区**不得**引用移动爱家的 _ydpcVendors —— 该变量只在爱家分支内声明，
               在此求值会 ReferenceError 中断整张卡片渲染（2026-09-28 修复）。 -->
          <div class="feature-row">
            <span title="被平台强制关机后自动拉起（双开关：本开关 + 单机「🛡️守护」；同机 10 分钟冷却）。平台存在约 48 小时强制关机策略，HTTP 保活无法阻止，本守护负责自动恢复。默认开启，不需要可关闭。">🛡️ 自动开机守护</span>
            <label class="switch">
              <input type="checkbox" ${f.autoBoot !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoBoot', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="账号级保活总开关：关闭后本账号 L1/L2 全部分层保活暂停">⚡ 账号级保活总开关</span>
            <label class="switch">
              <input type="checkbox" ${f.keepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'keepAlive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="L1 账号态保活：USER_GET_INFO / USER_GET_DEVICE_INFO / PROBE_QKK_BATCHPUSH（三态，未判定时不重登）">🧩 L1 账号态保活</span>
            <label class="switch">
              <input type="checkbox" ${f.ecloudL1AccountKeep !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'ecloudL1AccountKeep', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="L2 桌面登记保活：desktopUptime 逐台登记">🧩 L2 桌面登记保活</span>
            <label class="switch">
              <input type="checkbox" ${f.ecloudL2DesktopReg !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'ecloudL2DesktopReg', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 快捷操作区 -->
      <div class="card-actions">
        <div class="card-action-tools" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
          <button class="btn btn-tool" onclick="triggerEcloudKeepalive('${acc.id}')" title="立即执行一次 L1 + L2 保活巡检（与自动巡检同一条代码路径）">💓 立即保活</button>
          <button class="btn btn-tool" onclick="syncEcloudDesktops('${acc.id}')" title="重新拉取名下云主机列表">🔄 同步桌面</button>
          <button class="btn btn-tool" onclick="switchPlatformFilter('ecloud'); showToast('已切换到移动公众独立日志流', 'info')" title="只查看移动公众自己的日志流（与另两平台隔离）">📄 看本平台日志</button>
        </div>
      </div>
    `;

    return card;
  }

  if (isYdpc) {
    // ====================================================
    // 📱 移动云电脑专属卡片呈现
    // ====================================================
    const typeBadge = acc.accountType === 'sub'
      ? `<span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;">独立子账号</span>`
      : `<span class="badge" style="background:#fef3c7;color:#b45309;border:1px solid #fde68a;">和家亲主账号</span>`;

    const vms = acc.vms || m.vms || [];

    // ══════════════════════════════════════════════════════════════════════════
    // 【2026-09-26】底座画像：SCG（深信服）与 ZTE 是**两条不同的保活底座**
    // ══════════════════════════════════════════════════════════════════════════
    // 为什么必须分叉：SCG 的材料里**没有** cagIp / connectStr，它走的是
    // firm-auth 的 scgIp/scgTcpPort/scAuthCode → 裸 TCP → auth 包 → 同 socket 升 TLS
    // → trunk 帧 + SPICE 通道认证。由此产生两条**不能再用 ZTE 文案盖过去**的事实：
    //   ① SCG 开机走 **CEM 官方通道**（2026-09-26 真机验证通过：getConnectInfo 触发开机
    //      + readyStatus 轮询；与保活的 CEM 控制面同一套已获批端点与材料）；
    //   ② SCG 不走 CAG 握手（它没有 cagIp）⇒ 控制面保活对 SCG 只剩 SOHO 心跳。
    // 判据只用后端 refreshVms 已持久化的 vm.vendor / vm.vendorName，前端**不自行嗅探**
    // （猜测过的代价见 app/ydpc/product_route.js 的注释：真 SCG 机被硬判成 ZTE 盲拨）。
    // 混挂多底座时一律降级为中性文案 —— 宁可少说，不可说错。
    const _ydpcVendors = Array.from(new Set(
      vms.map(v => String((v && v.vendor) || '').toUpperCase()).filter(Boolean)
    ));
    const _ydpcAllScg = vms.length > 0 && _ydpcVendors.length === 1 && _ydpcVendors[0] === 'SCG';
    const _ydpcAllZte = vms.length > 0 && _ydpcVendors.length === 1 && _ydpcVendors[0] === 'ZTE';
    const _ydpcMixedBase = _ydpcVendors.length > 1;
    const _ydpcBaseLabel = _ydpcAllScg ? '深信服 SCG'
      : (_ydpcAllZte ? '中兴 ZTE' : (_ydpcMixedBase ? '混合底座（逐台判定）' : '底座未判定'));
    const _ydpcBaseChipStyle = _ydpcAllScg
      ? 'background:#f0fdfa;color:#0f766e;border:1px solid #99f6e4;'
      : (_ydpcAllZte
        ? 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;'
        : 'background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;');
    const _ydpcBaseNote = _ydpcAllScg
      ? 'SCG 数据面：裸 TCP → auth 包 → 同 socket 升 TLS → trunk 帧 + SPICE 通道认证（材料取自 firm-auth 的 scgIp/scAuthCode；无 cagIp / connectStr）'
      : (_ydpcAllZte
        ? 'ZTE 数据面：按内层主机地址族分流 —— IPv6 走 raw ZTEC，IPv4 走 TLS+CAGMux+SPICE'
        : '各机底座不同，数据面通道**逐台**判定（见下方每台机器行）');
    /** 单机是否 SCG 底座（只读后端已持久化的 vendor，不外推） */
    const _isScgVm = (v) => String((v && v.vendor) || '').toUpperCase() === 'SCG';

    const vmsCountText = vms.length > 0 ? `名下云主机 (${vms.length}台)` : '云主机';

    const isAllYdpcChannelsOff = f.controlPlaneKeepalive === false && f.mqttKeepAlive === false && f.dataPlaneKeepalive === false;
    const isGlobalKeepAliveOff = f.keepAlive === false || isAllYdpcChannelsOff;

    let ydpcMultiStatusBadge = '';
    if (isGlobalKeepAliveOff) {
      ydpcMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
    } else {
      const anyKeepOn = vms.some(v => v.keepaliveEnabled !== false);
      const allKeepOn = vms.every(v => v.keepaliveEnabled !== false);
      if (allKeepOn && vms.length > 1) {
        ydpcMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
      } else if (anyKeepOn) {
        ydpcMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
      } else {
        ydpcMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
      }
    }

    let vmsHtml = '';
    if (vms.length > 0) {

      vmsHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ ${vmsCountText}</span>
            <span id="acc-multi-status-${acc.id}">${ydpcMultiStatusBadge}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${vms.map(vm => {
              const statusStr = String(vm.vmStatus || vm.vmStatusShow || '');
              const isRunning = statusStr.includes('运行') || vm.vmStatus === 1 || vm.vmStatusCode === 1;
              const cpuClean = vm.cpu ? String(vm.cpu).replace(/核+$/g, '') : '';
              const memClean = vm.memory ? String(vm.memory).replace(/[Gg]+$/g, '') : '';
              const specSuffix = (cpuClean && memClean) ? ` · ${cpuClean}核/${memClean}G` : (cpuClean ? ` · ${cpuClean}核` : (memClean ? ` · ${memClean}G` : ''));
              const isKeepaliveOn = vm.keepaliveEnabled !== false;
              const usid = String(vm.userServiceId || '');

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="vm-item-${acc.id}-${usid}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(vm.vmName || '移动云电脑')}</span>
                        ${vm.vendorName ? `<span class="badge" style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(vm.vendorName)}</span>` : ''}
                      </div>
                      <span style="font-size: 11px; color: #64748b;">USID: ${usid}${specSuffix}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                      <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                      <span style="font-size: 11.5px; font-weight: 600; color: ${vm.durationMode === 'limited' ? '#b45309' : '#059669'};">${vm.remainText || '♾️ 永久'}</span>
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${usid}" onclick="toggleVmFeature('${acc.id}', '${usid}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关">⚡保活: ${keepText}</button>
                      <span class="pill-static" id="pill-interval-${acc.id}-${usid}" title="单台周期只读展示：要看板（实例）里改，或改账号级周期">${pillIntervalLabel(vm.keepaliveInterval, acc.keepaliveInterval)}</span>
                      <!-- 【2026-09-23 新增】单机自动开机守护开关：与账号级 features.autoBoot 构成双重把关 -->
                      <!-- 【2026-09-26 恢复】SCG（深信服）底座开机已真机打通（CEM 通道：getConnectInfo 触发开机
                           + readyStatus 轮询，见 app/ydpc/scg_keepalive.js 的 cemBootVm），守护/开机控件恢复渲染。 -->
                      <button type="button" class="pill-toggle-btn ${(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm)) ? 'pill-on-keepalive' : 'pill-off-keepalive'}" id="pill-autoboot-${acc.id}-${usid}" onclick="toggleVmFeature('${acc.id}', '${usid}', 'autoBootEnabled', ${!(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm))})" title="单台云电脑独立自动开机守护（需账号级开关同时开启；SCG 机默认开、走 CEM 通道，ZTE 机默认关、走 CAG 通道）">🛡️守护: ${(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm)) ? '开' : '关'}</button>
                      ${!isRunning ? `<button type="button" class="pill-toggle-btn pill-action-boot" id="pill-boot-${acc.id}-${usid}" onclick="bootYdpcVm('${acc.id}', '${usid}', '${escapeHtml(vm.vmName || '')}')" title="${_isScgVm(vm) ? '通过 CEM 官方通道拉起这台云电脑（深信服底座 · 已真机验证）' : '通过 CAG 官方通道拉起这台云电脑'}">🖥️开机</button>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      vmsHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">暂未拉取到名下云主机，点击下方心跳或握手自动同步</div>`;
    }

    const primaryUsid = vms[0]?.userServiceId || '';

    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <div class="account-name-row">
              <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
                <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
                <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
              </span>
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30">
            </div>
            <div class="account-phone">
              <span>${fullPhone}</span>
              <span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">移动爱家</span>
              ${typeBadge}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
          <button class="btn btn-sm" onclick="openYdpcRelogin('${acc.id}')" title="短信验证码登录（补登录态 / 解除暂停）">📩</button>
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑移动爱家账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <!-- 🖥️ 名下云主机列表 -->
      ${vmsHtml}

      <!-- 📡 移动云专属 CAG 握手与心跳监视 -->
      <!-- 【2026-09-24 用户要求·第三轮】账号级「保活在线」徽章已删除；本板块改为可点击收起/展开。 -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'yd-monitor') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'yd-monitor', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="color: #0369a1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_ydpcAllScg ? '📡 移动爱家 SCG 数据面监视' : '📡 移动爱家 ZTEC 握手与心跳监视'}</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 3px;">
          <!-- 【2026-09-23 按主机维度】原先是单行账号级"当前动作"，多机（如ZTE样本主号下 2 台）
               状态不同时无法区分，且运行中时该文案永不刷新 → 长期停在「保活巡检待命中」。
               现改为逐台主机渲染，状态由后端 describeVmKeepAlive 统一下发。 -->
          <div id="acc-vm-actions-${acc.id}" style="display: flex; flex-direction: column;">
            ${buildYdpcVmMonitorHtml(acc)}
          </div>
          <div id="acc-active-info-${acc.id}" style="font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b></div>
        </div>
      </details>

      <!-- 专属功能开关 (精致折叠设计，状态持久化) -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 自动化保活开关<span class="badge" style="margin-left:6px;${_ydpcBaseChipStyle}" title="${escapeHtml(_ydpcBaseNote)}">${escapeHtml(_ydpcBaseLabel)}</span></span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <!-- 【2026-09-23 修订】「🛡️ 自动开机守护」开关已恢复。
               ZTE 底座开机走 CAG HTTPS 干净通道（app/ydpc/cag_boot.js）：账号自有 firm-auth 凭据、
               RSA 公钥动态获取、保留 TLS 证书校验，全程走官方通道、不伪造客户端身份。
               【2026-09-26 恢复】SCG（深信服）底座开机已真机打通，走 CEM 官方通道
               （app/ydpc/scg_keepalive.js 的 cemBootVm）：OAuth → getConnectInfo 触发开机 →
               getVmReadyStatus 轮询至就绪。两端共用同一套账号自有凭据与已获批 CEM 材料。
               默认开启（2026-09-28 用户拍板），不需要可显式关闭。 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcMixedBase ? '检测到机器关机时自动拉起（默认开启）。本账号混挂多底座：ZTE 机走 CAG 通道，SCG 机走 CEM 通道，各自使用账号自有凭据' : '检测到机器关机时自动拉起（默认开启）。ZTE 机走 CAG 通道，SCG 机走 CEM 通道')}">${_ydpcMixedBase ? '🛡️ 自动开机守护（CAG/CEM 通道 · 按底座自动分流）' : (_ydpcAllScg ? '🛡️ 自动开机守护（CEM 通道）' : '🛡️ 自动开机守护（CAG 通道）')}</span>
            <!-- 【2026-09-28 修复】默认口径按底座分叉（与后端 _autoBootArmed 同源）：含 SCG 的账号默认勾选；
                 纯 ZTE 账号默认不勾（ZTE 开机走 CAG 会真实消耗限时套餐时长，需显式开启）。
                 本表达式依赖 _ydpcVendors，只能在移动爱家分支内使用。 -->
            <label class="switch">
              <input type="checkbox" ${(f.autoBoot !== undefined ? f.autoBoot !== false : _ydpcVendors.includes('SCG')) ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoBoot', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <!-- 【2026-09-23 新增】数据面保活：官方客户端同款 raw ZTEC 数据面，唯一被证实能真保活的方式。
               开启后，已开启「⚡保活」的运行中机器自动改走数据面，并抑制其 SOHO 心跳/CAG 握手（冗余）。
               ⚠️ 数据面是独占桌面会话，官方 App 可能无法同时接入该机器。 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcAllScg ? 'SCG 数据面保活（官方同款原生传输的另一套实现）：裸 TCP → auth 包 → 同 socket 升 TLS → trunk 帧 + SPICE 通道认证。开启后单机「⚡保活」开着的运行中机器自动改走数据面，并抑制其控制面保活。⚠️ 会占用桌面会话，官方 App 可能无法同时接入。⚠️ 本通道尚未被证明有效（显示面是否真的出图只能在真机观察）' : (_ydpcAllZte ? '官方客户端同款原生协议数据面保活（真保活）。开启后单机「⚡保活」开着的运行中机器自动改走数据面，并抑制其控制面保活。⚠️ 会占用桌面会话，官方 App 可能无法同时接入' : '原生协议数据面保活。各机按自身底座走对应通道（ZTE：raw ZTEC / TLS+SPICE；SCG：trunk+SPICE）。⚠️ 会占用桌面会话，官方 App 可能无法同时接入。⚠️ 是否真保活以实跑为准，本项目不作"保活已被证明"的声明'))}">${_ydpcAllScg ? '📡 数据面保活（SCG · trunk+SPICE）' : (_ydpcAllZte ? '📡 数据面保活（raw ZTEC / TLS+SPICE · 真保活）' : '📡 数据面保活（原生协议 · 逐台判定）')}</span>
            <label class="switch">
              <input type="checkbox" ${f.dataPlaneKeepalive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'dataPlaneKeepalive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <!-- 【2026-09-23 合并】ZTEC CAG 握手 与 SOHO 心跳 共用同一周期，合并为一个"控制面保活"开关 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcAllScg ? 'SCG 底座**没有** CAG 握手（firm-auth 材料里只有 scgIp/scAuthCode，没有 cagIp）—— 因此本开关在 SCG 机器上只驱动 SOHO 心跳（它同时也是 SCG 会话慢平面的同一路心跳），不发起任何 CAG 握手' : 'ZTEC CAG TCP 握手 + SOHO 心跳（共用同一周期，默认 10 分钟，可单机覆盖）。⚠️ 对 SCG 底座机器只走 SOHO 心跳——SCG 没有 cagIp')}">${_ydpcAllScg ? '🔄 控制面保活（SOHO 心跳 · SCG 无 CAG 握手）' : '🔄 控制面保活（CAG 握手 + SOHO 心跳）'}</span>
            <label class="switch">
              <input type="checkbox" ${f.controlPlaneKeepalive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'controlPlaneKeepalive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span>📡 官方 MQTT 3.1.1 链路长连保活</span>
            <label class="switch">
              <input type="checkbox" ${f.mqttKeepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'mqttKeepAlive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 快捷操作区 -->
      <div class="card-actions">
        <div class="card-action-tools" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
          <button class="btn btn-tool" onclick="pingYdpcCag('${acc.id}')" title="立即向中兴 CAG 发起 TCP 握手保活">🔄 CAG 握手</button>
          <button class="btn btn-tool" onclick="heartbeatYdpc('${acc.id}')" title="立即发送一次 SOHO 活跃心跳">💓 发送心跳</button>
          <button class="btn btn-tool" onclick="verifyYdpcKeepAlive('${acc.id}')" title="用独立轮询验证保活是否真的有效（默认监控 60 秒）">🔍 独立验证</button>
        </div>
      </div>
    `;

    return card;
  }

  // ====================================================
  // ☁️ 天翼云电脑专属卡片呈现
  // ====================================================
  let sessionBadge = '';
  if (acc.sessionExpired) {
    sessionBadge = `<span class="badge badge-danger" style="cursor:pointer;" onclick="editAccount('${acc.id}')">${!acc.hasPassword ? '⚠️ 待扫码授权' : '⚠️ 会话失效'}</span>`;
  }

  const boundBadgeHtml = acc.bound
    ? `<span class="badge badge-online">已绑设备</span>`
    : `<span class="badge badge-warning" style="cursor: pointer;" onclick="openSmsModal('${acc.id}')">⚠️ 待绑定</span>`;

  const officialTaskHtml = buildOfficialTasksHtml(m);

  // 云电脑设备列表渲染
  let desktopsHtml = '';
  const dList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : [{
    desktopId: m.desktopId || acc.stats?.desktopId || '',
    desktopCode: acc.stats?.desktopId ? String(acc.stats.desktopId).slice(-6) : '',
    desktopName: m.desktopName || '天翼云电脑',
    useStatusText: (acc.stats?.keepAliveStatus === 'online' || m.status === 'online') ? '运行中' : '就绪',
    flavorName: '标准版'
  }];

  let ctyunMultiStatusBadge = '';
  if (f.keepAlive === false) {
    ctyunMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
  } else {
    const anyKeepOn = dList.some(d => d.keepaliveEnabled !== false);
    const allKeepOn = dList.every(d => d.keepaliveEnabled !== false);
    if (allKeepOn && dList.length > 1) {
      ctyunMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
    } else if (anyKeepOn) {
      ctyunMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
    } else {
      ctyunMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
    }
  }

  if (dList.length > 0) {
    const isGlobalKeepAliveOff = f.keepAlive === false;
    const isGlobalTasksOff = f.cloudHang === false && f.autoSign === false && f.aiChat === false;

    // 【2026-09-25·第七轮补】用户要求三平台口径统一：本卡片栏目名也改成「名下云主机」。
    // 注意：源码注释里**不得复述旧名**，否则会撞"旧栏目名已全平台废弃"的反向断言（模板串内的 HTML 注释剥不掉）。
    desktopsHtml = `
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
        <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
          <span>🖥️ 名下云主机 (${dList.length}台)</span>
          <span id="acc-multi-status-${acc.id}">${ctyunMultiStatusBadge}</span>
        </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${dList.map(d => {
              const idText = d.desktopCode || d.desktopId || d.objId || '主设备';
              const isRunning = (d.useStatusText || '').includes('运行') || d.useStatus === 1 || d.useStatus === 0;
              // 前端规格解析 (完全对齐 ctyun-pro parseDesktopSpec 策略)
              const flavor = d.flavorName || '';
              const name = d.desktopName || '';
              let cpuClean = d.cpu ? String(d.cpu).replace(/核+$/g, '') : '';
              let memClean = d.memory ? String(d.memory).replace(/[Gg]+$/g, '') : '';
              if (!cpuClean || !memClean) {
                const explicit = (flavor.match(/(\d+)C(\d+)G/i) || name.match(/(\d+)C(\d+)G/i));
                if (explicit) {
                  cpuClean = cpuClean || explicit[1];
                  memClean = memClean || explicit[2];
                } else {
                  const cn = (flavor + ' ' + name).match(/(\d+)\s*核\s*[/]?\s*(\d+)\s*G/i);
                  if (cn) {
                    cpuClean = cpuClean || cn[1];
                    memClean = memClean || cn[2];
                  }
                }
              }
              // 版本名智能映射兜底 (旗舰16C32G / 尊享·精英8C16G / 标准4C8G / 其余8C16G)
              if (!cpuClean || !memClean) {
                let spec = '8C16G';
                if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
                else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
                else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
                const m2 = spec.match(/(\d+)C(\d+)G/);
                cpuClean = cpuClean || m2[1];
                memClean = memClean || m2[2];
              }
              const specSuffix = ` · ${cpuClean}核/${memClean}G`;
              const isKeepaliveOn = d.keepaliveEnabled !== false;
              const isTaskOn = d.taskEnabled !== false;
              const targetId = String(d.desktopId || d.objId || idText);

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              let taskClass = isTaskOn ? 'pill-on-task' : 'pill-off-task';
              let taskText = isTaskOn ? '开' : '关';
              if (isGlobalTasksOff && isTaskOn) {
                taskClass = 'pill-paused';
                taskText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="desktop-item-${acc.id}-${targetId}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span title="${escapeHtml(d.desktopName || '天翼云电脑')}" style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; cursor: help;">${escapeHtml(d.desktopName || '天翼云电脑')}</span>
                        ${d.flavorName ? `<span style="font-size: 10.5px; background: #eff6ff; color: #2563eb; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; white-space: nowrap;">${escapeHtml(d.flavorName)}</span>` : ''}
                      </div>
                      <span style="font-size: 11px; color: #64748b; margin-top: 1px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="设备ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}">ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;">
                      <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                      <button class="btn btn-sm btn-primary" style="padding: 2px 7px; font-size: 11px; flex-shrink: 0; white-space: nowrap;" onclick="launchWebDesktop('${acc.id}', '${d.desktopId || d.objId}')">🚀 打开</button>
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${targetId}" onclick="toggleVmFeature('${acc.id}', '${targetId}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关 (脉冲长连保活)">⚡保活: ${keepText}</button>
                      <button type="button" class="pill-toggle-btn ${taskClass}" id="pill-task-${acc.id}-${targetId}" onclick="toggleVmFeature('${acc.id}', '${targetId}', 'taskEnabled', ${!isTaskOn})" title="单台云电脑独立任务开关 (控制打卡/AI对话/1小时挂机任务)">🎯任务: ${taskText}</button>
                      <span class="pill-static" id="pill-interval-${acc.id}-${targetId}" title="单台周期只读展示：要看板（实例）里改，或改账号级周期">${pillIntervalLabel(d.keepaliveInterval, acc.keepaliveInterval)}</span>
                    </div>
                    <div style="display: flex; gap: 4px; align-items: center;">
                      ${!isRunning ? `<button type="button" class="pill-toggle-btn pill-action-boot" onclick="bootCtyunVm('${acc.id}', '${targetId}')" title="单独对此台天翼云电脑下发开机">🖥️ 开机</button>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
      </div>
    `;
  }

  const targetDeviceDisplay = dList.length > 1 
    ? `名下 ${dList.length} 台云电脑 (全量多机守护)` 
    : `${escapeHtml(m.desktopName || dList[0]?.desktopName || '云电脑')} (${escapeHtml(m.currentHost || '已就绪')})`;

  card.innerHTML = `
    <div class="card-top">
      <div class="account-main-info">
        <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
        <div class="account-name-block">
          <div class="account-name-row">
            <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
              <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
              <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
            </span>
            <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30" placeholder="账号备注名">
          </div>
          <div class="account-phone">
            <span>${fullPhone}</span>
            <span class="badge" style="background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;">天翼云</span>
            ${boundBadgeHtml}
            ${sessionBadge}
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
        <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑账号与重新验证">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
      </div>
    </div>

    <!-- 🖥️ 名下云主机列表 -->
    ${desktopsHtml}

    <!-- 📡 真实 WebSocket 保活心跳状态监视 -->
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; gap: 6px; flex-wrap: wrap;">
        <span style="color: #2563eb; font-weight: 700; flex-shrink: 0;">📡 状态与心跳监视</span>
        <span id="acc-countdown-${acc.id}" style="color: var(--text-muted); font-size: 11px; text-align: right; flex-shrink: 1;">${m.isTaskHanging ? `模式: <b style="color:#d97706;">定时挂机中</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)` : `脉冲周期: <b>${buildIntervalOverviewText(acc)}</b> (倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`}</span>
      </div>
      <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 3px;">
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">目标设备:</span>
          <span id="acc-host-${acc.id}" title="${targetDeviceDisplay}" style="color: #0f172a; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; min-width: 0; cursor: help;">${targetDeviceDisplay}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span>
          <span id="acc-hb-text-${acc.id}" title="${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}" style="font-size: 11.5px; color: ${(m.lastHeartbeatResult || '').includes('避让') ? '#d97706' : '#16a34a'}; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; min-width: 0; cursor: help;">${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}</span>
        </div>
        <div style="font-size: 11.5px; color: #475569;">当日成功轮次: <span id="acc-success-count-${acc.id}" style="color: #2563eb; font-weight: 600;">${m.successCount || 0} 轮</span></div>
      </div>
    </div>

    <!-- 🏆 天翼云官方真实任务看板 (精致可折叠设计，状态持久化) -->
    <details class="card-collapse-box" ${isDetailsOpen(acc.id, 'tasks') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'tasks', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-weight: 700; user-select: none; gap: 6px;">
        <span style="color: #b45309; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🏆 官方任务进度 (总分: <b id="acc-points-val-${acc.id}" style="color:#16a34a;">${m.userPoints || 0}</b>)</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
      </summary>
      <div id="acc-tasks-list-${acc.id}" style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px;">
        ${officialTaskHtml}
      </div>
    </details>

    <!-- 功能开关 (精致折叠设计，状态持久化) -->
    <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 自动化任务与保活开关</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
      </summary>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        <div class="feature-row">
          <span>📡 启用云电脑保活</span>
          <label class="switch">
            <input type="checkbox" ${f.keepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'keepAlive', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>📅 每日自动签到打卡</span>
          <label class="switch">
            <input type="checkbox" ${f.autoSign !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoSign', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🤖 AI 智能对话任务 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.aiChat !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'aiChat', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>⏱️ 云电脑挂机1小时 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.cloudHang !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'cloudHang', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🎁 自动兑换/抽奖 (${acc.redeemConfig?.enabled ? '<b style=\"color:#16a34a\">已开</b>' : '未开'})</span>
          <button class="btn btn-sm btn-warning" onclick="openRedeemModal('${acc.id}')" style="flex-shrink:0;padding:3px 8px;font-size:11.5px;">⚙️ 奖品设置</button>
        </div>
      </div>
    </details>

    <!-- 快捷操作按钮 -->
    <div class="card-actions">
      ${acc.sessionExpired ? `
        <button class="btn btn-danger btn-launch-full" onclick="editAccount('${acc.id}')" style="margin-bottom:6px;">
          <span>${!acc.hasPassword ? '📱 重新扫码授权' : '🔑 重新验证登录'}</span>
          <span class="btn-subtext">${!acc.hasPassword ? '手机 App 扫码一键恢复 ➔' : '输验证码恢复 ➔'}</span>
        </button>
      ` : ''}
      <div class="card-action-tools">
        <button class="btn btn-tool" onclick="syncAccountTasks('${acc.id}')" title="一键极速执行今日全部任务 (打卡/AI对话/挂机)">🔄 一键同步任务</button>
        <button class="btn btn-tool" onclick="openPowerModal('${acc.id}')" title="云电脑电源管理 (开机/重启/关机)">⚡ 电源管理</button>
        <button class="btn btn-tool" onclick="openManualRedeemModal('${acc.id}')" title="根据当前积分手动兑换商品或抽奖">🎁 积分商城</button>
      </div>
      ${!acc.bound ? `<button class="btn btn-sm btn-warning" style="width:100%;margin-top:2px;" onclick="openSmsModal('${acc.id}')">📲 短信二次安全绑定</button>` : ''}
    </div>
  `;

  return card;
}

// 原地静默增量局部数据更新 (100% 杜绝 DOM 结构重绘与滚动条跳跃)
function updateAccountsInPlace(filteredAccounts) {
  filteredAccounts.forEach(acc => {
    const card = document.getElementById(`acc-card-${acc.id}`);
    if (!card) return;

    const isYdpc = acc.platform === 'ydpc';
    const isEcloud = acc.platform === 'ecloud';
    const m = acc.liveMetrics || {};
    const f = acc.features || {};

    // 1.【2026-09-24 用户要求·第三轮】账号级「保活在线/离线待机」徽章已从卡片删除，
    //    原先在此处就地覆写该徽章元素的整段逻辑一并移除（元素已不存在，保留即死代码）。
    //    在线口径改由日志流承载；卡片上的监视板块改为可折叠标题。

    // 2. 更新心跳/动作文本（天翼云：账号级单行；移动两平台走下方按主机渲染）
    if (!isYdpc && !isEcloud) {
      const hbTextEl = document.getElementById(`acc-hb-text-${acc.id}`);
      if (hbTextEl) {
        const hbResult = m.lastHeartbeatResult || '正在建立心跳通道...';
        hbTextEl.innerText = hbResult;
        hbTextEl.title = hbResult;
        hbTextEl.style.color = hbResult.includes('避让') ? '#d97706' : '#16a34a';
      }
    }

    // 2b.【2026-09-23 按主机维度】移动云逐台刷新"当前动作"区：
    //     一个账号下多台主机的状态可以完全不同，必须按主机呈现。
    if (isYdpc) {
      const vmActionsEl = document.getElementById(`acc-vm-actions-${acc.id}`);
      if (vmActionsEl) {
        vmActionsEl.innerHTML = buildYdpcVmMonitorHtml(acc);
      }
    }

    // 2c.【2026-09-23】移动公众逐台刷新（**独立元素与独立渲染函数**，不与移动爱家共用）：
    //     只刷新逐台"当前动作"区（倒计时/最近动作每轮都在变）。
    //     分层总览条已按用户要求移入日志流，此处不再有对应的 DOM 节点。
    if (isEcloud) {
      const ecMonEl = document.getElementById(`acc-ec-mon-actions-${acc.id}`);
      if (ecMonEl) ecMonEl.innerHTML = buildEcloudDesktopMonitorHtml(acc);
      // 【2026-09-28】逐台同步「🛡️守护」胶囊（按元素存在性过滤，绝不留无元素可写的幽灵控件）
      for (const d of (acc.desktops || [])) {
        const iid2 = String(d.instanceId || '');
        const pAuto = document.getElementById(`pill-autoboot-${acc.id}-${iid2}`);
        if (!pAuto) continue;
        const on = d.autoBootEnabled !== false;
        pAuto.className = `pill-toggle-btn ${on ? 'pill-on-keepalive' : 'pill-off-keepalive'}`;
        pAuto.innerText = `🛡️守护: ${on ? '开' : '关'}`;
      }
    }

    // 3. 更新倒计时与轮次 (天翼云)
    const cdEl = document.getElementById(`acc-countdown-${acc.id}`);
    if (cdEl) {
      cdEl.innerHTML = m.isTaskHanging
        ? `模式: <b style="color:#d97706;">定时挂机中</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)`
        : `脉冲周期: <b>${buildIntervalOverviewText(acc)}</b> (倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`;
    }

    const successEl = document.getElementById(`acc-success-count-${acc.id}`);
    if (successEl) {
      successEl.innerText = `${m.successCount || 0} 轮`;
    }

    // 4. 更新移动两平台账号级汇总与周期概览（逐台状态已在 2b / 2c 刷新）
    if (isYdpc || isEcloud) {
      const activeInfoEl = document.getElementById(`acc-active-info-${acc.id}`);
      if (activeInfoEl) {
        activeInfoEl.innerHTML = `账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b>`;
      }
    }

    // 5. 更新官方任务积分与列表 (天翼云)
    const pointsValEl = document.getElementById(`acc-points-val-${acc.id}`);
    if (pointsValEl) {
      pointsValEl.innerText = m.userPoints || 0;
    }

    const tasksListEl = document.getElementById(`acc-tasks-list-${acc.id}`);
    if (tasksListEl && m.officialTasks && m.officialTasks.length > 0) {
      tasksListEl.innerHTML = buildOfficialTasksHtml(m);
    }

    // 6. 原地增量更新单机独立保活与开机/任务胶囊开关状态与总状态徽章
    const multiStatusEl = document.getElementById(`acc-multi-status-${acc.id}`);
    if (isYdpc && acc.vms) {
      const isAllYdpcChannelsOff = f.controlPlaneKeepalive === false && f.mqttKeepAlive === false && f.dataPlaneKeepalive === false;
      const isGlobalKeepAliveOff = f.keepAlive === false || isAllYdpcChannelsOff;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.vms.some(v => v.keepaliveEnabled !== false);
          const allKeepOn = acc.vms.every(v => v.keepaliveEnabled !== false);
          if (allKeepOn && acc.vms.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.vms.forEach(vm => {
        const usid = String(vm.userServiceId || '');
        const isKeepaliveOn = vm.keepaliveEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${usid}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${usid}`);
        if (pInterval) pInterval.textContent = pillIntervalLabel(vm.keepaliveInterval, acc.keepaliveInterval);
        // 【2026-09-23 新增】同步单机自动开机守护胶囊
        // 【2026-09-26 恢复】SCG 机器的守护/开机控件已恢复渲染，此处按元素存在性同步
        // （元素不存在时 getElementById 返回 null 天然跳过，不会造幽灵控件）。
        const pAutoBoot = document.getElementById(`pill-autoboot-${acc.id}-${usid}`);
        if (pAutoBoot) {
          const vmIsScg = String((vm && vm.vendor) || '').toUpperCase() === 'SCG';
          const on = vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : vmIsScg;
          pAutoBoot.className = `pill-toggle-btn ${on ? 'pill-on-keepalive' : 'pill-off-keepalive'}`;
          pAutoBoot.innerText = `🛡️守护: ${on ? '开' : '关'}`;
        }
        // 【2026-09-23 新增】同步"运行中则隐藏 🖥️开机 按钮"（整卡片重绘会处理新增，这里只处理隐藏）
        const statusStr = String(vm.vmStatus || vm.vmStatusShow || '');
        const isRunningNow = statusStr.includes('运行') || vm.vmStatus === 1 || vm.vmStatusCode === 1;
        if (isRunningNow) {
          const pBoot = document.getElementById(`pill-boot-${acc.id}-${usid}`);
          if (pBoot) pBoot.remove();
        }
      });
    } else if (isEcloud && acc.desktops) {
      // 【2026-09-24】移动公众：主键是 instanceId，胶囊 id 与移动爱家/天翼云不同前缀无关，
      // 但此处必须走 ecloud 自己的分支，避免误用 desktopId/objId 导致元素永远匹配不上。
      const isGlobalKeepAliveOff = f.keepAlive === false;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.desktops.some(d => d.keepaliveEnabled !== false);
          const allKeepOn = acc.desktops.every(d => d.keepaliveEnabled !== false);
          if (allKeepOn && acc.desktops.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.desktops.forEach(d => {
        const iid = String(d.instanceId || '');
        const isKeepaliveOn = d.keepaliveEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${iid}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${iid}`);
        if (pInterval) pInterval.textContent = pillIntervalLabel(d.keepaliveInterval, acc.keepaliveInterval);
      });
    } else if (!isYdpc && !isEcloud && acc.desktops) {
      const isGlobalKeepAliveOff = f.keepAlive === false;
      const isGlobalTasksOff = f.cloudHang === false && f.autoSign === false && f.aiChat === false;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.desktops.some(d => d.keepaliveEnabled !== false);
          const allKeepOn = acc.desktops.every(d => d.keepaliveEnabled !== false);
          if (allKeepOn && acc.desktops.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.desktops.forEach(d => {
        const targetId = String(d.desktopId || d.objId || d.desktopCode || '');
        const isKeepaliveOn = d.keepaliveEnabled !== false;
        const isTaskOn = d.taskEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${targetId}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pTask = document.getElementById(`pill-task-${acc.id}-${targetId}`);
        if (pTask) {
          let taskClass = isTaskOn ? 'pill-on-task' : 'pill-off-task';
          let taskText = isTaskOn ? '开' : '关';
          if (isGlobalTasksOff && isTaskOn) {
            taskClass = 'pill-paused';
            taskText = '待命(总关)';
          }
          pTask.className = `pill-toggle-btn ${taskClass}`;
          pTask.innerText = `🎯任务: ${taskText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${targetId}`);
        if (pInterval) pInterval.textContent = pillIntervalLabel(d.keepaliveInterval, acc.keepaliveInterval);
      });
    }
  });
}

// 账号卡片 HTML 模板生成
function renderAccounts(isSilent = false) {
  const container = document.getElementById("accounts-container");
  if (!container) return;

  // 1. 如果用户正在拖拽卡片或正在行内编辑备注名，跳过重绘避免打断交互
  if (draggedAccId || activeEditingAccId) return;

  // 如果未登录，严格阻断访客查看云电脑信息，只显示登录注册引导
  if (!currentUser) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 24px; background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border); box-shadow: var(--shadow);">
        <div style="font-size: 40px; margin-bottom: 12px;">🔒</div>
        <h3 style="font-size: 17px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">还没有绑定云电脑账号</h3>
        <p style="font-size: 13.5px; color: var(--text-muted); max-width: 500px; margin: 0 auto 20px auto;">
          点击右上角「➕ 添加云电脑」，填入天翼云 / 移动爱家 / 移动公众云电脑的账号即可开始保活。
        </p>
      </div>
    `;
    return;
  }

  // 智能切换平台视图 Tab 栏：只有同时存在 >=2 个平台（天翼云 / 移动爱家 / 移动公众）时才显示，
  // 单一平台时自动隐藏；同时按"实际出现的平台"逐个显隐各自按钮，避免出现点了没内容的空 Tab。
  const presentPlatforms = getPresentPlatforms();
  const viewTabsGroup = document.getElementById("account-view-tabs-group");
  if (viewTabsGroup) {
    if (presentPlatforms.size >= 2) {
      viewTabsGroup.style.display = "flex";
    } else {
      viewTabsGroup.style.display = "none";
      activeAccountViewTab = 'all'; // 自动还原
    }
  }
  const tabBtnMap = { ctyun: 'view-tab-ctyun', ydpc: 'view-tab-ydpc', ecloud: 'view-tab-ecloud' };
  for (const [pf, btnId] of Object.entries(tabBtnMap)) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    const present = presentPlatforms.has(pf);
    btn.style.display = present ? '' : 'none';
    if (!present && activeAccountViewTab === pf) activeAccountViewTab = 'all';
  }

  // 根据当前视图过滤账号
  const filteredAccounts = getFilteredAccounts();

  if (!filteredAccounts || filteredAccounts.length === 0) {
    const tabNameMap = { ydpc: '移动爱家', ctyun: '天翼云电脑', ecloud: '移动公众' };
    const tabName = tabNameMap[activeAccountViewTab] || '云电脑';
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border);">
        <p style="font-size: 15px; margin-bottom: 12px;">当前暂未配置【${tabName}】设备</p>
        <button class="btn btn-primary" onclick="openAddAccountModal()">➕ 立即添加云电脑</button>
      </div>
    `;
    return;
  }

  const cols = getGridColumns();
  const slots = loadGridSlots(filteredAccounts, cols);

  // 2. 检查是否可无感局部原地更新 (In-Place Update)
  // 如果现有的 DOM 卡片结构和 slots 一致，直接更新动态文本与指标，100% 避免销毁 DOM 和触发表单/滚动条复位！
  if (isSilent) {
    const existingChildren = container.children;
    let matchExact = existingChildren.length === slots.length;
    if (matchExact) {
      for (let i = 0; i < slots.length; i++) {
        const expectedAccId = slots[i];
        const el = existingChildren[i];
        if (!expectedAccId) {
          if (!el.classList.contains("grid-empty-slot")) { matchExact = false; break; }
        } else {
          if (!el.classList.contains("account-card") || el.dataset.accId !== expectedAccId) { matchExact = false; break; }
        }
      }
    }

    if (matchExact) {
      updateAccountsInPlace(filteredAccounts);
      return;
    }
  }

  // 3. 结构发生变动时的平滑重绘：锁定高度与滚动位置
  const prevScrollY = window.scrollY || window.pageYOffset || 0;
  const currentHeight = container.offsetHeight;
  if (currentHeight > 0) {
    container.style.minHeight = `${currentHeight}px`;
  }

  const fragment = document.createDocumentFragment();

  slots.forEach((accId, slotIndex) => {
    if (!accId) {
      const emptySlot = document.createElement("div");
      emptySlot.className = "grid-empty-slot";
      emptySlot.dataset.slot = slotIndex;
      emptySlot.innerHTML = "";
      emptySlot.addEventListener("dragover", handleSlotDragOver);
      emptySlot.addEventListener("dragleave", handleSlotDragLeave);
      emptySlot.addEventListener("drop", handleSlotDrop);
      fragment.appendChild(emptySlot);
      return;
    }

    const acc = filteredAccounts.find(a => a.id === accId);
    if (!acc) return;

    const card = buildAccountCardElement(acc, slotIndex);
    fragment.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(fragment);

  // 渲染完成释放高度并确保滚动位置绝对稳定
  requestAnimationFrame(() => {
    container.style.minHeight = "";
    if (Math.abs(window.scrollY - prevScrollY) > 2) {
      window.scrollTo({ top: prevScrollY, behavior: "instant" });
    }
  });
}

// ==========================================
// 卡片自由网格插槽拖拽交互与持久化
// ==========================================
let draggedCardEl = null;
let draggedAccId = null;
let draggedSlotIndex = null;

function handleCardDragStart(e) {
  draggedCardEl = this;
  draggedAccId = this.dataset.accId;
  draggedSlotIndex = parseInt(this.dataset.slot, 10);
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedAccId);

  // 激活所有可放置空位插槽的高亮
  document.querySelectorAll(".grid-empty-slot").forEach(s => s.classList.add("droppable"));
}

function handleCardDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  if (this !== draggedCardEl) {
    this.classList.add("drag-over");
  }
}

function handleCardDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  this.classList.add("drag-over");
}

function handleSlotDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 移动卡片到目标空位插槽
  slots[draggedSlotIndex] = null;
  slots[targetSlot] = draggedAccId;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 互换两个插槽的内容
  const temp = slots[targetSlot];
  slots[targetSlot] = draggedAccId;
  slots[draggedSlotIndex] = temp;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDragEnd(e) {
  this.classList.remove("dragging");
  draggedCardEl = null;
  draggedAccId = null;
  draggedSlotIndex = null;
  document.querySelectorAll(".account-card, .grid-empty-slot").forEach(c => {
    c.classList.remove("drag-over");
    c.classList.remove("droppable");
  });
}

function saveAccountsOrderFromSlots(slots) {
  const orderedIds = slots.filter(Boolean);
  for (const a of accounts) {
    if (!orderedIds.includes(a.id)) orderedIds.push(a.id);
  }
  accounts.sort((a, b) => {
    const idxA = orderedIds.indexOf(a.id);
    const idxB = orderedIds.indexOf(b.id);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });
  saveAccountsOrder();
}

async function saveAccountsOrder() {
  const orderedIds = accounts.map(a => a.id);
  try {
    await authFetch("/api/accounts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds })
    });
  } catch (e) {}
}

// 账号备注名即点即改 (Inline Edit)
function startInlineEditName(accId) {
  activeEditingAccId = accId;
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  if (!textEl || !inputEl) return;
  textEl.classList.add("hidden");
  inputEl.classList.remove("hidden");
  inputEl.focus();
  inputEl.select();
}

function handleInlineNameKey(e, accId) {
  if (e.key === "Enter") {
    e.preventDefault();
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl) inputEl.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    activeEditingAccId = null;
    const acc = accounts.find(a => a.id === accId);
    const textEl = document.getElementById(`acc-name-text-${accId}`);
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl && textEl) {
      inputEl.value = acc ? (acc.name || acc.user) : inputEl.value;
      inputEl.classList.add("hidden");
      textEl.classList.remove("hidden");
    }
  }
}

async function saveInlineName(accId) {
  const acc = accounts.find(a => a.id === accId);
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  const labelEl = document.getElementById(`acc-name-val-${accId}`);
  if (!acc || !inputEl || !textEl) {
    activeEditingAccId = null;
    return;
  }

  const newName = inputEl.value.trim();
  const oldName = acc.name || acc.user;
  activeEditingAccId = null;

  // 切回展示态
  inputEl.classList.add("hidden");
  textEl.classList.remove("hidden");

  // 如果内容没变或为空则还原
  if (!newName || newName === oldName) {
    inputEl.value = oldName;
    return;
  }

  // 响应式即时渲染 (Optimistic UI)
  const previousName = acc.name;
  acc.name = newName;
  if (labelEl) labelEl.textContent = newName;

  // 响应式更新头像字母
  const avatarEl = document.getElementById(`acc-avatar-${accId}`);
  if (avatarEl) avatarEl.textContent = (newName || acc.user)[0].toUpperCase();

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
    if (res.ok) {
      showToast(`账号备注已成功修改为 "${newName}"`, "success");
    } else {
      const err = await res.json();
      showToast("修改失败: " + (err.error || "未知错误"), "error");
      acc.name = previousName;
      if (labelEl) labelEl.textContent = previousName || acc.user;
      inputEl.value = previousName || acc.user;
      if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    acc.name = previousName;
    if (labelEl) labelEl.textContent = previousName || acc.user;
    inputEl.value = previousName || acc.user;
    if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
  }
}

// 快速切换开关
async function toggleFeature(accId, featureKey, checked) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  acc.features = acc.features || {};
  acc.features[featureKey] = checked;

  // 立即刷新卡片视图以联动反映单机与全局层叠状态
  renderAccounts();

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: acc.features })
    });
    if (res.ok) {
      showToast(`已${checked ? '开启' : '关闭'}该功能`, "success");
    } else {
      showToast("更新失败", "error");
      // 更新失败则还原界面的复选状态
      acc.features[featureKey] = !checked;
      renderAccounts();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    acc.features[featureKey] = !checked;
    renderAccounts();
  }
}

// 单台云电脑独立特性开关切换 (优化为原地乐观更新与异步上报)
async function toggleVmFeature(accId, vmKey, featureName, nextVal) {
  // 【2026-09-23 修订】移动云"自动开机守护"开关已恢复放行，开机走 CAG HTTPS 干净通道
  // （账号自有 firm-auth 凭据 + RSA 公钥动态获取 + 保留 TLS 证书校验）。
  // 伪造身份 / 硬编码第三方凭据 / 关证书 等红线仍被回归组 7 机械拦截。
  // 支持的单机开关：keepaliveEnabled / taskEnabled / autoBootEnabled / keepaliveInterval

  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  if (isYdpc) {
    acc.vms = acc.vms || [];
    const targetVm = acc.vms.find(v => String(v.userServiceId) === String(vmKey));
    if (targetVm) targetVm[featureName] = nextVal;
  } else if (isEcloud) {
    // 移动公众：单机主键为 instanceId（与 ydpc 的 userServiceId、天翼云的 desktopId 各自独立）
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.instanceId) === String(vmKey));
    if (targetD) targetD[featureName] = nextVal;
  } else {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.desktopId || d.objId) === String(vmKey));
    if (targetD) targetD[featureName] = nextVal;
  }

  // 1. 立即乐观更新 DOM 按钮状态
  let prefixKey = '';
  let onClass = '';
  let offClass = '';
  let labelPrefix = '';
  if (featureName === 'keepaliveEnabled') {
    prefixKey = 'pill-keep-';
    onClass = 'pill-on-keepalive';
    offClass = 'pill-off-keepalive';
    labelPrefix = '⚡保活: ';
  } else if (featureName === 'taskEnabled') {
    prefixKey = 'pill-task-';
    onClass = 'pill-on-task';
    offClass = 'pill-off-task';
    labelPrefix = '🎯任务: ';
  } else if (featureName === 'autoBootEnabled') {
    // 【2026-09-23 新增】单机自动开机守护胶囊（移动云卡片行内）
    prefixKey = 'pill-autoboot-';
    onClass = 'pill-on-keepalive';
    offClass = 'pill-off-keepalive';
    labelPrefix = '🛡️守护: ';
  }

  const pillBtn = prefixKey ? document.getElementById(prefixKey + accId + '-' + vmKey) : null;
  if (pillBtn) {
    pillBtn.classList.remove(onClass, offClass);
    pillBtn.classList.add(nextVal ? onClass : offClass);
    pillBtn.innerText = labelPrefix + (nextVal ? '开' : '关');
    pillBtn.onclick = () => toggleVmFeature(accId, vmKey, featureName, !nextVal);
  }

  const featureCn = featureName === 'keepaliveEnabled' ? '单机独立保活'
    : featureName === 'taskEnabled' ? '单机自动化任务'
    : featureName === 'autoBootEnabled' ? '单机自动开机守护'
    : featureName;
  try {
    const res = await authFetch(`/api/accounts/${accId}/vm-feature`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: vmKey, desktopId: vmKey, feature: featureName, value: nextVal })
    });
    if (res.ok) {
      showToast(`已${nextVal ? '开启' : '关闭'}${featureCn}`, "success");
    } else {
      const data = await res.json();
      showToast(data.error || "更新失败", "error");
      await loadAccounts(true);
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    await loadAccounts(true);
  }
}

// 单台云电脑独立保活周期调整
function pillIntervalLabel(ownSec, accSec) {
  const fmt = (s) => {
    const n = parseInt(s, 10);
    if (!n) return '';
    return n < 60 ? n + 's脉冲' : Math.round(n / 60) + '分钟';
  };
  if (ownSec) return '⏱️' + fmt(ownSec) + ' · 单机';
  const inherited = fmt(accSec);
  return inherited ? '⏱️继承默认(' + inherited + ')' : '⏱️继承默认';
}

async function changeVmInterval(accId, vmKey, value) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const numVal = parseInt(value);
  const finalVal = (!isNaN(numVal) && numVal > 0) ? numVal : null;

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  if (isYdpc) {
    acc.vms = acc.vms || [];
    const targetVm = acc.vms.find(v => String(v.userServiceId) === String(vmKey));
    if (targetVm) targetVm.keepaliveInterval = finalVal;
  } else if (isEcloud) {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.instanceId) === String(vmKey));
    if (targetD) targetD.keepaliveInterval = finalVal;
  } else {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.desktopId || d.objId) === String(vmKey));
    if (targetD) targetD.keepaliveInterval = finalVal;
  }

  // 立即刷新卡片以联动反映多机周期概览
  renderAccounts();

  try {
    const res = await authFetch(`/api/accounts/${accId}/vm-feature`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: vmKey, desktopId: vmKey, feature: 'keepaliveInterval', value: finalVal })
    });
    if (res.ok) {
      showToast(`已将该主机保活周期调整为: ${finalVal ? ((isYdpc || isEcloud) ? Math.round(finalVal / 60) + '分钟' : finalVal + '秒') : '继承账号默认'}`, "success");
    } else {
      const data = await res.json();
      showToast(data.error || "更新失败", "error");
      await loadAccounts(true);
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    await loadAccounts(true);
  }
}

// 单台天翼云电脑快捷开机
async function bootCtyunVm(accId, desktopId) {
  showToast("正在向天翼云下发开机指令...", "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron?desktopId=${encodeURIComponent(desktopId)}`, {
      method: "POST"
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.msg || "🎉 开机指令下发成功，云电脑正在启动中！", "success");
      setTimeout(() => loadAccounts(true), 3000);
    } else {
      showToast(data.error || "开机指令下发失败", "error");
    }
  } catch (e) {
    showToast("网络异常: " + e.message, "error");
  }
}

// 3. 添加/编辑账号
async function refreshModalCaptcha() {
  const user = document.getElementById("acc-user").value.trim() || '13800000000';
  let devCode = document.getElementById("acc-device-code").value.trim();
  const imgEl = document.getElementById("acc-captcha-img");
  const loadingEl = document.getElementById("acc-captcha-loading");

  loadingEl.style.display = "inline";
  loadingEl.innerText = "获取中...";
  imgEl.style.display = "none";

  try {
    const res = await authFetch(`/api/captcha/${encodeURIComponent(user)}?deviceCode=${encodeURIComponent(devCode)}`);
    const data = await res.json();
    if (res.ok && data.success) {
      currentCaptchaChallenge = data;
      document.getElementById("acc-challenge-id").value = data.challengeId;
      document.getElementById("acc-challenge-code").value = data.challengeCode;
      if (data.deviceCode) {
        document.getElementById("acc-device-code").value = data.deviceCode;
      }
      imgEl.src = data.captchaImage;
      imgEl.style.display = "block";
      loadingEl.style.display = "none";
    } else {
      loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    loadingEl.innerText = "网络异常，点击重试";
  }
}

function switchAccountLoginTab(tab) {
  const btnQr = document.getElementById("tab-btn-qrcode");
  const btnPwd = document.getElementById("tab-btn-pwd");
  const panelQr = document.getElementById("login-panel-qrcode");
  const panelPwd = document.getElementById("login-panel-pwd");
  const btnSave = document.getElementById("btn-save-account-pwd");

  if (tab === 'qrcode') {
    if (btnQr) { btnQr.className = "btn btn-sm btn-primary"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm"; }
    if (panelQr) panelQr.classList.remove("hidden");
    if (panelPwd) panelPwd.classList.add("hidden");
    if (btnSave) btnSave.style.display = "none";
    loadQrCodeForModal();
  } else {
    if (btnQr) { btnQr.className = "btn btn-sm"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm btn-primary"; }
    if (panelQr) panelQr.classList.add("hidden");
    if (panelPwd) panelPwd.classList.remove("hidden");
    if (btnSave) btnSave.style.display = "inline-block";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    setTimeout(refreshModalCaptcha, 200);
  }
}

async function loadQrCodeForModal() {
  if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
  const imgEl = document.getElementById("acc-qrcode-img");
  const loadingEl = document.getElementById("acc-qrcode-loading");
  const hintEl = document.getElementById("acc-qrcode-hint");

  if (imgEl) imgEl.style.display = "none";
  if (loadingEl) { loadingEl.style.display = "flex"; loadingEl.innerText = "正在生成官方二维码..."; }
  if (hintEl) { hintEl.innerText = "等待扫码确认中..."; hintEl.style.color = "#2563eb"; }

  try {
    const res = await authFetch("/api/account/qrcode/generate", { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success && data.qrUrl) {
      currentQrCodeId = data.qrCodeId;
      // 使用快速 QR 渲染引擎
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.qrUrl)}`;
      if (imgEl) {
        imgEl.src = qrApiUrl;
        imgEl.onload = () => {
          imgEl.style.display = "block";
          if (loadingEl) loadingEl.style.display = "none";
        };
      }

      // 启动 2 秒轮询看门狗 (每次轮询动态读取用户实时填写的账号备注名与目标重登账号ID)
      const currentAccId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
      const accIdParam = currentAccId ? `&accId=${encodeURIComponent(currentAccId)}` : "";
      qrPollingTimer = setInterval(async () => {
        try {
          const currentNameVal = document.getElementById("qrcode-acc-name") ? document.getElementById("qrcode-acc-name").value.trim() : "";
          const sRes = await authFetch(`/api/account/qrcode/status?qrCodeId=${encodeURIComponent(currentQrCodeId)}&deviceCode=${encodeURIComponent(data.deviceCode)}&accountName=${encodeURIComponent(currentNameVal)}${accIdParam}`);
          const sData = await sRes.json();
          if (sData.success) {
            if (sData.codeStatus === 'scaned') {
              if (hintEl) { hintEl.innerText = "📱 手机端已扫描，请在手机上点击【确认登录】..."; hintEl.style.color = "#16a34a"; }
            } else if (sData.codeStatus === 'authorize') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              showToast(sData.isReAuth ? "🎉 官方扫码重新授权成功！已恢复在线保活！" : "🎉 官方扫码授权成功！云电脑已上线！", "success");
              closeModal("account-modal");
              loadAccounts();
            } else if (sData.codeStatus === 'expire') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              if (hintEl) { hintEl.innerText = "⚠️ 二维码已失效，点击刷新重试"; hintEl.style.color = "#ef4444"; }
              if (imgEl) imgEl.style.display = "none";
              if (loadingEl) {
                loadingEl.style.display = "flex";
                loadingEl.innerHTML = `<button class="btn btn-sm btn-primary" onclick="loadQrCodeForModal()">🔄 刷新二维码</button>`;
              }
            }
          }
        } catch (e) {}
      }, 2000);
    } else {
      if (loadingEl) loadingEl.innerText = "获取二维码失败: " + (data.error || '接口异常');
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "网络异常，点击重试";
  }
}

function openAddAccountModal() {
  document.getElementById("acc-id").value = "";
  document.getElementById("acc-name").value = "";
  document.getElementById("acc-user").value = "";
  document.getElementById("acc-password").value = "";
  document.getElementById("acc-password").placeholder = "请输入登录密码";
  document.getElementById("acc-captcha-code").value = "";
  document.getElementById("acc-device-code").value = "";
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = "";
  const ydNameEl = document.getElementById("ydpc-name");
  if (ydNameEl) ydNameEl.value = "";
  const ydUserEl = document.getElementById("ydpc-user");
  if (ydUserEl) ydUserEl.value = "";
  const ydSmsCode = document.getElementById("ydpc-sms-code");
  if (ydSmsCode) ydSmsCode.value = "";

  // 移动公众：清空字段并收起短信验证区、丢弃上一轮待定登录
  pendingEcloudLogin = null;
  const ecName = document.getElementById("ecloud-name");
  if (ecName) ecName.value = "";
  const ecUser = document.getElementById("ecloud-user");
  if (ecUser) ecUser.value = "";
  const ecPwd = document.getElementById("ecloud-password");
  if (ecPwd) { ecPwd.value = ""; ecPwd.placeholder = "请输入移动公众登录密码"; }
  const ecCode = document.getElementById("ecloud-sms-code");
  if (ecCode) ecCode.value = "";
  const ecInterval = document.getElementById("ecloud-interval");
  if (ecInterval) ecInterval.value = "300";
  resetEcloudSmsGroup();

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "flex";

  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "flex";

  openModal("account-modal");
  switchAddAccountPlatform('ctyun');
}

async function refreshYdpcModalCaptcha() {
  const imgEl = document.getElementById("ydpc-captcha-img");
  const loadingEl = document.getElementById("ydpc-captcha-loading");
  const randomCodeEl = document.getElementById("ydpc-random-code");

  if (loadingEl) {
    loadingEl.style.display = "inline";
    loadingEl.innerText = "获取中...";
  }
  if (imgEl) imgEl.style.display = "none";

  try {
    const res = await authFetch('/api/ydpc/captcha');
    const data = await res.json();
    if (res.ok && data.success && data.image) {
      if (randomCodeEl) randomCodeEl.value = data.randomCode || '';
      if (imgEl) {
        imgEl.src = data.image;
        imgEl.style.display = "block";
      }
      if (loadingEl) loadingEl.style.display = "none";
    } else {
      if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
  }
}


// 移动爱家只有短信验证码 / 官方 App 扫码两种登录方式，弹窗固定在这两种之间切换。
// 扫码时代码逻辑：无账号也可取码（/api/ydpc/qr/start），扫成功后由后端直接建号，
// 因此扫码模式下隐藏手机号与短信验证码，「保存」按钮也收起来（建号在轮询成功时完成）。
function switchYdpcAuthMode() {
  const modeEl = document.getElementById("ydpc-auth-mode");
  if (modeEl) modeEl.value = "sms";
  const pwd = document.getElementById("ydpc-password-group");
  if (pwd) pwd.classList.add("hidden");
  const accIdEl = document.getElementById("acc-id");
  const isEdit = !!(accIdEl && accIdEl.value);
  if (!isEdit) switchAddYdpcMode("sms");
  else {
    const sms = document.getElementById("ydpc-sms-group");
    if (sms) sms.classList.add("hidden");
  }
}

// ── 添加账号：短信 / App 扫码两页签 ──────────────────────────────────────
let addYdpcQrTimer = null;
let addYdpcQrToken = "";

function stopAddYdpcQr() {
  if (addYdpcQrTimer) { clearInterval(addYdpcQrTimer); addYdpcQrTimer = null; }
}

function switchAddYdpcMode(mode) {
  const qr = mode === "qr";
  const auth = document.getElementById("ydpc-auth-mode");
  if (auth) auth.value = qr ? "qr" : "sms";
  const sTab = document.getElementById("ydpc-add-tab-sms");
  const qTab = document.getElementById("ydpc-add-tab-qr");
  if (sTab) sTab.classList.toggle("active", !qr);
  if (qTab) qTab.classList.toggle("active", qr);
  const smsGroup = document.getElementById("ydpc-sms-group");
  if (smsGroup) smsGroup.classList.toggle("hidden", qr);
  const userGroup = document.getElementById("ydpc-user-group");
  if (userGroup) userGroup.classList.toggle("hidden", qr);
  const qrGroup = document.getElementById("ydpc-qr-group");
  if (qrGroup) qrGroup.classList.toggle("hidden", !qr);
  const hint = document.getElementById("ydpc-mode-hint");
  if (hint) {
    hint.textContent = qr
      ? "扫码成功后自动建号，手机号从和家亲 App 获取。"
      : "验证码由 10086 下发，登录态保存到本地面板。";
  }
  const submit = document.getElementById("btn-save-account-ydpc");
  if (submit) submit.style.display = qr ? "none" : "inline-block";
  if (qr) startAddYdpcQr(false);
  else stopAddYdpcQr();
}

async function startAddYdpcQr(force) {
  stopAddYdpcQr();
  const img = document.getElementById("ydpc-qr-img");
  const status = document.getElementById("ydpc-qr-status");
  if (status) status.textContent = "正在获取二维码…";
  if (force) addYdpcQrToken = "";
  try {
    const res = await authFetch("/api/ydpc/qr/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountType: (document.getElementById("ydpc-account-type") || {}).value || "main" })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (status) status.textContent = "⚠️ " + (data.error || "获取二维码失败");
      return;
    }
    addYdpcQrToken = data.token;
    if (img) img.src = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(data.url);
    if (status) status.textContent = "等待扫码…（" + (data.expireTime || 10) + " 分钟内有效）";
    let waited = 0;
    addYdpcQrTimer = setInterval(async () => {
      // 弹窗被关掉就停：否则后台会一直轮询上游
      const panel = document.getElementById("panel-add-ydpc");
      if (!panel || panel.classList.contains("hidden") || !addYdpcQrToken) { stopAddYdpcQr(); return; }
      waited += 2;
      if (waited > (data.expireTime || 10) * 60 + 5) {
        stopAddYdpcQr();
        if (status) status.textContent = "⚠️ 二维码已过期，点「刷新二维码」重新取码";
        return;
      }
      try {
        const pr = await authFetch("/api/ydpc/qr/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: addYdpcQrToken,
            name: (document.getElementById("ydpc-name") || {}).value || "",
            accountType: (document.getElementById("ydpc-account-type") || {}).value || "main",
            keepaliveInterval: parseInt((document.getElementById("ydpc-interval") || {}).value) || 600
          })
        });
        const pd = await pr.json();
        if (pd && pd.status === "waiting") {
          if (status) status.textContent = "等待扫码…（已等待 " + waited + " 秒）";
          return;
        }
        stopAddYdpcQr();
        addYdpcQrToken = "";
        if (pd && pd.success) {
          if (status) status.textContent = "✅ 扫码成功";
          showToast(pd.existing ? "登录态已刷新，正在同步云电脑…" : "🎉 扫码添加成功，已开启保活守护", "success");
          closeModal("account-modal");
          await loadAccounts(true);
          refreshBoard(true);
          return;
        }
        if (status) status.textContent = "⚠️ " + (pd.msg || pd.error || "扫码登录失败");
      } catch (e) {
        stopAddYdpcQr();
        if (status) status.textContent = "⚠️ 轮询失败：" + e.message;
      }
    }, 2000);
  } catch (e) {
    if (status) status.textContent = "⚠️ 网络异常：" + e.message;
  }
}


let ydpcSmsCountdown = null;
// ── 已有账号补短信登录态（📩）────────────────────────────────────────────
let ydpcReloginAccId = "";

function openYdpcReloginFromModal() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  closeModal("account-modal");
  if (accId) setTimeout(() => openYdpcRelogin(accId), 150);
}
let ydpcReloginTimer = null;

async function openYdpcRelogin(accId) {
  // 账号页签撤销后 accounts 不再随首屏加载，必须先按需拉一次再查
  // （否则从抽屉点「📩 短信登录」恒报"账号不存在"）
  let acc = (accounts || []).find(a => a.id === accId);
  if (!acc) {
    try { await loadAccounts(true); } catch (e) { /* 下面统一报错 */ }
    acc = (accounts || []).find(a => a.id === accId);
  }
  if (!acc) { showToast("账号不存在，请刷新后重试", "error"); return; }
  ydpcReloginAccId = accId;
  const phoneEl = document.getElementById("ydpc-relogin-phone");
  if (phoneEl) phoneEl.value = acc.user || "";
  const codeEl = document.getElementById("ydpc-relogin-code");
  if (codeEl) codeEl.value = "";
  const titleEl = document.getElementById("ydpc-relogin-title");
  if (titleEl) titleEl.textContent = "🔐 " + (acc.name || acc.user || "移动爱家") + " · 重新登录";
  const sendBtn = document.getElementById("ydpc-relogin-send");
  if (sendBtn) { sendBtn.disabled = false; sendBtn.innerText = "发送验证码"; }
  const submitBtn = document.getElementById("ydpc-relogin-submit");
  if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "登录并解除暂停"; }
  if (ydpcReloginTimer) { clearInterval(ydpcReloginTimer); ydpcReloginTimer = null; }
  openModal("ydpc-relogin-modal");
  switchReloginTab("sms");
}

async function sendYdpcReloginCode() {
  if (!ydpcReloginAccId) return;
  const phoneEl = document.getElementById("ydpc-relogin-phone");
  const btn = document.getElementById("ydpc-relogin-send");
  const phone = phoneEl ? phoneEl.value.trim() : "";
  if (!/^1\d{10}$/.test(phone)) { showToast("请填写 11 位手机号", "error"); return; }
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.innerText = "发送中..."; }
  try {
    const res = await authFetch("/api/accounts/" + encodeURIComponent(ydpcReloginAccId) + "/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("验证码已下发，请查看手机短信", "success");
      let left = 60;
      if (btn) btn.innerText = left + "s 后重发";
      if (ydpcReloginTimer) clearInterval(ydpcReloginTimer);
      ydpcReloginTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(ydpcReloginTimer);
          ydpcReloginTimer = null;
          if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
          return;
        }
        if (btn) btn.innerText = left + "s 后重发";
      }, 1000);
    } else {
      showToast(data.error || "验证码下发失败", "error");
      if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
  }
}

async function submitYdpcRelogin() {
  if (!ydpcReloginAccId) return;
  const phoneEl = document.getElementById("ydpc-relogin-phone");
  const codeEl = document.getElementById("ydpc-relogin-code");
  const btn = document.getElementById("ydpc-relogin-submit");
  const phone = phoneEl ? phoneEl.value.trim() : "";
  const smsCode = codeEl ? codeEl.value.trim() : "";
  if (!smsCode) { showToast("请填写短信验证码", "error"); return; }
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.innerText = "登录中..."; }
  try {
    const res = await authFetch("/api/accounts/" + encodeURIComponent(ydpcReloginAccId) + "/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, smsCode })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("登录成功，登录态已保存" + (typeof data.vmCount === "number" ? "（名下 " + data.vmCount + " 台）" : ""), "success");
      closeModal("ydpc-relogin-modal");
      if (typeof loadAccounts === "function") loadAccounts(true);
    } else {
      showToast("登录失败: " + (data.error || "未知错误"), "error");
      if (btn) { btn.disabled = false; btn.innerText = "登录并解除暂停"; }
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.innerText = "登录并解除暂停"; }
  }
}

// ── 扫码登录（📱 App 扫码，免短信）────────────────────────────────────────
let ydpcQrPollTimer = null;
let ydpcQrToken = "";
let ydpcQrTicks = 0;

function stopYdpcQrPoll() {
  if (ydpcQrPollTimer) { clearInterval(ydpcQrPollTimer); ydpcQrPollTimer = null; }
}

function switchReloginTab(tab) {
  const smsPane = document.getElementById("ydpc-relogin-sms-pane");
  const qrPane = document.getElementById("ydpc-relogin-qr-pane");
  const smsTab = document.getElementById("ydpc-relogin-tab-sms");
  const qrTab = document.getElementById("ydpc-relogin-tab-qr");
  const submitBtn = document.getElementById("ydpc-relogin-submit");
  const isQr = tab === "qr";
  if (smsPane) smsPane.classList.toggle("hidden", isQr);
  if (qrPane) qrPane.classList.toggle("hidden", !isQr);
  if (smsTab) smsTab.classList.toggle("active", !isQr);
  if (qrTab) qrTab.classList.toggle("active", isQr);
  // 扫码不需要点提交按钮，隐藏掉免得误以为要手动确认
  if (submitBtn) submitBtn.classList.toggle("hidden", isQr);
  if (isQr) startYdpcQrLogin();
  else stopYdpcQrPoll();
}

async function startYdpcQrLogin() {
  if (!ydpcReloginAccId) return;
  stopYdpcQrPoll();
  ydpcQrToken = "";
  ydpcQrTicks = 0;
  const img = document.getElementById("ydpc-relogin-qr-img");
  const statusEl = document.getElementById("ydpc-relogin-qr-status");
  const refreshBtn = document.getElementById("ydpc-relogin-qr-refresh");
  if (statusEl) statusEl.textContent = "正在生成二维码…";
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const res = await authFetch("/api/accounts/" + encodeURIComponent(ydpcReloginAccId) + "/qr/start", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.success || !data.url) {
      if (statusEl) statusEl.textContent = "二维码生成失败：" + (data.error || data.msg || "未知错误");
      if (refreshBtn) refreshBtn.disabled = false;
      return;
    }
    ydpcQrToken = data.token || "";
    if (img) img.src = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(data.url);
    if (statusEl) statusEl.textContent = "等待扫码…（" + (data.expireTime || 10) + " 分钟内有效）";
    if (refreshBtn) refreshBtn.disabled = false;
    ydpcQrPollTimer = setInterval(pollYdpcQrLogin, 2000);
  } catch (e) {
    if (statusEl) statusEl.textContent = "二维码生成失败：" + e.message;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

async function pollYdpcQrLogin() {
  if (!ydpcReloginAccId || !ydpcQrToken) return;
  ydpcQrTicks += 1;
  const statusEl = document.getElementById("ydpc-relogin-qr-status");
  try {
    const res = await authFetch("/api/accounts/" + encodeURIComponent(ydpcReloginAccId) + "/qr/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ydpcQrToken })
    });
    const data = await res.json();
    if (!res.ok) {
      stopYdpcQrPoll();
      if (statusEl) statusEl.textContent = "轮询失败：" + (data.error || "未知错误");
      return;
    }
    if (data.success && data.status === "success") {
      stopYdpcQrPoll();
      if (statusEl) statusEl.textContent = "✅ 扫码登录成功";
      showToast("扫码登录成功，登录态已保存" + (typeof data.vmCount === "number" ? "（名下 " + data.vmCount + " 台）" : ""), "success");
      closeModal("ydpc-relogin-modal");
      if (typeof loadAccounts === "function") loadAccounts(true);
      if (typeof refreshBoard === "function") refreshBoard(true);
      return;
    }
    if (data.status === "expired") {
      stopYdpcQrPoll();
      if (statusEl) statusEl.textContent = "二维码已失效，点「刷新二维码」重来";
      return;
    }
    // waiting：6002 扫码中，最长轮询 10 分钟（对应上游 expireTime）
    if (ydpcQrTicks * 2 >= 600) {
      stopYdpcQrPoll();
      if (statusEl) statusEl.textContent = "二维码已超时，点「刷新二维码」重来";
      return;
    }
    if (statusEl) statusEl.textContent = "等待扫码…（已等待 " + ydpcQrTicks * 2 + " 秒）";
  } catch (e) {
    if (statusEl) statusEl.textContent = "轮询异常：" + e.message + "（继续重试）";
  }
}

async function sendYdpcSmsCode() {
  const userEl = document.getElementById("ydpc-user");
  const btn = document.getElementById("ydpc-sms-send-btn");
  const phone = userEl ? userEl.value.trim() : "";
  if (!/^1\d{10}$/.test(phone)) {
    showToast("请先填写 11 位中国移动手机号", "error");
    return;
  }
  if (btn && btn.disabled) return;
  if (btn) { btn.disabled = true; btn.innerText = "发送中..."; }
  try {
    const res = await authFetch("/api/ydpc/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("验证码已下发，请查看手机短信", "success");
      let left = 60;
      if (btn) btn.innerText = left + "s 后重发";
      if (ydpcSmsCountdown) clearInterval(ydpcSmsCountdown);
      ydpcSmsCountdown = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(ydpcSmsCountdown);
          ydpcSmsCountdown = null;
          if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
          return;
        }
        if (btn) btn.innerText = left + "s 后重发";
      }, 1000);
    } else {
      showToast(data.error || "验证码下发失败", "error");
      if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.innerText = "发送验证码"; }
  }
}

function switchAddAccountPlatform(platform) {
  currentAddPlatform = platform;
  const tabCt = document.getElementById("platform-tab-ctyun");
  const tabYd = document.getElementById("platform-tab-ydpc");
  const tabEc = document.getElementById("platform-tab-ecloud");
  const panelCt = document.getElementById("panel-add-ctyun");
  const panelYd = document.getElementById("panel-add-ydpc");
  const panelEc = document.getElementById("panel-add-ecloud");
  const btnSaveCt = document.getElementById("btn-save-account-pwd");
  const btnSaveYd = document.getElementById("btn-save-account-ydpc");
  const btnSaveEc = document.getElementById("btn-save-account-ecloud");
  const loginTabs = document.getElementById("acc-login-tabs");
  const modalTitle = document.getElementById("modal-account-title");
  const isNew = !document.getElementById("acc-id").value;

  // 先统一收起全部面板/按钮，再按平台单独展开（三平台各自独立，不互相污染）
  if (tabCt) tabCt.className = "btn btn-sm";
  if (tabYd) tabYd.className = "btn btn-sm";
  if (tabEc) tabEc.className = "btn btn-sm";
  if (panelCt) panelCt.classList.add("hidden");
  if (panelYd) panelYd.classList.add("hidden");
  if (panelEc) panelEc.classList.add("hidden");
  if (btnSaveCt) btnSaveCt.style.display = "none";
  if (btnSaveYd) btnSaveYd.style.display = "none";
  if (btnSaveEc) btnSaveEc.style.display = "none";

  if (platform === 'ydpc') {
    if (tabYd) tabYd.className = "btn btn-sm btn-primary";
    if (panelYd) panelYd.classList.remove("hidden");
    if (btnSaveYd) btnSaveYd.style.display = "inline-block";
    if (modalTitle && isNew) modalTitle.innerText = "添加移动爱家账号";
    if (loginTabs) loginTabs.style.display = "none";
    switchYdpcAuthMode();
    const ydNote = document.getElementById("ydpc-edit-note");
    if (ydNote) ydNote.classList.add("hidden");
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    return;
  }

  if (platform === 'ecloud') {
    // 移动公众：登录 UI **独立设计** —— 不使用天翼云扫码、不使用移动爱家图形验证码，
    // 而是「账号+密码」→（按需）进入短信验证的两段式。
    if (tabEc) tabEc.className = "btn btn-sm btn-primary";
    if (panelEc) panelEc.classList.remove("hidden");
    if (btnSaveEc) btnSaveEc.style.display = "inline-block";
    if (modalTitle && (isNew || pendingEcloudLogin)) modalTitle.innerText = pendingEcloudLogin ? "移动公众账号 · 短信验证" : "添加移动公众账号";
    if (loginTabs) loginTabs.style.display = "none";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    return;
  }

  // 天翼云
  if (tabCt) tabCt.className = "btn btn-sm btn-primary";
  if (panelCt) panelCt.classList.remove("hidden");
  if (modalTitle && isNew) modalTitle.innerText = "添加天翼云电脑账号";
  if (isNew) {
    if (loginTabs) loginTabs.style.display = "flex";
    switchAccountLoginTab('qrcode');
  }
}

async function saveYdpcAccount() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  const name = document.getElementById("ydpc-name") ? document.getElementById("ydpc-name").value.trim() : "";
  const user = document.getElementById("ydpc-user") ? document.getElementById("ydpc-user").value.trim() : "";
  const accountType = document.getElementById("ydpc-account-type") ? document.getElementById("ydpc-account-type").value : "main";
  const keepaliveInterval = document.getElementById("ydpc-interval") ? parseInt(document.getElementById("ydpc-interval").value) || 600 : 600;

  // 移动爱家只有短信验证码 / 官方 App 扫码两种登录方式，没有账号密码登录。
  const authMode = "sms";
  if (!user) {
    showToast("请输入移动爱家手机号", "error");
    return;
  }

  // 短信验证码登录：不落盘密码，直接建号（仅新增模式）
  if (!accId && authMode === "sms") {
    const smsCode = document.getElementById("ydpc-sms-code") ? document.getElementById("ydpc-sms-code").value.trim() : "";
    if (!smsCode) {
      showToast("请输入手机收到的短信验证码", "error");
      return;
    }
    showToast("正在用短信验证码登录中国移动 SOHO 中心...", "info");
    try {
      const res = await authFetch("/api/ydpc/sms/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, user, smsCode, accountType, keepaliveInterval })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("🎉 移动爱家添加成功！已自动开启保活守护", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "短信验证码登录失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  if (accId) {
    // 编辑修改模式
    showToast("正在保存移动爱家账号修改并重新同步...", "info");
    try {
      const existingAcc = accounts.find(a => a.id === accId) || {};
      const features = {
        controlPlaneKeepalive: existingAcc.features?.controlPlaneKeepalive !== false,
        mqttKeepAlive: existingAcc.features?.mqttKeepAlive !== false,
        dataPlaneKeepalive: existingAcc.features?.dataPlaneKeepalive !== false,
        autoBoot: existingAcc.features?.autoBoot !== false,
        keepAlive: existingAcc.features?.keepAlive !== false
      };

      const res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || user,
          user,
          accountType,
          keepaliveInterval,
          features
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("🎉 移动爱家账号修改已保存！", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "更新失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  // 新增模式
  showToast("正在向中国移动 SOHO 中心验证并拉取云电脑...", "info");
  try {
    const res = await authFetch("/api/accounts/ydpc/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, user, accountType, keepaliveInterval, authMode: "sms" })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 移动爱家添加成功！已自动开启保活守护", "success");
      closeModal("account-modal");
      await loadAccounts(true);
    } else {
      const errMsg = data.error || "添加移动爱家失败";
      showToast(errMsg, "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// ====================================================
// 📡 移动公众：两段式登录 + 卡片快捷操作
// ----------------------------------------------------
// 与天翼云（扫码 / 图形验证码）和移动爱家（图形验证码）**登录 UI 完全区分**：
// 移动公众是「账号 + 密码」→ 若服务端要求设备信任 / 双因素 → 就地进入短信验证。
// 第一段 POST /api/accounts/ecloud/add   → 直接成功则落库；需短信返回 pendingId
// 第二段 POST /api/accounts/ecloud/login → 带 pendingId + code 完成并落库
// ====================================================
function showEcloudSmsGroup(info) {
  const group = document.getElementById("ecloud-sms-group");
  if (group) group.classList.remove("hidden");
  const hint = document.getElementById("ecloud-sms-hint");
  if (hint) {
    const mobile = info && info.mobile ? String(info.mobile) : '';
    const masked = mobile.length >= 7 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : (mobile || '该账号绑定手机号');
    // 诚实陈述：只有后端确认发送成功才敢说"已下发"。
    // 这里曾经无条件写死"已发送"，而后端当时根本没有发码 —— 属于本项目最忌的"假成功"。
    if (info && info.smsSent === false) {
      hint.innerHTML = `<b style="color:#b91c1c">验证码未发送成功</b>：${escapeHtml(info.smsError || '未知原因')}。请点「重新发送」重试。`;
    } else {
      hint.innerHTML = `已向 <b>${escapeHtml(masked)}</b> 下发短信验证码，请输入收到的验证码完成绑定。`;
    }
  }
  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  const resendBtn = document.getElementById("btn-ecloud-sms-resend");
  if (resendBtn) { resendBtn.disabled = false; resendBtn.innerText = "重新发送"; }
  const codeInput = document.getElementById("ecloud-sms-code");
  if (codeInput) { codeInput.value = ""; codeInput.focus(); }
}

// 重新下发验证码（走 pendingId 复用已有会话，不再走密码登录，避开限流）
async function resendEcloudSmsCode() {
  if (!pendingEcloudLogin || !pendingEcloudLogin.pendingId) {
    showToast("没有待完成的短信验证，请重新添加账号", "error");
    return;
  }
  const btn = document.getElementById("btn-ecloud-sms-resend");
  if (btn) { btn.disabled = true; btn.innerText = "发送中..."; }
  try {
    const res = await authFetch("/api/accounts/ecloud/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingId: pendingEcloudLogin.pendingId,
        mobile: pendingEcloudLogin.mobile || ""
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (data.mobile) pendingEcloudLogin.mobile = data.mobile;
      showEcloudSmsGroup({ mobile: data.mobile || pendingEcloudLogin.mobile, smsSent: true });
      showToast("📲 验证码已重新发送，请查收", "success");
    } else {
      showToast(data.error || "验证码重新发送失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "重新发送"; }
  }
}

function resetEcloudSmsGroup() {
  const group = document.getElementById("ecloud-sms-group");
  if (group) group.classList.add("hidden");
  const codeInput = document.getElementById("ecloud-sms-code");
  if (codeInput) codeInput.value = "";
  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  const resendBtn = document.getElementById("btn-ecloud-sms-resend");
  if (resendBtn) { resendBtn.disabled = false; resendBtn.innerText = "重新发送"; }
  const saveBtn = document.getElementById("btn-save-account-ecloud");
  if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = "保存移动公众账号"; }
}

async function saveEcloudAccount() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  const name = document.getElementById("ecloud-name") ? document.getElementById("ecloud-name").value.trim() : "";
  const user = document.getElementById("ecloud-user") ? document.getElementById("ecloud-user").value.trim() : "";
  const password = document.getElementById("ecloud-password") ? document.getElementById("ecloud-password").value.trim() : "";
  const keepaliveInterval = document.getElementById("ecloud-interval") ? (parseInt(document.getElementById("ecloud-interval").value) || 300) : 300;

  // 已进入第二段（等验证码）时，本按钮等同于「提交验证」
  if (!accId && pendingEcloudLogin) {
    return submitEcloudSmsCode();
  }

  if (!user || !password) {
    showToast("请输入移动公众账号与密码", "error");
    return;
  }

  if (accId) {
    // 编辑模式：只改账号信息与默认周期，分层开关由卡片上的开关单独维护
    showToast("正在保存移动公众账号修改并重新同步桌面...", "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || user, user, password, keepaliveInterval })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("🎉 移动公众账号修改已保存！", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "更新失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  // 新增模式 · 第一段
  showToast("正在通过移动公众协议侧车验证账号...", "info");
  const saveBtn = document.getElementById("btn-save-account-ecloud");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = "验证中..."; }
  try {
    const res = await authFetch("/api/accounts/ecloud/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, user, password, keepaliveInterval })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.success) {
      pendingEcloudLogin = null;
      showToast(`🎉 移动公众添加成功！已发现 ${(data.desktops || []).length} 台云电脑并启动独立保活守护`, "success");
      closeModal("account-modal");
      await loadAccounts(true);
      return;
    }

    if (data.needVerification && data.pendingId) {
      pendingEcloudLogin = {
        pendingId: data.pendingId,
        branch: data.branch || '',
        mobile: data.mobile || '',
        smsSent: data.smsSent !== false,
        name, user, password, keepaliveInterval
      };
      showEcloudSmsGroup(data);
      const titleEl = document.getElementById("modal-account-title");
      if (titleEl) titleEl.innerText = "移动公众账号 · 短信验证";
      // 本按钮此刻的作用是「提交验证码」（与上方按钮一致），不再谎称自己是"重新发送"。
      // 必须显式复位 disabled：它在本次调用开头被置为"验证中..."，若不复位，
      // 下面的 finally 因 pendingEcloudLogin 已存在而不会接管，按钮会永久卡在禁用态。
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = "提交验证码"; }
      showToast(
        data.message || (data.smsSent === false ? "验证码下发失败，请点「重新发送」重试" : "该账号登录需要短信验证，请输入收到的验证码"),
        data.smsSent === false ? "error" : "warning"
      );
      return;
    }

    showToast(data.error || `添加移动公众账号失败（HTTP ${res.status}）`, "error");
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (saveBtn && !pendingEcloudLogin) { saveBtn.disabled = false; saveBtn.innerText = "保存移动公众账号"; }
  }
}

async function submitEcloudSmsCode() {
  if (!pendingEcloudLogin || !pendingEcloudLogin.pendingId) {
    showToast("没有待完成的短信验证，请重新添加账号", "error");
    return;
  }
  const codeEl = document.getElementById("ecloud-sms-code");
  const code = codeEl ? codeEl.value.trim() : "";
  if (!code) {
    showToast("请输入收到的短信验证码", "error");
    return;
  }

  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = true; btn.innerText = "验证中..."; }

  try {
    const res = await authFetch("/api/accounts/ecloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingId: pendingEcloudLogin.pendingId,
        code,
        mobile: pendingEcloudLogin.mobile || ""
      })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.success) {
      pendingEcloudLogin = null;
      resetEcloudSmsGroup();
      showToast(`🎉 短信验证通过！已发现 ${(data.desktops || []).length} 台云电脑并启动独立保活守护`, "success");
      closeModal("account-modal");
      await loadAccounts(true);
      return;
    }

    showToast(data.error || "短信验证未通过，请检查验证码", "error");
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  }
}

// 立即执行一次移动公众分层保活（与自动巡检同一条代码路径）
async function triggerEcloudKeepalive(accId) {
  showToast("正在执行一次移动公众分层保活巡检（L1 + L2）...", "info");
  try {
    const res = await authFetch("/api/accounts/ecloud/keepalive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: accId })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const l1 = data.result && data.result.l1;
      const l2n = (data.result && data.result.l2) ? data.result.l2.length : 0;
      const l1Text = l1 ? (l1.ok === true ? 'L1 探针通过' : (l1.ok === false ? 'L1 token 失效（已按纪律处理）' : 'L1 未判定（不重登）')) : 'L1 已跳过';
      showToast(`巡检完成：${l1Text} · L2 执行 ${l2n} 台`, "success");
    } else {
      showToast("保活巡检失败: " + (data.error || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

// 重新拉取名下云主机列表（复用账号更新路由触发的 refreshDesktops）
async function syncEcloudDesktops(accId) {
  showToast("正在重新同步移动公众桌面列表...", "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast(`🔄 桌面列表已同步（${(data.desktops || []).length} 台）`, "success");
    } else {
      showToast("同步失败: " + (data.error || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

function editAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("acc-id").value = acc.id;

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "none"; // 编辑模式锁定平台

  if (acc.platform === 'ecloud') {
    document.getElementById("modal-account-title").innerText = `编辑移动公众账号 [${acc.name || acc.user}]`;
    const ecNameEl = document.getElementById("ecloud-name");
    const ecUserEl = document.getElementById("ecloud-user");
    const ecPwdEl = document.getElementById("ecloud-password");
    const ecIntEl = document.getElementById("ecloud-interval");
    if (ecNameEl) ecNameEl.value = acc.name || "";
    if (ecUserEl) ecUserEl.value = acc.user || "";
    if (ecPwdEl) { ecPwdEl.value = ""; ecPwdEl.placeholder = acc.hasPassword ? "已保存密码，留空则不修改" : "请输入移动公众登录密码"; }
    if (ecIntEl) {
      const want = String(acc.keepaliveInterval || 300);
      const exists = Array.prototype.some.call(ecIntEl.options, o => o.value === want);
      ecIntEl.value = exists ? want : "300";
    }
    // 编辑态不进入两段式登录（重置短信区，避免误提交上一轮的 pendingId）
    pendingEcloudLogin = null;
    resetEcloudSmsGroup();

    openModal("account-modal");
    switchAddAccountPlatform('ecloud');
    return;
  }

  if (acc.platform === 'ydpc') {
    document.getElementById("modal-account-title").innerText = "编辑移动爱家账号";
    const nameEl = document.getElementById("ydpc-name");
    const userEl = document.getElementById("ydpc-user");
    const typeEl = document.getElementById("ydpc-account-type");
    const intEl = document.getElementById("ydpc-interval");

    if (nameEl) nameEl.value = acc.name || "";
    if (userEl) userEl.value = acc.user || "";
    if (typeEl) typeEl.value = acc.accountType || "main";
    if (intEl) intEl.value = String(acc.keepaliveInterval || 600);

    openModal("account-modal");
    switchAddAccountPlatform('ydpc');
    // 编辑态不发短信验证码（那是登录动作），只留重登入口
    const smsGroup = document.getElementById("ydpc-sms-group");
    if (smsGroup) smsGroup.classList.add("hidden");
    const editNote = document.getElementById("ydpc-edit-note");
    if (editNote) editNote.classList.remove("hidden");
  } else {
    const isQrAccount = !acc.hasPassword;
    if (isQrAccount) {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `📱 重新扫码授权天翼云账号 [${acc.name || acc.user}]` 
        : `📱 重新扫码授权 [${acc.name || acc.user}]`;
      const qrNameEl = document.getElementById("qrcode-acc-name");
      if (qrNameEl) qrNameEl.value = acc.name || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('qrcode');
    } else {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `⚠️ 重新验证天翼云账号 [${acc.name || acc.user}]` 
        : `编辑天翼云账号 [${acc.name || acc.user}]`;
      document.getElementById("acc-name").value = acc.name || "";
      document.getElementById("acc-user").value = acc.user || "";
      const accPwdEl = document.getElementById("acc-password");
      accPwdEl.value = "";
      accPwdEl.placeholder = acc.hasPassword ? "已保存密码，留空则不修改" : "请输入登录密码";
      document.getElementById("acc-captcha-code").value = "";
      document.getElementById("acc-device-code").value = acc.deviceCode || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('pwd');
      setTimeout(refreshModalCaptcha, 300);
    }
  }
}

// 【2026-09-23 修订】移动云单机开机入口。
// 路径：本函数 → /api/accounts/:id/power/poweron → server.js → ydpc_client.bootVmViaCag()
//       → app/ydpc/cag_boot.js（CAG HTTPS 干净通道）
// 注：上一版曾误以为"电源管理弹窗已足以覆盖移动云"，但移动云卡片当时并未渲染
//     ⚡ 电源管理 按钮（该按钮只在 天翼云 分支），导致开机入口在 UI 上缺失。
//     现于每台云主机行内直接提供 🖥️开机 按钮，与 per-VM 保活开关同一排。
async function bootYdpcVm(accId, userServiceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  showToast(`正在通过 CAG 通道拉起 ${label}，请留意日志...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: String(userServiceId) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      showToast(data.message || data.msg || `🎉 已下发开机指令，${label}正在启动`, "success");
    } else {
      showToast("开机失败: " + (data.error || data.message || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("开机请求异常: " + e.message, "error");
  }
  // 无论成败都刷新，让卡片状态与日志同步
  await loadAccounts(true);
}

// 【2026-09-28】移动公众（大众版）开机：走平台官方 operate 通道（available=开机）。
// 措辞纪律：受理 ≠ 已开机 —— toast 只说"平台已受理"，最终以状态徽章变"运行中"为准。
async function bootEcloudDesktop(accId, instanceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  showToast(`正在通过平台通道拉起 ${label}，请留意日志...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: String(instanceId) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      showToast(data.message || `🎉 已下发开机指令，${label}正在启动`, "success");
    } else {
      showToast("开机失败: " + (data.error || data.message || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("开机请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

// 【2026-09-26】"机器没开机 ⇒ 本次压根没执行"必须与真失败分开渲染。
// 后端在机关机时返回 { success:false, message:'云电脑处于关机状态' }；SCG 机 / 未下发 cagIp 的机器则返回「无 CAG 通道 / 未发起握手」——同属"本次没做事"。
// 若按失败渲染会给出「异常/失败」——把"待命"渲染成"报错"，
// 与"把待命渲染成成功"是同一种失真（诚实性红线两侧都要守）。
function isVmOffSkipResult(data) {
  return !!data && data.success === false && !data.error &&
    /关机|未开机|未运行|未发起|无 CAG 通道/.test(String(data.message || ''));
}

async function pingYdpcCag(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在向中兴 CAG 发起三阶段 TCP 握手...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/cag-ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🟢 ZTEC CAG 握手成功！网关返回 200 OK", "success");
      await loadAccounts(true);
    } else if (isVmOffSkipResult(data)) {
      showToast("云电脑未开机，本次未发起 CAG 握手（开机后会自动继续）", "info");
    } else {
      showToast("CAG 握手失败: " + (data.error || "超时"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function verifyYdpcKeepAlive(accId) {
  showToast("正在启动独立状态验证（监控 60 秒，请稍候）...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/verify-keepalive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationSec: 60, intervalSec: 15 })
    });
    const data = await res.json();
    if (res.ok) {
      const detail = `持续 ${data.durationSeconds}s / 采样 ${data.snapshots?.length || 0} 次` +
        (data.firstOffSeconds !== null && data.firstOffSeconds !== undefined ? ` / 首次离线于 ${data.firstOffSeconds}s` : "");
      if (data.ok) {
        showToast(`✅ 独立验证通过：机器全程在线（${detail}）`, "success");
      } else {
        showToast(`⚠️ 独立验证未通过：${data.stopReason || "存在异常"}（${detail}）`, "error");
      }
      await loadAccounts(true);
    } else {
      showToast("验证请求失败: " + (data.error || "未知错误"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function heartbeatYdpc(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在发送 SOHO 心跳保持...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && (data.code === 2000 || data.code === 0 || data.success)) {
      showToast("💓 SOHO 心跳保持成功！", "success");
      await loadAccounts(true);
    } else if (isVmOffSkipResult(data)) {
      showToast("云电脑未开机，本次未发送心跳（开机后会自动继续）", "info");
    } else {
      showToast("心跳异常: " + (data.msg || data.error || "失败"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function generateNewDeviceCode() {
  try {
    const res = await authFetch("/api/device/generate", { method: "POST" });
    const data = await res.json();
    if (data && data.deviceCode) {
      document.getElementById("acc-device-code").value = data.deviceCode;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    } else {
      // 前端本地生成 32 位标准 web_ 设备码作为即时兜底
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let code = 'web_';
      for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      document.getElementById("acc-device-code").value = code;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    }
  } catch (e) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = 'web_';
    for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById("acc-device-code").value = code;
    showToast("已重新生成设备码", "info");
    refreshModalCaptcha();
  }
}

async function saveAccount() {
  const accId = document.getElementById("acc-id").value;
  const name = document.getElementById("acc-name").value.trim();
  const user = document.getElementById("acc-user").value.trim();
  const password = document.getElementById("acc-password").value.trim();
  const deviceCode = document.getElementById("acc-device-code").value.trim();
  const captchaCode = document.getElementById("acc-captcha-code").value.trim();
  const challengeId = document.getElementById("acc-challenge-id").value.trim();
  const challengeCode = document.getElementById("acc-challenge-code").value.trim();

  if (!user || !password) {
    showToast("手机号/账号与密码不能为空", "error");
    return;
  }

  // 新增账号或重登验证时，强制要求输入验证码
  if (!accId || (accId && captchaCode)) {
    if (!captchaCode) {
      showToast("请输入图形验证码", "error");
      document.getElementById("acc-captcha-code").focus();
      return;
    }
  }

  showToast("正在向天翼云发起真实登录验证，请稍候...", "info");

  const payload = {
    name: name || user,
    user,
    password,
    deviceCode,
    captchaCode,
    challengeId,
    challengeCode
  };

  try {
    let res;
    if (accId) {
      res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await authFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (res.ok) {
      closeModal("account-modal");
      showToast(accId ? "账号更新成功！" : "🎉 账号真实验证成功，已添加并启动保活！", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("❌ 操作未通过: " + (data.error || "验证码或密码错误"), "error");
      refreshModalCaptcha();
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!confirm(`确定要删除账号 [${acc?.name || acc?.user}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/accounts/${accId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("账号已删除", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("网络异常", "error");
  }
}

// 4. 短信验证码绑定设备 (含官方图形验证码前置校验链路)
function openSmsModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("sms-acc-id").value = acc.id;
  document.getElementById("sms-phone").value = acc.user;
  document.getElementById("sms-code").value = "";
  document.getElementById("sms-captcha-code").value = "";
  document.getElementById("sms-captcha-key").value = "";
  openModal("sms-modal");
  refreshSmsCaptcha();
}

// 方案 B：从短信弹窗一键切换到手机 App 扫码授信 (免短信，官方 App 扫码即自动信任设备)
function openQrTrustFromSms() {
  const accId = document.getElementById("sms-acc-id").value;
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  closeModal("sms-modal");

  // 复用天翼云官方扫码重授权链路：指定目标账号 ID，扫码确认后官方自动将该设备码标记为永久信任
  document.getElementById("acc-id").value = acc.id;
  const titleEl = document.getElementById("modal-account-title");
  if (titleEl) titleEl.innerText = `📱 扫码一键信任设备 [${acc.name || acc.user}] (免短信)`;
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = acc.name || "";
  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "none";

  openModal("account-modal");
  switchAddAccountPlatform('ctyun');
  switchAccountLoginTab('qrcode');
}

// 拉取天翼云官方短信流程图形验证码 (点击图片亦可刷新)
async function refreshSmsCaptcha() {
  const accId = document.getElementById("sms-acc-id").value;
  if (!accId) return;
  const imgEl = document.getElementById("sms-captcha-img");
  const loadingEl = document.getElementById("sms-captcha-loading");
  if (imgEl) imgEl.style.display = "none";
  if (loadingEl) loadingEl.style.display = "flex";
  try {
    const res = await authFetch(`/api/accounts/${accId}/sms-captcha`);
    const data = await res.json();
    if (res.ok && data.success) {
      document.getElementById("sms-captcha-key").value = data.captchaKey || "";
      if (imgEl) {
        imgEl.src = data.captchaImage;
        imgEl.style.display = "block";
      }
      if (loadingEl) loadingEl.style.display = "none";
    } else {
      if (loadingEl) loadingEl.innerHTML = `<span style="color:#ef4444; font-size:11px;">加载失败<br>点击重试</span>`;
      loadingEl && (loadingEl.onclick = () => refreshSmsCaptcha());
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:#ef4444; font-size:11px;">网络异常<br>点击重试</span>`;
    loadingEl && (loadingEl.onclick = () => refreshSmsCaptcha());
  }
}

async function sendSmsCode() {
  const accId = document.getElementById("sms-acc-id").value;
  const btn = document.getElementById("btn-send-sms");
  const captchaCode = document.getElementById("sms-captcha-code").value.trim();
  const captchaKey = document.getElementById("sms-captcha-key").value.trim();

  if (smsCountdown > 0) return;
  if (!captchaCode) {
    showToast("请先输入图形验证码", "error");
    return;
  }

  btn.innerText = "发送中...";
  btn.disabled = true;

  try {
    const res = await authFetch(`/api/accounts/${accId}/send-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captchaCode, captchaKey })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("验证码发送成功，请查收手机短信", "success");
      smsCountdown = 60;
      const timer = setInterval(() => {
        smsCountdown--;
        if (smsCountdown <= 0) {
          clearInterval(timer);
          btn.innerText = "获取验证码";
          btn.disabled = false;
        } else {
          btn.innerText = `重新获取(${smsCountdown}s)`;
        }
      }, 1000);
    } else {
      showToast("发送短信失败: " + (data.message || data.error), "error");
      btn.innerText = "获取验证码";
      btn.disabled = false;
      // 图验校验失败后自动刷新图形验证码以便重试
      refreshSmsCaptcha();
      document.getElementById("sms-captcha-code").value = "";
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
    btn.innerText = "获取验证码";
    btn.disabled = false;
  }
}

async function submitSmsBind() {
  const accId = document.getElementById("sms-acc-id").value;
  const code = document.getElementById("sms-code").value.trim();

  if (!code) {
    showToast("请输入短信验证码", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/accounts/${accId}/bind-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verificationCode: code })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("设备绑定成功！保活已就绪", "success");
      closeModal("sms-modal");
      loadAccounts();
    } else {
      showToast("绑定失败: " + (data.message || data.error), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 5. 自动兑换与抽奖设置
async function openRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("redeem-acc-id").value = acc.id;

  const cfg = acc.redeemConfig || {};
  document.getElementById("redeem-enabled").checked = !!cfg.enabled;
  document.getElementById("redeem-enabled-label").innerText = cfg.enabled ? "已启用自动兑换" : "未启用";

  document.getElementById("redeem-target-type").value = cfg.targetType || "redeem";
  document.getElementById("redeem-schedule-type").value = cfg.scheduleType || "monthly_days";
  document.getElementById("redeem-monthly-days").value = (cfg.monthlyDays || [-1]).join(",");
  document.getElementById("redeem-interval-days").value = cfg.intervalDays || 1;
  document.getElementById("redeem-max-times").value = cfg.maxRedeemTimes || 0;

  onScheduleTypeChange();
  onTargetTypeChange();

  await loadProductList(cfg.prodId);
  loadAccountDesktops(accId, cfg.desktopId);

  openModal("redeem-modal");
}

document.getElementById("redeem-enabled")?.addEventListener("change", (e) => {
  document.getElementById("redeem-enabled-label").innerText = e.target.checked ? "已启用自动兑换" : "未启用";
});

async function loadProductList(selectedProdId) {
  const select = document.getElementById("redeem-product-select");
  select.innerHTML = "<option value=''>正在连接天翼云商城拉取最新奖品...</option>";

  try {
    const res = await authFetch("/api/rewards");
    availableRewards = await res.json();

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      if (selectedProdId && Number(selectedProdId) === Number(r.prodId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  } catch (e) {
    select.innerHTML = "<option value='17023101'>8C16G升配包1天 (500积分)</option>";
  }
}

async function loadAccountDesktops(accId, selectedDesktopId) {
  const select = document.getElementById("redeem-desktop-select");
  select.innerHTML = "<option value=''>正在获取绑定的云电脑...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '云电脑'})`;
          if (selectedDesktopId && String(selectedDesktopId) === String(d.desktopId)) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='default'>默认主云电脑</option>";
}

function onTargetTypeChange() {
  const type = document.getElementById("redeem-target-type").value;
  const desktopGroup = document.getElementById("group-desktop-select");
  if (type === "lottery") {
    desktopGroup.classList.add("hidden");
  } else {
    desktopGroup.classList.remove("hidden");
  }
}

function onScheduleTypeChange() {
  const type = document.getElementById("redeem-schedule-type").value;
  document.getElementById("group-monthly-days").classList.toggle("hidden", type !== "monthly_days");
  document.getElementById("group-interval-days").classList.toggle("hidden", type !== "interval_days");
}

async function saveRedeemConfig() {
  const accId = document.getElementById("redeem-acc-id").value;
  const enabled = document.getElementById("redeem-enabled").checked;
  const targetType = document.getElementById("redeem-target-type").value;
  const prodSelect = document.getElementById("redeem-product-select");
  const selectedOpt = prodSelect.options[prodSelect.selectedIndex];

  const desktopSelect = document.getElementById("redeem-desktop-select");
  const desktopId = desktopSelect.value;
  const desktopName = desktopSelect.options[desktopSelect.selectedIndex]?.innerText || "";

  const scheduleType = document.getElementById("redeem-schedule-type").value;
  const monthlyStr = document.getElementById("redeem-monthly-days").value.trim();
  const monthlyDays = monthlyStr.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  const intervalDays = parseInt(document.getElementById("redeem-interval-days").value) || 1;
  const maxTimes = parseInt(document.getElementById("redeem-max-times").value) || 0;

  const redeemConfig = {
    enabled,
    targetType,
    prodId: selectedOpt ? parseInt(selectedOpt.value) : 17023101,
    prodName: selectedOpt ? selectedOpt.dataset.name : "8C16G升配包1天",
    prodType: selectedOpt ? selectedOpt.dataset.type : "pointstplupgrade",
    costPoints: selectedOpt ? parseInt(selectedOpt.dataset.points) : 500,
    desktopId,
    desktopName,
    scheduleType,
    monthlyDays: monthlyDays.length > 0 ? monthlyDays : [-1],
    intervalDays,
    maxRedeemTimes: maxTimes
  };

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features: { autoRedeem: enabled },
        redeemConfig
      })
    });
    if (res.ok) {
      showToast("自动兑换与抽奖配置已保存！", "success");
      closeModal("redeem-modal");
      loadAccounts();
    } else {
      showToast("保存配置失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// ==========================================
// 手动积分兑换 / 幸运抽奖
// ==========================================
async function openManualRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("manual-acc-id").value = acc.id;
  document.getElementById("manual-acc-name").innerText = acc.name || acc.user;
  const pts = acc.liveMetrics?.userPoints || acc.stats?.points || 0;
  document.getElementById("manual-user-points").innerText = pts;
  document.getElementById("manual-order-times").value = 1;

  await loadManualProductList();
  await loadManualDesktops(accId);
  updateManualTotalCost();

  openModal("manual-redeem-modal");
}

async function loadManualProductList() {
  const select = document.getElementById("manual-prod-select");
  select.innerHTML = "<option value=''>加载天翼云商城最新商品...</option>";

  try {
    if (!availableRewards || availableRewards.length === 0) {
      const res = await authFetch("/api/rewards");
      availableRewards = await res.json();
    }

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      opt.dataset.desc = r.description || "";
      select.appendChild(opt);
    });
    onManualProductChange();
  } catch (e) {
    select.innerHTML = "<option value='17023101' data-name='8C16G升配包1天' data-points='500' data-type='pointstplupgrade' data-desc='升级云电脑配置'>8C16G升配包1天 (500 积分)</option>";
    onManualProductChange();
  }
}

function onManualProductChange() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt) {
    document.getElementById("manual-prod-desc").innerText = selectedOpt.dataset.desc || "";
    // 如果是升配包（pointstplupgrade），需要选择云电脑；数据盘、智库等直发型商品无需强制选择设备
    const prodType = selectedOpt.dataset.type;
    const desktopGroup = document.getElementById("group-manual-desktop");
    if (desktopGroup) {
      desktopGroup.style.display = (prodType === 'pointstplupgrade') ? 'block' : 'none';
    }
  }
  updateManualTotalCost();
}

async function loadManualDesktops(accId) {
  const select = document.getElementById("manual-desktop-select");
  select.innerHTML = "<option value='0'>正在获取云电脑设备...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.dataset.prodInstId = d.prodInstId || "";
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '运行中'})`;
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='0'>主云电脑 (默认)</option>";
}

function updateManualTotalCost() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  const unitCost = selectedOpt ? (parseInt(selectedOpt.dataset.points) || 0) : 0;
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const total = unitCost * times;
  document.getElementById("manual-cost-tip").innerText = `单价: ${unitCost}分 | 数量: ${times} | 预计消耗: ${total} 积分`;
}

async function submitManualRedeemOrder() {
  const accId = document.getElementById("manual-acc-id").value;
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) {
    showToast("请选择要兑换的商品", "error");
    return;
  }

  const prodId = parseInt(selectedOpt.value);
  const prodName = selectedOpt.dataset.name;
  const prodType = selectedOpt.dataset.type;
  const costPoints = parseInt(selectedOpt.dataset.points) || 0;
  const desktopSelect = document.getElementById("manual-desktop-select");
  const desktopId = parseInt(desktopSelect.value) || 0;
  const prodInstId = desktopSelect.options[desktopSelect.selectedIndex]?.dataset.prodInstId || "";
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const totalCost = costPoints * times;

  const currentPts = parseInt(document.getElementById("manual-user-points").innerText) || 0;
  if (currentPts < totalCost) {
    showToast(`积分不足：当前拥有 ${currentPts} 分，本次兑换需要 ${totalCost} 分！`, "error");
    return;
  }

  if (!confirm(`确认消耗 ${totalCost} 积分立即兑换【${prodName} x${times}】吗？`)) {
    return;
  }

  const btn = document.getElementById("btn-manual-order-submit");
  btn.disabled = true;
  btn.innerText = "正在下单兑换...";

  try {
    const res = await authFetch(`/api/accounts/${accId}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prodId, prodName, prodType, costPoints, desktopId, times })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `🎉 成功兑换 ${prodName} x${times}！`, data.partial ? "warning" : "success");
      closeModal("manual-redeem-modal");
      await loadAccounts();
    } else {
      const errDetail = data.reason ? `${data.error}\n\n🔍 原因分析: ${data.reason}` : (data.error || "兑换下单失败");
      showToast(data.error || "兑换下单失败", "error");
      alert(errDetail);
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  } finally {
    // 防风控纪律：兑换后按钮强制 10 秒冷却，杜绝连续点击触发天翼云反欺诈
    let cooldown = 10;
    btn.innerText = `冷却中 (${cooldown}s)`;
    const timer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.innerText = "立即确认兑换";
      } else {
        btn.innerText = `冷却中 (${cooldown}s)`;
      }
    }, 1000);
  }
}

// ==========================================
// 云电脑电源管理 (开机 / 重启 / 关机)
// ==========================================
// 【2026-09-23 修订】移动云"开机 / 唤醒"已恢复，走 CAG HTTPS 干净通道，故电源管理弹窗
// 中重新显示该按钮；天翼云不受影响。
function setPowerBootButtonEnabled(enabled) {
  const btn = document.getElementById("power-btn-boot");
  if (!btn) return;
  btn.style.display = enabled ? "" : "none";
  btn.disabled = !enabled;
}

async function openPowerModal(accId, desktopId = '', desktopName = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("power-acc-id").value = acc.id;
  currentPowerDesktopId = desktopId || '';

  const select = document.getElementById("power-desktop-select");
  select.innerHTML = "<option value=''>正在获取名下云主机...</option>";
  document.getElementById("power-desktop-status").innerHTML = `<span style="color: #64748b;">检测中...</span>`;
  openModal("power-modal");

  if (acc.platform === 'ydpc') {
    // 2026-09-23：开机能力已恢复（CAG 干净通道），重新显示开机按钮
    setPowerBootButtonEnabled(true);
    const vms = (acc.vms && acc.vms.length > 0) ? acc.vms : (acc.desktops || []);
    const localList = vms.map(v => ({
      desktopId: String(v.userServiceId),
      desktopName: v.vmName || '中国移动云电脑',
      useStatusText: v.vmStatus || '未知',
      flavorName: v.cpu ? `${v.cpu}核/${v.memory}G` : ''
    }));
    renderPowerDesktopSelect(localList, desktopId);
    return;
  }

  // 天翼云
  setPowerBootButtonEnabled(true);
  const localList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : (acc.liveMetrics?.desktopName ? [{
    desktopId: acc.liveMetrics?.desktopId || acc.stats?.desktopId || '0',
    desktopName: acc.liveMetrics?.desktopName,
    useStatusText: '运行中',
    flavorName: ''
  }] : []);

  renderPowerDesktopSelect(localList, desktopId);

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list && list.length > 0) {
        currentPowerAccountDesktops = list;
        renderPowerDesktopSelect(list, desktopId || currentPowerDesktopId);
      }
    }
  } catch (e) {}
}

function renderPowerDesktopSelect(list, targetDesktopId) {
  const select = document.getElementById("power-desktop-select");
  if (!select) return;
  if (!list || list.length === 0) {
    select.innerHTML = "<option value=''>默认主云电脑</option>";
    onPowerDesktopChange();
    return;
  }

  currentPowerAccountDesktops = list;
  select.innerHTML = "";
  list.forEach((d, idx) => {
    const opt = document.createElement("option");
    opt.value = d.desktopId;
    opt.dataset.status = d.useStatusText || '运行中';
    const flavor = d.flavorName ? ` [${d.flavorName}]` : '';
    opt.innerText = `🖥️ ${d.desktopName || '云电脑'}${flavor} - (${d.useStatusText || '运行中'})`;
    
    // 如果指定了 targetDesktopId，或者首项匹配
    if (targetDesktopId && String(targetDesktopId) === String(d.desktopId)) {
      opt.selected = true;
    } else if (!targetDesktopId && idx === 0) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  onPowerDesktopChange();
}

function onPowerDesktopChange() {
  const select = document.getElementById("power-desktop-select");
  const statusEl = document.getElementById("power-desktop-status");
  if (!select || !statusEl) return;

  currentPowerDesktopId = select.value || '';
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt && selectedOpt.dataset.status) {
    const st = selectedOpt.dataset.status;
    const isRunning = st.includes('运行');
    statusEl.innerHTML = `<span style="color: ${isRunning ? '#16a34a' : '#d97706'}; font-weight:700;">${isRunning ? '🟢 ' : '⚪ '}${st}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color: #64748b;">就绪</span>`;
  }
}

async function executePowerAction(action) {
  const accId = document.getElementById("power-acc-id").value;
  const acc = accounts.find(a => a.id === accId);
  const actionNames = { poweron: '开机 / 唤醒', reboot: '重启', shutdown: '关机' };
  const actionName = actionNames[action] || action;

  if (action === 'shutdown' || action === 'reboot') {
    if (!confirm(`确认要对云电脑下达【${actionName}】指令吗？未保存的数据可能会丢失。`)) {
      return;
    }
  }

  if (acc && acc.platform === 'ydpc') {
    // 【2026-09-23 修订】移动云"开机 / 唤醒"已恢复，走 CAG HTTPS 干净通道；
    // 关机 / 重启仍走官方 SOHO 接口。
    showToast(`正在向移动爱家下发【${actionName}】指令...`, "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}/power/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userServiceId: currentPowerDesktopId })
      });
      const data = await res.json();
      if (res.ok && (data.success || data.code === 2000)) {
        showToast(data.message || `【${actionName}】指令已生效！`, "success");
        closeModal("power-modal");
        await loadAccounts(true);
      } else {
        showToast(`操作未成功: ${data.error || data.msg || '网关拒绝'}`, "error");
      }
    } catch (e) {
      showToast("请求异常: " + e.message, "error");
    }
    return;
  }

  // 天翼云
  showToast(`正在向天翼云下发【${actionName}】指令...`, "info");
  try {
    const query = currentPowerDesktopId ? `?desktopId=${encodeURIComponent(currentPowerDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/power/${action}${query}`, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `【${actionName}】指令下达成功！`, "success");
      closeModal("power-modal");
      await loadAccounts(true);
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast(data.error || `操作失败: ${data.message || '网关拒绝'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// ==========================================
// 弹窗浏览器免密直达访问云电脑 (自动匹配设定的分辨率与缩放，手机端全屏横向沉浸)
// ==========================================
async function launchWebDesktop(accId, targetDesktopId = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  return launchDesktopSession(accId, targetDesktopId, acc.name || acc.user || '');
}

// 阶段 3：把卡片「打开画面」链路抽成可复用函数（实例看板直接复用，失败一律 showToast 服务端 message）
async function launchDesktopSession(accId, targetDesktopId = '', displayName = '') {
  if (!accId) {
    showToast("缺少账号 ID，无法打开画面", "error");
    return;
  }
  const knownAcc = (typeof accounts !== 'undefined' && accounts) ? accounts.find(a => a.id === accId) : null;
  const displayLabel = displayName || (knownAcc && (knownAcc.name || knownAcc.user)) || accId;

  showToast(`正在获取 [${displayLabel}] 的云电脑直达访问会话...`, "info");

  try {
    const query = targetDesktopId ? `?desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/web-launch${query}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "获取访问会话失败", "error");
      return;
    }

    const token = currentAuthToken || localStorage.getItem('ctyun_auth_token') || sessionStorage.getItem('ctyun_auth_token') || '';
    const directViewParam = targetDesktopId ? `&desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const launchUrl = data.directViewUrl || `/desktop-view?accId=${accId}&token=${encodeURIComponent(token)}${directViewParam}`;

    // 智能设备检测：手机/移动端 (屏幕宽度 <= 768 或触屏移动设备)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (isMobile) {
      // 移动端：直接全屏沉浸式在新标签页/全屏视图打开，充分利用手机全部横向像素！
      const mobileWin = window.open(launchUrl, '_blank');
      if (mobileWin) {
        showToast(`📱 正在全屏打开【${data.desktopName}】操作界面！建议将手机横屏使用以获得最佳体验。`, "success");
      } else {
        window.location.href = launchUrl;
      }
    } else {
      // 桌面端：居中独立无边框弹窗
      const winWidth = Math.min(window.screen.availWidth || 1920, 1920);
      const winHeight = Math.min(window.screen.availHeight || 1080, 1080);
      const left = Math.max(0, Math.round((window.screen.availWidth - winWidth) / 2));
      const top = Math.max(0, Math.round((window.screen.availHeight - winHeight) / 2));
      const windowFeatures = `width=${winWidth},height=${winHeight},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;

      const popup = window.open(launchUrl, `ctyun_desktop_${accId}_${targetDesktopId || 'main'}`, windowFeatures);

      if (popup) {
        popup.focus();
        showToast(`已为您直达打开【${data.desktopName}】云电脑操作界面！已自动完成免密鉴权。`, "success");
      } else {
        showToast("弹窗被浏览器拦截，请在地址栏右侧允许本站点弹出窗口！", "warning");
        window.open(launchUrl, '_blank');
      }
    }
  } catch (e) {
    showToast("访问请求异常: " + e.message, "error");
  }
}

// 6. 手动触发任务与一键全量任务同步
async function syncAccountTasks(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const f = acc.features || {};
  showToast(`正在为【${acc.name || acc.user}】执行已开启项任务即时同步...`, "info");
  
  const tasksToRun = [];
  if (f.autoSign !== false) tasksToRun.push({ type: 'sign', name: '登录打卡' });
  if (f.aiChat !== false) tasksToRun.push({ type: 'aiChat', name: 'AI对话' });
  if (f.cloudHang !== false) tasksToRun.push({ type: 'hang', name: '挂机守护' });
  if (f.autoRedeem) tasksToRun.push({ type: 'redeem', name: '兑换检查' });

  if (tasksToRun.length === 0) {
    showToast(`【${acc.name || acc.user}】未开启任何自动化任务选项，无需同步。`, "warning");
    return;
  }

  try {
    for (const t of tasksToRun) {
      const res = await authFetch(`/api/accounts/${accId}/run/${t.type}`, { method: "POST" });
      if (!res.ok) {
        let detail = "HTTP " + res.status;
        try { const d = await res.json(); detail = d.error || d.message || detail; } catch (e) { /* 无 JSON 体 */ }
        throw new Error(t.name + " 同步失败：" + detail);
      }
    }

    showToast(`🎉【${acc.name || acc.user}】已开启任务（${tasksToRun.map(t=>t.name).join('/')}）已即时完成同步！`, "success");
    setTimeout(() => loadAccounts(true), 1200);
  } catch (e) {
    showToast("任务同步异常: " + e.message, "error");
  }
}

async function triggerTask(accId, taskType) {
  const acc = accounts.find(a => a.id === accId);
  const taskNames = { sign: "签到打卡", aiChat: "AI智能对话", hang: "云电脑挂机", redeem: "自动兑换检查" };
  const name = taskNames[taskType] || taskType;

  showToast(`正在向天翼云下发 [${acc?.name}] 的${name}指令并同步真实进度...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/run/${taskType}`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || `[${name}] 执行成功，官方状态已刷新！`, "success");
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast("触发失败: " + (data.error || "未知异常"), "error");
    }
  } catch (e) {
    showToast("网络异常: " + e.message, "error");
  }
}

// 7. 重启保活守护
async function restartKeeper() {
  if (!confirm("确定要平滑重置所有云电脑保活守护通道吗？")) return;
  showToast("正在重置保活通道...", "info");
  try {
    const res = await authFetch("/api/keeper/restart", { method: "POST" });
    if (!res.ok) {
      showToast("重启保活失败：HTTP " + res.status, "error");
      return;
    }
    showToast("指令已发送，保活长连接已重新建立", "success");
  } catch (e) {
    showToast("发送指令失败", "error");
  }
}

// 8. 全局系统与平台调度设置 (仅管理员)
async function openSettingsModal() {
  try {
    const res = await authFetch("/api/settings");
    if (!res.ok) {
      if (res.status === 403) {
        showToast("权限不足：仅管理员可访问全局系统设置", "error");
        return;
      }
      showToast("获取系统设置失败", "error");
      return;
    }
    const settings = await res.json();

    const c = settings.cron || {};
    if (document.getElementById("set-system-title")) {
      document.getElementById("set-system-title").value = settings.systemTitle || "天翼云 / 移动爱家 保活签到中心";
    }
    if (document.getElementById("set-system-subtitle")) {
      document.getElementById("set-system-subtitle").value = settings.systemSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机";
    }
    if (document.getElementById("cron-task-time")) {
      document.getElementById("cron-task-time").value = c.executeTime || "01:20";
    }
    const enableSub = c.enableSubCron === true;
    if (document.getElementById("cron-enable-sub")) {
      document.getElementById("cron-enable-sub").checked = enableSub;
    }
    if (document.getElementById("cron-sign")) document.getElementById("cron-sign").value = c.signCron || "";
    if (document.getElementById("cron-aichat")) document.getElementById("cron-aichat").value = c.aiChatCron || "";
    if (document.getElementById("cron-hang")) document.getElementById("cron-hang").value = c.cloudHangCron || "";
    if (document.getElementById("cron-redeem")) document.getElementById("cron-redeem").value = c.redeemCron || "";
    toggleSubCronInputs(enableSub);

    if (document.getElementById("set-allow-reg")) {
      document.getElementById("set-allow-reg").checked = settings.allowRegistration === true;
    }
    if (document.getElementById("set-default-quota")) {
      document.getElementById("set-default-quota").value = settings.defaultQuota || 2;
    }

    openModal("settings-modal");
  } catch (e) {
    showToast("获取设置失败: " + e.message, "error");
  }
}

function toggleSubCronInputs(enabled) {
  const container = document.getElementById("sub-cron-inputs-container");
  if (!container) return;
  const inputs = container.querySelectorAll("input");
  inputs.forEach(input => {
    input.disabled = !enabled;
    input.style.opacity = enabled ? "1" : "0.55";
    input.style.background = enabled ? "#ffffff" : "#f1f5f9";
  });
}

async function saveSettings() {
  const customTitle = document.getElementById("set-system-title") ? document.getElementById("set-system-title").value.trim() : "";
  const customSubtitle = document.getElementById("set-system-subtitle") ? document.getElementById("set-system-subtitle").value.trim() : "";
  const payload = {
    systemTitle: customTitle || "天翼云 / 移动爱家 保活签到中心",
    systemSubtitle: customSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机",
    keepAliveSeconds: 60,
    pulseIntervalSeconds: 30,
    allowRegistration: document.getElementById("set-allow-reg") ? document.getElementById("set-allow-reg").checked : false,
    defaultQuota: document.getElementById("set-default-quota") ? parseInt(document.getElementById("set-default-quota").value) || 2 : 2,
    cron: {
      executeTime: document.getElementById("cron-task-time") ? document.getElementById("cron-task-time").value.trim() : "01:20",
      enableSubCron: document.getElementById("cron-enable-sub") ? document.getElementById("cron-enable-sub").checked : false,
      signCron: document.getElementById("cron-sign") ? document.getElementById("cron-sign").value.trim() : "",
      aiChatCron: document.getElementById("cron-aichat") ? document.getElementById("cron-aichat").value.trim() : "",
      cloudHangCron: document.getElementById("cron-hang") ? document.getElementById("cron-hang").value.trim() : "",
      redeemCron: document.getElementById("cron-redeem") ? document.getElementById("cron-redeem").value.trim() : ""
    }
  };

  try {
    const res = await authFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast("全局系统设置已成功更新！调度已即时热重载", "success");
      closeModal("settings-modal");
      if (payload.systemTitle) {
        const titleEl = document.getElementById("main-system-title");
        if (titleEl) titleEl.innerText = payload.systemTitle;
        document.title = `${payload.systemTitle} - 多账号保活控制台`;
      }
      if (payload.systemSubtitle) {
        const subtitleEl = document.querySelector(".title-group p");
        if (subtitleEl) subtitleEl.innerText = payload.systemSubtitle;
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 8.5 个人消息通知推送设置 (所有用户通用)
async function openUserNotifyModal() {
  try {
    const res = await authFetch("/api/user/notify");
    if (!res.ok) {
      showToast("获取个人通知设置失败", "error");
      return;
    }
    const notify = await res.json();

    if (document.getElementById("user-notify-enabled")) {
      document.getElementById("user-notify-enabled").checked = !!notify.enabled;
    }
    if (document.getElementById("user-notify-channel")) {
      document.getElementById("user-notify-channel").value = notify.channel || "webhook";
    }
    if (document.getElementById("user-notify-token")) {
      document.getElementById("user-notify-token").value = notify.webhookUrl || "";
    }
    if (document.getElementById("user-notify-secret")) {
      document.getElementById("user-notify-secret").value = notify.secret || "";
    }
    if (document.getElementById("user-notify-title-tpl")) {
      document.getElementById("user-notify-title-tpl").value = notify.customTitleTemplate || "";
    }
    if (document.getElementById("user-notify-content-tpl")) {
      document.getElementById("user-notify-content-tpl").value = notify.customContentTemplate || "";
    }
    onUserNotifyChannelChange(false);
    openModal("user-notify-modal");
  } catch (e) {
    showToast("获取个人通知设置失败: " + e.message, "error");
  }
}

function onUserNotifyChannelChange(isUserSwitch = true) {
  const channelEl = document.getElementById("user-notify-channel");
  const label = document.getElementById("user-notify-token-label");
  const input = document.getElementById("user-notify-token");
  const secretGroup = document.getElementById("group-user-notify-secret");
  const secretInput = document.getElementById("user-notify-secret");
  const secretHint = document.getElementById("user-notify-secret-hint");
  if (!channelEl || !label || !input) return;

  const channel = channelEl.value;
  const currentVal = input.value.trim();

  // 控制加签密钥输入框的显隐
  if (secretGroup) {
    if (channel === "dingtalk" || channel === "feishu") {
      secretGroup.classList.remove("hidden");
      if (channel === "dingtalk") {
        document.getElementById("user-notify-secret-label").innerText = "钉钉机器人加签密钥 (Secret / 选填)";
        secretInput && (secretInput.placeholder = "例如 SECxxxxxxxx (如未开启加签请留空)");
        secretHint && (secretHint.innerText = "若机器人在钉钉中开启了【加签】安全设置，请填写以 SEC 开头的密钥；若仅使用关键词请留空。");
      } else {
        document.getElementById("user-notify-secret-label").innerText = "飞书机器人签名密钥 (Secret / 选填)";
        secretInput && (secretInput.placeholder = "例如 vQoxxxxxxxxx (如未开启签名校验请留空)");
        secretHint && (secretHint.innerText = "若飞书机器人在安全设置中开启了【签名校验】，请在此填写密钥；如未开启请留空。");
      }
    } else {
      secretGroup.classList.add("hidden");
    }
  }

  // 若用户主动在下拉列表中切换通道类型，且当前输入框中残留了其他通道的特征链接，自动清空避免跨渠道残留
  if (isUserSwitch && currentVal) {
    const isOtherChannelUrl = 
      (channel !== "feishu" && currentVal.includes("open.feishu.cn")) ||
      (channel !== "qywx" && currentVal.includes("qyapi.weixin.qq.com")) ||
      (channel !== "dingtalk" && currentVal.includes("oapi.dingtalk.com")) ||
      (channel !== "bark" && currentVal.includes("api.day.app")) ||
      (channel !== "pushplus" && currentVal.includes("pushplus.plus")) ||
      (channel !== "serverchan" && currentVal.includes("ftqq.com")) ||
      (channel !== "telegram" && currentVal.includes("api.telegram.org"));
    if (isOtherChannelUrl) {
      input.value = "";
      if (secretInput) secretInput.value = "";
    }
  }

  if (channel === "qywx") {
    label.innerText = "企业微信机器人 Webhook 地址";
    input.placeholder = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx";
  } else if (channel === "dingtalk") {
    label.innerText = "钉钉机器人 Webhook 地址 (或仅输入 Token)";
    input.placeholder = "https://oapi.dingtalk.com/robot/send?access_token=xxxx";
  } else if (channel === "feishu") {
    label.innerText = "飞书机器人 Webhook 地址";
    input.placeholder = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx";
  } else if (channel === "serverchan") {
    label.innerText = "Server酱 SendKey";
    input.placeholder = "请输入 SendKey (SCTxxxx)";
  } else if (channel === "pushplus") {
    label.innerText = "PushPlus Token";
    input.placeholder = "请输入 PushPlus Token";
  } else if (channel === "bark") {
    label.innerText = "Bark 推送完整 URL";
    input.placeholder = "例如 https://api.day.app/你的Key";
  } else if (channel === "telegram") {
    label.innerText = "TG BotToken (格式: token@chatId)";
    input.placeholder = "BotToken@ChatId";
  } else {
    label.innerText = "自定义 Webhook URL";
    input.placeholder = "https://example.com/webhook";
  }
}

async function testUserNotify() {
  const channel = document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook";
  const webhookUrl = document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "";
  const secret = document.getElementById("user-notify-secret") ? document.getElementById("user-notify-secret").value.trim() : "";
  const customTitleTemplate = document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "";
  const customContentTemplate = document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : "";

  if (!webhookUrl) {
    showToast("请先输入推送地址或 Token", "error");
    return;
  }

  showToast("正在发送测试推送...", "info");
  try {
    const res = await authFetch("/api/user/notify/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, webhookUrl, secret, customTitleTemplate, customContentTemplate })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 推送成功！已向您的专属通道发送测试卡片", "success");
    } else {
      showToast(`推送失败: ${data.message || '网络无法连通或已被系统安全拦截'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function saveUserNotify() {
  const payload = {
    enabled: document.getElementById("user-notify-enabled") ? document.getElementById("user-notify-enabled").checked : false,
    channel: document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook",
    webhookUrl: document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "",
    secret: document.getElementById("user-notify-secret") ? document.getElementById("user-notify-secret").value.trim() : "",
    customTitleTemplate: document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "",
    customContentTemplate: document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : ""
  };

  try {
    const res = await authFetch("/api/user/notify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("个人通知设置已成功保存！", "success");
      closeModal("user-notify-modal");
    } else {
      showToast(data.error || "保存失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 9. 实时控制台日志与分类过滤 (三维绝对隔离：平台筛选 + 业务事件)
function switchPlatformFilter(platform) {
  activePlatformFilter = platform;
  const pAll = document.getElementById('tab-platform-all');
  const pCt = document.getElementById('tab-platform-ctyun');
  const pYd = document.getElementById('tab-platform-ydpc');
  const pEc = document.getElementById('tab-platform-ecloud');
  if (pAll) pAll.className = platform === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pCt) pCt.className = platform === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pYd) pYd.className = platform === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pEc) pEc.className = platform === 'ecloud' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

function switchLogFilter(filterType) {
  activeLogFilter = filterType;
  const tTasks = document.getElementById('tab-tasks');
  const tHeart = document.getElementById('tab-heartbeat');
  const tAll = document.getElementById('tab-all');
  if (tTasks) tTasks.className = filterType === 'tasks' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tHeart) tHeart.className = filterType === 'heartbeat' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tAll) tAll.className = filterType === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

// 统一日志可见性判定引擎 (双维过滤：平台隔离 + 业务类型)
function shouldDisplayLogItem(item) {
  if (!item) return false;

  // 1. 平台维度绝对隔离（三平台各自成流：天翼云 / 移动爱家 / 移动公众）
  const isSystemOrAuth = item.source === 'System' || item.source === 'Auth' || item.source === 'Admin' || item.source === 'Notify';
  if (!isSystemOrAuth) {
    if (activePlatformFilter === 'ctyun' && item.platform !== 'ctyun') return false;
    if (activePlatformFilter === 'ydpc' && item.platform !== 'ydpc') return false;
    if (activePlatformFilter === 'ecloud' && item.platform !== 'ecloud') return false;
  }

  // 2. 业务事件维度过滤 (心跳/长连保活 vs 业务任务)
  //    【2026-09-23】CAGRAW（数据面保活）与 MQTT（官方长连链路）同属心跳保活类，
  //    此前漏配导致它们被误归入「任务」分类。
  //    【2026-09-24】ECLOUD（移动公众协议侧车）同属保活类；日志源独立于 SOHO/CAG，互不混流。
  const isHeartbeat = item.source === 'Heartbeat' || item.source === 'CAG' || item.source === 'CAGRAW'
    || item.source === 'KeepAlive' || item.source === 'SOHO' || item.source === 'MQTT'
    || item.source === 'ECLOUD';
  if (activeLogFilter === 'heartbeat' && !isHeartbeat) return false;
  if (activeLogFilter === 'tasks' && isHeartbeat) return false;
  return true;
}

/**
 * 日志行的稳定身份键：优先用服务端 id；无 id 时退化为"来源+平台+账号+文本"。
 * 折叠更新会保持 id 不变，所以同一件事的新旧快照拿到的是**同一个键**。
 */
function logLineKey(item) {
  if (!item) return '';
  if (item.id) return 'id:' + item.id;
  return 'k:' + (item.source || '') + '|' + (item.platform || '') + '|' + (item.accountName || '') + '|' + (item.message || '');
}

/**
 * 内存日志数组的**幂等插入**：同一身份键只保留一条，就地替换为最新快照并排到末尾。
 *
 * 【为什么必须幂等 · 用户 2026-09-25 第六轮】
 * 服务端每次 SSE 连接都会重发最近 80 条历史。旧逻辑里这些历史走"无条件 push + appendChild"，
 * 于是每重连一次，同一件事就多出一行，且各自带着**当时那一刻**的 xN 快照
 * （用户看到 x3353 / x3354 / x3355 … 连续递增地铺了一屏，就是这么来的）。
 * 改为按身份键就地更新后，重发多少次都只有一行，且始终显示最新计数。
 */
function upsertLogList(list, item) {
  const key = logLineKey(item);
  const idx = list.findIndex(l => logLineKey(l) === key);
  if (idx !== -1) {
    list[idx] = item;
    if (idx !== list.length - 1) {
      list.splice(idx, 1);
      list.push(item);
    }
    return 'updated';
  }
  list.push(item);
  return 'inserted';
}

function logLineInnerHtml(item) {
  const repeatBadge = (item.repeatCount && item.repeatCount > 1)
    ? `<span class="badge-repeat">x${item.repeatCount}</span>`
    : '';
  return `<span class="log-time">[${item.timestamp}]</span><span class="log-source">[${item.source}]</span><span class="log-text">${escapeHtml(item.message)}</span>${repeatBadge}`;
}

function createLogLineElement(item) {
  const line = document.createElement("div");
  line.className = `log-line log-level-${item.level || 'info'}`;
  if (item.id) line.dataset.logId = item.id;
  line.dataset.logKey = logLineKey(item);
  line.innerHTML = logLineInnerHtml(item);
  return line;
}

/** 渲染行数上限：与内存数组 3000 上限同源，避免长期运行后 DOM 无界增长 */
const MAX_RENDERED_LOG_LINES = 2000;

/**
 * 把一条日志（新增 或 折叠更新）**幂等**地落到 DOM 上。
 * 新增与更新走同一条路径 —— 这是"重连重发历史导致整屏翻倍"的根治点。
 */
function upsertLogLine(logBox, item) {
  if (!logBox) return;
  const key = logLineKey(item);
  const existing = renderedLogLines.get(key);

  if (!shouldDisplayLogItem(item)) {
    // 不符合当前平台/类型过滤：已渲染的要从 DOM 移除，避免切过滤后留下幽灵行
    if (existing) {
      existing.remove();
      renderedLogLines.delete(key);
    }
    return;
  }

  if (existing && existing.isConnected) {
    existing.className = `log-line log-level-${item.level || 'info'}`;
    existing.innerHTML = logLineInnerHtml(item);
    existing.classList.remove('log-flash');
    void existing.offsetWidth;
    existing.classList.add('log-flash');
    // appendChild 对已存在的节点是"移动"而非"复制"，保证最新一行始终在末尾
    logBox.appendChild(existing);
    return;
  }

  const emptyEl = logBox.querySelector('.log-line');
  if (emptyEl && emptyEl.innerText.includes('[暂无此类日志]')) emptyEl.remove();
  const line = createLogLineElement(item);
  logBox.appendChild(line);
  renderedLogLines.set(key, line);

  while (renderedLogLines.size > MAX_RENDERED_LOG_LINES) {
    const oldest = logBox.firstElementChild;
    if (!oldest) break;
    const oldestKey = oldest.dataset.logKey;
    if (oldestKey) renderedLogLines.delete(oldestKey);
    oldest.remove();
  }
}

function renderFilteredLogs() {
  const logBox = document.getElementById("log-content");
  if (!logBox) return;
  logBox.innerHTML = "";
  // 整表重建 ⇒ 注册表必须同步清空重建，否则会残留指向已销毁节点的引用
  renderedLogLines.clear();

  const filtered = allReceivedLogs.filter(shouldDisplayLogItem);

  if (filtered.length === 0) {
    logBox.innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[暂无此类日志]</div>`;
    return;
  }

  filtered.forEach(item => {
    const line = createLogLineElement(item);
    logBox.appendChild(line);
    renderedLogLines.set(logLineKey(item), line);
  });

  if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
}

async function initLogStream() {
  const statusSpan = document.getElementById("log-status");

  // 单用户模式：不再有 token 闸门（网关不校验），直接订阅日志流。
  // 曾经的 !currentAuthToken 早退会让「实时控制台日志」永远停在「未登录」且一条日志都收不到。
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // 仅通过单一的 SSE 流实时推送与初始化历史日志，彻底消除“历史请求+初始流”造成的二次重复！
  const sseUrl = "/api/logs/stream";
  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    statusSpan.innerText = "已连接";
    statusSpan.className = "badge badge-online";
  };

  eventSource.onmessage = (e) => {
    try {
      const item = JSON.parse(e.data);
      const logBox = document.getElementById("log-content");

      // 【2026-09-25 用户要求·第六轮】新增 与 折叠更新 走**同一条幂等路径**。
      //
      // 旧逻辑有两个致命缺口，合起来就是用户看到的"同一件事 x3353、x3354、x3355 … 铺一屏"：
      //   ① isUpdate 分支用 `l.id === item.id || 同 source+account` 在数组里找条目 ——
      //      后半句会把**同源同账号的其它条目**误当作自己，于是数组越换越乱；
      //   ② 非 isUpdate 分支（也就是服务端每次连接都会重发的最近 80 条历史）**无条件 push
      //      与 appendChild** —— 每重连一次就整批再画一遍，且每条都带着"当时那一刻"的 xN 快照。
      // 现在统一为：数组按身份键就地 upsert，DOM 也按身份键就地 upsert。
      upsertLogList(allReceivedLogs, item);
      if (allReceivedLogs.length > 3000) {
        const dropped = allReceivedLogs.shift();
        // 内存淘汰同步反映到 DOM，避免两处视图长期不一致
        const droppedKey = logLineKey(dropped);
        const droppedLine = renderedLogLines.get(droppedKey);
        if (droppedLine) {
          droppedLine.remove();
          renderedLogLines.delete(droppedKey);
        }
      }

      upsertLogLine(logBox, item);
      if (autoScroll && logBox) logBox.scrollTop = logBox.scrollHeight;
    } catch (err) {}
  };

  eventSource.onerror = () => {
    // 单用户模式没有「未登录」这个态，只有断线与待命
    statusSpan.innerText = "日志流重连中…";
    statusSpan.style.color = "#64748b";
  };
}

async function clearLogs() {
  allReceivedLogs = [];
  renderedLogLines.clear();
  document.getElementById("log-content").innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[日志已彻底清空]</div>`;
  
  // 联动后端持久化清空
  try {
    const res = await authFetch('/api/logs/clear', { method: 'POST' });
    if (res.ok) {
      showToast("控制台与后台历史日志已全部一键清空", "success");
    } else {
      showToast("前端已清屏", "info");
    }
  } catch (e) {
    showToast("前端已清屏", "info");
  }
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById("btn-autoscroll").innerText = `自动滚动: ${autoScroll ? '开' : '关'}`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("设备码已复制到剪贴板", "success");
  }).catch(() => {
    showToast("复制失败，请手动复制", "error");
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 【2026-09-25 用户要求】把渲染用的 HTML 片段转成能放进 title 属性的纯文本。
 *
 * 为什么不能直接塞 HTML：title 属性不解析标签，`<b>` 会原样显示成字面量。
 * 为什么还要反转义：这些片段里的用户可见文本已经过 escapeHtml（&amp;/&lt;/&quot;），
 * 再去标签后必须先还原成原字符，否则 escapeHtml 会二次转义、悬停看到 `&amp;` 这类乱码。
 * 注意 `&amp;` 必须最后还原 —— 否则 `&amp;lt;` 会被错解成 `<`。
 */
function htmlToPlainTitle(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// ==========================================
// 配置备份与还原 (JSON 导入/导出)
// ==========================================
function openReleaseNotesModal() {
  if (!currentUser && !currentAuthToken) {
    showToast("请先登录账号后再查看版本更新介绍！", "warning");
    openAuthModal();
    return;
  }
  openModal("release-notes-modal");
}

function openBackupModal() {
  document.getElementById("import-file-name").innerText = "未选择文件";
  document.getElementById("import-file-input").value = "";
  openModal("backup-modal");
}

// 备份文件里含账号明文密码，/api/config/export 与 /api/config/import 在 8555 网关后
// 要求口令（只认 X-Export-Pass 请求头，网关不接受 query 参数，避免口令进历史/日志）。
// 口令既不在前端代码里也不进 localStorage：每次操作问一次，只放在本页内存。
let configExportPass = "";

function askConfigExportPass() {
  if (configExportPass) return configExportPass;
  const input = window.prompt("请输入备份口令（部署方在 .env 的 EXPORT_PASS 中设置）：", "");
  if (input === null) return ""; // 用户取消
  configExportPass = String(input).trim();
  return configExportPass;
}

async function exportConfigJson() {
  try {
    const pass = askConfigExportPass();
    if (!pass) {
      showToast("已取消导出", "info");
      return;
    }
    showToast("正在导出配置...", "info");
    const res = await authFetch("/api/config/export", { headers: { "X-Export-Pass": pass } });
    if (res.status === 403) {
      configExportPass = "";
      throw new Error("口令不正确或被网关拒绝，请重试");
    }
    if (!res.ok) throw new Error("导出失败（HTTP " + res.status + "）");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ctyun_config_backup_${new Date().toISOString().substring(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast("🎉 配置备份文件已成功下载！", "success");
  } catch (e) {
    showToast("导出失败: " + e.message, "error");
  }
}

function handleFileSelected(input) {
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  document.getElementById("import-file-name").innerText = file.name;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.accounts || !Array.isArray(json.accounts)) {
        showToast("文件格式错误：未找到 accounts 账号列表", "error");
        return;
      }
      const mode = document.getElementById("import-mode-select").value;
      const count = json.accounts.length;
      if (!confirm(`检测到文件中包含 ${count} 个云电脑账号，确认使用【${mode === 'merge' ? '增量合并' : '完全覆盖'}】模式导入吗？`)) {
        return;
      }

      const pass = askConfigExportPass();
      if (!pass) {
        showToast("已取消导入", "info");
        return;
      }
      showToast("正在解析并导入账号配置...", "info");
      const res = await authFetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Export-Pass": pass },
        body: JSON.stringify({ ...json, mode })
      });
      if (res.status === 403) {
        configExportPass = "";
        showToast("导入被拒绝：口令不正确或被网关拦截", "error");
        return;
      }
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || "导入成功！已自动上线长连接保活", "success");
        closeModal("backup-modal");
        await loadAccounts();
      } else {
        showToast("导入失败: " + (data.error || "未知异常"), "error");
      }
    } catch (err) {
      showToast("JSON 解析失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

// ==========================================
// 多用户系统与管理员配额控制
// ==========================================
function openAuthModal() {
  console.warn("[单用户模式] 登录入口已下线");
  return;
  document.getElementById("auth-username").value = "";
  document.getElementById("auth-password").value = "";
  switchAuthMode("login");
  openModal("auth-modal");
  setTimeout(() => {
    const input = document.getElementById("auth-username");
    if (input) input.focus();
  }, 100);
}

function switchAuthMode(mode) {
  console.warn("[单用户模式] 登录/注册切换已下线");
  return;
  authMode = mode;
  const isLogin = mode === "login";
  document.getElementById("auth-modal-title").innerText = isLogin ? "用户登录" : "新用户注册";
  document.getElementById("btn-auth-tab-login").className = isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-tab-reg").className = !isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-submit").innerText = isLogin ? "立即登录" : "立即注册并登录";
  const tipEle = document.getElementById("auth-tip");
  if (tipEle) {
    tipEle.innerHTML = "";
  }
}

async function submitAuth() {
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value.trim();

  if (!username || !password) {
    showToast("请输入用户名和密码", "error");
    return;
  }

  const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  // 【2026-09-28】30 天免登录：勾选 ⇒ 会话落盘（服务端）+ localStorage（浏览器侧）；
  // 不勾选 ⇒ 仅 sessionStorage（关闭浏览器即失效）+ 服务端内存会话（容器重启即失效）。
  const rememberEl = document.getElementById("auth-remember");
  const remember = !!(rememberEl && rememberEl.checked);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, remember })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentAuthToken = data.token;
      try {
        if (remember) {
          localStorage.setItem("ctyun_auth_token", data.token);
          sessionStorage.removeItem("ctyun_auth_token");
        } else {
          sessionStorage.setItem("ctyun_auth_token", data.token);
          localStorage.removeItem("ctyun_auth_token");
        }
      } catch (e) { /* 隐私模式等存储不可用时仅内存生效 */ }
      showToast(authMode === "login" ? `欢迎回来，${data.user.username}！` : `注册成功，欢迎加入！`, "success");
      closeModal("auth-modal");
      // 立即前端就地置为已登录，彻底消除任何 DOM 刷新等待延迟！
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      const initial = (currentUser.username || "A")[0].toUpperCase();
      const headerAvatar = document.getElementById("header-avatar");
      const dropdownUsername = document.getElementById("dropdown-username");
      const menuAdminUsers = document.getElementById("menu-admin-users");
      const authBtn = document.getElementById("btn-auth-action");
      const loggedActionsGroup = document.getElementById("logged-actions-group");
      const statsGrid = document.getElementById("main-stats-grid");
      const sectionHeader = document.getElementById("main-section-header");
      const logPanel = document.getElementById("main-log-panel");

      if (headerAvatar) headerAvatar.innerText = initial;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      checkCurrentUser();
      loadAccounts();
    } else {
      showToast(data.error || "操作失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
}

function logoutUser() {
  console.warn("[单用户模式] 无登出");
  return;
  // 【2026-09-28】退出必须**显式吊销服务端会话**：免登录会话已落盘，
  // 只清浏览器存储的话，容器重启后旧 token 依然有效（等于"退不掉"）。
  const token = currentAuthToken || localStorage.getItem("ctyun_auth_token") || sessionStorage.getItem("ctyun_auth_token") || "";
  if (token) {
    fetch("/api/auth/logout", { method: "POST", headers: { "Authorization": "Bearer " + token } }).catch(() => {});
  }
  currentAuthToken = "";
  localStorage.removeItem("ctyun_auth_token");
  sessionStorage.removeItem("ctyun_auth_token");
  currentUser = null;
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }
  allReceivedLogs = [];
  renderedLogLines.clear();
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = '<div class="log-line"><span class="log-time">[系统]</span> 未登录状态，日志已隐藏</div>';
  showToast("已安全退出登录", "info");
  checkCurrentUser();
  loadAccounts();
}

// 打开管理员用户配额管理模态框
async function openAdminUsersModal() {
  console.warn("[单用户模式] 用户管理已下线");
  return;
  const tbody = document.getElementById("admin-users-tbody");
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-muted);">正在加载用户列表...</td></tr>`;
  openModal("admin-users-modal");

  try {
    const res = await authFetch("/api/admin/users");
    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">权限不足或获取用户列表失败</td></tr>`;
      return;
    }
    const users = await res.json();
    tbody.innerHTML = "";

    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--border)";
      const isAdmin = u.role === "admin";

      tr.innerHTML = `
        <td style="padding: 10px 8px; font-weight: 600; white-space: nowrap;">${escapeHtml(u.username)}</td>
        <td style="padding: 10px 8px; white-space: nowrap;">
          <span class="badge ${isAdmin ? 'badge-online' : 'badge-offline'}">${isAdmin ? '超级管理员' : '普通用户'}</span>
        </td>
        <td style="padding: 10px 8px; font-weight: 600; color: #38bdf8; white-space: nowrap;">${u.accountsCount || 0} 台</td>
        <td style="padding: 10px 8px; white-space: nowrap;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="number" class="form-control" style="width: 70px; padding: 4px 6px; font-size: 12px;" id="quota-input-${u.id}" value="${u.maxQuota || 2}" min="0">
            <button class="btn btn-sm btn-primary" onclick="saveUserQuota('${u.id}')" style="white-space: nowrap; padding: 4px 8px;">保存配额</button>
          </div>
        </td>
        <td style="padding: 10px 8px; white-space: nowrap; text-align: right;">
          <div style="display: flex; gap: 4px; justify-content: flex-end;">
            <button class="btn btn-sm" onclick="openAdminSetPwdModal('${u.id}', '${u.username}')" style="white-space: nowrap; padding: 4px 8px;">修改密码</button>
            ${!isAdmin ? `<button class="btn btn-sm btn-danger" onclick="deleteUserAccount('${u.id}', '${u.username}')" style="white-space: nowrap; padding: 4px 8px;">删除</button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">加载异常: ${e.message}</td></tr>`;
  }
}

async function saveUserQuota(userId) {
  const input = document.getElementById(`quota-input-${userId}`);
  const quota = parseInt(input.value) || 0;

  try {
    const res = await authFetch(`/api/admin/users/${userId}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxQuota: quota })
    });
    if (res.ok) {
      showToast(`已成功将该用户的云电脑添加配额设置为 ${quota} 台！`, "success");
      checkCurrentUser();
    } else {
      showToast("设置配额失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteUserAccount(userId, username) {
  if (!confirm(`确定要删除普通用户 [${username}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("用户已删除", "success");
      openAdminUsersModal();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 修改个人密码/修改管理员用户名
function openChangePwdModal() {
  console.warn("[单用户模式] 改密已下线");
  return;
  document.getElementById("new-user-pwd").value = "";
  document.getElementById("confirm-user-pwd").value = "";
  
  // 回显头像设置
  if (document.getElementById("custom-user-avatar")) {
    document.getElementById("custom-user-avatar").value = currentUser?.avatar || "";
  }
  updateAvatarPreview(currentUser?.avatar || (currentUser?.username || "A")[0].toUpperCase());

  const adminGroup = document.getElementById("admin-change-username-group");
  if (adminGroup) {
    const isAdmin = currentUser && currentUser.role === "admin";
    adminGroup.classList.toggle("hidden", !isAdmin);
    if (isAdmin) {
      document.getElementById("new-admin-username").value = currentUser.username || "admin";
    }
  }
  openModal("change-pwd-modal");
}

function selectPresetAvatar(emoji) {
  const input = document.getElementById("custom-user-avatar");
  if (input) input.value = emoji;
  updateAvatarPreview(emoji);
}

function updateAvatarPreview(text) {
  const preview = document.getElementById("current-avatar-preview");
  if (!preview) return;
  const val = (text || '').trim();
  preview.innerText = val ? val.slice(0, 2) : ((currentUser?.username || "A")[0].toUpperCase());
}

async function submitChangeAvatar() {
  const customAvatar = document.getElementById("custom-user-avatar") ? document.getElementById("custom-user-avatar").value.trim() : "";
  if (!customAvatar) {
    showToast("请输入或选择一个头像内容", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar: customAvatar })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (currentUser) currentUser.avatar = customAvatar;
      const headerAvatar = document.getElementById("header-avatar");
      if (headerAvatar) headerAvatar.innerText = customAvatar.slice(0, 2);
      showToast("🎉 头像个性化设置已保存！", "success");
    } else {
      showToast(data.error || "头像设置失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
}

async function submitChangeUsername() {
  const newName = document.getElementById("new-admin-username").value.trim();
  if (!newName) {
    showToast("用户名不能为空", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newUsername: newName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`管理员用户名已成功修改为: ${newName}！`, "success");
      await checkCurrentUser();
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function submitChangePassword() {
  const p1 = document.getElementById("new-user-pwd").value.trim();
  const p2 = document.getElementById("confirm-user-pwd").value.trim();

  if (!p1 || p1.length < 5) {
    showToast("新密码长度不能少于5位", "error");
    return;
  }
  if (p1 !== p2) {
    showToast("两次输入的新密码不一致", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: p1 })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("密码修改成功，请牢记新密码！", "success");
      closeModal("change-pwd-modal");
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 管理员修改其他用户密码
function openAdminSetPwdModal(userId, username) {
  document.getElementById("admin-edit-user-id").value = userId;
  document.getElementById("admin-edit-username").value = username;
  document.getElementById("admin-set-new-pwd").value = "";
  openModal("admin-user-pwd-modal");
}

async function submitAdminUserPassword() {
  const userId = document.getElementById("admin-edit-user-id").value;
  const newPassword = document.getElementById("admin-set-new-pwd").value.trim();

  if (!newPassword || newPassword.length < 5) {
    showToast("密码长度至少5位", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/admin/users/${userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("指定用户密码已成功更新！", "success");
      closeModal("admin-user-pwd-modal");
    } else {
      showToast(data.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 响应式窗口缩放防抖自动重新排版
let resizeGridTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeGridTimer);
  resizeGridTimer = setTimeout(() => {
    if (currentUser) renderAccounts();
  }, 250);
});


/* ==========================================================================
   阶段 3 · 实例看板（统一混合列表 + 账号分组头 + 右侧抽屉）
   数据源：唯一 GET /api/resources（8555 同源 BFF），无第二来源、无 iframe。
   注意：页面挂在 /ctyun/ 下，boot.js 注入的同源 shim 会把 "/" 开头的运行时
   请求改写成 /ctyun/...，因此看板数据请求使用 location.origin 拼出的绝对
   URL 直达 BFF；账号写接口仍用 "/api/accounts/..."（shim 改写后正是 ctyun
   上游的对应路径），云手机写接口用 "/cmcc/api/devices/..."（shim 不改写）。
   ========================================================================== */
const BOARD_REFRESH_MS = 15000;
const BOARD_INTERVAL_OPTIONS = [300, 600, 900, 1800];
const BOARD_DASH = "—";
const boardKeepAliveOverride = new Map();
let boardRows = [];
let boardMeta = null;
let boardLoading = false;
// 最近一次拉取失败的时间：失败时不清空旧数据，但必须在横幅上说清楚"这是旧数据"
let boardDataErrorAt = 0;
// 横幅要说"最后成功是什么时候"。拿失败时刻当成功时刻会让时间每次重试都往后跳，
// 用户会以为数据是新的（实测审计 §P1 抓到）。
let boardLastOkAt = 0;
let boardTimer = null;
// 阶段 8：首屏是总览；资源 / 账号 / 运维为同级视图
const BOARD_VIEWS = ["overview", "board", "tariff", "billing", "ops"];
let boardActiveView = "overview";
let boardSelectedRowId = "";

/* ---------------------------------------------------------------- 工具函数 */
// 暂停原因码 → 人话（后端只给稳定码，中文文案在前端统一）
function boardPausedReasonText(reason) {
  const code = String(reason || "");
  if (code === "sms_login_required") return "短信账号未保存密码，需重新短信登录";
  if (code.indexOf("连续失败") === 0) return code;
  return code;
}

function boardText(value, fallback) {
  if (value === null || value === undefined) return fallback === undefined ? BOARD_DASH : fallback;
  const text = String(value).trim();
  if (!text || text === "null" || text === "undefined") return fallback === undefined ? BOARD_DASH : fallback;
  return text;
}

function boardIntervalText(sec) {
  const num = parseInt(sec, 10);
  if (!num || num <= 0) return BOARD_DASH;
  if (num < 60) return num + " 秒";
  const minutes = Math.round(num / 60);
  return minutes + " 分钟";
}

function boardTimeText(value) {
  if (!value) return BOARD_DASH;
  const num = typeof value === "number" ? value : Date.parse(value);
  if (!num) return BOARD_DASH;
  const date = new Date(num);
  if (isNaN(date.getTime())) return BOARD_DASH;
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function boardRowFind(rowId) {
  const key = String(rowId || "");
  return boardRows.find((row) => String(row && row.id) === key) || null;
}

function boardAccountLabel(row) {
  const acc = (row && row.account) || {};
  return boardText(acc.label || acc.name, (row && row.accountId) || BOARD_DASH);
}

/* 按账号分组：保持后端返回顺序（先云电脑子应用，再云手机子应用） */
function boardGroups() {
  const groups = new Map();
  boardRows.forEach((row) => {
    const key = String(row.source || "") + ":" + String(row.accountId || row.id || "");
    if (!groups.has(key)) {
      groups.set(key, {
        key: key,
        source: row.source || "",
        accountId: String(row.accountId || ""),
        account: row.account || {},
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  });
  const list = Array.from(groups.values());
  if (boardSortState.key) {
    list.forEach((g) => g.rows.sort((a, b) => boardSortCompare(a, b)));
    list.sort((a, b) => boardSortCompare(a.rows[0] || {}, b.rows[0] || {}));
  }
  return list;
}

// 表头排序（取代旧卡片的拖拽排序：分组本身有语义，拖次序反而破坏"按账号归组"）
let boardSortState = { key: "", dir: 1 };
// 分组折叠：一个账号下 5 台时整表很长，收起次要分组只留标题行
const boardCollapsedGroups = new Set();
const BOARD_SKELETON_ROWS = 6;
// 抽屉关闭后焦点要还回触发元素，否则键盘用户每次关抽屉都掉回页面顶端
let drawerReturnFocus = null;
const BOARD_SORT_LABEL = { type: "类型", name: "实例名称", platform: "平台", account: "账号归属", status: "保活状态", heartbeat: "最近心跳" };

function boardSortValue(row, key) {
  const keepalive = row.keepalive || {};
  const STATUS_RANK = { error: 0, paused: 1, idle: 2, stopped: 3, managed_stalled: 4, managed: 5, managed_off: 6, keeping: 7, keeping_long: 8 };
  if (key === "type") return ({ pc: 0, phone: 1, vdi: 2 })[row.type] ?? 9;
  if (key === "status") return STATUS_RANK[String(keepalive.status || "")] ?? 9;
  if (key === "heartbeat") {
    const beat = (row.heartbeat || {}).at;
    return beat ? Number(new Date(beat)) : 0;
  }
  if (key === "platform") return String(row.platformLabel || row.platform || "");
  if (key === "account") return boardAccountLabel(row);
  return String(row.name || "");
}

function boardSortCompare(a, b) {
  const va = boardSortValue(a, boardSortState.key);
  const vb = boardSortValue(b, boardSortState.key);
  let cmp;
  if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb), "zh-Hans-CN");
  return cmp * boardSortState.dir;
}

function boardSortBy(key) {
  if (!BOARD_SORT_LABEL[key]) return;
  if (boardSortState.key === key) boardSortState.dir = -boardSortState.dir;
  else boardSortState = { key: key, dir: 1 };
  renderBoardTable();
  renderBoardSortMarks();
  showToast("已按「" + BOARD_SORT_LABEL[key] + "」" + (boardSortState.dir === 1 ? "升序" : "降序") + "排列", "info");
}

function renderBoardSortMarks() {
  const row = document.getElementById("board-thead-row");
  if (!row) return;
  Array.prototype.forEach.call(row.children, (th) => {
    const key = th.getAttribute && th.getAttribute("data-sort");
    if (!key) return;
    const base = th.textContent.replace(/\s*[▲▼]$/, "");
    th.textContent = base + (boardSortState.key === key ? (boardSortState.dir === 1 ? " ▲" : " ▼") : "");
    th.setAttribute("aria-sort", boardSortState.key === key ? (boardSortState.dir === 1 ? "ascending" : "descending") : "none");
  });
}

function boardGroupIsPhone(group) {
  if (group.source === "cmcc") return true;
  return group.rows.some((row) => row && row.type === "phone");
}

/* 分组头的账号级保活状态：优先会话内写操作结果，否则由该账号下各实例状态归纳 */
function boardGroupKeepAliveOn(group) {
  const override = boardKeepAliveOverride.get(group.accountId);
  if (typeof override === "boolean") return override;
  const rows = group.rows;
  if (!rows.length) return false;
  // 账号级开关的真值在 account.enabled。行上的 keepalive.enabled 已经叠加了单机开关，
  // 用它归纳会把"账号开着、某台单机关了"误报成账号关闭（两套算法互斥的根源）。
  const account = group.account || {};
  if (typeof account.enabled === "boolean") return account.enabled;
  return rows.every((row) => !!(row.keepalive && row.keepalive.enabled));
}

function boardGroupInterval(group) {
  for (let i = 0; i < group.rows.length; i++) {
    const keepalive = group.rows[i].keepalive || {};
    const sec = parseInt(keepalive.intervalSec, 10);
    if (sec > 0) return sec;
  }
  return 0;
}

/* ---------------------------------------------------------------- 首屏列表 */
async function refreshBoard(manual) {
  if (boardLoading) return;
  boardLoading = true;
  const btn = document.getElementById("board-refresh-btn");
  const ovBtn = document.getElementById("ov-refresh-btn");
  // 刷新时按钮只是变灰、文案不变，看起来像没反应；改成明确的进行中文案
  if (btn) {
    btn.disabled = true;
    btn.dataset.idleText = btn.textContent;
    btn.textContent = "刷新中…";
  }
  if (ovBtn) ovBtn.disabled = true;
  try {
    // 手动刷新要绕过 BFF 的 5s 缓存，否则刚写完的开关/周期会读回旧值（看起来像没生效）
    const url = location.origin + "/api/resources?pageSize=200" + (manual ? "&refresh=1" : "");
    // 请求悬挂（半开连接）时全局 boardLoading 会永久为真：按钮永久灰、轮询静默失效、连横幅都不出来
    const ctrl = new AbortController();
    const killTimer = setTimeout(() => ctrl.abort(), 12000);
    let res, data;
    try {
      res = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" }, signal: ctrl.signal });
      data = await res.json().catch(() => null);
    } finally {
      clearTimeout(killTimer);
    }
    if (!res.ok || !data || data.ok === false) {
      boardDataErrorAt = Date.now();
      renderBoardMeta();
      renderBoardBanners();
      renderBoardTable();
      // 总览的 ov-meta 只在这里以外的地方被写：失败时不重绘，总览会永久停在「正在加载…」
      renderOverview();
      showToast("实例列表加载失败: " + (data && (data.error || data.message) ? (data.error || data.message) : ("HTTP " + res.status)), "error");
      return;
    }
    boardRows = Array.isArray(data.items) ? data.items : [];
    boardMeta = data;
    boardDataErrorAt = 0;
    boardLastOkAt = Date.now();
    renderBoard();
    if (manual) showToast("实例列表已刷新", "success");
  } catch (e) {
    boardDataErrorAt = Date.now();
    renderBoardMeta();
    renderBoardBanners();
    renderBoardTable();
    renderOverview();
    // AbortError 的原文是 "The user aborted a request."，对用户没有意义
    const msg = netErrText(e);
    showToast("实例列表请求异常: " + msg, "error");
  } finally {
    boardLoading = false;
    if (btn && btn.isConnected) {
      btn.disabled = false;
      if (btn.dataset.idleText) btn.textContent = btn.dataset.idleText;
    }
    if (ovBtn && ovBtn.isConnected) ovBtn.disabled = false;
  }
}

function renderBoard() {
  renderBoardMeta();
  renderBoardBanners();
  // 资源表只在「资源」页可见：其它视图里整表 innerHTML 重建纯属白烧（200 行时明显卡顿）
  const rowsFocus = document.activeElement && document.activeElement.closest &&
    document.activeElement.closest("#board-tbody .board-row");
  if (boardActiveView === "board" && !rowsFocus) renderBoardTable();
  renderBoardSortMarks();
  renderOverview();
  if (boardSelectedRowId) {
    const overlay = document.getElementById("instance-drawer-overlay");
    // 抽屉整段 innerHTML 重写会丢焦点、丢展开态、丢掉还没提交的选择：
    // 15 秒轮询正好在你改下拉时发生，键盘焦点会掉到 body（审计 §P1 实测）。
    // 焦点在抽屉里就跳过这次重绘，等你松开手再更新。
    const active = document.activeElement;
    const focusInside = !!(overlay && active && active !== document.body && overlay.contains(active));
    if (overlay && !overlay.classList.contains("hidden") && !focusInside) drawInstanceDrawer(boardSelectedRowId, true);
  }
}

function renderBoardMeta() {
  const meta = boardMeta || {};
  const metaEl = document.getElementById("board-meta");
  if (metaEl) {
    const parts = [];
    parts.push(meta.lastRefreshText ? ("数据刷新于 " + meta.lastRefreshText) : "尚未获得刷新时间");
    if (meta.generatedAt) parts.push("生成 " + boardTimeText(meta.generatedAt));
    if (typeof meta.buildMs === "number") parts.push("耗时 " + meta.buildMs + " ms");
    if (meta.cache && typeof meta.cache.hit === "boolean") parts.push(meta.cache.hit ? "命中缓存" : "实时拉取");
    metaEl.textContent = parts.join(" · ");
  }
  const countsEl = document.getElementById("board-counts");
  if (countsEl) {
    const counts = meta.counts || {};
    const total = counts.total !== undefined ? counts.total : boardRows.length;
    countsEl.innerHTML = "共 <b>" + boardText(total, "0") + "</b> 台 · 云电脑 <b>" + boardText(counts.pc, "0") +
      "</b> · 云手机 <b>" + boardText(counts.phone, "0") + "</b> · 状态滞后 <b>" + boardText(counts.stale, "0") + "</b>";
  }
}

function renderBoardBanners() {
  const meta = boardMeta || {};
  const partialEl = document.getElementById("board-partial-banner");
  if (partialEl) {
    if (meta.partial) {
      const reasons = Array.isArray(meta.partialReasons) ? meta.partialReasons.filter(Boolean) : [];
      // 单侧失败时只缺一类数据：把技术原因折成一句人话放在前面，原始原因降级为可展开明细
      const labels = [];
      reasons.forEach((r) => {
        const text = String(r);
        if (/云手机/.test(text)) labels.push("云手机数据暂不可用");
        else if (/云电脑/.test(text)) labels.push("云电脑数据暂不可用");
        else labels.push(text);
      });
      const detail = reasons.map((r) => escapeHtml(String(r))).join("；");
      partialEl.innerHTML = '<b>⚠️ ' + escapeHtml(labels.join("；") || "部分数据源拉取失败") + '</b>' +
        '<button class="board-mini-btn" style="margin-left:8px" onclick="refreshBoard(true)">重试</button>' +
        '<div class="board-banner-detail" title="' + detail + '">' + detail + '</div>';
      partialEl.classList.remove("hidden");
    } else {
      partialEl.classList.add("hidden");
      partialEl.innerHTML = "";
    }
  }
  const staleDataEl = document.getElementById("board-data-error-banner");
  if (staleDataEl) {
    if (boardDataErrorAt) {
      // 从没成功过的时候说「上次成功拉取的快照」是假的：明确说还没拉到过
      const when = boardLastOkAt ? boardTimeText(boardLastOkAt) : "";
      const snapshotText = boardLastOkAt
        ? ('当前展示的是上次成功拉取的快照（最后成功 ' + escapeHtml(when) + '）。')
        : '还没有成功获取过数据（首次请求失败或超时）。';
      staleDataEl.innerHTML = '<b>⚠️ 数据连接中断</b>' + snapshotText +
        '<button class="board-mini-btn" style="margin-left:8px" onclick="refreshBoard(true)">重试</button>';
      staleDataEl.classList.remove("hidden");
    } else {
      staleDataEl.classList.add("hidden");
      staleDataEl.innerHTML = "";
    }
  }
  const truncatedEl = document.getElementById("board-truncated-banner");
  if (truncatedEl) {
    if (meta.truncated) {
      const shown = Array.isArray(meta.items) ? meta.items.length : boardRows.length;
      truncatedEl.innerHTML = "⚠️ 结果已截断：当前仅显示前 " + shown + " 台，服务端共 " +
        boardText(meta.total, "?") + " 台。";
      truncatedEl.classList.remove("hidden");
    } else {
      truncatedEl.classList.add("hidden");
      truncatedEl.innerHTML = "";
    }
  }
}

function toggleBoardGroupCollapse(groupKey) {
  const key = String(groupKey || "");
  if (!key) return;
  if (boardCollapsedGroups.has(key)) boardCollapsedGroups.delete(key);
  else boardCollapsedGroups.add(key);
  renderBoardTable();
}

// 窄屏必须横向滚动，但多数环境不显示滚动条：只在真溢出且没滚到最右时给一行提示
function updateOneScrollHint(wrapSelector, hintId) {
  const wrap = document.querySelector(wrapSelector);
  const hint = document.getElementById(hintId);
  if (!wrap || !hint) return;
  const overflow = wrap.scrollWidth - wrap.clientWidth > 4;
  const atEnd = wrap.scrollLeft >= wrap.scrollWidth - wrap.clientWidth - 8;
  hint.classList.toggle("hidden", !overflow || atEnd);
}

function updateBoardScrollHint() {
  updateOneScrollHint("#instance-board .board-table-wrap", "board-scroll-hint");
  updateOneScrollHint("#tariff-panel .board-table-wrap", "tariff-scroll-hint");
  updateOneScrollHint("#tariff-card-panel .board-table-wrap", "tariff-card-scroll-hint");
}

function renderBoardTable() {
  const tbody = document.getElementById("board-tbody");
  if (!tbody) return;
  if (!boardRows.length) {
    const partial = !!(boardMeta || {}).partial;
    // 首屏还没拿到数据时给骨架行：只写「暂无实例数据」会和正在加载互相矛盾
    if (boardLoading && !partial) {
      const cells = '<td><span class="board-skeleton w60"></span></td>' +
        '<td><span class="board-skeleton w90"></span></td>' +
        '<td><span class="board-skeleton w70"></span></td>' +
        '<td><span class="board-skeleton w80"></span></td>' +
        '<td><span class="board-skeleton w70"></span></td>' +
        '<td><span class="board-skeleton w70"></span></td>' +
        '<td><span class="board-skeleton w60"></span></td>' +
        '<td><span class="board-skeleton w50"></span></td>';
      const rows = [];
      for (let i = 0; i < BOARD_SKELETON_ROWS; i++) {
        rows.push('<tr class="board-skeleton-row" aria-hidden="true">' + cells + '</tr>');
      }
      tbody.innerHTML = rows.join("");
      updateBoardScrollHint();
      return;
    }
    tbody.innerHTML = partial
      ? '<tr><td colspan="8" class="board-empty">数据源暂时不可用，没有可显示的实例 · <a href="javascript:refreshBoard(true)">重试</a></td></tr>'
      : '<tr><td colspan="8" class="board-empty">暂无实例数据</td></tr>';
    updateBoardScrollHint();
    return;
  }
  const html = [];
  boardGroups().forEach((group) => {
    html.push(boardGroupRowHtml(group));
    if (boardCollapsedGroups.has(String(group.key))) return;
    group.rows.forEach((row) => html.push(boardRowHtml(row)));
  });
  tbody.innerHTML = html.join("");
  updateBoardScrollHint();
}

function boardGroupRowHtml(group) {
  const total = group.rows.length;
  const isPhone = boardGroupIsPhone(group);
  const first = group.rows[0] || {};
  const platform = boardText(first.platform, "");
  const platformLabel = boardText(first.platformLabel, platform || BOARD_DASH);
  const accountName = boardText((group.account && (group.account.name || group.account.label)), group.accountId || BOARD_DASH);
  const keepAliveOn = boardGroupKeepAliveOn(group);
  const interval = boardGroupInterval(group);

  const isReadOnlyGroup = !!first.readOnly;
  const optionList = BOARD_INTERVAL_OPTIONS.slice();
  if (interval > 0 && optionList.indexOf(interval) < 0) optionList.push(interval);
  optionList.sort((a, b) => a - b);
  const intervalOptions = optionList.map((sec) => {
    const selected = sec === interval ? ' selected' : '';
    return '<option value="' + sec + '"' + selected + '>' + boardIntervalText(sec) + '</option>';
  }).join("");
  const intervalSelect = isReadOnlyGroup
    ? '<span class="board-group-static" title="该分组只读：周期由 jiatingyun-pc 的 automation 脚本固定（部分实例 20 分钟、部分 60 秒），面板写入只会与容器双写">' +
      '容器侧固定</span>'
    : '<select class="board-group-select" title="' + (isPhone
        ? '写入该账号下每台云手机的 waitMinutes（分钟）'
        : '写入账号级 keepaliveInterval（秒）') + '" data-prev="' + interval + '" onchange="changeGroupInterval(\'' + escapeHtml(group.accountId) + '\', this.value, this)">' + intervalOptions + '</select>';

  const switchInput = isReadOnlyGroup
    ? '<span class="board-badge board-badge-muted" title="只读行：保活由外部托管，面板不写入">只读</span>'
    : '<input type="checkbox" ' + (keepAliveOn ? 'checked ' : '') +
      'onchange="toggleGroupKeepAlive(\'' + escapeHtml(group.key) + '\', this.checked, this)">';

  const collapsed = boardCollapsedGroups.has(String(group.key));
  const controls = '<div class="board-group-controls">' +
    '<button class="board-mini-btn board-group-toggle" aria-expanded="' + (collapsed ? "false" : "true") +
      '" title="' + (collapsed ? "展开" : "收起") + '该账号下的实例行" onclick="toggleBoardGroupCollapse(\'' + escapeHtml(group.key) + '\')">' +
      (collapsed ? "▸" : "▾") + '</button>' +
    '<label>账号级保活 ' + switchInput + '</label>' +
    '<label>周期 ' + intervalSelect + '</label>' +
    '<button class="board-mini-btn" onclick="openGroupAccountPanel(\'' + escapeHtml(group.key) + '\')" title="账号级操作：编辑/删除/短信登录/同步/触发保活">⚙️ 账号</button>' +
    '<span class="board-group-scope">' + (isReadOnlyGroup
      ? escapeHtml(boardText(first.readOnlyNote, "只读")) + ' · ' + total + ' 台（面板不写开关）'
      : '作用于该账号 ' + total + ' 台') + '</span>' +
    '</div>';

  return '<tr class="board-group-row' + (collapsed ? " collapsed" : "") + '"><td colspan="8"><div class="board-group">' +
    '<span class="board-group-name">' + escapeHtml(accountName) + '</span>' +
    '<span class="board-badge board-badge-' + escapeHtml(platform || "muted") + '">' + escapeHtml(platformLabel) + '</span>' +
    '<span class="board-group-count">' + total + ' 台' + (collapsed ? " · 已收起" : "") + '</span>' +
    controls +
    '</div></td></tr>';
}

// 心跳精确到秒的完整值时列宽装不下（8 位日期+时间），列里给紧凑写法，完整值放 title
// 到期列宽有限，"2026/11/18 20:58:11" 会被裁成省略号：列里省掉秒，完整值放 title
function boardExpireShort(text) {
  return String(text == null ? "" : text).replace(/(\d{1,2}:\d{2}):\d{2}$/, "$1");
}

function boardHeartbeatShort(text) {
  const raw = String(text || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw);
  return m ? (m[2] + "-" + m[3] + " " + m[4]) : raw;
}

function boardRowHtml(row) {
  const id = escapeHtml(String(row.id || ""));
  const isPhone = row.type === "phone";
  const typeClass = isPhone ? "board-type-phone" : "board-type-pc";
  const typeIcon = isPhone ? "📱" : "💻";
  const keepalive = row.keepalive || {};
  const statusKey = String(keepalive.status || "idle");
  const statusLabel = boardText(keepalive.label, BOARD_DASH);
  const expireText = boardText(row.expire && row.expire.text, BOARD_DASH);
  const expireCellText = boardExpireShort(expireText);
  const heartbeatText = boardText(row.heartbeat && row.heartbeat.text, BOARD_DASH);
  const readOnly = !!row.readOnly;
  // 暂停原因要落在行上：只显示「已暂停」用户看不出为什么（短信账号无密码 / 连续失败）
  const pausedNote = keepalive.paused && keepalive.pausedReason ? String(keepalive.pausedReason) : "";
  const needSmsLogin = pausedNote === "sms_login_required" && !!row.accountId;
  const pausedBadge = pausedNote
    ? (needSmsLogin
        ? '<span class="board-pause-badge board-pause-action" title="点此用短信验证码重新登录" onclick="event.stopPropagation(); openYdpcRelogin(\'' + escapeHtml(row.accountId) + '\')">📩 需短信登录</span>'
        : '<span class="board-pause-badge" title="' + escapeHtml(pausedNote) + '">已暂停</span>')
    : "";
  const staleClass = (row.stale ? " stale" : "") + (readOnly ? " readonly" : "");
  const staleBadge = row.stale
    ? '<span class="board-stale-badge" title="' + escapeHtml(row.staleReason || "数据滞后") + '">滞后</span>'
    : '';
  // 保活开着但自动开机未开：机器一关就掉线，必须在行上提醒（只在抽屉里放开关没人会点开）
  const reminderBadge = row.reminder && row.reminder.text
    ? '<span class="board-remind-badge" title="' + escapeHtml(row.reminder.text) + '">🛡️ 自动开机未开</span>'
    : '';
  const readOnlyBadge = readOnly
    ? '<span class="board-ro-badge" title="该行只读：由外部托管，面板不会写入">' + escapeHtml(row.readOnlyNote || "只读") + '</span>'
    : '';
  const nameTitle = row.stale && row.staleReason ? (row.name + "（" + row.staleReason + "）") : boardText(row.name, BOARD_DASH);
  const accountLabel = boardAccountLabel(row);
  // 只读行也要能看详情：抽屉是唯一的只读说明入口（为什么不给开关、谁在保活）
  // 「打开画面」只给真有直通能力的行：云手机走 control.html；云电脑只有 ctyun 平台有
  // web-launch 实现（ecloud/ydpc 的 web-launch 会 500 client.login is not a function）
  const canScreen = isPhone || String(row.platform || "") === "ctyun";
  // 卡片视图的右上角快捷开关：不开抽屉也能开/关保活与自动开机（表格视图下隐藏，DOM 与表格共用）
  const kaOn = !!(row.keepalive && row.keepalive.enabled);
  const quickHtml = '<div class="v4-card-quick">' +
    v4QuickBtn(id, "keepalive", kaOn, true, readOnly, "⚡", "保活") +
    v4QuickBtn(id, "autoboot", row.autoBootEnabled === true, row.type === "pc", readOnly, "🛡️", "自动开机") +
    '</div>';
  const bandColor = boardStatusColor(statusKey);
  const actionsHtml = (canScreen
      ? '<button class="board-mini-btn primary" data-act="screen" data-row-id="' + id + '">打开画面</button>'
      : '') +
    '<button class="board-mini-btn" data-act="drawer" data-row-id="' + id + '">详情</button>';

  return '<tr class="board-row' + staleClass + '" data-row-id="' + id + '" tabindex="0" style="--v4-band:' + bandColor + '">' +
    '<td class="cell-type"><span class="board-type ' + typeClass + '">' + typeIcon + ' ' + escapeHtml(boardText(row.typeLabel, BOARD_DASH)) + '</span></td>' +
    '<td class="cell-name" title="' + escapeHtml(nameTitle) + '">' + escapeHtml(boardText(row.name, BOARD_DASH)) +
      (row.shortId ? '<span class="board-short-id" title="实例尾号：同名机器靠它区分">#' + escapeHtml(String(row.shortId)) + '</span>' : '') +
      staleBadge + readOnlyBadge + reminderBadge + quickHtml + '</td>' +
    '<td class="cell-platform">' + escapeHtml(boardText(row.platformLabel, BOARD_DASH)) + '</td>' +
    '<td class="cell-account">' + escapeHtml(accountLabel) + '</td>' +
    '<td class="cell-keepalive" title="' + escapeHtml(pausedNote) + '"><span class="board-status board-status-' + escapeHtml(statusKey) + '"><span class="board-status-dot"></span>' + escapeHtml(statusLabel) + '</span>' + pausedBadge + '</td>' +
    '<td class="cell-expire' + (row.keepalive && row.keepalive.expired ? ' cell-expired' : '') + '" title="' + escapeHtml(expireText + (row.keepalive && row.keepalive.expired ? "（服务已到期）" : "")) + '">' + escapeHtml(expireCellText) + (row.keepalive && row.keepalive.expired ? '<span class="expired-tag">已过期</span>' : '') + '</td>' +
    '<td class="cell-heartbeat" title="' + escapeHtml(heartbeatText) + '">' + escapeHtml(boardHeartbeatShort(heartbeatText)) + '</td>' +
    '<td class="cell-actions"><div class="board-row-actions">' + actionsHtml + '</div></td></tr>';
}

function boardStatusColor(statusKey) {
  switch (String(statusKey || "")) {
    case "keeping":
    case "keeping_long": return "#22c55e";
    case "managed": return "#6366f1";
    case "managed_stalled": return "#f59e0b";
    case "error": return "#ef4444";
    case "paused": return "#f59e0b";
    default: return "#cbd5e1";
  }
}
function v4QuickBtn(rowId, kind, on, supported, readOnly, icon, label) {
  if (!supported) return "";
  const state = on ? "已开启" : "已关闭";
  const nextWord = on ? "关闭" : "开启";
  return '<button class="v4-quick-btn' + (on ? " on" : "") + '" type="button"' +
    ' data-quick="' + kind + '" data-row-id="' + rowId + '"' +
    ' aria-pressed="' + (on ? "true" : "false") + '"' +
    ' aria-label="' + label + "：" + state + "（点击" + nextWord + '）"' +
    ' title="' + label + "：" + state + "（点击" + nextWord + '）"' +
    (readOnly ? " disabled" : "") + '>' + icon + '</button>';
}
function paintQuickBtn(btn, kind, on) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const label = kind === "autoboot" ? "自动开机" : "保活";
  btn.setAttribute("aria-label", label + "：" + (on ? "已开启" : "已关闭") + "（点击" + (on ? "关闭" : "开启") + "）");
}

async function onBoardTbodyClick(event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const quickBtn = target.closest("button[data-quick]");
  if (quickBtn) {
    event.stopPropagation();
    event.preventDefault();
    const rowId = quickBtn.getAttribute("data-row-id");
    const row = boardRowFind(rowId);
    if (!row || quickBtn.disabled) return;
    const kind = quickBtn.getAttribute("data-quick");
    if (kind === "keepalive") {
      const next = !(row.keepalive && row.keepalive.enabled);
      await toggleInstanceKeepAlive(rowId, next, null);
    } else if (kind === "autoboot") {
      const next = row.autoBootEnabled !== true;
      await toggleInstanceAutoBoot(rowId, next, null);
      paintQuickBtn(quickBtn, "autoboot", next);
    }
    return;
  }
  const actionBtn = target.closest("button[data-act]");
  const rowEl = target.closest("tr.board-row");
  if (!rowEl) return;
  const rowId = (actionBtn && actionBtn.getAttribute("data-row-id")) || rowEl.getAttribute("data-row-id");
  if (!rowId) return;
  if (actionBtn && actionBtn.getAttribute("data-act") === "screen") {
    event.stopPropagation();
    openInstanceScreen(rowId);
    return;
  }
  openInstanceDrawer(rowId);
}

/* ---------------------------------------------------------------- 右侧抽屉 */
function drawInstanceDrawer(rowId, keepScroll) {
  const row = boardRowFind(rowId);
  const overlay = document.getElementById("instance-drawer-overlay");
  const body = document.getElementById("drawer-body");
  if (!row || !overlay || !body) return;
  const title = document.getElementById("drawer-title");
  const subtitle = document.getElementById("drawer-subtitle");
  if (title) title.textContent = boardText(row.name, "实例详情");
  if (subtitle) {
    subtitle.textContent = [boardText(row.typeLabel, ""), boardText(row.platformLabel, ""), boardAccountLabel(row)]
      .filter(Boolean).join(" · ");
  }
  const scrollTop = keepScroll ? body.scrollTop : 0;
  body.innerHTML = boardDrawerHtml(row);
  body.scrollTop = scrollTop;
  overlay.classList.remove("hidden");
}

function openInstanceDrawer(rowId) {
  const overlay = document.getElementById("instance-drawer-overlay");
  if (overlay && overlay.classList.contains("hidden")) drawerReturnFocus = document.activeElement;
  boardSelectedRowId = String(rowId || "");
  drawInstanceDrawer(boardSelectedRowId, false);
  // role=dialog 的抽屉必须自己接管焦点，否则键盘用户还停在背后的表格里
  const closeBtn = overlay && overlay.querySelector(".drawer-close");
  if (closeBtn && closeBtn.focus) closeBtn.focus();
}

// 分组头「⚙️ 账号」：账号级操作住在行抽屉的⑥段，所以直接打开该账号第一台的抽屉
function openGroupAccountPanel(groupKey) {
  const groups = boardGroups();
  const group = groups.find((g) => String(g.key) === String(groupKey));
  const first = group && group.rows && group.rows[0];
  if (!first) { showToast("该分组暂无可操作实例", "info"); return; }
  openInstanceDrawer(first.id);
}

function closeInstanceDrawer() {
  const overlay = document.getElementById("instance-drawer-overlay");
  if (overlay) overlay.classList.add("hidden");
  boardSelectedRowId = "";
  if (drawerReturnFocus && document.contains(drawerReturnFocus) && drawerReturnFocus.focus) {
    try { drawerReturnFocus.focus(); } catch (err) { /* 元素已不可聚焦时放弃 */ }
  }
  drawerReturnFocus = null;
}

function onDrawerOverlayClick(event) {
  if (event.target && event.target.id === "instance-drawer-overlay") closeInstanceDrawer();
}

function boardDrawerLogLines(row) {
  const list = Array.isArray(allReceivedLogs) ? allReceivedLogs : [];
  const keys = [row.name, row.instanceId, row.account && row.account.label, row.account && row.account.name]
    .filter(Boolean).map((v) => String(v).trim()).filter((v) => v.length >= 2);
  if (!keys.length) return [];
  const hits = [];
  for (let i = list.length - 1; i >= 0 && hits.length < 30; i--) {
    const item = list[i];
    const message = String((item && item.message) || "");
    if (keys.some((key) => message.indexOf(key) >= 0)) hits.push(item);
  }
  return hits.reverse();
}

function boardDrawerHtml(row) {
  const keepalive = row.keepalive || {};
  const expire = row.expire || {};
  const heartbeat = row.heartbeat || {};
  const isPhone = row.type === "phone";
  const readOnly = !!row.readOnly;
  const kv = (label, value) => '<dt>' + label + '</dt><dd>' + escapeHtml(boardText(value, BOARD_DASH)) + '</dd>';

  const basic = '<div class="drawer-section"><h4>① 基础</h4><dl class="drawer-kv">' +
    kv("类型", boardText(row.typeLabel, BOARD_DASH)) +
    kv("实例名称", boardText(row.name, BOARD_DASH)) +
    kv("平台", boardText(row.platformLabel, BOARD_DASH)) +
    kv("账号归属", boardAccountLabel(row)) +
    kv("电源状态", boardText(row.powerState, BOARD_DASH)) +
    kv("数据状态", row.stale ? ("滞后" + (row.staleReason ? "（" + row.staleReason + "）" : "")) : "正常") +
    '</dl></div>';

  const keepaliveSection = '<div class="drawer-section"><h4>② 保活</h4><dl class="drawer-kv">' +
    kv("保活状态", boardText(keepalive.label, BOARD_DASH)) +
    kv("保活归属", row.owner && row.owner.label ? row.owner.label : (readOnly ? boardText(row.readOnlyNote, "外部托管（面板不写开关）") : "面板")) +
    kv("账号级开关", (row.account && typeof row.account.enabled === "boolean") ? (row.account.enabled ? "已开启" : "已关闭") : "—") +
    kv("保活周期", boardIntervalText(keepalive.intervalSec)) +
    kv("是否暂停", keepalive.paused ? ("已暂停" + (keepalive.pausedReason ? "（" + boardPausedReasonText(keepalive.pausedReason) + "）" : "")) : "未暂停") +
    kv("连续失败", typeof keepalive.failCount === "number" ? (keepalive.failCount + " 次") : BOARD_DASH) +
    kv("最近错误", boardText(keepalive.lastError, BOARD_DASH)) +
    '</dl></div>';

  const instanceSection = '<div class="drawer-section"><h4>③ 实例</h4><dl class="drawer-kv">' +
    kv("实例 ID", boardText(row.instanceId || row.id, BOARD_DASH)) +
    kv("行 ID", boardText(row.id, BOARD_DASH)) +
    kv("账号 ID", boardText(row.accountId, BOARD_DASH)) +
    kv("数据来源", row.source === "cmcc" ? "云手机子应用" : ("云电脑子应用")) +
    (function () {
      const t = boardTariffInfo(row);
      return kv("资费参考", t.detail ? (t.text + "（" + t.detail + "）") : t.text);
    })() +
    (function () {
      const r = row.remain || null;
      if (!r || (!r.text && !r.hours)) return "";
      const zero = r.hours === 0 && !/永久|♾/.test(r.text || "");
      return kv("剩余时长", boardText(r.text, BOARD_DASH) + (zero ? "（本月额度已用尽，次月 1 日重置；未到重置前开机也连不上）" : ""));
    })() +
    kv("到期时间", boardText(expire.text, BOARD_DASH)) +
    kv("最近心跳", boardText(heartbeat.text, BOARD_DASH)) +
    '</dl></div>';

  const logs = boardDrawerLogLines(row);
  const logBody = logs.length
    ? logs.map((item) => '<div>[' + escapeHtml(String(item.timestamp || "")) + '] [' + escapeHtml(String(item.source || "")) + '] ' + escapeHtml(String(item.message || "")) + '</div>').join("")
    : '<div style="color: #94a3b8;">暂无与该实例相关的日志</div>';
  const logSection = '<div class="drawer-section"><h4>④ 日志</h4><div class="drawer-log">' + logBody + '</div>' +
    '<div class="drawer-hint">取自当前控制台实时日志流（最近 30 条匹配记录）</div></div>';

  const screenLabel = isPhone ? "📱 打开画面（云手机控制台）" : "🖥️ 打开画面（云电脑）";
  const toggleControl = readOnly
    ? ''
    : '<label class="board-mini-btn" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">单机保活 <input type="checkbox" ' +
      (keepalive.enabled ? 'checked ' : '') + 'data-drawer-act="keepalive"></label>';
  const ownInterval = Number(keepalive.intervalSec || 0);
  const intervalOpts = BOARD_INTERVAL_OPTIONS.slice();
  if (ownInterval > 0 && intervalOpts.indexOf(ownInterval) < 0) intervalOpts.push(ownInterval);
  intervalOpts.sort((a, b) => a - b);
  // 云手机 continuous 模式是长连接心跳，没有"周期"这个概念，置灰避免误导
  const intervalLocked = isPhone && String(keepalive.mode || "") === "continuous";
  const ownIntervalControl = readOnly ? '' :
    '<label class="drawer-inline' + (intervalLocked ? ' locked' : '') + '"' + (intervalLocked ? ' title="该设备是连续保活（长连接心跳），周期由心跳频率决定"' : '') + '>单机周期 <select data-drawer-act="interval"' +
    (intervalLocked ? ' disabled' : '') + '>' +
    intervalOpts.map((sec) => '<option value="' + sec + '"' + (sec === ownInterval ? ' selected' : '') + '>' + boardIntervalText(sec) + '</option>').join('') +
    '</select>' + (intervalLocked ? '<span class="drawer-fixed">连续保活 · 固定</span>' : '') + '</label>';
  const taskControl = (readOnly || isPhone || row.taskEnabled === undefined || row.taskEnabled === null) ? '' :
    '<label class="board-mini-btn" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;" title="打卡 / AI 对话 / 1 小时挂机任务是否在这台机器上执行">🎯 单机任务 <input type="checkbox" ' +
    (row.taskEnabled ? 'checked ' : '') + 'data-drawer-act="task"></label>';
  // 单机「自动开机守护」：关着时这台机器即使⚡保活开着也不会被拉起（广州 2C4G 就是这样一直关机）
  const autoBootControl = (readOnly || isPhone || row.autoBootEnabled === undefined || row.autoBootEnabled === null) ? '' :
    '<label class="board-mini-btn" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer;" title="这台云电脑关机后是否自动拉起（需账号级自动开机守护也开启；同机 10 分钟冷却）">🛡️ 自动开机 <input type="checkbox" ' +
    (row.autoBootEnabled ? 'checked ' : '') + 'data-drawer-act="autoboot"></label>';
  const actions = '<div class="drawer-section"><h4>⑤ 操作</h4><div class="drawer-actions">' +
    '<button class="board-mini-btn primary" data-drawer-act="screen">' + screenLabel + '</button>' +
    '<button class="board-mini-btn" data-drawer-act="copy">复制实例 ID</button>' +
    toggleControl +
    taskControl +
    autoBootControl +
    ownIntervalControl +
    '</div><div class="drawer-hint">' +
    (readOnly
      ? "该行只读：保活由外部托管，面板不写入，避免双写。"
      : (isPhone
        ? "云手机的账号级周期在列表分组头调整（写入每台设备的 waitMinutes）；账号级开关也在分组头。"
        : "账号级开关与周期请使用列表分组头；此处的单机开关只影响这一台云电脑。")) +
    '</div></div>';

  const accId = String(row.accountId || "");
  const platform = String(row.platform || "");
  const accActions = [];
  if (platform === "ydpc") accActions.push('<button class="board-mini-btn" data-drawer-act="acc-relogin">📩 短信登录（补登录态）</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-edit">✏️ 编辑账号</button>');
  if (platform === "ecloud") accActions.push('<button class="board-mini-btn" data-drawer-act="acc-sync">🔄 同步桌面</button>');
  if (platform === "ecloud") accActions.push('<button class="board-mini-btn" data-drawer-act="acc-ping">💓 立即保活一次</button>');
  if (platform === "ydpc") accActions.push('<button class="board-mini-btn" data-drawer-act="acc-ping">💓 发送心跳</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-tasks">⚙️ 任务与签到设置</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-redeem">🎁 兑换</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-points">📊 积分明细</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-notify">🔔 通知设置</button>');
  // 容器托管的账号不给删除入口：删掉面板记录不会停掉容器，只会让这 5 台从看板上消失
  if (!readOnly) accActions.push('<button class="board-mini-btn" data-drawer-act="acc-delete" style="color:#b91c1c;">🗑 删除账号</button>');
  accActions.push('<button class="board-mini-btn" data-drawer-act="acc-add">➕ 添加账号</button>');
  const accountSection = '<div class="drawer-section"><h4>⑥ 账号</h4><div class="drawer-actions">' + accActions.join("") + '</div>' +
    '<div class="drawer-hint">账号级操作按账号生效（' + escapeHtml(accId || "-") + '）；删除账号会同时移除其名下实例与保活记录。</div></div>';

  return basic + keepaliveSection + instanceSection + logSection + actions + accountSection;
}

function boardGroupStateText(row) {
  const key = String(row.accountId || "");
  const actual = !!(row.keepalive || {}).enabled;
  const override = boardKeepAliveOverride.get(key);
  if (typeof override === "boolean") {
    // 快照已经追上写入结果就丢弃覆盖，否则会话里会一直显示"本次会话设置"（永久脏标记）
    if (override === actual) { boardKeepAliveOverride.delete(key); return actual ? "已开启" : "已关闭"; }
    return override ? "已开启（本次会话设置）" : "已关闭（本次会话设置）";
  }
  return actual ? "已开启" : "已关闭";
}

function onDrawerBodyChange(event) {
  const target = event.target;
  if (!target || !target.getAttribute) return;
  const act = target.getAttribute("data-drawer-act");
  if (!act) return;
  if (act === "keepalive") {
    toggleInstanceKeepAlive(boardSelectedRowId, !!target.checked, target);
    return;
  }
  if (act === "task") {
    toggleInstanceTask(boardSelectedRowId, !!target.checked, target);
    return;
  }
  if (act === "autoboot") {
    toggleInstanceAutoBoot(boardSelectedRowId, !!target.checked, target);
    return;
  }
  if (act === "interval") {
    boardSetInstanceInterval(boardSelectedRowId, Number(target.value) || 0, target);
  }
}

// 单机自动开机守护：关着时不拉起（即使⚡保活开着）——广州 2C4G 实测卡在这里
async function toggleInstanceAutoBoot(rowId, next, el) {
  const row = boardRowFind(rowId);
  if (!row || row.type !== "pc") return;
  const wantOn = !!next;
  if (el) el.disabled = true;
  try {
    await boardWrite("/api/accounts/" + encodeURIComponent(row.accountId) + "/vm-feature", "PUT",
      { vmId: row.instanceId || row.id, desktopId: row.instanceId || row.id, feature: "autoBootEnabled", value: wantOn });
    row.autoBootEnabled = wantOn;
    showToast(wantOn ? "已开启自动开机守护" : "已关闭自动开机守护", "success");
  } catch (err) {
    if (el) el.checked = !wantOn;
    showToast("自动开机守护保存失败: " + (err.message || err), "error");
  } finally {
    if (el) el.disabled = false;
  }
}

// 单机任务开关（打卡 / AI 对话 / 1 小时挂机）：与账号卡片里的 🎯任务 同一接口
async function toggleInstanceTask(rowId, next, el) {
  const row = boardRowFind(rowId);
  if (!row || row.type !== "pc") return;
  const wantOn = !!next;
  if (el) el.disabled = true;
  try {
    await boardWrite("/api/accounts/" + encodeURIComponent(row.accountId) + "/vm-feature", "PUT",
      { vmId: row.instanceId || row.id, desktopId: row.instanceId || row.id, feature: "taskEnabled", value: wantOn });
    showToast("已" + (wantOn ? "开启" : "关闭") + "该实例的任务（打卡/挂机）", "success");
    await refreshBoard(true);
  } catch (err) {
    showToast("单机任务保存失败: " + (err.message || err), "error");
    if (el && el.isConnected) { el.checked = !wantOn; el.disabled = false; }
  }
}

// 单机周期：云电脑写 vm-feature，云手机写设备 waitMinutes（与分组头同一套接口）
async function boardSetInstanceInterval(rowId, sec, el) {
  const row = boardRowFind(rowId);
  if (!row) return;
  const prevSec = Number((row.keepalive || {}).intervalSec || 0);
  if (el) el.disabled = true;
  try {
    if (row.type === "phone") {
      const minutes = Math.max(1, Math.round(sec / 60));
      await boardWrite("/cmcc/api/devices/" + encodeURIComponent(row.id) + "/settings", "PATCH", { waitMinutes: minutes });
      showToast("已把该设备周期改为 " + minutes + " 分钟", "success");
    } else {
      await boardWrite("/api/accounts/" + encodeURIComponent(row.accountId) + "/vm-feature", "PUT",
        { vmId: row.instanceId || row.id, desktopId: row.instanceId || row.id, feature: "keepaliveInterval", value: sec || null });
      showToast("已把该实例周期改为 " + boardIntervalText(sec), "success");
    }
    await refreshBoard(true);
  } catch (err) {
    showToast("周期写入失败: " + (err.message || err), "error");
    if (el && el.isConnected) {
      el.value = String(prevSec);
      el.disabled = false;
    }
    await refreshBoard(true);
  }
}

function onDrawerBodyClick(event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const btn = target.closest("[data-drawer-act]");
  if (!btn) return;
  if (btn.tagName === "INPUT") return;
  const act = btn.getAttribute("data-drawer-act");
  if (act === "screen") openInstanceScreen(boardSelectedRowId);
  else if (act === "copy") copyBoardInstanceId(boardSelectedRowId);
  else if (act.indexOf("acc-") === 0) {
    const row = boardRowFind(boardSelectedRowId);
    boardAccountAction(act.slice(4), row ? String(row.accountId || "") : "", row ? String(row.platform || "") : "");
  }
}

// 账号级操作：账号数据是懒加载的（账号页签已撤，只在需要时按需拉一次）
async function boardAccountAction(act, accountId, platform) {
  if (!accountId) { showToast("缺少账号标识", "error"); return; }
  if (act === "add") { openAddAccountModal(); return; }
  if (act === "relogin") { openYdpcRelogin(accountId); return; }
  if (!accountsLoaded()) {
    try { await loadAccounts(true); } catch (err) { showToast("账号数据加载失败: " + (err.message || err), "error"); return; }
  }
  if (act === "edit") { editAccount(accountId); return; }
  if (act === "delete") { deleteAccount(accountId); return; }
  if (act === "tasks") { openSettingsModal(); return; }
  if (act === "redeem") { if (typeof openRedeemModal === "function") openRedeemModal(accountId); return; }
  if (act === "points") {
    // 积分数据源是 /api/status，账号视图撤销后没人再调它，直接开弹窗只会永远显示 0 分
    openPointsDetailModal();
    loadStatus().then(() => { if (!document.getElementById("points-detail-modal").classList.contains("hidden")) openPointsDetailModal(); }).catch(() => {});
    return;
  }
  if (act === "notify") { openUserNotifyModal(); return; }
  if (act === "sync") {
    if (typeof syncEcloudDesktops === "function") syncEcloudDesktops(accountId);
    return;
  }
  if (act === "ping") {
    if (platform === "ecloud" && typeof triggerEcloudKeepalive === "function") triggerEcloudKeepalive(accountId);
    else if (platform === "ydpc" && typeof heartbeatYdpc === "function") heartbeatYdpc(accountId);
    else showToast("该平台没有手动触发入口", "info");
  }
}

function accountsLoaded() {
  return Array.isArray(accounts) && accounts.some((a) => a && a.id);
}

/* ---------------------------------------------------------------- 画面直通 */
function openInstanceScreen(rowId) {
  const row = boardRowFind(rowId);
  if (!row) {
    showToast("实例不存在或数据已刷新，请重试", "error");
    return;
  }
  if (row.type !== "phone" && String(row.platform || "") !== "ctyun") {
    showToast("该平台没有面板直通画面：云电脑画面请用官方客户端，面板只提供状态与保活", "info");
    return;
  }
  if (row.type === "phone") {
    // 直连控制页而不是 /cmcc/ 首页：设备页整页跳走会把看板会话也带走，且用户还得自己再点一次设备
    // control.html 认的是 cmcc 存储里的设备 UUID（row.id），不是云端 instanceId
    const deviceId = row.id || row.instanceId || "";
    const target = "/cmcc/control.html?device=" + encodeURIComponent(deviceId);
    showToast("正在打开云手机控制台…", "info");
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }
  launchDesktopSession(row.accountId, row.instanceId || "", row.name || "");
}

function copyBoardInstanceId(rowId) {
  const row = boardRowFind(rowId);
  const text = String((row && (row.instanceId || row.id)) || "");
  if (!text) return;
  const done = () => showToast("实例 ID 已复制", "success");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => showToast("复制失败，请手动选择文本", "error"));
    return;
  }
  showToast("当前浏览器不支持一键复制：" + text, "info");
}

/* ---------------------------------------------------------------- 写操作 */
async function boardWrite(url, method, body) {
  const res = await authFetch(url, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || (data && (data.success === false || data.ok === false))) {
    const message = (data && (data.error || data.message)) || ("HTTP " + res.status);
    throw new Error(message);
  }
  return data;
}

async function toggleGroupKeepAlive(groupKey, next, el) {
  const group = boardGroups().find((g) => g.key === String(groupKey));
  if (!group) return;
  if (group.rows.length && group.rows[0].readOnly) {
    showToast("该分组只读：保活由外部托管，面板不改写", "warning");
    if (el && el.isConnected) el.checked = !el.checked;
    return;
  }
  if (el) el.disabled = true;
  const wantOn = !!next;
  let doneCount = 0;
  try {
    if (boardGroupIsPhone(group)) {
      const errors = [];
      for (const row of group.rows) {
        try {
          await boardWrite("/cmcc/api/devices/" + encodeURIComponent(row.id) + "/settings", "PATCH", { keepaliveEnabled: wantOn });
          doneCount++;
        } catch (e) {
          errors.push(boardText(row.name, row.id) + "：" + e.message);
        }
      }
      if (errors.length) throw new Error(errors.slice(0, 3).join("；"));
      showToast("已" + (wantOn ? "开启" : "关闭") + "该账号 " + doneCount + " 台云手机的保活", "success");
    } else {
      await boardWrite("/api/accounts/" + encodeURIComponent(group.accountId), "PUT", { features: { keepAlive: wantOn } });
      showToast("已" + (wantOn ? "开启" : "关闭") + "该账号 " + group.rows.length + " 台云电脑的保活", "success");
    }
    boardKeepAliveOverride.set(String(group.accountId), wantOn);
    await refreshBoard(false);
  } catch (e) {
    showToast("保活开关保存失败: " + e.message, "error");
    // 失败必须回滚控件：否则界面显示"已关"，后端仍旧开启，用户以为生效了
    if (el && el.isConnected) {
      el.checked = !wantOn;
      el.disabled = false;
    }
    // 云手机是逐台写：报"失败"时可能已经有几台真改了，得按后端真实值重绘
    if (doneCount > 0) {
      showToast("其中 " + doneCount + " 台已改成功，其余失败；按后端真实值重绘", "warning");
      await refreshBoard(false).catch(() => {});
    }
  }
}

async function changeGroupInterval(accountId, value, el) {
  const sec = parseInt(value, 10);
  if (!sec) return;
  const group = boardGroups().find((g) => String(g.accountId) === String(accountId));
  if (!group) return;
  // 回滚要回到"写之前那个值"：intervalSec 为 0 时旧代码 prevInterval 为空串，
  // 回滚被跳过，下拉永久停在新值而后端没改。data-prev 是渲染时的真值。
  const prevInterval = String(
    (el && el.getAttribute && el.getAttribute("data-prev")) ||
    ((group.rows[0] || {}).keepalive || {}).intervalSec || ""
  );
  if (group.rows.length && group.rows[0].readOnly) {
    showToast("该分组只读：周期由外部托管，面板不会双写", "warning");
    if (el && el.isConnected) el.disabled = false;
    return;
  }
  if (el) el.disabled = true;
  try {
    if (boardGroupIsPhone(group)) {
      // 云手机没有账号级周期字段（实测 cmcc store 无 accounts[].keepaliveInterval），周期是每台设备的 waitMinutes，
      // 用既有的 PATCH /api/devices/:id/settings 逐台写，不新增接口。
      const minutes = Math.max(1, Math.round(sec / 60));
      let doneCount = 0;
      const errors = [];
      for (const row of group.rows) {
        if (row.readOnly) continue;
        try {
          await boardWrite("/cmcc/api/devices/" + encodeURIComponent(row.id) + "/settings", "PATCH", { waitMinutes: minutes });
          doneCount++;
        } catch (e) {
          errors.push(boardText(row.name, row.id) + "：" + e.message);
        }
      }
      if (errors.length) throw new Error(errors.slice(0, 3).join("；"));
      showToast("已把该账号 " + doneCount + " 台云手机的周期改为 " + boardIntervalText(minutes * 60), "success");
    } else {
      await boardWrite("/api/accounts/" + encodeURIComponent(accountId), "PUT", { keepaliveInterval: sec });
      showToast("保活周期已更新为 " + boardIntervalText(sec), "success");
    }
    if (el && el.setAttribute) el.setAttribute("data-prev", String(sec));
    await refreshBoard(false);
  } catch (e) {
    showToast("保活周期保存失败: " + e.message, "error");
    if (el && el.isConnected) {
      if (prevInterval) el.value = prevInterval;
      el.disabled = false;
    }
    // 云手机是逐台 PATCH：写了一半失败时前半部分真的改了，不能只说"失败"
    if (typeof doneCount === "number" && doneCount > 0) {
      showToast("已改 " + doneCount + " 台，其余失败；列表将按后端真实值重绘", "warning");
      await refreshBoard(false).catch(() => {});
    }
  }
}

async function toggleInstanceKeepAlive(rowId, next, el) {
  const row = boardRowFind(rowId);
  if (!row) return;
  if (el) el.disabled = true;
  const wantOn = !!next;
  try {
    if (row.type === "phone") {
      await boardWrite("/cmcc/api/devices/" + encodeURIComponent(row.id) + "/settings", "PATCH", { keepaliveEnabled: wantOn });
    } else {
      await boardWrite("/api/accounts/" + encodeURIComponent(row.accountId) + "/vm-feature", "PUT", {
        vmId: row.instanceId || row.id,
        feature: "keepaliveEnabled",
        value: wantOn
      });
    }
    showToast("已" + (wantOn ? "开启" : "关闭") + "该实例的保活", "success");
    await refreshBoard(false);
  } catch (e) {
    showToast("单机保活保存失败: " + e.message, "error");
    if (el && el.isConnected) { el.checked = !wantOn; el.disabled = false; }
  }
}

/* ---------------------------------------------------------------- 视图与定时 */
/* ---------------------------------------------------------------- 总览（阶段 8） */
// 总览不新增接口：KPI 与账号健康表都由 refreshBoard 已经拿到的 /api/resources 快照派生，
// 因此首屏请求仍然只有一条 /api/resources（硬闸门）。
let overviewEventsSig = "";

/* 资费参考：公示价（运营商官网），不是账单。ok 才有唯一月价，ambiguous 给候选，未收录也照实说 */
function boardMoney(v) {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return (Math.round(n * 10) / 10).toString();
}

function boardTariffInfo(row) {
  const t = (row && row.tariff) || {};
  if (t.status === "ok" && typeof t.monthly === "number") {
    const src = [t.planName, t.code, t.province].filter(Boolean).join(" · ");
    return { ok: true, text: "≈ " + boardMoney(t.monthly) + " 元/月", detail: src };
  }
  if (t.status === "ambiguous") {
    const prices = (t.candidates || []).map((c) => String(c.price || "")).filter(Boolean);
    return { ok: false, text: "多档", detail: "公示库里有多个价格：" + (prices.join(" / ") || "见资费站") + "，需按订购记录确认" };
  }
  return { ok: false, text: "未收录", detail: "公示资费库里没有这个规格（不代表不收费）" };
}

function renderOverview() {
  const meta = boardMeta || {};
  const rows = boardRows || [];

  const metaEl = document.getElementById("ov-meta");
  if (metaEl) {
    const parts = [];
    parts.push(meta.lastRefreshText ? ("数据刷新于 " + meta.lastRefreshText) : "尚未获得刷新时间");
    if (meta.partial) parts.push("部分数据源不可用");
    if (typeof meta.buildMs === "number") parts.push("耗时 " + meta.buildMs + " ms");
    metaEl.textContent = parts.join(" · ");
  }
  const countsEl = document.getElementById("ov-counts");
  if (countsEl) {
    const counts = meta.counts || {};
    countsEl.innerHTML = "共 <b>" + escapeHtml(String(counts.total !== undefined ? counts.total : rows.length)) +
      "</b> 台 · 云电脑 <b>" + escapeHtml(String(counts.pc || 0)) + "</b> · 云手机 <b>" +
      escapeHtml(String(counts.phone || 0)) + "</b>";
  }

  const partialEl = document.getElementById("ov-partial-banner");
  if (partialEl) {
    if (meta.partial) {
      const reasons = Array.isArray(meta.partialReasons) ? meta.partialReasons.filter(Boolean) : [];
      const labels = reasons.map((r) => {
        const text = String(r);
        if (/云手机/.test(text)) return "云手机数据暂不可用";
        if (/云电脑/.test(text)) return "云电脑数据暂不可用";
        return text;
      });
      partialEl.innerHTML = '<b>⚠️ ' + escapeHtml(labels.join("；") || "部分数据源拉取失败") + '</b>' +
        '<button class="board-mini-btn" style="margin-left:8px" onclick="refreshBoard(true)">重试</button>';
      partialEl.classList.remove("hidden");
    } else {
      partialEl.classList.add("hidden");
      partialEl.innerHTML = "";
    }
  }

  const statusOf = (r) => String((r.keepalive || {}).status);
  const keep = rows.filter((r) => ["keeping", "keeping_long"].includes(statusOf(r))).length;
  // 容器托管有三种真值：正常、循环停滞、已停保活 —— 都要算进"容器接管"，否则 KPI 会少算
  const managed = rows.filter((r) => ["managed", "managed_stalled", "managed_off"].includes(statusOf(r))).length;
  const idle = rows.filter((r) => ["idle", "stopped", "paused", "error"].includes(statusOf(r))).length;
  const stale = rows.filter((r) => !!r.stale).length;
  const sources = meta.sources || {};
  const srcKeys = Object.keys(sources);
  const srcOk = srcKeys.filter((k) => sources[k] && sources[k].ok !== false).length;
  const setKpi = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };
  setKpiAnimated("ov-kpi-total", rows.length);
  setKpiAnimated("ov-kpi-keeping", keep);
  setKpiAnimated("ov-kpi-managed", managed);
  setKpiAnimated("ov-kpi-idle", idle);
  setKpiAnimated("ov-kpi-stale", stale);
  renderStatusChart(keep, managed, idle, stale, rows.length);
  renderExpiryTimeline(rows);
  loadHeartbeatTimeline(false);
  // 月资费参考：只用后端算好的 counts（唯一月价才累加），多档/未收录单独标，不摊进合计
  const counts = meta.counts || {};
  const matched = Number(counts.costMatched || 0);
  const costEl = document.getElementById("ov-kpi-cost");
  if (costEl) {
    costEl.textContent = matched ? ("≈" + boardMoney(counts.costMonthly || 0)) : "—";
    const t = meta.tariff || {};
    costEl.title = (matched ? (matched + " 台有唯一公示月价") : "还没有可匹配的公示价") +
      (counts.costAmbiguous ? ("；" + counts.costAmbiguous + " 台多档") : "") +
      (counts.costUnknown ? ("；" + counts.costUnknown + " 台未收录") : "") +
      (t.updated ? ("\n资费快照：" + t.updated) : "\n资费快照未同步");
  }
  const tariffNote = document.getElementById("ops-tariff-note");
  if (tariffNote) {
    const t = meta.tariff || {};
    const ch = t.changes || null;
    const chText = !ch || ch.first
      ? ' · 首次快照，下次同步起开始比对变更'
      : (ch.counts && (ch.counts.added || ch.counts.removed || ch.counts.priceChanged)
        ? (' · 较上次：新增 ' + ch.counts.added + ' / 下架 ' + ch.counts.removed + ' / 调价 ' + ch.counts.priceChanged +
           (function () {
             const sample = [].concat(ch.priceChanged || [], ch.added || [], ch.removed || []).slice(0, 2)
               .map(function (p) { return escapeHtml(p.name || '') + (p.to !== undefined ? '（' + escapeHtml(String(p.from)) + ' → ' + escapeHtml(String(p.to)) + '）' : ''); });
             return sample.length ? '（' + sample.join('；') + '）' : '';
           })())
        : ' · 较上次无变更');
    tariffNote.innerHTML = t.updated
      ? ('资费快照：<b>' + escapeHtml(t.updated) + '</b> · ' + escapeHtml(String(t.plans || 0)) + ' 条云电脑/云手机公示价' + chText +
         '（来源 <code>rdtscx.github.io/tariff</code>，仅供参考，不是账单；每 ' + '12 小时自动同步，手动：<code>docker exec cloud-dashboard node /opt/tariff-sync.js</code>）')
      : '资费快照：尚未同步（<code>docker exec cloud-dashboard node /opt/tariff-sync.js</code>）。';
  }

  const costLabel = document.getElementById("ov-kpi-cost-label");
  if (costLabel) {
    costLabel.textContent = matched
      ? ("月资费参考 · " + matched + "/" + rows.length + " 台")
      : "月资费参考";
  }
  setKpi("ov-kpi-sources", srcKeys.length ? (srcOk + "/" + srcKeys.length) : "—");

  renderOverviewAccounts();
}

function renderOverviewAccounts() {
  const tbody = document.getElementById("ov-account-tbody");
  if (!tbody) return;
  const groups = boardGroups();
  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="board-empty">暂无账号数据</td></tr>';
    return;
  }
  const html = groups.map((group) => {
    const rows = group.rows;
    const first = rows[0] || {};
    const account = group.account || {};
    const readOnly = !!first.readOnly;
    const keepRows = rows.filter((r) => ["keeping", "keeping_long"].includes(String((r.keepalive || {}).status)));
    const staleRows = rows.filter((r) => !!r.stale);
    const errorRows = rows.filter((r) => String((r.keepalive || {}).status) === "error");
    const pausedRows = rows.filter((r) => !!(r.keepalive || {}).paused);
    const beat = rows.reduce((max, r) => {
      const t = (r.heartbeat || {}).at;
      return t && t > max ? t : max;
    }, 0);
    const interval = boardGroupInterval(group);
    // 只读账号不进「滞后/异常」判定：它们的心跳与状态不在面板这边，判了就是误报
    let health = "正常";
    let healthClass = "board-status-keeping";
    let keepLabel = keepRows.length + "/" + rows.length;
    if (readOnly) {
      // 三种只读要分开说：容器真在保活 / 容器循环停滞 / 根本没有会话（面板没登录态）
      const containerRows = rows.filter((r) => ((r.owner || {}).kind === "container"));
      const stalled = rows.filter((r) => String((r.keepalive || {}).status) === "managed_stalled").length;
      const off = rows.filter((r) => String((r.keepalive || {}).status) === "managed_off").length;
      healthClass = "board-status-managed";
      if (!containerRows.length) {
        health = "面板无会话（只读）";
        healthClass = "board-status-managed_off";
      } else {
        keepLabel = "容器侧";
        const on = containerRows.length - off;
        if (stalled) { health = stalled + " 台容器停滞"; healthClass = "board-status-error"; }
        else if (off) { health = off + " 台已停保活 · " + on + " 台在保"; healthClass = "board-status-managed_off"; }
        else health = "容器接管 · " + on + " 台全在保";
      }
    } else {
      if (staleRows.length) { health = staleRows.length + " 台滞后"; healthClass = "board-status-paused"; }
      if (errorRows.length) { health = errorRows.length + " 台异常"; healthClass = "board-status-error"; }
      if (pausedRows.length) { health = pausedRows.length + " 台暂停"; healthClass = "board-status-paused"; }
    }
    const roBadge = readOnly
      ? '<span class="board-ro-badge" title="该账号由 jiatingyun-pc 容器接管，面板只读不写开关">只读</span>'
      : "";
    return '<tr class="board-row' + (readOnly ? " readonly" : "") + '">' +
      '<td class="cell-account">' + escapeHtml(boardText(account.label || account.name, group.accountId || BOARD_DASH)) + roBadge + '</td>' +
      '<td class="cell-platform">' + escapeHtml(boardText(first.platformLabel, BOARD_DASH)) + '</td>' +
      '<td class="ov-col-num">' + rows.length + '</td>' +
      '<td>' + escapeHtml(keepLabel) + '</td>' +
      '<td class="ov-col-num">' + escapeHtml(interval > 0 ? boardIntervalText(interval) : BOARD_DASH) + '</td>' +
      '<td class="cell-heartbeat" title="' + escapeHtml(beat ? boardTimeText(beat) : BOARD_DASH) + '">' + escapeHtml(beat ? boardHeartbeatShort(boardTimeText(beat)) : BOARD_DASH) + '</td>' +
      '<td class="ov-col-num"><span class="board-status ' + healthClass + '"><span class="board-status-dot"></span>' + escapeHtml(health) + '</span></td>' +
      '<td class="cell-actions"><button class="board-mini-btn" onclick="switchMainView(\'board\')">查看资源</button></td>' +
      '</tr>';
  }).join("");
  tbody.innerHTML = html;
}

async function loadOverviewEvents() {
  const box = document.getElementById("ov-events");
  if (!box) return;
  try {
    const res = await fetch(location.origin + "/ctyun/api/logs", { cache: "no-store", headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => null);
    const rows = Array.isArray(data) ? data.slice(-8).reverse() : [];
    if (!rows.length) {
      box.innerHTML = '<div class="ov-empty">暂无日志</div>';
      return;
    }
    box.innerHTML = rows.map((row) => {
      const level = String(row.level || "info");
      return '<div class="ov-event ov-event-' + escapeHtml(level) + '">' +
        '<span class="ov-event-time">' + escapeHtml(String(row.timestamp || "")) + '</span>' +
        '<span class="ov-event-src">' + escapeHtml(String(row.source || "")) + '</span>' +
        '<span class="ov-event-msg">' + escapeHtml(String(row.message || "")) + '</span>' +
        '</div>';
    }).join("");
    overviewEventsSig = rows.map((r) => r.id).join(",");
  } catch (e) {
    box.innerHTML = '<div class="ov-empty">日志加载失败：' + escapeHtml(e.message) + '</div>';
  }
}


// ---------------------------------------------------------------- 资费库（只读）
// 数据来自公开资费库快照（BFF /api/tariff）；这里只做查询与展示，不写任何上游。
const tariffState = { q: "", kind: "pc", province: "", type: "", offset: 0, limit: 50, total: 0 };

function tariffEsc(v) { return escapeHtml(String(v == null ? "" : v)); }

async function refreshTariff(reset, attempt) {
  const tryNo = attempt || 0;
  if (reset) tariffState.offset = 0;
  tariffState.q = (document.getElementById("tariff-q") || {}).value || "";
  tariffState.kind = (document.getElementById("tariff-kind") || {}).value || "";
  tariffState.province = (document.getElementById("tariff-province") || {}).value || "";
  tariffState.type = (document.getElementById("tariff-type") || {}).value || "";
  const params = new URLSearchParams({
    q: tariffState.q, kind: tariffState.kind, province: tariffState.province,
    type: tariffState.type, limit: String(tariffState.limit), offset: String(tariffState.offset),
  });
  const tbody = document.getElementById("tariff-tbody");
  // 只在还没有数据时显示「查询中…」：已有结果时保留旧表，避免一次抖动把整张表清空
  if (tbody && (!tbody.querySelector("tr") || tbody.querySelector(".board-empty"))) {
    tbody.innerHTML = '<tr><td colspan="7" class="board-empty">查询中…</td></tr>';
  }
  let data;
  try {
    // 8555 的同源 shim 会把 "/api/..." 前缀成 "/ctyun/api/..."，BFF 路由必须显式带 origin
    const res = await authFetch(location.origin + "/api/tariff?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (err) {
    if (tryNo < 1 && isTransientNetErr(err)) {
      if (tbody && !tbody.querySelector("tr.board-row")) tbody.innerHTML = '<tr><td colspan="7" class="board-empty">连不上面板服务，正在重试…</td></tr>';
      await new Promise((r) => setTimeout(r, 2500));
      return refreshTariff(false, 1);
    }
    const msg = "资费数据读取失败：" + netErrText(err) + (tryNo ? "（已自动重试 1 次）" : "");
    if (tbody && tbody.querySelector("tr.board-row")) {
      const banner = document.createElement("tr");
      banner.className = "board-inline-error";
      banner.innerHTML = '<td colspan="7">' + tariffEsc(msg) + " · 下面是上一次成功的结果</td>";
      tbody.insertBefore(banner, tbody.firstChild);
    } else if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="board-empty">' + tariffEsc(msg) + "</td></tr>";
    }
    return;
  }
  tariffState.total = Number(data.total || 0);
  tariffState.items = data.items || [];
  renderTariffFilters(data);
  renderTariffRows(tariffState.items);
  updateBoardScrollHint();
  const meta = document.getElementById("tariff-meta");
  if (meta) meta.textContent = (data.plans || 0) + " 条云电脑 / 云手机资费 · 快照 " + (data.updated || "未知");
  const count = document.getElementById("tariff-count");
  if (count) {
    const from = tariffState.total === 0 ? 0 : tariffState.offset + 1;
    const to = Math.min(tariffState.offset + tariffState.limit, tariffState.total);
    count.textContent = "第 " + from + "–" + to + " 条 / 共 " + tariffState.total + " 条";
  }
  const prev = document.getElementById("tariff-prev");
  const next = document.getElementById("tariff-next");
  if (prev) prev.disabled = tariffState.offset <= 0;
  if (next) next.disabled = tariffState.offset + tariffState.limit >= tariffState.total;
}

function renderTariffFilters(data) {
  const fill = (id, values, current) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.filled === "1") return;
    el.innerHTML = '<option value="">' + (id === "tariff-province" ? "全部省份" : "全部类型") + '</option>' +
      (values || []).map((v) => '<option value="' + tariffEsc(v) + '"' + (v === current ? " selected" : "") + '>' + tariffEsc(v) + '</option>').join("");
    el.dataset.filled = "1";
  };
  fill("tariff-province", data.provinces, tariffState.province);
  fill("tariff-type", data.types, tariffState.type);
}

function tariffSmsBadge(p) {
  const sms = (p && p.guide && p.guide.sms) || [];
  if (!sms.length) return "";
  const label = sms.map((s) => s.code + "（" + (s.kind === "cancel" ? "退订" : s.kind === "order" ? "开通" : "指令") + "）").join("、");
  return '<span class="tc-sms-badge" title="公示里写了短信指令：' + tariffEsc(label) + '">📩 ' + tariffEsc(sms.map((s) => s.code).join(" / ")) + "</span>";
}

function renderTariffRows(items) {
  const tbody = document.getElementById("tariff-tbody");
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="board-empty">没有匹配的资费条目，换个关键词或放宽筛选。</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((p) => '<tr class="board-row">' +
    '<td class="col-name">' + tariffEsc(p.name) + tariffSmsBadge(p) + '</td>' +
    '<td>' + tariffEsc(p.price || "—") + '</td>' +
    '<td>' + tariffEsc(p.type || "—") + '</td>' +
    '<td class="cell-code">' + tariffEsc(p.code || "—") + '</td>' +
    '<td>' + tariffEsc(p.province || "—") + '</td>' +
    '<td class="cell-valid">' + tariffEsc([p.validFrom, p.validTo].filter(Boolean).join(" ~ ") || "—") + '</td>' +
    '<td class="cell-guide"><button class="board-mini-btn tc-guide-btn" data-guide-kind="cloud" data-guide-code="' + tariffEsc(p.code || "") + '">怎么开通</button></td>' +
    '</tr>').join("");
}

function tariffPage(delta) {
  const next = tariffState.offset + delta * tariffState.limit;
  if (next < 0) return;
  tariffState.offset = next;
  refreshTariff(false);
}

/* ---------------- 号卡套餐与优惠（资费页第二个子页签） ---------------- */

const catalogState = { q: "", province: "北京", kind: "", promo: true, only: "", offset: 0, limit: 50, total: 0 };
let tariffTab = "cloud";

function switchTariffTab(tab) {
  tariffTab = tab === "card" ? "card" : "cloud";
  const isCard = tariffTab === "card";
  const cloudBtn = document.getElementById("tariff-tab-cloud");
  const cardBtn = document.getElementById("tariff-tab-card");
  if (cloudBtn) cloudBtn.classList.toggle("active", !isCard);
  if (cardBtn) cardBtn.classList.toggle("active", isCard);
  // 用 body class 控制显隐：内联 display 会被首访时无人调用的 switchTariffTab 漏掉，
  // 导致两张表同屏、号卡表永远停在"加载中…"（审计 §P1 实测）。
  document.body.classList.toggle("tariff-card", isCard);
  const cloudPanel = document.getElementById("tariff-panel");
  const cardPanel = document.getElementById("tariff-card-panel");
  if (cloudPanel) cloudPanel.style.display = "";
  if (cardPanel) cardPanel.style.display = "";
  if (isCard) refreshCatalog(true);
  else refreshTariff(false);
}

async function refreshCatalog(reset, attempt) {
  const tryNo = attempt || 0;
  if (reset) catalogState.offset = 0;
  catalogState.q = (document.getElementById("tc-q") || {}).value || "";
  catalogState.province = (document.getElementById("tc-province") || {}).value || "";
  catalogState.kind = (document.getElementById("tc-kind") || {}).value || "";
  const promoEl = document.getElementById("tc-promo");
  catalogState.promo = !promoEl || promoEl.checked;
  catalogState.only = (document.getElementById("tc-only") || {}).value || "";
  const params = new URLSearchParams({
    q: catalogState.q, province: catalogState.province, kind: catalogState.kind,
    promo: catalogState.promo ? "1" : "0", only: catalogState.only, sort: "price",
    limit: String(catalogState.limit), offset: String(catalogState.offset),
  });
  const tbody = document.getElementById("tc-tbody");
  if (tbody && (!tbody.querySelector("tr") || tbody.querySelector(".board-empty"))) {
    tbody.innerHTML = '<tr><td colspan="7" class="board-empty">查询中…</td></tr>';
  }
  let data;
  try {
    const res = await authFetch(location.origin + "/api/tariff/catalog?" + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (err) {
    if (tryNo < 1 && isTransientNetErr(err)) {
      if (tbody && !tbody.querySelector("tr.board-row")) tbody.innerHTML = '<tr><td colspan="7" class="board-empty">连不上面板服务，正在重试…</td></tr>';
      await new Promise((r) => setTimeout(r, 2500));
      return refreshCatalog(false, 1);
    }
    const msg = "号卡资费读取失败：" + netErrText(err) + (tryNo ? "（已自动重试 1 次）" : "");
    if (tbody && tbody.querySelector("tr.board-row")) {
      const banner = document.createElement("tr");
      banner.className = "board-inline-error";
      banner.innerHTML = '<td colspan="7">' + tariffEsc(msg) + " · 下面是上一次成功的结果</td>";
      tbody.insertBefore(banner, tbody.firstChild);
    } else if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="board-empty">' + tariffEsc(msg) + "</td></tr>";
    }
    return;
  }
  catalogState.total = Number(data.total || 0);
  catalogState.items = data.items || [];
  renderCatalogKinds(data);
  renderCatalogRows(catalogState.items);
  updateBoardScrollHint();
  const meta = document.getElementById("tc-meta");
  if (meta) meta.textContent = (data.entries || 0) + " 条在售资费（其中优惠 " + (data.promoCount || 0) + " 条）· 快照 " + (data.updated || "未知");
  renderCatalogChanges(data.changes, data.history);
  const count = document.getElementById("tc-count");
  if (count) {
    const from = catalogState.total === 0 ? 0 : catalogState.offset + 1;
    const to = Math.min(catalogState.offset + catalogState.limit, catalogState.total);
    count.textContent = "第 " + from + "–" + to + " 条 / 共 " + catalogState.total + " 条";
  }
  const prev = document.getElementById("tc-prev");
  const next = document.getElementById("tc-next");
  if (prev) prev.disabled = catalogState.offset <= 0;
  if (next) next.disabled = catalogState.offset + catalogState.limit >= catalogState.total;
}

function renderCatalogKinds(data) {
  const el = document.getElementById("tc-kind");
  if (el && el.dataset.filled !== "1") {
    el.innerHTML = '<option value="">全部类型</option>' +
      (data.kinds || []).map((k) => '<option value="' + tariffEsc(k) + '">' + tariffEsc(k) + '</option>').join("");
    el.dataset.filled = "1";
  }
  // 省份下拉原先是页面里写死的北京/广东/全网三项，而快照里实际有 30 多个省份：
  // 菜单跟着后端返回的 provinces 走，新增省份不用改前端。
  const pv = document.getElementById("tc-province");
  if (!pv || pv.dataset.filled === "1") return;
  const list = (data.provinces || []).filter(Boolean);
  if (!list.length) return;
  const cur = pv.value;
  pv.innerHTML = list.map((p) => '<option value="' + tariffEsc(p) + '">' + tariffEsc(p) + '</option>').join("");
  if (list.indexOf(cur) >= 0) pv.value = cur;
  pv.dataset.filled = "1";
}

function renderCatalogChanges(ch, history) {
  const el = document.getElementById("tc-changes");
  if (!el) return;
  // 单次同步会覆盖 changes；历史里取最近一次真有变动的批次，否则 12 小时前的变动用户永远看不到
  let pick = ch;
  const batches = (history || []).filter((x) => x && x.counts && (x.counts.added + x.counts.removed + x.counts.priceChanged));
  if (batches.length) pick = batches[batches.length - 1];
  ch = pick;
  const c = ch && ch.counts;
  if (!c || !(c.added + c.removed + c.priceChanged)) { el.style.display = "none"; return; }
  const when = ch.at ? new Date(ch.at).toLocaleString("zh-CN", { hour12: false }) : "";
  const sample = (arr, fmt) => (arr || []).slice(0, 3).map(fmt).join("；");
  const parts = [];
  if (c.added) parts.push("新增 " + c.added + " 条（" + sample(ch.added, (x) => tariffEsc(x.name) + " " + tariffEsc(x.price || "")) + "）");
  if (c.priceChanged) parts.push("调价 " + c.priceChanged + " 条（" + sample(ch.priceChanged, (x) => tariffEsc(x.name) + " " + tariffEsc(x.from || "") + " → " + tariffEsc(x.to || "")) + "）");
  if (c.removed) parts.push("下架 " + c.removed + " 条（" + sample(ch.removed, (x) => tariffEsc(x.name)) + "）");
  el.innerHTML = "🆕 " + (when ? when + " 那次同步发现：" : "较上一次同步：") + parts.join("；");
  el.style.display = "";
}

function catalogContent(p) {
  const bits = [];
  if (p.data && p.data !== "0GB" && p.data !== "无") bits.push("流量 " + p.data);
  if (p.call && p.call !== "0分钟" && p.call !== "无") bits.push("通话 " + p.call);
  if (p.direct && p.direct !== "0GB") bits.push("定向 " + p.direct);
  if (p.benefit && p.benefit !== "无" && p.benefit !== "0") bits.push("权益 " + p.benefit);
  const text = bits.join(" · ") || (p.note || p.term || "—");
  const title = [p.note, p.scope, p.term].filter(Boolean).join(" ｜ ");
  return '<span title="' + tariffEsc(title) + '">' + tariffEsc(text.slice(0, 90)) + '</span>';
}

function renderCatalogRows(items) {
  const tbody = document.getElementById("tc-tbody");
  if (!tbody) return;
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="board-empty">没有匹配的条目，换个关键词，或取消「只看优惠」。</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((p) => '<tr class="board-row' + (p.promo ? ' tc-row-promo' : '') + '">' +
    '<td class="col-name">' + tariffEsc(p.name) + (p.promo ? ' <span class="expired-tag tc-tag-promo">优惠</span>' : '') + tariffSmsBadge(p) + '</td>' +
    '<td class="cell-code">' + tariffEsc(p.price || "—") + '</td>' +
    '<td>' + tariffEsc(p.kind || "—") + '</td>' +
    '<td class="cell-code">' + tariffEsc(p.code || "—") + '</td>' +
    '<td class="cell-valid">' + catalogContent(p) + '</td>' +
    '<td class="cell-valid">' + tariffEsc([p.validFrom, p.validTo].filter(Boolean).join(" ~ ") || "—") + '</td>' +
    '<td class="cell-guide"><button class="board-mini-btn tc-guide-btn" data-guide-kind="card" data-guide-code="' + tariffEsc(p.code || "") + '">怎么开通</button></td>' +
    '</tr>').join("");
}

function catalogPage(delta) {
  const next = catalogState.offset + delta * catalogState.limit;
  if (next < 0) return;
  catalogState.offset = next;
  refreshCatalog(false);
}

function switchMainView(view) {
  const target = BOARD_VIEWS.indexOf(view) >= 0 ? view : "overview";
  boardActiveView = target;
  BOARD_VIEWS.forEach((name) => {
    document.body.classList.toggle("view-" + name, name === target);
    const btn = document.getElementById("view-switch-" + name);
    if (btn) {
      btn.classList.toggle("active", name === target);
      btn.setAttribute("aria-selected", name === target ? "true" : "false");
    }
  });
  // 四个视图吃同一份 /api/resources 快照；账号数据改为按需加载（打开行抽屉⑥时）
  startBoardTimer();
  if (target !== "tariff" && target !== "billing") refreshBoard(false);
  if (target === "billing") loadBilling(false);
  if (target === "overview") loadOverviewEvents();
  // 资费页：按当前子页签只刷一个，避免两套请求同时打
  const cardPanel = document.getElementById("tariff-card-panel");
  if (target === "tariff") {
    if (cardPanel && cardPanel.style.display !== "none" && tariffTab === "card") refreshCatalog(false);
    else refreshTariff(false);
  }
  const note = document.getElementById("page-tabs-note");
  if (note) {
    note.textContent = target === "tariff"
      ? "资费来自公开资费库快照（只读）· 每 12 小时自动同步"
      : target === "billing"
        ? "话费与流量来自中国移动 App 凭证（只读）· 缓存 30 分钟，可手动刷新"
        : "实例数据每 15 秒自动刷新 · 开关与周期即时生效";
  }
}

function startBoardTimer() {
  stopBoardTimer();
  boardTimer = setInterval(() => {
    if (document.hidden) return;
    // 资费页是只读公示数据，不该每 15 秒推进一次资源表（隐藏 DOM 的整表重绘）
    if (boardActiveView === "tariff") return;
    refreshBoard(false);
    // 同一屏的"最近事件"也要跟着走，否则 KPI 每 15 秒变、事件流冻住，像已经没事件了
    if (boardActiveView === "overview") loadOverviewEvents().catch(() => {});
  }, BOARD_REFRESH_MS);
}

function stopBoardTimer() {
  if (boardTimer) {
    clearInterval(boardTimer);
    boardTimer = null;
  }
}

/* ---------------------------------------------------------------- 初始化 */
// 14 个弹窗原先只有 div 壳：补 role=dialog / aria-modal / aria-labelledby 与关闭按钮 aria-label
function initModalA11y() {
  Array.prototype.forEach.call(document.querySelectorAll(".modal-backdrop .modal"), (modal, index) => {
    if (!modal.hasAttribute("role")) modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const heading = modal.querySelector("h3, h2");
    if (heading) {
      if (!heading.id) heading.id = "modal-title-" + index;
      if (!modal.hasAttribute("aria-labelledby")) modal.setAttribute("aria-labelledby", heading.id);
    }
    Array.prototype.forEach.call(modal.querySelectorAll(".modal-close"), (btn) => {
      if (!btn.getAttribute("aria-label")) btn.setAttribute("aria-label", "关闭对话框");
    });
  });
}

// 表单 label 只是兄弟节点、没有 for：读屏点标签不会聚焦到对应输入框
function initLabelAssociation() {
  Array.prototype.forEach.call(document.querySelectorAll(".modal label"), (label, index) => {
    if (label.getAttribute("for")) return;
    const field = label.nextElementSibling;
    if (!field) return;
    const ctrl = /^(INPUT|SELECT|TEXTAREA)$/.test(field.tagName)
      ? field
      : field.querySelector("input, select, textarea");
    if (!ctrl) return;
    if (!ctrl.id) ctrl.id = "auto-field-" + index;
    label.setAttribute("for", ctrl.id);
  });
}

function initTableHeaders() {
  Array.prototype.forEach.call(document.querySelectorAll("table thead th"), (th) => {
    if (!th.getAttribute("scope")) th.setAttribute("scope", "col");
  });
}

function initA11yHooks() {
  initModalA11y();
  initLabelAssociation();
  initTableHeaders();
}

/* ------------------------------------------------ 阶段 9b · 视觉增强（v4）
 * 只做表现层：卡片视图切换、KPI 数字滚动、状态分布环形图、点击涟漪。
 * 数据仍全部来自 /api/resources，不改任何语义。 */
const BOARD_VIEW_MODE_KEY = "boardViewMode";
function boardViewMode() {
  try { return localStorage.getItem(BOARD_VIEW_MODE_KEY) === "cards" ? "cards" : "table"; } catch (e) { return "table"; }
}
function applyBoardViewMode() {
  const mode = boardViewMode();
  document.body.classList.toggle("board-cards", mode === "cards");
  const btn = document.getElementById("board-view-toggle");
  if (btn) {
    btn.textContent = mode === "cards" ? "☰ 表格" : "▦ 卡片";
    btn.setAttribute("aria-pressed", mode === "cards" ? "true" : "false");
  }
}
function toggleBoardViewMode() {
  const next = boardViewMode() === "cards" ? "table" : "cards";
  try { localStorage.setItem(BOARD_VIEW_MODE_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
  applyBoardViewMode();
}
function v4ReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
function setKpiAnimated(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = String(value);
  const target = Number(value);
  if (!Number.isFinite(target)) { el.textContent = text; return; }
  const from = Number(el.dataset.kpiValue || 0);
  el.dataset.kpiValue = String(target);
  if (from === target || v4ReducedMotion()) { el.textContent = text; return; }
  const started = performance.now();
  el.classList.add("v4-bump");
  setTimeout(() => el.classList.remove("v4-bump"), 480);
  const step = (now) => {
    const p = Math.min(1, (now - started) / 420);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (p < 1) requestAnimationFrame(step); else el.textContent = text;
  };
  requestAnimationFrame(step);
}
function renderStatusChart(keep, managed, idle, stale, total) {
  const donut = document.getElementById("ov-donut");
  const center = document.getElementById("ov-donut-center");
  const bar = document.getElementById("ov-legend-bar");
  const caption = document.getElementById("ov-legend-caption");
  const sum = Math.max(1, Number(total) || 0);
  const segs = [
    { key: "keep", color: "#22c55e", n: keep },
    { key: "managed", color: "#6366f1", n: managed },
    { key: "idle", color: "#cbd5e1", n: idle },
    { key: "stale", color: "#f59e0b", n: stale }
  ];
  let acc = 0;
  const stops = [];
  segs.forEach((s) => {
    const from = (acc / sum) * 360;
    acc += Number(s.n) || 0;
    const to = (acc / sum) * 360;
    if (to > from) stops.push(s.color + " " + from.toFixed(2) + "deg " + to.toFixed(2) + "deg");
  });
  if (donut) donut.style.setProperty("--v4-donut", "conic-gradient(" + (stops.join(",") || "#e2e8f0 0 360deg") + ")");
  if (center) {
    const pct = Math.round(((Number(keep) || 0) / sum) * 100);
    center.innerHTML = "<b>" + pct + "%</b><span>保活在位</span>";
  }
  if (bar) {
    bar.innerHTML = segs.map((s) => {
      const w = ((Number(s.n) || 0) / sum) * 100;
      return '<i style="width:' + w.toFixed(2) + "%;background:" + s.color + '" title="' + s.key + " " + s.n + '"></i>';
    }).join("");
  }
  const put = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  put("ov-legend-keep", keep); put("ov-legend-managed", managed);
  put("ov-legend-idle", idle); put("ov-legend-stale", stale);
  if (caption) {
    const driven = (Number(keep) || 0) + (Number(managed) || 0);
    caption.textContent = "面板或容器正在保活 " + driven + " / " + sum + " 台" +
      (stale ? ("，其中 " + stale + " 台状态滞后") : "，无状态滞后");
  }
}
function initV4Interactions() {
  applyBoardViewMode();
  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest("button, .btn, .board-mini-btn");
    if (!btn || v4ReducedMotion()) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 1.1;
    const span = document.createElement("span");
    span.className = "v4-ripple";
    span.style.width = size + "px";
    span.style.height = size + "px";
    span.style.left = (ev.clientX - rect.left - size / 2) + "px";
    span.style.top = (ev.clientY - rect.top - size / 2) + "px";
    btn.appendChild(span);
    setTimeout(() => { if (span.parentNode) span.parentNode.removeChild(span); }, 620);
  }, true);
}

/* ------------------------------------------------ 阶段 9c · 总览两张图
 * 左上：近 24 小时心跳/掉线（/api/timeline，BFF 只读日志聚合）
 * 右上：到期时间轴（由已经拿到的 /api/resources 行派生，不新增请求）
 * 两张图都手写 SVG，不引图表库。 */
let heartbeatTimeline = null;
let heartbeatTimelineAt = 0;
let heartbeatTimelineError = "";

function chartEsc(v) {
  return String(v === undefined || v === null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadHeartbeatTimeline(force) {
  const node = document.getElementById("ov-heartbeat-chart");
  const meta = document.getElementById("ov-heartbeat-meta");
  if (heartbeatTimeline && !force && Date.now() - heartbeatTimelineAt < 60000) {
    renderHeartbeatTimeline(heartbeatTimeline);
    return;
  }
  try {
    const res = await fetch(location.origin + "/api/timeline" + (force ? "?refresh=1" : ""), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    heartbeatTimeline = data;
    heartbeatTimelineAt = Date.now();
    heartbeatTimelineError = "";
    renderHeartbeatTimeline(data);
  } catch (err) {
    heartbeatTimelineError = err && err.message ? err.message : String(err);
    if (node) node.innerHTML = '<div class="ov-chart-empty">心跳时间线读取失败：' + chartEsc(heartbeatTimelineError) + '</div>';
    if (meta) meta.textContent = "读取失败";
  }
}

function renderHeartbeatTimeline(data) {
  const node = document.getElementById("ov-heartbeat-chart");
  const meta = document.getElementById("ov-heartbeat-meta");
  if (!node) return;
  const hours = (data && data.hours) || [];
  if (!hours.length) {
    node.innerHTML = '<div class="ov-chart-empty">暂无日志可聚合</div>';
    if (meta) meta.textContent = "无数据";
    return;
  }
  const totals = (data && data.totals) || {};
  const W = 1000, H = 208, padL = 34, padR = 14, topH = 104, gap = 26, botH = 44;
  const plotW = W - padL - padR;
  const slot = plotW / hours.length;
  const barW = Math.max(6, slot - 6);
  const maxIds = Math.max(1, ...hours.map((h) => Number(h.accounts) || 0));
  const maxFails = Math.max(1, ...hours.map((h) => Number(h.fails) || 0));
  const maxLines = Math.max(1, ...hours.map((h) => Number(h.lines) || 0));
  const parts = [];
  parts.push('<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="近 24 小时心跳与掉线时间线">');
  parts.push('<defs><linearGradient id="ov-hb-grad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#059669"/></linearGradient>' +
    '<linearGradient id="ov-fail-grad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#fca5a5"/><stop offset="100%" stop-color="#ef4444"/></linearGradient></defs>');
  // 底衬：每小时面板日志活跃度（灰）——灰柱高但绿柱空 = 面板在跑、保活没在跑；两者都空 = 面板当时没在跑
  hours.forEach((h, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const lines = Number(h.lines) || 0;
    if (!lines) return;
    const hh = Math.max(2, (lines / maxLines) * topH);
    parts.push('<rect x="' + x.toFixed(1) + '" y="' + (topH - hh).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="3" fill="#e6eef8"><title>' +
      chartEsc(h.label + " · 面板日志 " + lines + " 行") + '</title></rect>');
  });
  // 上排：机器数
  for (let g = 1; g <= maxIds; g += 1) {
    const y = topH - (g / maxIds) * topH;
    parts.push('<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f7" stroke-width="1"/>');
  }
  parts.push('<text x="4" y="12" class="ov-chart-axis">' + maxIds + ' 台</text>');
  parts.push('<text x="4" y="' + (topH - 2) + '" class="ov-chart-axis">0</text>');
  hours.forEach((h, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const ids = Number(h.accounts) || 0;
    const hh = (ids / maxIds) * topH;
    if (ids > 0) {
      parts.push('<rect x="' + x.toFixed(1) + '" y="' + (topH - hh).toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + hh.toFixed(1) + '" rx="3" fill="url(#ov-hb-grad)"><title>' + chartEsc(h.label + " · " + ids + " 台有心跳 · 心跳 " + h.beats + " 次 · 异常 " + h.fails + " 次") + '</title></rect>');
    } else {
      parts.push('<rect x="' + x.toFixed(1) + '" y="' + (topH - 3) + '" width="' + barW.toFixed(1) + '" height="3" rx="1.5" fill="#e2e8f0"><title>' +
        chartEsc(h.label + " · 该小时没有心跳") + '</title></rect>');
    }
  });
  // 下排：异常事件数
  const botTop = topH + gap;
  parts.push('<text x="4" y="' + (botTop + 12) + '" class="ov-chart-axis">' + maxFails + ' 异常</text>');
  hours.forEach((h, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const f = Number(h.fails) || 0;
    // 用平方根比例尺：一次事故（800+ 条）会把其余小时的柱子压成一条线，根号后仍单调但看得见
    const hh = Math.sqrt(f / maxFails) * botH;
    if (f > 0) {
      parts.push('<rect x="' + x.toFixed(1) + '" y="' + (botTop + botH - hh).toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + hh.toFixed(1) + '" rx="3" fill="url(#ov-fail-grad)"><title>' + chartEsc(h.label + " · 异常 " + f + " 次") + '</title></rect>');
    }
  });
  parts.push('<line x1="' + padL + '" y1="' + (botTop + botH) + '" x2="' + (W - padR) + '" y2="' + (botTop + botH) + '" stroke="#e2e8f0" stroke-width="1"/>');
  // 横轴：每 3 小时一个刻度
  hours.forEach((h, i) => {
    if (i % 3 !== 0 && i !== hours.length - 1) return;
    const x = padL + i * slot + slot / 2;
    parts.push('<text x="' + x.toFixed(1) + '" y="' + (botTop + botH + 16) + '" class="ov-chart-axis" text-anchor="middle">' + chartEsc(h.label) + '</text>');
  });
  parts.push('<line x1="' + (W - padR) + '" y1="4" x2="' + (W - padR) + '" y2="' + (topH + gap + botH) + '" stroke="#e2e8f0" stroke-dasharray="2 3"/>');
  parts.push("</svg>");
  parts.push('<div class="ov-chart-legend">' +
    '<span><i style="background:linear-gradient(180deg,#34d399,#059669)"></i>每小时有心跳的机器数</span>' +
    '<span><i style="background:#e6eef8"></i>面板日志活跃度（有日志但没心跳＝保活当时没在跑）</span>' +
    '<span><i style="background:linear-gradient(180deg,#fca5a5,#ef4444)"></i>异常事件（独立比例尺 · 平方根，避免一次事故压平其余小时）</span>' +
    "</div>");
  node.innerHTML = parts.join("");
  if (meta) {
    const src = (data && data.source) || {};
    meta.textContent = "心跳 " + (totals.beats || 0) + " 次 · 覆盖 " + (totals.coveredHours || 0) + "/" + (totals.windowHours || 24) +
      " 小时 · 峰值 " + (totals.peakAccounts || 0) + " 台 · 异常 " + (totals.fails || 0) + " 次" +
      (totals.darkHours ? " · " + totals.darkHours + " 小时无日志" : "") +
      (src.ctyunLines ? "（日志 " + src.ctyunLines + " 行）" : "");
    meta.title = "数据来自 " + (src.files || []).join("、") + " 与 " + (src.cmccLog || "云手机日志");
  }
}

function boardDaysLeft(at) {
  if (!at) return null;
  return Math.ceil((Number(at) - Date.now()) / 86400000);
}

function renderExpiryTimeline(rows) {
  const node = document.getElementById("ov-expiry-chart");
  const meta = document.getElementById("ov-expiry-meta");
  if (!node) return;
  const dated = (rows || []).filter((r) => r && r.expire && Number(r.expire.at) > 0)
    .map((r) => ({ name: r.name || "实例", shortId: r.shortId || "", at: Number(r.expire.at), days: boardDaysLeft(r.expire.at) }))
    .sort((a, b) => a.at - b.at);
  const forever = (rows || []).filter((r) => r && r.expire && !Number(r.expire.at) && /永久|♾/.test(String(r.expire.text || ""))).length;
  const unknown = (rows || []).filter((r) => r && r.expire && !Number(r.expire.at) && !/永久|♾/.test(String(r.expire.text || ""))).length;
  // 半年以内的才有轴上意义；更远的（例如 2037 年）单列在轴下，否则整条轴被拉成十年、近期的点全挤在左边缘
  const HORIZON_DAYS = 180;
  const near = dated.filter((d) => d.days <= HORIZON_DAYS);
  const far = dated.filter((d) => d.days > HORIZON_DAYS);
  if (meta) {
    meta.textContent = near.length + " 台在轴上" + (far.length ? " · " + far.length + " 台远期" : "") +
      " · " + forever + " 台永久" + (unknown ? " · " + unknown + " 台未提供" : "");
  }
  if (!dated.length) {
    node.innerHTML = '<div class="ov-chart-empty">没有带到期日的实例</div>';
    return;
  }
  const now = Date.now();
  const parts = [];
  if (near.length) {
    const minAt = Math.min(now - 14 * 86400000, near[0].at - 3 * 86400000);
    const maxAt = Math.max(now + 60 * 86400000, near[near.length - 1].at + 10 * 86400000);
    const span = Math.max(1, maxAt - minAt);
    const rowH = 22, padL = 210, padR = 96, top = 26;
    const W = 1000, H = top + near.length * rowH + 14;
    const plotW = W - padL - padR;
    const xOf = (ts) => padL + ((ts - minAt) / span) * plotW;
    parts.push('<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="每台实例的到期时间轴">');
    const startDate = new Date(minAt);
    let cursor = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
    let guard = 0;
    while (cursor <= maxAt && guard < 40) {
      guard += 1;
      const d = new Date(cursor);
      if (cursor >= minAt) {
        const x = xOf(cursor);
        parts.push('<line x1="' + x.toFixed(1) + '" y1="' + (top - 8) + '" x2="' + x.toFixed(1) + '" y2="' + (H - 10) + '" stroke="#eef2f7" stroke-width="1"/>');
        parts.push('<text x="' + x.toFixed(1) + '" y="' + (top - 12) + '" class="ov-chart-axis" text-anchor="middle">' +
          String(d.getUTCFullYear()).slice(2) + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + '</text>');
      }
      cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    const tx = xOf(now);
    parts.push('<line x1="' + tx.toFixed(1) + '" y1="' + (top - 16) + '" x2="' + tx.toFixed(1) + '" y2="' + (H - 10) + '" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4 3"/>');
    parts.push('<text x="' + (tx + 4).toFixed(1) + '" y="' + (top - 16) + '" class="ov-chart-axis" fill="#3b82f6">今天</text>');
    near.forEach((row, i) => {
      const y = top + i * rowH + rowH / 2;
      const color = row.days < 0 ? "#ef4444" : row.days <= 30 ? "#f97316" : row.days <= 90 ? "#f59e0b" : "#22c55e";
      const label = (row.shortId ? "#" + row.shortId + " " : "") + row.name;
      parts.push('<text x="4" y="' + (y + 4).toFixed(1) + '" class="ov-chart-row">' + chartEsc(label.length > 20 ? label.slice(0, 19) + "…" : label) + "</text>");
      parts.push('<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + xOf(row.at).toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + color + '" stroke-opacity="0.22" stroke-width="1.5"/>');
      parts.push('<circle cx="' + xOf(row.at).toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5" fill="' + color + '" stroke="#fff" stroke-width="1.5"><title>' +
        chartEsc(row.name + " · 到期 " + new Date(row.at).toISOString().slice(0, 10) + " · " + (row.days < 0 ? "已过期 " + Math.abs(row.days) + " 天" : "剩 " + row.days + " 天")) + "</title></circle>");
      const txt = row.days < 0 ? "已过期 " + Math.abs(row.days) + " 天" : row.days + " 天";
      parts.push('<text x="' + (xOf(row.at) + 9).toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" class="ov-chart-axis" fill="' + color + '">' + chartEsc(txt) + "</text>");
    });
    parts.push("</svg>");
  } else {
    parts.push('<div class="ov-chart-empty">半年内没有到期日</div>');
  }
  if (far.length) {
    parts.push('<div class="ov-chart-far">远期（半年以上，不上轴）：' + far.map((r) =>
      chartEsc((r.shortId ? "#" + r.shortId + " " : "") + r.name) + " · " + new Date(r.at).toISOString().slice(0, 10) + "（剩 " + r.days + " 天）"
    ).join("；") + "</div>");
  }
  node.innerHTML = parts.join("");
}
/* ---------------- 业务开通指导（两张资费表的「怎么开通」） ---------------- */

function guideFindItem(kind, code) {
  const list = kind === "card" ? (catalogState.items || []) : (tariffState.items || []);
  const want = String(code || "");
  return list.find((p) => String(p.code || "") === want) || null;
}

function guideRow(label, value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "";
  return '<div class="tariff-guide-row"><span class="tariff-guide-label">' + tariffEsc(label) + '</span><span class="tariff-guide-value">' + tariffEsc(v) + "</span></div>";
}

function openTariffGuide(kind, code) {
  const item = guideFindItem(kind, code);
  if (!item) {
    showToast("没有找到这条资费（列表可能已刷新，请重新查询）", "warn");
    return;
  }
  const guide = item.guide || { channels: [], steps: [], cancel: "" };
  const title = document.getElementById("tariff-guide-title");
  const body = document.getElementById("tariff-guide-body");
  if (title) title.textContent = "🧭 " + (item.name || "怎么开通");
  if (!body) return;

  const channels = (guide.channels || []).map((c) =>
    '<li class="tariff-guide-channel">' +
      '<div class="tariff-guide-channel-head"><span class="tariff-guide-channel-name">' + tariffEsc(c.label || c.key) + "</span>" +
      (c.quoted ? '<span class="tariff-guide-flag quoted">公示写明</span>' : '<span class="tariff-guide-flag">通用通道</span>') +
      "</div>" +
      '<div class="tariff-guide-channel-hint">' + tariffEsc(c.hint || "") + "</div>" +
    "</li>").join("");

  const steps = (guide.steps || []).map((s) => "<li>" + tariffEsc(s) + "</li>").join("");

  const smsList = guide.sms || [];
  const smsBlock = smsList.length
    ? '<div class="tariff-guide-block"><div class="tariff-guide-block-title">📩 短信指令（公示原文，可直接复制）</div><div class="tariff-guide-sms">' +
      smsList.map((s) =>
        '<div class="tariff-guide-sms-row">' +
          '<code class="tariff-guide-code">' + tariffEsc(s.code) + "</code>" +
          '<span class="tariff-guide-sms-tag ' + (s.kind === "cancel" ? "cancel" : s.kind === "order" ? "order" : "other") + '">' +
            (s.kind === "cancel" ? "退订" : s.kind === "order" ? "开通" : "指令") + "</span>" +
          '<span class="tariff-guide-sms-how">发送到 ' + tariffEsc(s.to || "10086") + "</span>" +
          '<button class="board-mini-btn tc-guide-btn" data-guide-copy="' + tariffEsc(s.code) + '">复制</button>' +
          '<div class="tariff-guide-sms-quote">' + tariffEsc(s.sentence) + "</div>" +
        "</div>").join("") +
      "</div>" +
      '<div class="tariff-guide-foot" style="margin-top:8px">以上指令逐字来自公示文案；面板不改写、不补全。公示没写的指令不会出现在这里。</div></div>'
    : (guide.smsGap
      ? '<div class="tariff-guide-block"><div class="tariff-guide-block-title">📩 短信指令</div><div class="tariff-guide-sms-gap">' + tariffEsc(guide.smsGap) + "</div></div>"
      : "");

  const links = guide.links || [];
  const linksBlock = links.length
    ? '<div class="tariff-guide-block"><div class="tariff-guide-block-title">🔗 公示里的链接</div><ul class="tariff-guide-links">' +
      links.map((l) => '<li><a href="' + tariffEsc(l.url) + '" target="_blank" rel="noopener noreferrer">' + tariffEsc(l.label || l.url) + '</a> <span class="tariff-guide-link-url">' + tariffEsc(l.url) + "</span></li>").join("") +
      "</ul></div>"
    : "";



  body.innerHTML =
    '<div class="tariff-guide-meta">' +
      guideRow("价格", item.price) +
      guideRow("类型", item.kind || item.type) +
      guideRow("方案编号", item.code) +
      guideRow("省份", item.province) +
      guideRow("生效区间", [item.validFrom, item.validTo].filter(Boolean).join(" ~ ")) +
      guideRow("有效期", item.term) +
      guideRow("流量 / 通话", [item.data, item.call].filter(Boolean).join(" · ")) +
      guideRow("权益", item.benefit || item.direct) +
      guideRow("适用范围", item.scope) +
    "</div>" +
    (item.note ? '<div class="tariff-guide-block"><div class="tariff-guide-block-title">📄 公示条款（原文）</div><div class="tariff-guide-note">' + tariffEsc(item.note) + "</div></div>" : "") +
    smsBlock +
    linksBlock +
    '<div class="tariff-guide-block"><div class="tariff-guide-block-title">🚪 去哪办</div><ul class="tariff-guide-channels">' + channels + "</ul></div>" +
    (steps ? '<div class="tariff-guide-block"><div class="tariff-guide-block-title">✅ 办理三步</div><ol class="tariff-guide-steps">' + steps + "</ol></div>" : "") +
    '<div class="tariff-guide-block"><div class="tariff-guide-block-title">↩️ 退订 / 违约</div><div class="tariff-guide-note">' + tariffEsc(guide.cancel || "公示文案未提供退订条款，办理时请向客服确认。") + "</div></div>" +
    '<div class="tariff-guide-actions">' +
      '<button class="btn-primary" data-guide-copy="' + tariffEsc(item.code || "") + '">📋 复制方案编号</button>' +
      '<a class="btn-secondary tariff-guide-tel" href="tel:10086">📞 拨打 10086</a>' +
      '<button class="btn-secondary" onclick="closeModal(\'tariff-guide-modal\')">关闭</button>' +
    "</div>" +
    '<div class="tariff-guide-foot">面板只做指引，不代办也不代扣费；公示价 ≠ 你的账单，实收以办理页面为准。</div>';

  const backdrop = document.getElementById("tariff-guide-modal");
  if (backdrop) backdrop.classList.remove("hidden");
}

function guideCopyFallback(text, done, fail) {
  // 面板常以 http://内网IP:8555 打开，那是不安全来源：navigator.clipboard 可能不存在或被拒绝
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) done(); else fail();
  } catch (e) {
    fail();
  }
}

function guideCopyCode(code) {
  const text = String(code || "");
  if (!text) return;
  const done = () => showToast("已复制「" + text + "」", "success");
  const fail = () => showToast("浏览器没让面板写剪贴板，请手动复制「" + text + "」", "warn");
  const fallback = () => guideCopyFallback(text, done, fail);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

function initTariffGuide() {
  document.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-guide-kind]");
    if (openBtn) {
      e.preventDefault();
      openTariffGuide(openBtn.getAttribute("data-guide-kind"), openBtn.getAttribute("data-guide-code"));
      return;
    }
    const copyBtn = e.target.closest("[data-guide-copy]");
    if (copyBtn) {
      e.preventDefault();
      guideCopyCode(copyBtn.getAttribute("data-guide-copy"));
    }
  });
}

// ---------------- 中国移动 App 凭证只读账单（📱 话费页） ----------------
const billingState = { items: [], totals: {}, fetchedAt: 0, loading: false, error: "" };

function billingMoney(v) {
  if (v === null || v === undefined || !isFinite(Number(v))) return "—";
  return "¥" + Number(v).toFixed(2);
}

function billingGb(mb) {
  if (mb === null || mb === undefined || !isFinite(Number(mb))) return "—";
  const n = Number(mb);
  return n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 1 : 2) + " GB" : Math.round(n) + " MB";
}

function billingTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getMonth() + 1 + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

async function loadBilling(force) {
  if (billingState.loading) return;
  billingState.loading = true;
  const btn = document.getElementById("billing-refresh-btn");
  if (btn) { btn.disabled = true; btn.textContent = "读取中…"; }
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 25000) : null;
  try {
    const res = await fetch(location.origin + "/api/cmcc-billing" + (force ? "?refresh=1" : ""), {
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
    billingState.items = Array.isArray(data.items) ? data.items : [];
    billingState.totals = data.totals || {};
    billingState.fetchedAt = data.fetchedAt || Date.now();
    billingState.error = "";
  } catch (err) {
    billingState.error = netErrText(err);
  } finally {
    if (timer) clearTimeout(timer);
    billingState.loading = false;
    if (btn) { btn.disabled = false; btn.textContent = "刷新"; }
    renderBilling();
  }
}

function renderBilling() {
  const kpiWrap = document.getElementById("billing-kpis");
  const listWrap = document.getElementById("billing-list");
  const meta = document.getElementById("billing-meta");
  if (!kpiWrap || !listWrap) return;
  const t = billingState.totals || {};
  const okCount = Number(t.ok || 0);
  const total = Number(t.count || 0);
  const hasAny = total > 0;
  const cards = [
    { label: "话费余额", value: hasAny ? billingMoney(t.balance) : "—", color: "green" },
    { label: "本月消费", value: hasAny ? billingMoney(t.consumed) : "—", color: "amber" },
    { label: "剩余流量", value: hasAny ? billingGb(t.remainMb) : "—", color: "blue" },
    { label: "积分", value: hasAny && t.points !== undefined && t.points !== null ? String(t.points) : "—", color: "violet" },
  ];
  kpiWrap.innerHTML = cards.map((c) =>
    '<div class="ov-kpi billing-kpi billing-kpi-' + c.color + '"><div class="ov-kpi-value">' + escapeHtml(c.value) + '</div><div class="ov-kpi-label">' + escapeHtml(c.label) + "</div></div>"
  ).join("");

  if (meta) {
    if (billingState.error) meta.textContent = "读取失败：" + billingState.error;
    else if (!total) meta.textContent = "还没有凭证 · 抓一次 App 的 autoLogin 请求体即可（见下方步骤）";
    else meta.textContent = total + " 个号码 · " + okCount + " 个读取成功 · 更新于 " + billingTime(billingState.fetchedAt);
  }

  if (!billingState.items.length) {
    listWrap.innerHTML = '<div class="billing-empty">' +
      (billingState.error ? "暂时读不到面板服务：" + escapeHtml(billingState.error) : "还没有添加任何号码的凭证。") +
      '<br><span>展开下面的「添加 / 替换凭证」，把 autoLogin 请求体贴进去；凭证只存在本机 <code>/data/cmcc/</code> 下并加密。</span></div>';
    return;
  }

  listWrap.innerHTML = billingState.items.map((it) => {
    const bad = !!it.error;
    const pkgs = (it.packages || []).map((p) =>
      '<div class="billing-pkg"><span class="billing-pkg-type">' + (p.type === "0" ? "通用流量" : p.type === "2" ? "定向流量" : "流量包 " + escapeHtml(p.type)) + "</span>" +
      '<span class="billing-pkg-num">' + billingGb(p.usedMb) + " / " + billingGb(p.totalMb) + "</span>" +
      '<span class="billing-pkg-remain">剩 ' + billingGb(p.remainMb) + "</span></div>"
    ).join("");
    const rows = [
      ["话费余额", billingMoney(it.balance)],
      ["本月消费", billingMoney(it.consumed)],
      ["剩余流量", it.flow ? billingGb(it.flow.remainMb) : "—"],
      ["积分", it.points === null || it.points === undefined ? "—" : String(it.points)],
      ["数据时间", it.feeTime || "—"],
    ];
    return '<div class="billing-card' + (bad ? " billing-card-bad" : "") + '">' +
      '<div class="billing-card-head"><span class="billing-card-title">' + escapeHtml(it.label || it.masked || it.phone) + "</span>" +
      '<span class="billing-card-phone">' + escapeHtml(it.masked || it.phone) + "</span>" +
      (it.cached ? '<span class="billing-card-tag">缓存 ' + Math.round(it.ageSec / 60) + " 分钟前</span>" : "") +
      "</div>" +
      (bad
        ? '<div class="billing-card-err">' + escapeHtml(it.error) + (it.rateLimited ? "（登录过于频繁，等半小时再试）" : "（凭证可能已失效，按下面步骤重新抓一次）") + "</div>"
        : '<div class="billing-metrics">' + rows.map((r) =>
            '<div class="billing-metric"><span class="billing-metric-label">' + escapeHtml(r[0]) + '</span><span class="billing-metric-value">' + escapeHtml(r[1]) + "</span></div>"
          ).join("") + "</div>" + (pkgs ? '<div class="billing-pkgs">' + pkgs + "</div>" : "")) +
      '<div class="billing-card-foot"><span>成功 ' + billingTime(it.lastOkAt) + (it.lastError ? " · 最近错误：" + escapeHtml(it.lastError) : "") + "</span>" +
      '<button class="board-mini-btn billing-del" data-billing-del="' + escapeHtml(it.phone) + '">删除凭证</button></div>' +
      "</div>";
  }).join("");

  listWrap.querySelectorAll("[data-billing-del]").forEach((el) => {
    el.addEventListener("click", () => deleteBillingCredential(el.getAttribute("data-billing-del")));
  });
}

async function saveBillingCredential() {
  const ta = document.getElementById("billing-envelope");
  const labelEl = document.getElementById("billing-label");
  const hint = document.getElementById("billing-add-hint");
  const btn = document.getElementById("billing-save-btn");
  const envelope = ta ? ta.value.trim() : "";
  if (!envelope) {
    if (hint) hint.textContent = "先把 autoLogin 的请求体贴进来。";
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "校验中…"; }
  try {
    const res = await fetch(location.origin + "/api/cmcc-billing/credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: envelope, label: labelEl ? labelEl.value.trim() : "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
    if (hint) hint.textContent = (data.replaced ? "已替换 " : "已保存 ") + data.masked + "，正在读取…";
    if (ta) ta.value = "";
    if (labelEl) labelEl.value = "";
    await loadBilling(true);
  } catch (err) {
    if (hint) hint.textContent = "保存失败：" + netErrText(err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "保存并读取"; }
  }
}

async function deleteBillingCredential(phone) {
  if (!phone) return;
  if (!confirm("删除这个号码的凭证？删除后不再读取它的话费与流量。")) return;
  try {
    const res = await fetch(location.origin + "/api/cmcc-billing/credential?phone=" + encodeURIComponent(phone), { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
    await loadBilling(true);
  } catch (err) {
    showToast("删除失败：" + netErrText(err), "error");
  }
}

function initInstanceBoard() {
  const tbody = document.getElementById("board-tbody");
  if (tbody) tbody.addEventListener("click", onBoardTbodyClick);
  // 抽屉原先只能鼠标点开：行内按钮之外，整行也要能用 Enter/Space 打开详情
  if (tbody) tbody.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target && event.target.closest && event.target.closest("button, a, input, select")) return;
    const rowEl = event.target && event.target.closest && event.target.closest("tr.board-row");
    if (!rowEl) return;
    event.preventDefault();
    openInstanceDrawer(rowEl.getAttribute("data-row-id"));
  });
  initA11yHooks();
  initV4Interactions();
  initTariffGuide();
  const theadRow = document.getElementById("board-thead-row");
  if (theadRow) {
    Array.prototype.forEach.call(theadRow.querySelectorAll("th.board-th-sort"), (th) => {
      if (!th.hasAttribute("tabindex")) th.tabIndex = 0;
      th.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        boardSortBy(th.getAttribute("data-sort"));
      });
    });
  }
  const tableWrap = document.querySelector("#instance-board .board-table-wrap");
  if (tableWrap) tableWrap.addEventListener("scroll", updateBoardScrollHint, { passive: true });
  ["#tariff-panel .board-table-wrap", "#tariff-card-panel .board-table-wrap"].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener("scroll", updateBoardScrollHint, { passive: true });
  });
  const drawerBody = document.getElementById("drawer-body");
  if (drawerBody) {
    drawerBody.addEventListener("click", onDrawerBodyClick);
    drawerBody.addEventListener("change", onDrawerBodyChange);
  }
  document.addEventListener("keydown", (event) => {
    const overlay = document.getElementById("instance-drawer-overlay");
    const drawerOpen = !!overlay && !overlay.classList.contains("hidden");
    if (event.key === "Escape") {
      if (drawerOpen) closeInstanceDrawer();
      return;
    }
    // aria-modal 语义：Tab 只能在抽屉内循环，不能跑到背后的表格
    if (event.key !== "Tab" || !drawerOpen) return;
    const focusables = overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const list = Array.prototype.filter.call(focusables, (el) => el === document.activeElement || el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopBoardTimer();
      return;
    }
    if (boardActiveView !== "accounts") {
      startBoardTimer();
      refreshBoard(false);
    }
  });
  // 日志面板挂到「运维」视图内：总览与资源下不该常驻一块 400px 高的终端
  const logPanel = document.getElementById("main-log-panel");
  const logSlot = document.getElementById("ops-log-slot");
  if (logPanel && logSlot && logPanel.parentElement !== logSlot) logSlot.appendChild(logPanel);
  // 首屏 = 总览（/api/resources 仍是唯一数据源，不新增接口）
  switchMainView("overview");
}

document.addEventListener("DOMContentLoaded", initInstanceBoard);
