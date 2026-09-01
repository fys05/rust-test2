import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import YAML from 'yaml';
import { WebSocketServer, WebSocket } from 'ws';
import * as k8s from '@kubernetes/client-node';
import { pool, initDatabase } from './db.js';
import { getK8sClients } from './k8s.js';
import { PassThrough } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/ws' });

const JWT_SECRET = process.env.JWT_SECRET || 'k8s-secret-jwt-key-2026';
const PORT = parseInt(process.env.PORT || '8080');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

interface AuthUser {
  id: number;
  username: string;
  role: string;
}

// JWT Auth Middleware
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    (req as Request & { user: AuthUser }).user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: invalid or expired token' });
  }
}

// Log audit helper
async function auditLog(username: string, action: string, resourceType: string, resourceName: string, ns?: string, details?: unknown) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (username, action, resource_type, resource_name, namespace, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, action, resourceType, resourceName, ns || '', details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('Audit log failure:', e);
  }
}

// ================= HEALTH CHECKS =================
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================= AUTH ROUTES =================
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (r.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const user = r.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: user.username, role: user.role });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/auth/me', authenticate, (req: Request, res: Response) => {
  res.json({ user: (req as Request & { user: AuthUser }).user });
});

// ================= CLUSTER MANAGEMENT ROUTES =================
app.get('/api/clusters', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT id, name, description, is_default, created_at, updated_at FROM clusters ORDER BY id ASC');
    res.json(result.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/clusters', authenticate, async (req: Request, res: Response) => {
  const { name, description, kubeconfig, is_default } = req.body;
  if (!name || !kubeconfig) {
    return res.status(400).json({ error: 'Name and kubeconfig are required' });
  }
  try {
    if (is_default) {
      await pool.query('UPDATE clusters SET is_default = FALSE');
    }
    const result = await pool.query(
      'INSERT INTO clusters (name, description, kubeconfig, is_default) VALUES ($1, $2, $3, $4) RETURNING id, name, description, is_default',
      [name, description || '', kubeconfig, !!is_default]
    );
    await auditLog((req as Request & { user: AuthUser }).user.username, 'CREATE', 'Cluster', name, '', { clusterId: result.rows[0].id });
    res.json(result.rows[0]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/clusters/:id', authenticate, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM clusters WHERE id = $1', [id]);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'DELETE', 'Cluster', id);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// ================= OVERVIEW & METRICS =================
app.get('/api/overview', authenticate, async (req: Request, res: Response) => {
  const clusterId = req.query.clusterId as string;
  try {
    const { coreV1, appsV1, networkingV1 } = await getK8sClients(clusterId);
    
    const [nodesRes, nsRes, podsRes, deployRes, svcRes, ingRes] = await Promise.all([
      coreV1.listNode(),
      coreV1.listNamespace(),
      coreV1.listPodForAllNamespaces(),
      appsV1.listDeploymentForAllNamespaces(),
      coreV1.listServiceForAllNamespaces(),
      networkingV1.listIngressForAllNamespaces(),
    ]);

    const nodeCount = nodesRes.body.items.length;
    const nsCount = nsRes.body.items.length;
    const podCount = podsRes.body.items.length;
    const deployCount = deployRes.body.items.length;
    const svcCount = svcRes.body.items.length;
    const ingCount = ingRes.body.items.length;

    let runningPods = 0;
    let failedPods = 0;
    podsRes.body.items.forEach(p => {
      if (p.status?.phase === 'Running') runningPods++;
      else if (p.status?.phase === 'Failed') failedPods++;
    });

    res.json({
      nodes: nodeCount,
      namespaces: nsCount,
      deployments: deployCount,
      pods: { total: podCount, running: runningPods, failed: failedPods, other: podCount - runningPods - failedPods },
      services: svcCount,
      ingresses: ingCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// ================= K8S CORE RESOURCES =================

// Namespaces
app.get('/api/k8s/namespaces', authenticate, async (req: Request, res: Response) => {
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = await coreV1.listNamespace();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/k8s/namespaces', authenticate, async (req: Request, res: Response) => {
  const { name } = req.body;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const nsObj: k8s.V1Namespace = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name },
    };
    const r = await coreV1.createNamespace(nsObj);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'CREATE', 'Namespace', name);
    res.json(r.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Nodes
app.get('/api/k8s/nodes', authenticate, async (req: Request, res: Response) => {
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = await coreV1.listNode();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Pods
app.get('/api/k8s/pods', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await coreV1.listNamespacedPod(ns) : await coreV1.listPodForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/k8s/pods/:namespace/:name', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    await coreV1.deleteNamespacedPod(name, namespace);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'DELETE', 'Pod', name, namespace);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Pod Logs
app.get('/api/k8s/pods/:namespace/:name/log', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  const container = req.query.container as string;
  const tailLines = req.query.tail ? parseInt(req.query.tail as string) : 200;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const logRes = await coreV1.readNamespacedPodLog(name, namespace, container || undefined, undefined, undefined, undefined, undefined, undefined, undefined, tailLines);
    res.setHeader('Content-Type', 'text/plain');
    res.send(logRes.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Deployments
app.get('/api/k8s/deployments', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { appsV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await appsV1.listNamespacedDeployment(ns) : await appsV1.listDeploymentForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/k8s/deployments/:namespace/:name/scale', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  const { replicas } = req.body;
  try {
    const { appsV1 } = await getK8sClients(req.query.clusterId as string);
    const patch = [{ op: 'replace', path: '/spec/replicas', value: parseInt(replicas) }];
    const options = { headers: { 'Content-type': k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH } };
    const r = await appsV1.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'SCALE', 'Deployment', name, namespace, { replicas });
    res.json(r.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.post('/api/k8s/deployments/:namespace/:name/restart', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  try {
    const { appsV1 } = await getK8sClients(req.query.clusterId as string);
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
            },
          },
        },
      },
    };
    const options = { headers: { 'Content-type': k8s.PatchUtils.PATCH_FORMAT_STRATEGIC_MERGE_PATCH } };
    const r = await appsV1.patchNamespacedDeployment(name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'RESTART', 'Deployment', name, namespace);
    res.json(r.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/k8s/deployments/:namespace/:name', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  try {
    const { appsV1 } = await getK8sClients(req.query.clusterId as string);
    await appsV1.deleteNamespacedDeployment(name, namespace);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'DELETE', 'Deployment', name, namespace);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// StatefulSets
app.get('/api/k8s/statefulsets', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { appsV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await appsV1.listNamespacedStatefulSet(ns) : await appsV1.listStatefulSetForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Services
app.get('/api/k8s/services', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await coreV1.listNamespacedService(ns) : await coreV1.listServiceForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/k8s/services/:namespace/:name', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    await coreV1.deleteNamespacedService(name, namespace);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'DELETE', 'Service', name, namespace);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Ingresses
app.get('/api/k8s/ingresses', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { networkingV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await networkingV1.listNamespacedIngress(ns) : await networkingV1.listIngressForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

app.delete('/api/k8s/ingresses/:namespace/:name', authenticate, async (req: Request, res: Response) => {
  const { namespace, name } = req.params;
  try {
    const { networkingV1 } = await getK8sClients(req.query.clusterId as string);
    await networkingV1.deleteNamespacedIngress(name, namespace);
    await auditLog((req as Request & { user: AuthUser }).user.username, 'DELETE', 'Ingress', name, namespace);
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// ConfigMaps
app.get('/api/k8s/configmaps', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await coreV1.listNamespacedConfigMap(ns) : await coreV1.listConfigMapForAllNamespaces();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Secrets
app.get('/api/k8s/secrets', authenticate, async (req: Request, res: Response) => {
  const ns = req.query.namespace as string;
  try {
    const { coreV1 } = await getK8sClients(req.query.clusterId as string);
    const r = ns ? await coreV1.listNamespacedSecret(ns) : await coreV1.listSecretForAllNamespaces();
    const items = r.body.items.map(s => ({
      metadata: s.metadata,
      type: s.type,
      dataKeys: s.data ? Object.keys(s.data) : [],
    }));
    res.json(items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// StorageClasses & PersistentVolumes
app.get('/api/k8s/storageclasses', authenticate, async (req: Request, res: Response) => {
  try {
    const { storageV1 } = await getK8sClients(req.query.clusterId as string);
    const r = await storageV1.listStorageClass();
    res.json(r.body.items);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Apply YAML (Any resource)
app.post('/api/k8s/apply', authenticate, async (req: Request, res: Response) => {
  const { yaml: yamlStr } = req.body;
  if (!yamlStr) {
    return res.status(400).json({ error: 'YAML payload required' });
  }
  try {
    const { kc } = await getK8sClients(req.query.clusterId as string);
    const client = k8s.KubernetesObjectApi.makeApiClient(kc);
    const specs = YAML.parseAllDocuments(yamlStr).map(doc => doc.toJSON());
    const results = [];

    for (const spec of specs) {
      if (!spec || !spec.kind || !spec.metadata) continue;
      try {
        await client.read(spec);
        const patchRes = await client.patch(spec);
        results.push({ name: spec.metadata.name, kind: spec.kind, status: 'updated', data: patchRes.body });
        await auditLog((req as Request & { user: AuthUser }).user.username, 'UPDATE_YAML', spec.kind, spec.metadata.name, spec.metadata.namespace);
      } catch (e) {
        const createRes = await client.create(spec);
        results.push({ name: spec.metadata.name, kind: spec.kind, status: 'created', data: createRes.body });
        await auditLog((req as Request & { user: AuthUser }).user.username, 'CREATE_YAML', spec.kind, spec.metadata.name, spec.metadata.namespace);
      }
    }

    res.json({ results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// ================= AUDIT LOGS =================
app.get('/api/audit/logs', authenticate, async (req: Request, res: Response) => {
  try {
    const r = await pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100');
    res.json(r.rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    res.status(500).json({ error: message });
  }
});

// Fallback to index.html for SPA
app.get('*', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// WebSockets for real-time terminal & pod exec
wss.on('connection', async (ws: WebSocket, req) => {
  const urlParams = new URLSearchParams(req.url?.split('?')[1]);
  const token = urlParams.get('token');
  const clusterId = urlParams.get('clusterId') || undefined;
  const namespace = urlParams.get('namespace');
  const pod = urlParams.get('pod');
  const container = urlParams.get('container');

  if (!token) {
    ws.close(1008, 'Token required');
    return;
  }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(1008, 'Invalid token');
    return;
  }

  if (!namespace || !pod) {
    ws.close(1002, 'Namespace and pod required');
    return;
  }

  try {
    const { kc } = await getK8sClients(clusterId);
    const exec = new k8s.Exec(kc);

    const stream = new PassThrough();
    
    await exec.exec(
      namespace,
      pod,
      container || '',
      ['/bin/sh', '-c', 'TERM=xterm /bin/sh || TERM=xterm /bin/bash || TERM=xterm sh'],
      stream,
      stream,
      stream,
      true, // tty
      (status) => {
        ws.send(JSON.stringify({ type: 'exit', status }));
        ws.close();
      }
    );

    stream.on('data', (chunk: Buffer) => {
      ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
    });

    ws.on('message', (msg: string) => {
      try {
        const payload = JSON.parse(msg);
        if (payload.type === 'stdin') {
          stream.write(payload.data);
        }
      } catch (e) {
        stream.write(msg);
      }
    });

    ws.on('close', () => {
      stream.end();
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown WebSocket error';
    ws.send(JSON.stringify({ type: 'error', message }));
    ws.close();
  }
});

// Start Server
async function start() {
  try {
    await initDatabase();
    
    // Auto-register current cluster if none exists
    const clusterCheck = await pool.query('SELECT id FROM clusters LIMIT 1');
    if (clusterCheck.rows.length === 0 && process.env.INITIAL_KUBECONFIG) {
      await pool.query(
        'INSERT INTO clusters (name, description, kubeconfig, is_default) VALUES ($1, $2, $3, $4)',
        ['Production-Cluster', 'Primary Kubernetes Cluster', process.env.INITIAL_KUBECONFIG, true]
      );
      console.log('[Init] Registered initial default cluster.');
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] K8s Cluster Management Platform running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
