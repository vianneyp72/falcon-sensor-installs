# Falcon Deployment - GKE Autopilot (DaemonSet)

Deploy CrowdStrike Falcon Platform on GKE **Autopilot** using the DaemonSet approach with images stored in Google Artifact Registry.

GKE Autopilot restricts privileged containers by default. CrowdStrike publishes `WorkloadAllowlists` that authorize the Falcon sensor DaemonSet to run with the required privileges. You must apply an `AllowlistSynchronizer` **before** deploying the sensor.

## Components Deployed

- **Falcon Sensor** (DaemonSet) - Runs on all nodes in `bpf` backend mode
- **Falcon KAC** (Deployment) - Kubernetes Admission Controller
- **Falcon Image Analyzer** (Deployment) - Container image scanning

## Prerequisites

- GKE **Autopilot** cluster
- CrowdStrike Falcon API credentials (CID, Client ID + Secret)
  - Required API scopes: **Falcon Images Download** (Read), **Sensor Download** (Read), **Falcon Container Image** (Read/Write)
- Helm 3 installed
- kubectl configured for the cluster
- `gcloud auth configure-docker <YOUR_GCP_REGION>-docker.pkg.dev` (Artifact Registry auth)

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials

```bash
export FALCON_CID=<YOUR_FALCON_CID>
export FCS_SENSOR_API_CLIENT_ID=<YOUR_CLIENT_ID>
export FCS_SENSOR_API_CLIENT_SECRET=<YOUR_CLIENT_SECRET>
export CLUSTER_NAME=<YOUR_CLUSTER_NAME>
```

### 2. Apply the AllowlistSynchronizer

```bash
kubectl apply -f allowlist-synchronizer.yaml
```

Wait for WorkloadAllowlists to appear (required before deploying sensor):

```bash
kubectl get workloadallowlists
```

### 3. Pull KAC and IAR images to Artifact Registry

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FCS_SENSOR_API_CLIENT_ID \
  --client-secret $FCS_SENSOR_API_CLIENT_SECRET \
  --type falcon-kac \
  --copy <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-kac-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FCS_SENSOR_API_CLIENT_ID \
  --client-secret $FCS_SENSOR_API_CLIENT_SECRET \
  --type falcon-imageanalyzer \
  --copy <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-iar-latest"
```

### 4. Set image environment variables

```bash
export FALCON_IMAGE_PULL_TOKEN=<your-base64-encoded-crowdstrike-pull-token>
export KAC_REGISTRY=<YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO>/falcon-kac
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=<YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO>/falcon-imageanalyzer
export IAR_IMAGE_TAG=falcon-iar-latest
```

### 5. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 6. Deploy the Helm chart

> **Note:** The sensor image must pull from `registry.crowdstrike.com` on Autopilot (WorkloadAllowlist regex requires it).

```bash
helm upgrade --install falcon-platform crowdstrike/falcon-platform --version 1.0.0 \
  --namespace falcon-platform \
  --create-namespace \
  --set createComponentNamespaces=true \
  --set global.falcon.cid=$FALCON_CID \
  --set global.containerRegistry.configJSON=$FALCON_IMAGE_PULL_TOKEN \
  --set falcon-sensor.node.image.repository=registry.crowdstrike.com/falcon-sensor/release/falcon-sensor \
  --set falcon-sensor.node.image.tag=<FALCON_SENSOR_VERSION> \
  --set falcon-sensor.node.backend=bpf \
  --set falcon-sensor.node.gke.autopilot=true \
  --set falcon-sensor.node.gke.deployAllowListVersion=v1.0.5 \
  --set falcon-sensor.node.gke.cleanupAllowListVersion=v1.0.3 \
  --set falcon-kac.image.repository=$KAC_REGISTRY \
  --set falcon-kac.image.tag=$KAC_IMAGE_TAG \
  --set falcon-image-analyzer.deployment.enabled=true \
  --set falcon-image-analyzer.image.repository=$IAR_REGISTRY \
  --set falcon-image-analyzer.image.tag=$IAR_IMAGE_TAG \
  --set falcon-image-analyzer.crowdstrikeConfig.clusterName=$CLUSTER_NAME \
  --set falcon-image-analyzer.crowdstrikeConfig.clientID=$FCS_SENSOR_API_CLIENT_ID \
  --set falcon-image-analyzer.crowdstrikeConfig.clientSecret=$FCS_SENSOR_API_CLIENT_SECRET
```

### 7. Verify

```bash
kubectl get pods -A | grep falcon
```

</div>

<div data-mode="lab">

### 1. Create GKE Autopilot Cluster

```bash
export GCP_PROJECT_ID=<YOUR_GCP_PROJECT_ID>
export GCP_REGION=<YOUR_GCP_REGION>
export CLUSTER_NAME=falcon-autopilot-lab

