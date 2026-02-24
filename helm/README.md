# MeshMonitor Helm Chart

This Helm chart deploys MeshMonitor, a web application for monitoring Meshtastic mesh networks over IP, to a Kubernetes cluster.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.0+
- A Meshtastic device with WiFi/Ethernet connectivity
- Network access to your Meshtastic node from the Kubernetes cluster

## Installation

### Quick Start

1. **Update the required configuration values**

   Create a `custom-values.yaml` file with your Meshtastic node IP:

   ```yaml
   env:
     meshtasticNodeIp: "192.168.1.100"  # Your Meshtastic node IP
     meshtasticUseTls: "false"          # Set to "true" for HTTPS
   ```

2. **Install the chart**

   ```bash
   helm install meshmonitor ./helm/meshmonitor -f custom-values.yaml
   ```

3. **Access the application**

   The default installation creates a ClusterIP service. To access it:

   ```bash
   # Port forward to access locally
   kubectl port-forward svc/meshmonitor 8080:80
   ```

   Then open http://localhost:8080 in your browser.

### Installing with Ingress

To expose MeshMonitor via an Ingress:

```yaml
# custom-values.yaml
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

Then install:

```bash
helm install meshmonitor ./helm/meshmonitor -f custom-values.yaml
```

### Installing in a Subfolder

To deploy MeshMonitor at a subfolder path (e.g., `https://example.com/meshmonitor/`):

```yaml
# custom-values.yaml
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

## Configuration

### Required Environment Variables

These are the **required** configuration values from the Docker documentation:

```yaml
env:
  # IP address of your Meshtastic node (REQUIRED)
  meshtasticNodeIp: "192.168.1.100"

  # Enable HTTPS connection to node (REQUIRED)
  meshtasticUseTls: "false"
```

### Complete Values.yaml Structure

Below is the complete tree of configurable values. Required values from the Docker docs are listed first:

```yaml
# REQUIRED: Meshtastic node connection settings
env:
  meshtasticNodeIp: "192.168.1.100"    # ⚠️ REQUIRED - IP address of your Meshtastic node
  meshtasticUseTls: "false"            # ⚠️ REQUIRED - Enable HTTPS connection to node

  # Optional environment variables
  nodeEnv: "production"                # Environment mode
  port: "3001"                         # Server port (should match service.targetPort)
  baseUrl: ""                          # Runtime base URL path for subfolder deployment (e.g., "/meshmonitor")

# Image configuration
image:
  repository: "ghcr.io/yeraze/meshmonitor"
  pullPolicy: "IfNotPresent"
  tag: "latest"

# Number of replicas
replicaCount: 1

# Service configuration
service:
  type: "ClusterIP"
  port: 80
  targetPort: 3001

# Ingress configuration
ingress:
  enabled: false
  className: ""
  annotations: {}
    # kubernetes.io/ingress.class: nginx
    # cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: "meshmonitor.local"
      paths:
        - path: /
          pathType: Prefix
  tls: []
    # - secretName: meshmonitor-tls
    #   hosts:
    #     - meshmonitor.local

# Persistent storage for SQLite database
persistence:
  enabled: true
  # storageClass: ""
  accessMode: "ReadWriteOnce"
  size: "1Gi"
  # existingClaim: ""

# Resource limits and requests
resources: {}
  # limits:
  #   cpu: 500m
  #   memory: 512Mi
  # requests:
  #   cpu: 250m
  #   memory: 256Mi

# Node selector for pod assignment
nodeSelector: {}

# Tolerations for pod assignment
tolerations: []

# Affinity for pod assignment
affinity: {}

# Security context
podSecurityContext:
  fsGroup: 1000

securityContext:
  runAsUser: 1000
  runAsNonRoot: true
  readOnlyRootFilesystem: false
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

## Common Configuration Examples

### Minimal Production Setup

```yaml
env:
  meshtasticNodeIp: "192.168.1.100"
  meshtasticUseTls: "false"

persistence:
  enabled: true
  size: "2Gi"

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi
```

### Setup with TLS/HTTPS

```yaml
env:
  meshtasticNodeIp: "192.168.1.100"
  meshtasticUseTls: "true"
```

### Using Existing PersistentVolumeClaim

```yaml
persistence:
  enabled: true
  existingClaim: "my-existing-pvc"
```

### Exposing via LoadBalancer

```yaml
service:
  type: LoadBalancer
  port: 80
```

## Upgrading

To upgrade an existing release:

```bash
helm upgrade meshmonitor ./helm/meshmonitor -f custom-values.yaml
```

## Uninstalling

To uninstall the release:

```bash
helm uninstall meshmonitor
```

**Note:** This will not delete the PersistentVolumeClaim by default. To delete it:

```bash
kubectl delete pvc meshmonitor
```

## Troubleshooting

### Cannot connect to Meshtastic node

1. Verify the `meshtasticNodeIp` is correct
2. Ensure the Kubernetes cluster can reach the Meshtastic node:
   ```bash
   kubectl run -it --rm debug --image=busybox --restart=Never -- wget -O- http://YOUR_NODE_IP
   ```
3. Check the logs:
   ```bash
   kubectl logs -l app.kubernetes.io/name=meshmonitor
   ```

### Database errors

1. Check if the PVC is bound:
   ```bash
   kubectl get pvc
   ```
2. Verify pod has write access to `/data`:
   ```bash
   kubectl exec -it deployment/meshmonitor -- ls -la /data
   ```

### Pod not starting

Check pod events and logs:
```bash
kubectl describe pod -l app.kubernetes.io/name=meshmonitor
kubectl logs -l app.kubernetes.io/name=meshmonitor
```

## Architecture

The Helm chart creates the following Kubernetes resources:

- **Deployment**: Manages the MeshMonitor pod(s)
- **Service**: Exposes the application within the cluster
- **PersistentVolumeClaim**: Stores the SQLite database
- **Ingress** (optional): Exposes the application externally

```
┌─────────────────────┐
│     Ingress         │ (optional)
│  meshmonitor.local  │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│      Service        │
│   ClusterIP:80      │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│     Deployment      │
│   meshmonitor       │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│       Pod           │
│  Container:3001     │
│  Volume: /data      │
└──────────┬──────────┘
           │
┌──────────▼──────────┐
│        PVC          │
│   meshmonitor-data  │
└─────────────────────┘
```

## Values Reference

See the [values.yaml](meshmonitor/values.yaml) file for all available configuration options.

## Support

For issues and questions:
- [GitHub Issues](https://github.com/Yeraze/meshmonitor/issues)
- [Project Documentation](https://github.com/Yeraze/meshmonitor)

## License

This chart is part of the MeshMonitor project and is licensed under the BSD-3-Clause License.
