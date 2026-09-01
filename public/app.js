let token = localStorage.getItem('token');
let currentCluster = 'default';
let currentNamespace = '';
let currentView = 'overview';
let activeWs = null;
let activeTerm = null;

// API Fetch Helper
async function api(path, options = {}) {
  const headers = options.headers || {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!(options.body instanceof FormData) && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

// Initial Boot
window.addEventListener('DOMContentLoaded', () => {
  if (!token) {
    document.getElementById('login-modal').classList.remove('hidden');
  } else {
    document.getElementById('login-modal').classList.add('hidden');
    initApp();
  }

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('login-username').value;
    const p = document.getElementById('login-password').value;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '登录失败');
      token = data.token;
      localStorage.setItem('token', token);
      localStorage.setItem('username', data.username);
      document.getElementById('login-modal').classList.add('hidden');
      initApp();
    } catch (err) {
      const errEl = document.getElementById('login-error');
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('cluster-selector').addEventListener('change', (e) => {
    currentCluster = e.target.value;
    loadNamespaces();
    refreshCurrentView();
  });

  document.getElementById('ns-selector').addEventListener('change', (e) => {
    currentNamespace = e.target.value;
    refreshCurrentView();
  });

  document.getElementById('add-cluster-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('cluster-name-input').value;
    const description = document.getElementById('cluster-desc-input').value;
    const kubeconfig = document.getElementById('cluster-kubeconfig-input').value;
    const is_default = document.getElementById('cluster-default-input').checked;

    try {
      await api('/api/clusters', {
        method: 'POST',
        body: { name, description, kubeconfig, is_default },
      });
      closeAddClusterModal();
      loadClusters();
    } catch (err) {
      alert('添加集群失败: ' + err.message);
    }
  });
});

async function initApp() {
  const username = localStorage.getItem('username') || 'Admin';
  document.getElementById('user-display').textContent = username;
  document.getElementById('user-avatar').textContent = username.charAt(0).toUpperCase();

  await loadClusters();
  await loadNamespaces();
  navigate('overview');
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  token = null;
  document.getElementById('login-modal').classList.remove('hidden');
}

