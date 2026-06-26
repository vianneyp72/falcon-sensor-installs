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

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials

```bash
export FALCON_CLIENT_ID="<YOUR_FALCON_CLIENT_ID>"
export FALCON_CLIENT_SECRET="<YOUR_FALCON_CLIENT_SECRET>"
```

### 2. Get pull token and image paths

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

### 3. Set environment variables

Use the output from the commands above:

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

### 4. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 5. Deploy the Helm chart

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

### 6. Verify deployment

```bash
kubectl get pods -n falcon-system
kubectl get pods -n falcon-kac
kubectl get pods -n falcon-image-analyzer
```

</div>

<div data-mode="lab">

### 1. Provision a test cluster

> **What this does:** Creates a minimal Kubernetes cluster for the lab. Pick one provider below.

**GKE:**

```bash
export PROJECT_ID=$(gcloud config get-value project)
export CLUSTER_NAME="falcon-helm-lab"
export REGION="us-central1"

gcloud container clusters create $CLUSTER_NAME \
  --region $REGION \
  --num-nodes 2 \
  --machine-type e2-standard-2
```

**EKS:**

```bash
export CLUSTER_NAME="falcon-helm-lab"
export REGION="us-east-1"

eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $REGION \
  --nodes 2 \
  --node-type t3.medium
```

**AKS:**

```bash
export CLUSTER_NAME="falcon-helm-lab"
export RESOURCE_GROUP="falcon-lab-rg"

az group create --name $RESOURCE_GROUP --location eastus
az aks create --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME \
  --node-count 2 --node-vm-size Standard_B2s --generate-ssh-keys
az aks get-credentials --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME
```

Verify connectivity:

```bash
kubectl get nodes
```

### 2. Set API credentials

```bash
export FALCON_CLIENT_ID="<YOUR_FALCON_CLIENT_ID>"
export FALCON_CLIENT_SECRET="<YOUR_FALCON_CLIENT_SECRET>"
```

### 3. Get pull token and image paths

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

### 4. Set environment variables

Use the output from step 3 to populate these:

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

### 5. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 6. Deploy the Helm chart

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

### 7. Verify deployment

Check all three component namespaces:

```bash
kubectl get pods -n falcon-system
kubectl get pods -n falcon-kac
kubectl get pods -n falcon-image-analyzer
```

Verify the DaemonSet has a pod on every node:

```bash
kubectl get ds -n falcon-system
```

Check sensor connectivity to CrowdStrike cloud:

```bash
kubectl logs -n falcon-system -l app.kubernetes.io/name=falcon-sensor --tail=20
```

### 8. Test KAC enforcement

Deploy a test pod and verify KAC webhook intercepts it:

```bash
kubectl run test-pod --image=nginx --restart=Never
kubectl describe pod test-pod | grep -A5 "Events"
```

You should see the admission controller annotating the pod creation event.

```bash
kubectl delete pod test-pod
```

### 9. Cleanup

Remove the Falcon platform:

```bash
helm uninstall falcon-platform -n falcon-platform
kubectl delete ns falcon-platform falcon-system falcon-kac falcon-image-analyzer
```

Delete the test cluster (pick your provider):

```bash
# GKE
gcloud container clusters delete $CLUSTER_NAME --region $REGION --quiet

# EKS
eksctl delete cluster --name $CLUSTER_NAME --region $REGION

# AKS
az aks delete --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME --yes
az group delete --name $RESOURCE_GROUP --yes
```

</div>
