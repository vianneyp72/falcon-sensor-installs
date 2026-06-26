# Falcon Platform Helm Deployment — DaemonSet (Standard Kubernetes)

Deploy the CrowdStrike Falcon Platform on any standard Kubernetes cluster (EKS, GKE Standard, AKS, on-prem) using the DaemonSet approach, pulling images directly from CrowdStrike's registry.

Official GH: https://github.com/CrowdStrike/falcon-helm/tree/main/helm-charts/falcon-platform

Official Docs: https://docs.crowdstrike.com/r/en-US/qg0ygdwl/l303c850

## Components Deployed

- **Falcon Sensor** (DaemonSet) - Runs on all nodes
- **Falcon KAC** (Deployment) - Kubernetes Admission Controller
- **Falcon Image Analyzer** (Deployment) - Container image scanning

```
KUBERNETES CLUSTER — FALCON PLATFORM HELM DEPLOYMENT
DaemonSet: 1 pod per node | Deployment: 1 pod per cluster
Node 1: falcon-sensor | Node 2: falcon-sensor | Node 3: falcon-sensor
Falcon KAC (Deployment) — Admission Controller
Falcon Image Analyzer (Deployment) — Image Assessment
CrowdStrike Cloud — Telemetry
```

## Prerequisites

- Kubernetes cluster running (EKS, GKE Standard, AKS, kubeadm, Rancher, k3s, etc.)
- CrowdStrike Falcon API credentials (CID, Client ID + Secret)
  - Required API scopes: **Falcon Images Download** (Read), **Sensor Download** (Read), **Falcon Container Image** (Read/Write), **Falcon Container CLI** (Write)
- Helm 3 installed
- kubectl configured for the cluster

```bash
export FALCON_CLIENT_ID="<YOUR_FALCON_CLIENT_ID>"
export FALCON_CLIENT_SECRET="<YOUR_FALCON_CLIENT_SECRET>"
```

## Deployment Steps

### 1. Get pull token and image paths from CrowdStrike registry

```bash
curl -sSL https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/refs/heads/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh | bash -s -- \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --get-pull-token
```

```bash
curl -sSL https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/refs/heads/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh | bash -s -- \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-sensor \
  --get-image-path
```

```bash
curl -sSL https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/refs/heads/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh | bash -s -- \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-kac \
  --get-image-path
```

```bash
curl -sSL https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/refs/heads/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh | bash -s -- \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-imageanalyzer \
  --get-image-path
```

### 2. Set environment variables

Use the output from step 1 to populate these:

```bash
export FALCON_CID=
export CLUSTER_NAME=
export FALCON_PULL_TOKEN=

export DAEMONSET_SENSOR_REGISTRY=
export DAEMONSET_SENSOR_IMAGE_TAG=

export KAC_REGISTRY=
export KAC_IMAGE_TAG=

export IAR_REGISTRY=
export IAR_IMAGE_TAG=
```

### 3. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 4. Deploy the Helm chart

```bash
helm upgrade --install falcon-platform crowdstrike/falcon-platform --version 1.0.0 \
  --namespace falcon-platform \
  --create-namespace \
  --set createComponentNamespaces=true \
  --set global.falcon.cid=$FALCON_CID \
  --set global.containerRegistry.configJSON=$FALCON_PULL_TOKEN \
  --set falcon-sensor.node.image.repository=$DAEMONSET_SENSOR_REGISTRY \
  --set falcon-sensor.node.image.tag=$DAEMONSET_SENSOR_IMAGE_TAG \
  --set falcon-kac.image.repository=$KAC_REGISTRY \
  --set falcon-kac.image.tag=$KAC_IMAGE_TAG \
  --set falcon-image-analyzer.deployment.enabled=true \
  --set falcon-image-analyzer.image.repository=$IAR_REGISTRY \
  --set falcon-image-analyzer.image.tag=$IAR_IMAGE_TAG \
  --set falcon-image-analyzer.crowdstrikeConfig.clusterName=$CLUSTER_NAME \
  --set falcon-image-analyzer.crowdstrikeConfig.clientID=$FALCON_CLIENT_ID \
  --set falcon-image-analyzer.crowdstrikeConfig.clientSecret=$FALCON_CLIENT_SECRET
```

> `createComponentNamespaces=true` places KAC in `falcon-kac` and IAR in `falcon-image-analyzer` namespaces.

### 5. Verify deployment

```bash
kubectl get pods -n falcon-system
kubectl get pods -n falcon-kac
kubectl get pods -n falcon-image-analyzer
```