gcloud container clusters create-auto $CLUSTER_NAME \
  --project=$GCP_PROJECT_ID \
  --region=$GCP_REGION \
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

### 2. Apply the AllowlistSynchronizer (REQUIRED for Autopilot)

This tells GKE to fetch CrowdStrike's WorkloadAllowlists, which authorize the privileged DaemonSet pods.

```bash
kubectl apply -f allowlist-synchronizer.yaml
```

Verify it's running:

```bash
kubectl get allowlistsynchronizers
```

Wait for it to fetch the WorkloadAllowlists (may take 1-2 minutes):

```bash
kubectl get workloadallowlists
```

Expected output:

```
NAME                                                  AGE
crowdstrike-falconsensor-cleanup-allowlist-v1.0.0     1m
crowdstrike-falconsensor-deploy-allowlist-v1.0.0      1m
crowdstrike-falconsensor-falconctl-allowlist-v1.0.0   1m
```

> **Do NOT proceed until WorkloadAllowlists appear.** Without them, GKE Warden will reject the DaemonSet pods with `denied by autogke-disallow-privilege` errors.

### 3. Pull Falcon sensor images to Artifact Registry

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FCS_SENSOR_API_CLIENT_ID \
  --client-secret $FCS_SENSOR_API_CLIENT_SECRET \
  --type falcon-sensor \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-daemonset-sensor-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FCS_SENSOR_API_CLIENT_ID \
  --client-secret $FCS_SENSOR_API_CLIENT_SECRET \
  --type falcon-kac \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-kac-latest"
```

```bash
./falcon-container-sensor-pull.sh \
  --client-id $FCS_SENSOR_API_CLIENT_ID \
  --client-secret $FCS_SENSOR_API_CLIENT_SECRET \
  --type falcon-imageanalyzer \
  --copy $GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO> \
  --copy-custom-tag "falcon-iar-latest"
```

### 4. Set environment variables

```bash
export FALCON_CID=<YOUR_FALCON_CID>

export DAEMONSET_SENSOR_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO>/falcon-sensor
export DAEMONSET_SENSOR_IMAGE_TAG=falcon-daemonset-sensor-latest
export KAC_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO>/falcon-kac
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/<YOUR_GAR_REPO>/falcon-imageanalyzer
export IAR_IMAGE_TAG=falcon-iar-latest
```

### 5. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 6. Deploy the Helm chart (with Autopilot settings)

```bash
helm upgrade --install falcon-platform crowdstrike/falcon-platform --version 1.0.0 \
  --namespace falcon-platform \
  --create-namespace \
  --set createComponentNamespaces=true \
  --set global.falcon.cid=$FALCON_CID \
  --set global.containerRegistry.configJSON=$FALCON_IMAGE_PULL_TOKEN \
  --set falcon-sensor.node.image.repository=registry.crowdstrike.com/falcon-sensor/release/falcon-sensor \
  --set falcon-sensor.node.image.tag=<FALCON_SENSOR_VERSION> \
  --set falcon-sensor.node.backend=bpf \
  --set falcon-sensor.node.gke.autopilot=true \
  --set falcon-sensor.node.gke.deployAllowListVersion=v1.0.5 \
  --set falcon-sensor.node.gke.cleanupAllowListVersion=v1.0.3 \
  --set falcon-kac.image.repository=$KAC_REGISTRY \
  --set falcon-kac.image.tag=$KAC_IMAGE_TAG \
  --set falcon-image-analyzer.deployment.enabled=true \
  --set falcon-image-analyzer.image.repository=$IAR_REGISTRY \
  --set falcon-image-analyzer.image.tag=$IAR_IMAGE_TAG \
  --set falcon-image-analyzer.crowdstrikeConfig.clusterName=$CLUSTER_NAME \
  --set falcon-image-analyzer.crowdstrikeConfig.clientID=$FCS_SENSOR_API_CLIENT_ID \
  --set falcon-image-analyzer.crowdstrikeConfig.clientSecret=$FCS_SENSOR_API_CLIENT_SECRET