async function loadClusters() {
  try {
    const clusters = await api('/api/clusters');
    const sel = document.getElementById('cluster-selector');
    sel.innerHTML = '<option value="default">默认集群 (In-Cluster)</option>';
    clusters.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} ${c.is_default ? '(默认)' : ''}`;
      sel.appendChild(opt);
    });

    // Render cluster grid if in clusters view
    const grid = document.getElementById('clusters-grid');
    if (grid) {
      grid.innerHTML = '';
      clusters.forEach(c => {
        grid.innerHTML += `
          <div class="glass-panel p-5 rounded-2xl flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-2">
                <h3 class="font-bold text-white text-base">${c.name}</h3>
                ${c.is_default ? '<span class="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-xs rounded-full border border-emerald-500/30">默认</span>' : ''}
              </div>
              <p class="text-xs text-slate-400 mb-4">${c.description || '无描述'}</p>
            </div>
            <div class="flex items-center justify-between pt-4 border-t border-slate-800/80 text-xs">
              <span class="text-slate-500">${new Date(c.created_at).toLocaleDateString()}</span>
              <button onclick="deleteCluster(${c.id})" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash mr-1"></i>删除</button>
            </div>
          </div>
        `;
      });
    }
  } catch (err) {
    console.error('Failed to load clusters:', err);
  }
}

async function loadNamespaces() {
  try {
    const namespaces = await api(`/api/k8s/namespaces?clusterId=${currentCluster}`);
    const sel = document.getElementById('ns-selector');
    sel.innerHTML = '<option value="">全部命名空间 (All)</option>';
    namespaces.forEach(ns => {
      const opt = document.createElement('option');
      opt.value = ns.metadata.name;
      opt.textContent = ns.metadata.name;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load namespaces:', err);
  }
}

function navigate(viewName) {
  currentView = viewName;
  document.querySelectorAll('.sidebar-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-nav') === viewName);
  });

  const overviewSec = document.getElementById('view-overview');
  const datatableSec = document.getElementById('view-datatable');
  const clustersSec = document.getElementById('view-clusters');

  overviewSec.classList.add('hidden');
  datatableSec.classList.add('hidden');
  clustersSec.classList.add('hidden');

  if (viewName === 'overview') {
    overviewSec.classList.remove('hidden');
    loadOverview();
  } else if (viewName === 'clusters') {
    clustersSec.classList.remove('hidden');
    loadClusters();
  } else {
    datatableSec.classList.remove('hidden');
    loadDataTable(viewName);
  }
}

function refreshCurrentView() {
  navigate(currentView);
}

async function loadOverview() {
  try {
    const stats = await api(`/api/overview?clusterId=${currentCluster}`);
    document.getElementById('stat-nodes').textContent = stats.nodes;
    document.getElementById('stat-namespaces').textContent = stats.namespaces;
    document.getElementById('stat-deployments').textContent = stats.deployments;
    document.getElementById('stat-pods').textContent = stats.pods.total;
    document.getElementById('stat-pods-status').textContent = `${stats.pods.running} 运行中`;
    document.getElementById('stat-services').textContent = stats.services;
    document.getElementById('stat-ingresses').textContent = stats.ingresses;

    const nodes = await api(`/api/k8s/nodes?clusterId=${currentCluster}`);
    const nodeTbody = document.getElementById('overview-nodes-body');
    nodeTbody.innerHTML = '';
    nodes.forEach(n => {
      const isReady = n.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True');
      nodeTbody.innerHTML += `
        <tr>
          <td class="py-3 px-3 font-medium text-white">${n.metadata.name}</td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 text-[11px] rounded-full font-semibold ${isReady ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}">
              ${isReady ? 'Ready' : 'NotReady'}
            </span>
          </td>
          <td class="py-3 px-3 text-slate-400">${Object.keys(n.metadata.labels || {}).some(l => l.includes('control-plane')) ? 'Master / Control' : 'Worker'}</td>
          <td class="py-3 px-3 font-mono text-xs text-slate-400">${n.status.nodeInfo.kubeletVersion}</td>
        </tr>
      `;
    });

    const logs = await api('/api/audit/logs');
    const logTbody = document.getElementById('overview-audit-body');
    logTbody.innerHTML = '';
    logs.slice(0, 5).forEach(l => {
      logTbody.innerHTML += `
        <tr>
          <td class="py-3 px-3 text-white font-medium">${l.username}</td>
          <td class="py-3 px-3"><span class="px-2 py-0.5 text-[10px] rounded bg-blue-500/20 text-blue-400 font-semibold">${l.action}</span></td>
          <td class="py-3 px-3 text-slate-300 text-xs">${l.resource_type} / ${l.resource_name}</td>
          <td class="py-3 px-3 text-slate-500 text-xs">${new Date(l.created_at).toLocaleTimeString()}</td>
        </tr>
      `;
    });
  } catch (err) {
    console.error('Failed to load overview:', err);
  }
}

async function loadDataTable(type) {
  const titleMap = {
    nodes: { title: '节点管理 (Nodes)', desc: 'Kubernetes 集群计算节点物理/虚拟服务器' },
    deployments: { title: '无状态应用 (Deployments)', desc: 'Pod 控制器，提供多副本伸缩与滚动更新' },
    statefulsets: { title: '有状态应用 (StatefulSets)', desc: '稳定网络标识与持久存储的工作负载' },
    pods: { title: '容器组 (Pods)', desc: 'Kubernetes 中创建和管理的最小可部署计算单元' },
    services: { title: '服务发现 (Services)', desc: '将运行在一组 Pods 上的应用程序公开为网络服务' },
    ingresses: { title: '路由规则 (Ingresses)', desc: '管理外部访问集群中服务的 API 对象 (HTTP/HTTPS)' },
    configmaps: { title: '配置项 (ConfigMaps)', desc: '将环境配置信息和容器镜像解耦' },
    secrets: { title: '密文 (Secrets)', desc: '存放敏感信息（如密码、OAuth 令牌和 SSH 密钥）' },
    audit: { title: '操作审计日志', desc: '记录集群内所有的变更和操作轨迹' },
  };

  const meta = titleMap[type] || { title: type, desc: '' };
  document.getElementById('datatable-title').textContent = meta.title;
  document.getElementById('datatable-desc').textContent = meta.desc;

  const thead = document.getElementById('datatable-head');
  const tbody = document.getElementById('datatable-body');
  thead.innerHTML = '';
  tbody.innerHTML = '<tr><td class="py-8 text-center text-slate-500" colspan="6"><i class="fa-solid fa-spinner animate-spin mr-2"></i>加载数据中...</td></tr>';

  try {
    let data;
    const nsQuery = currentNamespace ? `&namespace=${currentNamespace}` : '';

    if (type === 'deployments') {
      thead.innerHTML = `<tr><th class="py-3 px-4">名称</th><th class="py-3 px-4">命名空间</th><th class="py-3 px-4">副本状态</th><th class="py-3 px-4">镜像</th><th class="py-3 px-4">创建时间</th><th class="py-3 px-4 text-right">操作</th></tr>`;
      data = await api(`/api/k8s/deployments?clusterId=${currentCluster}${nsQuery}`);
      tbody.innerHTML = '';
      data.forEach(d => {
        const ready = `${d.status?.readyReplicas || 0}/${d.spec.replicas || 0}`;
        const images = (d.spec.template.spec.containers || []).map(c => c.image).join(', ');
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${d.metadata.name}</td>
            <td class="py-3.5 px-4 text-slate-400"><span class="px-2 py-0.5 bg-slate-800 rounded text-xs">${d.metadata.namespace}</span></td>
            <td class="py-3.5 px-4"><span class="text-xs font-semibold ${ready.startsWith('0') ? 'text-amber-400' : 'text-emerald-400'}">${ready} Ready</span></td>
            <td class="py-3.5 px-4 text-xs font-mono text-slate-400 max-w-xs truncate" title="${images}">${images}</td>
            <td class="py-3.5 px-4 text-xs text-slate-500">${new Date(d.metadata.creationTimestamp).toLocaleString()}</td>
            <td class="py-3.5 px-4 text-right space-x-2 text-xs">
              <button onclick="scaleDeployment('${d.metadata.namespace}', '${d.metadata.name}', ${d.spec.replicas})" class="text-blue-400 hover:text-blue-300"><i class="fa-solid fa-up-right-and-down-left-from-center mr-1"></i>伸缩</button>
              <button onclick="restartDeployment('${d.metadata.namespace}', '${d.metadata.name}')" class="text-amber-400 hover:text-amber-300"><i class="fa-solid fa-arrows-rotate mr-1"></i>重启</button>
              <button onclick="deleteResource('deployments', '${d.metadata.namespace}', '${d.metadata.name}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash mr-1"></i>删除</button>
            </td>
          </tr>
        `;
      });
    } else if (type === 'pods') {
      thead.innerHTML = `<tr><th class="py-3 px-4">Pod 名称</th><th class="py-3 px-4">命名空间</th><th class="py-3 px-4">状态</th><th class="py-3 px-4">Pod IP</th><th class="py-3 px-4">节点</th><th class="py-3 px-4 text-right">操作</th></tr>`;
      data = await api(`/api/k8s/pods?clusterId=${currentCluster}${nsQuery}`);
      tbody.innerHTML = '';
      data.forEach(p => {
        const phase = p.status?.phase || 'Unknown';
        const isRun = phase === 'Running';
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${p.metadata.name}</td>
            <td class="py-3.5 px-4 text-slate-400"><span class="px-2 py-0.5 bg-slate-800 rounded text-xs">${p.metadata.namespace}</span></td>
            <td class="py-3.5 px-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${isRun ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}">${phase}</span></td>
            <td class="py-3.5 px-4 text-xs font-mono text-slate-400">${p.status?.podIP || '-'}</td>
            <td class="py-3.5 px-4 text-xs text-slate-400">${p.spec?.nodeName || '-'}</td>
            <td class="py-3.5 px-4 text-right space-x-2 text-xs">
              <button onclick="openLogs('${p.metadata.namespace}', '${p.metadata.name}')" class="text-indigo-400 hover:text-indigo-300"><i class="fa-solid fa-align-left mr-1"></i>日志</button>
              <button onclick="openTerminal('${p.metadata.namespace}', '${p.metadata.name}')" class="text-emerald-400 hover:text-emerald-300"><i class="fa-solid fa-terminal mr-1"></i>终端</button>
              <button onclick="deleteResource('pods', '${p.metadata.namespace}', '${p.metadata.name}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash mr-1"></i>删除</button>
            </td>
          </tr>
        `;
      });
    } else if (type === 'services') {
      thead.innerHTML = `<tr><th class="py-3 px-4">服务名称</th><th class="py-3 px-4">命名空间</th><th class="py-3 px-4">类型</th><th class="py-3 px-4">ClusterIP</th><th class="py-3 px-4">端口映射</th><th class="py-3 px-4 text-right">操作</th></tr>`;
      data = await api(`/api/k8s/services?clusterId=${currentCluster}${nsQuery}`);
      tbody.innerHTML = '';
      data.forEach(s => {
        const ports = (s.spec?.ports || []).map(p => `${p.port}:${p.targetPort}/${p.protocol}`).join(', ');
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${s.metadata.name}</td>
            <td class="py-3.5 px-4 text-slate-400"><span class="px-2 py-0.5 bg-slate-800 rounded text-xs">${s.metadata.namespace}</span></td>
            <td class="py-3.5 px-4 text-xs font-semibold text-blue-400">${s.spec?.type}</td>
            <td class="py-3.5 px-4 text-xs font-mono text-slate-300">${s.spec?.clusterIP}</td>
            <td class="py-3.5 px-4 text-xs font-mono text-slate-400">${ports}</td>
            <td class="py-3.5 px-4 text-right text-xs">
              <button onclick="deleteResource('services', '${s.metadata.namespace}', '${s.metadata.name}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash mr-1"></i>删除</button>
            </td>
          </tr>
        `;
      });
    } else if (type === 'ingresses') {
      thead.innerHTML = `<tr><th class="py-3 px-4">Ingress 名称</th><th class="py-3 px-4">命名空间</th><th class="py-3 px-4">域名 Hosts</th><th class="py-3 px-4">路由路径</th><th class="py-3 px-4 text-right">操作</th></tr>`;
      data = await api(`/api/k8s/ingresses?clusterId=${currentCluster}${nsQuery}`);
      tbody.innerHTML = '';
      data.forEach(i => {
        const hosts = (i.spec?.rules || []).map(r => r.host).join(', ');
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${i.metadata.name}</td>
            <td class="py-3.5 px-4 text-slate-400"><span class="px-2 py-0.5 bg-slate-800 rounded text-xs">${i.metadata.namespace}</span></td>
            <td class="py-3.5 px-4 text-xs text-blue-400 font-semibold"><a href="https://${hosts}" target="_blank" class="hover:underline">${hosts}</a></td>
            <td class="py-3.5 px-4 text-xs text-slate-400">/ -> Service</td>
            <td class="py-3.5 px-4 text-right text-xs">
              <button onclick="deleteResource('ingresses', '${i.metadata.namespace}', '${i.metadata.name}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash mr-1"></i>删除</button>
            </td>
          </tr>
        `;
      });
    } else if (type === 'audit') {
      thead.innerHTML = `<tr><th class="py-3 px-4">操作人</th><th class="py-3 px-4">动作</th><th class="py-3 px-4">资源类型</th><th class="py-3 px-4">资源名称</th><th class="py-3 px-4">命名空间</th><th class="py-3 px-4">操作时间</th></tr>`;
      data = await api('/api/audit/logs');
      tbody.innerHTML = '';
      data.forEach(l => {
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${l.username}</td>
            <td class="py-3.5 px-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-blue-500/20 text-blue-400">${l.action}</span></td>
            <td class="py-3.5 px-4 text-xs text-slate-300">${l.resource_type}</td>
            <td class="py-3.5 px-4 text-xs font-semibold text-slate-200">${l.resource_name}</td>
            <td class="py-3.5 px-4 text-xs text-slate-400">${l.namespace || '-'}</td>
            <td class="py-3.5 px-4 text-xs text-slate-500">${new Date(l.created_at).toLocaleString()}</td>
          </tr>
        `;
      });
    } else {
      // General fallbacks (Nodes, ConfigMaps, Secrets, StatefulSets)
      thead.innerHTML = `<tr><th class="py-3 px-4">资源名称</th><th class="py-3 px-4">命名空间 / 详情</th><th class="py-3 px-4">创建时间</th></tr>`;
      data = await api(`/api/k8s/${type}?clusterId=${currentCluster}${nsQuery}`);
      tbody.innerHTML = '';
      data.forEach(item => {
        tbody.innerHTML += `
          <tr>
            <td class="py-3.5 px-4 font-semibold text-white">${item.metadata?.name || item.name}</td>
            <td class="py-3.5 px-4 text-xs text-slate-400">${item.metadata?.namespace || item.type || '-'}</td>
            <td class="py-3.5 px-4 text-xs text-slate-500">${item.metadata?.creationTimestamp ? new Date(item.metadata.creationTimestamp).toLocaleString() : '-'}</td>
          </tr>
        `;
      });
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td class="py-8 text-center text-rose-400" colspan="6">加载失败: ${err.message}</td></tr>`;
  }
}

// Modal and Action Operations
async function scaleDeployment(ns, name, current) {
  const num = prompt(`设置 Deployment ${name} 副本数量:`, current);
  if (num === null) return;
  try {
    await api(`/api/k8s/deployments/${ns}/${name}/scale?clusterId=${currentCluster}`, {
      method: 'POST',
      body: { replicas: parseInt(num) },
    });
    refreshCurrentView();
  } catch (err) {
    alert('伸缩失败: ' + err.message);
  }
}

async function restartDeployment(ns, name) {
  if (!confirm(`确定要滚动重启 Deployment ${name} 吗？`)) return;
  try {
    await api(`/api/k8s/deployments/${ns}/${name}/restart?clusterId=${currentCluster}`, {
      method: 'POST',
    });
    refreshCurrentView();
  } catch (err) {
    alert('重启失败: ' + err.message);
  }
}

async function deleteResource(kind, ns, name) {
  if (!confirm(`警告：确定要删除 ${kind} ${ns}/${name} 吗？`)) return;
  try {
    await api(`/api/k8s/${kind}/${ns}/${name}?clusterId=${currentCluster}`, {
      method: 'DELETE',
    });
    refreshCurrentView();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

function openApplyYamlModal() {
  document.getElementById('yaml-modal').classList.remove('hidden');
}

function closeYamlModal() {
  document.getElementById('yaml-modal').classList.add('hidden');
}

async function submitYaml() {
  const yamlContent = document.getElementById('yaml-input').value;
  if (!yamlContent.trim()) return alert('YAML 内容不能为空');
  try {
    const res = await api(`/api/k8s/apply?clusterId=${currentCluster}`, {
      method: 'POST',
      body: { yaml: yamlContent },
    });
    alert('应用成功: ' + JSON.stringify(res.results.map(r => `${r.kind}/${r.name} (${r.status})`)));
    closeYamlModal();
    refreshCurrentView();
  } catch (err) {
    alert('应用失败: ' + err.message);
  }
}

function openAddClusterModal() {
  document.getElementById('add-cluster-modal').classList.remove('hidden');
}

function closeAddClusterModal() {
  document.getElementById('add-cluster-modal').classList.add('hidden');
}

async function deleteCluster(id) {
  if (!confirm('确定要解绑该 Kubernetes 集群吗？')) return;
  try {
    await api(`/api/clusters/${id}`, { method: 'DELETE' });
    loadClusters();
  } catch (err) {
    alert('删除集群失败: ' + err.message);
  }
}

async function openLogs(ns, name) {
  const modal = document.getElementById('terminal-modal');
  document.getElementById('terminal-modal-title').textContent = `容器实时日志: ${ns}/${name}`;
  modal.classList.remove('hidden');
  const container = document.getElementById('terminal-container');
  container.innerHTML = '<div class="p-4 font-mono text-xs text-slate-300 overflow-y-auto h-full whitespace-pre-wrap" id="log-output">正在获取日志...</div>';
  
  try {
    const logs = await api(`/api/k8s/pods/${ns}/${name}/log?clusterId=${currentCluster}&tail=500`);
    document.getElementById('log-output').textContent = logs || '(暂无日志)';
  } catch (err) {
    document.getElementById('log-output').textContent = '获取日志失败: ' + err.message;
  }
}

function openTerminal(ns, name) {
  const modal = document.getElementById('terminal-modal');
  document.getElementById('terminal-modal-title').textContent = `Web Terminal: ${ns}/${name}`;
  modal.classList.remove('hidden');
  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  const term = new Terminal({
    cursorBlink: true,
    theme: {
      background: '#000000',
      foreground: '#a6e22e',
      cursor: '#ffffff',
    },
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/api/ws?token=${token}&clusterId=${currentCluster}&namespace=${ns}&pod=${name}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    term.write('\r\n\x1b[32m=== Connected to Pod Terminal ===\x1b[0m\r\n\r\n');
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'stdout') {
        term.write(msg.data);
      } else if (msg.type === 'error') {
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
    } catch {
      term.write(e.data);
    }
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[33m=== Session Closed ===\x1b[0m\r\n');
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stdin', data }));
    }
  });

  activeWs = ws;
  activeTerm = term;
}

function closeTerminalModal() {
  if (activeWs) {
    activeWs.close();
    activeWs = null;
  }
  if (activeTerm) {
    activeTerm.dispose();
    activeTerm = null;
  }
  document.getElementById('terminal-modal').classList.add('hidden');
}
