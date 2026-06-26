# Falcon Deployment - GKE DaemonSet on GCE Nodes

Deploy the full CrowdStrike Falcon Platform on GKE using DaemonSet approach with images stored in Google Artifact Registry.

https://github.com/CrowdStrike/falcon-helm/tree/main/helm-charts/falcon-platform
falcon docs portal https://docs.crowdstrike.com/r/en-US/qg0ygdwl/l303c850

## Components Deployed

- **Falcon Sensor** (DaemonSet) - Runs on all GCE nodes
- **Falcon KAC** (Deployment) - Kubernetes Admission Controller
- **Falcon Image Analyzer** (Deployment) - Container image scanning

## Prerequisites

- GKE cluster running with GCE node pools
- CrowdStrike Falcon API credentials (CID, Client ID + Secret)
  - Required API scopes: **Falcon Images Download** (Read), **Sensor Download** (Read), **Falcon Container Image** (Read/Write)
- Helm 3 installed
- kubectl configured for the cluster
- `gcloud auth configure-docker <YOUR_GCP_REGION>-docker.pkg.dev` (Artifact Registry auth)

```bash
export FALCON_CLIENT_ID="<YOUR_FALCON_CLIENT_ID>"
export FALCON_CLIENT_SECRET="<YOUR_FALCON_CLIENT_SECRET>"
```

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials

```bash
export FALCON_CID=<YOUR_FALCON_CID>
export FALCON_CLIENT_ID=<YOUR_CLIENT_ID>
export FALCON_CLIENT_SECRET=<YOUR_CLIENT_SECRET>
export CLUSTER_NAME=<YOUR_CLUSTER_NAME>
```

### 2. Pull Falcon sensor images to Artifact Registry

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-sensor \
  --copy <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-daemonset-sensor-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-kac \
  --copy <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-kac-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-imageanalyzer \
  --copy <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-iar-latest"
```

### 3. Set image environment variables

```bash
export DAEMONSET_SENSOR_REGISTRY=<YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO>/falcon-sensor
export DAEMONSET_SENSOR_IMAGE_TAG=falcon-daemonset-sensor-latest
export KAC_REGISTRY=<YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO>/falcon-kac
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=<YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO>/falcon-imageanalyzer
export IAR_IMAGE_TAG=falcon-iar-latest
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

### 6. Verify

```bash
kubectl get pods -A | grep falcon
```

</div>

<div data-mode="lab">

### 1. Create GKE Standard Cluster

```bash
export GCP_PROJECT_ID=<YOUR_GCP_PROJECT_ID>
export GCP_REGION=<YOUR_GCP_REGION>
export CLUSTER_NAME=falcon-gke-lab

gcloud container clusters create $CLUSTER_NAME \
  --project=$GCP_PROJECT_ID \
  --region=$GCP_REGION \
  --num-nodes=2 \
  --machine-type=e2-medium \
  --release-channel=regular
```

Get credentials for kubectl:

```bash
gcloud container clusters get-credentials $CLUSTER_NAME \
  --project=$GCP_PROJECT_ID \
  --region=$GCP_REGION
```

Verify cluster is ready:

```bash
kubectl get nodes
```

### 2. Create Artifact Registry Repository

```bash
gcloud artifacts repositories create falcon-images \
  --project=$GCP_PROJECT_ID \
  --repository-format=docker \
  --location=$GCP_REGION \
  --description="CrowdStrike Falcon sensor images"
```

Configure Docker auth for GAR:

```bash
gcloud auth configure-docker $GCP_REGION-docker.pkg.dev
```

### 3. Pull Falcon sensor images to Artifact Registry

> **Note:** Do NOT use `--copy-omit-image-name`. GAR requires an image name in the path:
> `REGION-docker.pkg.dev/PROJECT/REPO/IMAGE:TAG`

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-sensor \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images \
  --copy-custom-tag "falcon-daemonset-sensor-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-kac \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images \
  --copy-custom-tag "falcon-kac-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FALCON_CLIENT_ID \
  --client-secret $FALCON_CLIENT_SECRET \
  --type falcon-imageanalyzer \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images \
  --copy-custom-tag "falcon-iar-latest"
```

Verify images are in GAR:

```bash
gcloud artifacts docker images list $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images --include-tags
```

### 4. Set environment variables

> **Important:** The `*_REGISTRY` vars must include the image name in the path (e.g. `.../falcon-sensor`).
> The helm chart constructs `{repository}:{tag}` — it does NOT append an image name automatically.

```bash
export FALCON_CID=<YOUR_FALCON_CID>

export DAEMONSET_SENSOR_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images/falcon-sensor
export DAEMONSET_SENSOR_IMAGE_TAG=falcon-daemonset-sensor-latest
export KAC_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images/falcon-kac
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/falcon-images/falcon-imageanalyzer
export IAR_IMAGE_TAG=falcon-iar-latest
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

```bash
kubectl get pods -n falcon-system
kubectl get pods -n falcon-kac
kubectl get pods -n falcon-image-analyzer
```

Check the DaemonSet is running on all nodes:

```bash
kubectl get daemonset -n falcon-system
# DESIRED and READY counts should match node count
```

### 8. Deep Verification

Check sensor logs for successful cloud connection:

```bash
kubectl logs -n falcon-system -l app.kubernetes.io/name=falcon-sensor --tail=30
```

Verify KAC webhook is registered:

```bash
kubectl get validatingwebhookconfigurations | grep falcon
```

Test with a workload:

```bash
kubectl create namespace test-detection
kubectl run nginx --image=nginx -n test-detection
kubectl wait --for=condition=Ready pod/nginx -n test-detection --timeout=60s
```

Verify the sensor observes the new container:

```bash
kubectl logs -n falcon-system -l app.kubernetes.io/name=falcon-sensor --tail=10
```

### 9. Cleanup

Remove Falcon components:

```bash
helm uninstall falcon-platform -n falcon-platform
kubectl delete namespace falcon-platform falcon-system falcon-kac falcon-image-analyzer
```

Delete the test workload:

```bash
kubectl delete namespace test-detection
```

Delete the Artifact Registry repo:

```bash
gcloud artifacts repositories delete falcon-images \
  --project=$GCP_PROJECT_ID \
  --location=$GCP_REGION \
  --quiet
```

Delete the GKE cluster:

```bash
gcloud container clusters delete $CLUSTER_NAME \
  --project=$GCP_PROJECT_ID \
  --region=$GCP_REGION \
  --quiet
```

</div>

## GAR vs ECR — Key Difference

|                          | ECR                                             | GAR                                            |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------- |
| Image path               | `account.dkr.ecr.region.amazonaws.com/repo:tag` | `region-docker.pkg.dev/project/repo/image:tag` |
| Repo = image?            | Yes — repo name IS the image                    | No — repo contains multiple images             |
| `--copy-omit-image-name` | Works                                           | Do NOT use                                     |
| `*_REGISTRY` var         | `account.dkr.ecr.region.amazonaws.com/repo`     | `region-docker.pkg.dev/project/repo/image`     |