```

> **Important:** The sensor image **must** be pulled directly from `registry.crowdstrike.com` (not a private registry like GAR/ECR). The WorkloadAllowlist contains a regex that only matches CrowdStrike's registry URLs — images from GAR/ECR will be rejected with `denied by autogke-disallow-privilege` because the allowlist won't vouch for images outside CrowdStrike's control. This restriction only applies to GKE Autopilot; GKE Standard allows pulling from anywhere. Use `$FALCON_IMAGE_PULL_TOKEN` for auth to CrowdStrike's registry.

#### Key Autopilot-specific settings

| Setting                                | Why                                                          |
| -------------------------------------- | ------------------------------------------------------------ |
| `node.backend=bpf`                     | Required - Autopilot doesn't allow kernel module loading     |
| `node.gke.autopilot=true`              | Configures the DaemonSet for Autopilot constraints           |
| `node.gke.deployAllowListVersion`      | Must match a WorkloadAllowlist version (`kubectl get workloadallowlists`) |
| `node.gke.cleanupAllowListVersion`     | Must match a cleanup WorkloadAllowlist version               |
| `image.repository=registry.crowdstrike.com/...` | Must pull from CrowdStrike registry (allowlist regex validates this) |
| `containerRegistry.configJSON`         | Auth token for pulling from CrowdStrike registry             |

> **Finding the correct allowlist versions:** Run `kubectl get workloadallowlists` and use the highest version numbers for `deploy` and `cleanup`. If deploy fails with args mismatch, step down one version (e.g. `v1.0.6` → `v1.0.5`).

### 7. Verify deployment

```bash
kubectl get pods -A | grep -E "falcon-system|falcon-kac|falcon-image-analyzer"
```

Check the DaemonSet specifically:

```bash
kubectl get daemonset -n falcon-system
kubectl get pods -n falcon-system
```

### 8. Verify sensor connectivity

```bash
kubectl logs -n falcon-system -l app=falcon-sensor --tail=50
```

### 9. Test with a workload

Deploy a sample workload to confirm the sensor is observing it:

```bash
kubectl create namespace test-workload
kubectl run nginx --image=nginx -n test-workload
kubectl wait --for=condition=Ready pod/nginx -n test-workload --timeout=120s
```

Verify the sensor sees the workload container:

```bash
kubectl logs -n falcon-system -l app=falcon-sensor --tail=20 | grep -i "container"
```

### 10. Cleanup

Remove Falcon components:

```bash
helm uninstall falcon-platform -n falcon-platform
kubectl delete namespace falcon-platform falcon-system falcon-kac falcon-image-analyzer
kubectl delete -f allowlist-synchronizer.yaml
```

Delete the test workload:

```bash
kubectl delete namespace test-workload
```

Delete the GKE Autopilot cluster:

```bash
gcloud container clusters delete $CLUSTER_NAME \
  --project=$GCP_PROJECT_ID \
  --region=$GCP_REGION \
  --quiet
```

</div>

## Troubleshooting

### Error: `denied by autogke-disallow-privilege`

The AllowlistSynchronizer hasn't fetched WorkloadAllowlists yet, or you skipped Step 1.

```bash
kubectl get workloadallowlists
```

If empty, wait a few minutes. If the synchronizer doesn't exist, apply it first.

### Error: `denied by autogke-disallow-hostnamespaces`

Same root cause as above. The WorkloadAllowlists authorize hostPID/hostNetwork/hostIPC for the CrowdStrike sensor specifically.

### Sensor pods in CrashLoopBackOff

Resources may be too low for your workload:

```bash
kubectl top pod -n falcon-system
```

Increase requests (max Autopilot allows varies by machine series):

```bash
--set "falcon-sensor.node.resources.requests.cpu=1000m" \
--set "falcon-sensor.node.resources.requests.memory=2Gi"
```

### Image pull errors

Verify the image exists in GAR:

```bash
gcloud artifacts docker images list <YOUR_GCP_REGION>-docker.pkg.dev/<YOUR_GCP_PROJECT_ID>/<YOUR_GAR_REPO> --include-tags
```

### DaemonSet still showing old image after upgrade

```bash
# Check what the DaemonSet spec actually has
kubectl get daemonset -n falcon-system -o jsonpath='{.items[*].spec.template.spec.containers[*].image}'

# Force restart
kubectl rollout restart daemonset -n falcon-system
```

## GKE Autopilot vs Standard — Key Differences

|                       | GKE Standard       | GKE Autopilot               |
| --------------------- | ------------------ | --------------------------- |
| AllowlistSynchronizer | Not needed         | **Required**                |
| `node.backend`        | `kernel` (default) | Must be `bpf`               |
| `node.gke.autopilot`  | `false`            | Must be `true`              |
| Resource requests     | Optional           | Required (min 250m/500Mi)   |
| Tolerations           | Optional           | Required for amd64          |
| Privileged containers | Allowed by default | Only with WorkloadAllowlist |

## Reference

- [CrowdStrike Docs: GKE Platform-specific config](https://docs.crowdstrike.com/r/en-US/qg0ygdwl/f344b152/me302ce8/ef3a99a0/vaed8b6d/oa491d1f)
- [Google Docs: AllowlistSynchronizer](https://cloud.google.com/kubernetes-engine/docs/reference/crds/allowlistsynchronizer)
- [Falcon Platform Helm Chart](https://github.com/CrowdStrike/falcon-helm/tree/main/helm-charts/falcon-platform)
