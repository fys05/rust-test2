# K8s Cluster Manager (Kuboard-like Platform)

A full-featured Kubernetes Multi-Cluster Management Platform with real-time Web Terminal, cluster management, deployment scaling/restarting, pod logs viewer, YAML editor & applicator, built-in PostgreSQL database and dark-themed UI.

## Features
- **Multi-Cluster Support**: Manage multiple Kubernetes clusters with dynamic switching and persistence in PostgreSQL.
- **Resource Management**: Namespaces, Nodes, Pods, Deployments, StatefulSets, Services, Ingresses, ConfigMaps, Secrets, StorageClasses.
- **Web Terminal**: Interactive live terminal (xterm.js) directly into running pods via WebSocket exec stream.
- **YAML Management**: Apply, inspect, and update Kubernetes YAML directly from browser.
- **Workload Operations**: Scale replicas, restart deployments, view container logs, and delete resources.
- **Audit Logging**: Full audit trail of user actions stored in database.
- **CI/CD**: Automated GitHub Actions workflow building multi-stage container and deploying to Kubernetes with Ingress TLS and independent PostgreSQL StatefulSet.

## Architecture
- **Backend**: Node.js + Express + TypeScript + `@kubernetes/client-node` + `ws` + `pg`
- **Frontend**: Clean dark-mode dashboard (Vanilla JS + CSS + FontAwesome + xterm.js)
- **Database**: PostgreSQL 15 (StatefulSet with NFS PersistentVolumeClaim)
- **Deployment**: Kubernetes Deployment + Service + Traefik Ingress
