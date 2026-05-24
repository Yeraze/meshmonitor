# Kubernetes Deployment (Helm)

MeshMonitor ships a Helm chart for deploying to any Kubernetes 1.19+ cluster. The chart lives under [`helm/meshmonitor/`](https://github.com/Yeraze/meshmonitor/tree/main/helm/meshmonitor) in the repository and is fully documented in the [chart README](https://github.com/Yeraze/meshmonitor/blob/main/helm/README.md) — this page is the docs-site landing point for Kubernetes installs.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- A Meshtastic node reachable from the cluster (WiFi/Ethernet, or a Serial/BLE bridge exposing TCP)
- Optional: an ingress controller (nginx, Traefik, etc.) and cert-manager if you want TLS

## Quick Start

1. **Clone the repository** to get the chart sources:

   ```bash
   git clone --recurse-submodules https://github.com/Yeraze/meshmonitor.git
   cd meshmonitor
   ```

2. **Create `custom-values.yaml`** with the required node settings:

   ```yaml
   env:
     meshtasticNodeIp: "192.168.1.100"   # REQUIRED — your Meshtastic node IP
     meshtasticUseTls: "false"           # REQUIRED — "true" for HTTPS to the node
   ```

3. **Install the chart**:

   ```bash
   helm install meshmonitor ./helm/meshmonitor -f custom-values.yaml
   ```

4. **Access the UI**. The default install creates a `ClusterIP` service; port-forward to reach it locally:

   ```bash
   kubectl port-forward svc/meshmonitor 8080:80
   ```

   Open <http://localhost:8080> and sign in with the default credentials (`admin` / `changeme`). Change the password immediately.

## Common Configurations

### Ingress with TLS

```yaml
env:
  meshtasticNodeIp: "192.168.1.100"
  meshtasticUseTls: "false"

ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: meshmonitor.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: meshmonitor-tls
      hosts:
        - meshmonitor.example.com
```

### Subfolder Deployment

To serve MeshMonitor at `https://example.com/meshmonitor/`:

```yaml
env:
  meshtasticNodeIp: "192.168.1.100"
  meshtasticUseTls: "false"
  baseUrl: "/meshmonitor"

ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: example.com
      paths:
        - path: /meshmonitor
          pathType: Prefix
```

### Persistence

The chart provisions a `PersistentVolumeClaim` by default (1Gi). Resize or point at an existing PVC:

```yaml
persistence:
  enabled: true
  size: "5Gi"
  # storageClass: "fast-ssd"
  # existingClaim: "my-existing-pvc"
```

### Resource Limits

```yaml
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi
```

## Upgrading

```bash
git pull
helm upgrade meshmonitor ./helm/meshmonitor -f custom-values.yaml
```

The chart `appVersion` is bumped on every MeshMonitor release; pin a specific image tag via `image.tag` if you need a stable target.

## Uninstalling

```bash
helm uninstall meshmonitor
# PVC is preserved by default — delete it explicitly if desired:
kubectl delete pvc meshmonitor
```

## Troubleshooting

**Can't reach the Meshtastic node from the pod:**

```bash
kubectl run -it --rm debug --image=busybox --restart=Never -- wget -O- http://YOUR_NODE_IP
kubectl logs -l app.kubernetes.io/name=meshmonitor
```

**Database/permission errors:**

```bash
kubectl get pvc
kubectl exec -it deployment/meshmonitor -- ls -la /data
```

**Pod not starting:**

```bash
kubectl describe pod -l app.kubernetes.io/name=meshmonitor
kubectl logs -l app.kubernetes.io/name=meshmonitor
```

## Reference

- [Helm chart README](https://github.com/Yeraze/meshmonitor/blob/main/helm/README.md) — full values tree, architecture diagram, and every supported option (canonical source).
- [Chart sources](https://github.com/Yeraze/meshmonitor/tree/main/helm/meshmonitor) — templates and default `values.yaml`.
- [Production Deployment Guide](/configuration/production) — production hardening notes that apply to the Helm install.
- [Deployment Guide](/deployment/DEPLOYMENT_GUIDE) — other deployment methods (Docker, bare metal, Proxmox LXC).

## GitOps

The chart is GitOps-friendly: commit your `custom-values.yaml` to a config repo and let ArgoCD or Flux apply it. Pin `image.tag` to a specific release rather than `latest` so deployments are reproducible.
