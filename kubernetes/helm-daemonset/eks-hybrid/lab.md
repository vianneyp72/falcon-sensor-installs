# Falcon Deployment - Method 2: DaemonSet Hybrid

Deploy CrowdStrike Falcon with DaemonSet on EC2 + Sidecar Injector for Fargate pods.

## Components Deployed

- **Falcon Sensor** (DaemonSet) - Runs on EC2 nodes only (Fargate ignores DaemonSets)
- **Falcon Sidecar Injector** (Deployment) - Mutating webhook that injects Falcon sensor into Fargate pods
- **Falcon KAC** (Deployment) - Kubernetes Admission Controller
- **Falcon Image Analyzer** (Deployment) - Container image scanning

## How It Works

- **EC2 nodes**: DaemonSet sensor runs on every EC2 node automatically. Fargate doesn't support DaemonSets so they are skipped.
- **Fargate pods**: The sidecar injector webhook intercepts pod creation and injects the Falcon sensor container as a sidecar.
- **KAC/IAR**: Stateless deployments, land on EC2 or Fargate depending on Fargate profile configuration.

## Prerequisites

- EKS cluster running in `compute_mode = "hybrid"`
- Both EC2 nodes AND Fargate profiles active
- Falcon credentials (CID, API keys)
- Helm 3 and kubectl configured
- Terraform applied with `enable_falcon_injector = true` (creates IRSA role for ECR access)

## Verify Fargate Profiles

Ensure `falcon-lumos-injector` namespace is covered by a Fargate profile. The IRSA trust policy is scoped to `system:serviceaccount:falcon-lumos-injector:crowdstrike-falcon-sa`, so the injector **must** be deployed in `falcon-lumos-injector` namespace.

```bash
terraform output fargate_profiles
```

> **Note:** `createComponentNamespaces=true` spreads KAC/IAR into separate namespaces (`falcon-kac`, `falcon-image-analyzer`). These won't have Fargate profiles unless you add them in `terraform.tfvars`, so they will land on EC2.

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials

```bash
export FALCON_CID=<YOUR_FALCON_CID>
export FCS_SENSOR_API_CLIENT_ID=<YOUR_CLIENT_ID>
export FCS_SENSOR_API_CLIENT_SECRET=<YOUR_CLIENT_SECRET>
```

### 2. Set image environment variables

```bash
export DAEMONSET_SENSOR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export DAEMONSET_SENSOR_IMAGE_TAG=falcon-daemonset-sensor-latest
export LUMOS_SENSOR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export LUMOS_SENSOR_IMAGE_TAG=falcon-lumos-sensor-latest
export KAC_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export IAR_IMAGE_TAG=falcon-iar-latest
export CLUSTER_NAME=<YOUR_CLUSTER_NAME>
export IAM_ROLE_ARN=<YOUR_FALCON_INJECTOR_ROLE_ARN>
export ENCODED_DOCKER_CONFIG=<your-base64-encoded-docker-config>
```

### 3. Add Falcon Helm repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 4. Deploy the DaemonSet sensor with KAC and IAR

```bash
helm upgrade --install falcon-platform crowdstrike/falcon-platform \
  --namespace falcon-platform \
  --create-namespace \
  --set createComponentNamespaces=true \
  --set global.falcon.cid=$FALCON_CID \
  --set global.containerRegistry.configJSON=$ENCODED_DOCKER_CONFIG \
  --set falcon-sensor.node.image.repository=$DAEMONSET_SENSOR_REGISTRY \
  --set falcon-sensor.node.image.tag=$DAEMONSET_SENSOR_IMAGE_TAG \
  --set falcon-kac.image.repository=$KAC_REGISTRY \
  --set falcon-kac.image.tag=$KAC_IMAGE_TAG \
  --set falcon-image-analyzer.deployment.enabled=true \
  --set falcon-image-analyzer.image.repository=$IAR_REGISTRY \
  --set falcon-image-analyzer.image.tag=$IAR_IMAGE_TAG \
  --set falcon-image-analyzer.crowdstrikeConfig.clusterName=$CLUSTER_NAME \
  --set falcon-image-analyzer.crowdstrikeConfig.clientID=$FCS_SENSOR_API_CLIENT_ID \
  --set falcon-image-analyzer.crowdstrikeConfig.clientSecret=$FCS_SENSOR_API_CLIENT_SECRET
```

### 5. Deploy the sidecar injector (Fargate pods)

```bash
helm upgrade --install falcon-lumos-injector crowdstrike/falcon-sensor \
  --namespace falcon-lumos-injector \
  --set falcon.cid=$FALCON_CID \
  --set falcon.tags="eks-fargate" \
  --set node.enabled=false \
  --set container.enabled=true \
  --set container.image.repository=$LUMOS_SENSOR_REGISTRY \
  --set container.image.tag=$LUMOS_SENSOR_IMAGE_TAG \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$IAM_ROLE_ARN
```

### 6. Verify

```bash
kubectl get pods -A | grep falcon
```

</div>

<div data-mode="lab">

### 1. Provision EKS Hybrid Cluster

Create a hybrid EKS cluster with both EC2 managed node groups and Fargate profiles:

```bash
export CLUSTER_NAME=falcon-hybrid-lab
export AWS_REGION=us-east-1

cat <<'EOF' > eksctl-hybrid.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: falcon-hybrid-lab
  region: us-east-1

managedNodeGroups:
  - name: ec2-nodes
    instanceType: m5.large
    desiredCapacity: 2
    minSize: 1
    maxSize: 3

fargateProfiles:
  - name: falcon-injector
    selectors:
      - namespace: falcon-lumos-injector
  - name: app-workloads
    selectors:
      - namespace: detection-vulnapp
EOF

eksctl create cluster -f eksctl-hybrid.yaml
```

Verify cluster is ready:

```bash
kubectl get nodes
eksctl get fargateprofile --cluster $CLUSTER_NAME
```

### 2. Set environment variables:

```bash
export FALCON_CID=<YOUR_FALCON_CID>
export DAEMONSET_SENSOR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export DAEMONSET_SENSOR_IMAGE_TAG=falcon-daemonset-sensor-latest
export LUMOS_SENSOR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export LUMOS_SENSOR_IMAGE_TAG=falcon-lumos-sensor-latest
export KAC_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export KAC_IMAGE_TAG=falcon-kac-latest
export IAR_REGISTRY=<YOUR_AWS_ACCOUNT_ID>.dkr.ecr.<YOUR_AWS_REGION>.amazonaws.com/<YOUR_ECR_REPO>
export IAR_IMAGE_TAG=falcon-iar-latest

# Get IAM Role ARN from Terraform output
export IAM_ROLE_ARN=$(cd <PATH_TO_YOUR_TERRAFORM_PROJECT> && terraform output -raw falcon_injector_role_arn)

echo "IAM Role ARN: $IAM_ROLE_ARN"
```

Optional (if pulling image straight from CrowdStrike):

```bash
export ENCODED_DOCKER_CONFIG=<your-base64-encoded-docker-config>
```

### 3. Add Falcon Helm Repository

```bash
helm repo add crowdstrike https://crowdstrike.github.io/falcon-helm
helm repo update
```

### 4. Deploy the Daemonset sensor Helm Chart with KAC & IAR

```bash
helm upgrade --install falcon-platform crowdstrike/falcon-platform \
  --namespace falcon-platform \
  --create-namespace \
  --set createComponentNamespaces=true \
  --set global.falcon.cid=$FALCON_CID \
  --set global.containerRegistry.configJSON=$ENCODED_DOCKER_CONFIG \
  --set falcon-sensor.node.image.repository=$DAEMONSET_SENSOR_REGISTRY \
  --set falcon-sensor.node.image.tag=$DAEMONSET_SENSOR_IMAGE_TAG \
  --set falcon-kac.image.repository=$KAC_REGISTRY \
  --set falcon-kac.image.tag=$KAC_IMAGE_TAG \
  --set falcon-image-analyzer.deployment.enabled=true \
  --set falcon-image-analyzer.image.repository=$IAR_REGISTRY \
  --set falcon-image-analyzer.image.tag=$IAR_IMAGE_TAG \
  --set falcon-image-analyzer.crowdstrikeConfig.clusterName=$CLUSTER_NAME \
  --set falcon-image-analyzer.crowdstrikeConfig.clientID=$FCS_SENSOR_API_CLIENT_ID \
  --set falcon-image-analyzer.crowdstrikeConfig.clientSecret=$FCS_SENSOR_API_CLIENT_SECRET
```

### 5. Deploy the LUMOS sensor Injector Helm Chart

```bash
helm upgrade --install falcon-lumos-injector crowdstrike/falcon-sensor \
  --namespace falcon-lumos-injector \
  --set falcon.cid=$FALCON_CID \
  --set falcon.tags="eks-fargate" \
  --set node.enabled=false \
  --set container.enabled=true \
  --set container.image.repository=$LUMOS_SENSOR_REGISTRY \
  --set container.image.tag=$LUMOS_SENSOR_IMAGE_TAG \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$IAM_ROLE_ARN
```

### 6. Verify Deployment

Check all Falcon components are running:

```bash
kubectl get pods -A | grep falcon
```

Expected output:
- `falcon-system` — DaemonSet sensor pods (one per EC2 node)
- `falcon-kac` — KAC deployment pod
- `falcon-image-analyzer` — IAR deployment pod
- `falcon-lumos-injector` — Sidecar injector pods

Verify the injector service account has the IRSA role:

```bash
kubectl get sa crowdstrike-falcon-sa -n falcon-lumos-injector -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}'
```

### 7. Test Sidecar Injection

Deploy a test pod into a Fargate-profiled namespace to confirm the injector is working:

```bash
kubectl run nginx --image=nginx -n detection-vulnapp
kubectl wait --for=condition=Ready pod/nginx -n detection-vulnapp --timeout=120s
kubectl get pod nginx -n detection-vulnapp -o jsonpath='{.spec.containers[*].name}'
# Should show: nginx crowdstrike-falcon-container
```

Check the DaemonSet sensor logs on EC2 nodes:

```bash
kubectl logs -n falcon-system -l app.kubernetes.io/name=falcon-sensor --tail=20
```

Verify the injector webhook is active:

```bash
kubectl get mutatingwebhookconfigurations | grep falcon
```

### 8. Cleanup

Remove Falcon components:

```bash
helm uninstall falcon-lumos-injector -n falcon-lumos-injector
helm uninstall falcon-platform -n falcon-platform
kubectl delete namespace falcon-platform falcon-system falcon-kac falcon-image-analyzer falcon-lumos-injector
```

Delete the EKS cluster:

```bash
eksctl delete cluster --name $CLUSTER_NAME --region $AWS_REGION
```

</div>
