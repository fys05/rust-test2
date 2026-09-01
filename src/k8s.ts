import * as k8s from '@kubernetes/client-node';
import { pool } from './db.js';

export async function getK8sClients(clusterId?: number | string) {
  const kc = new k8s.KubeConfig();

  if (clusterId && clusterId !== 'default' && clusterId !== 'current') {
    const res = await pool.query('SELECT kubeconfig FROM clusters WHERE id = $1', [clusterId]);
    if (res.rows.length > 0) {
      kc.loadFromString(res.rows[0].kubeconfig);
    } else {
      throw new Error(`Cluster with ID ${clusterId} not found`);
    }
  } else {
    // Check if cluster exists in DB marked as default
    const res = await pool.query('SELECT kubeconfig FROM clusters WHERE is_default = TRUE LIMIT 1');
    if (res.rows.length > 0) {
      kc.loadFromString(res.rows[0].kubeconfig);
    } else {
      try {
        kc.loadFromDefault();
      } catch {
        // fallback to inCluster
        kc.loadFromCluster();
      }
    }
  }

  return {
    kc,
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
    appsV1: kc.makeApiClient(k8s.AppsV1Api),
    networkingV1: kc.makeApiClient(k8s.NetworkingV1Api),
    storageV1: kc.makeApiClient(k8s.StorageV1Api),
    customObjectsApi: kc.makeApiClient(k8s.CustomObjectsApi),
    batchV1: kc.makeApiClient(k8s.BatchV1Api),
    rbacV1: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
  };
}
