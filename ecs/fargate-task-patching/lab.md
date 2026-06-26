# Falcon Container Sensor Deployment — ECS Fargate (Task Definition Patching)

Deploy the CrowdStrike Falcon Container Sensor for Linux on AWS ECS Fargate using the task definition patching utility.

Official Docs: https://docs.crowdstrike.com/r/en-US/iopiipqy/ba83eb6c

Official GH: https://github.com/CrowdStrike/falcon-scripts/tree/main/bash/containers/falcon-container-sensor-pull

Igor GH: https://github.com/igorschultz/container-sensor-ecs-fargate/tree/main

## How It Works

The patching utility modifies your ECS task definition to inject the Falcon sensor:

- **Init container** (`crowdstrike-falcon-init-container`) copies sensor binaries to a shared volume
- **Entrypoint override** on each app container starts the Falcon sensor before the app
- **Shared volume** (`crowdstrike-falcon-volume`) mounted at `/tmp/CrowdStrike`
- **`SYS_PTRACE`** capability added to monitored containers

## Image Architecture

There are **two images** involved in ECS task definition patching:

| Image                   | What it is                             | Role in patched task                                                         |
| ----------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| **Falcon sensor image** | CrowdStrike's `falcon-container` image | Becomes the `crowdstrike-falcon-init-container` that injects sensor binaries |
| **App image**           | Your application container             | The container being protected by the sensor                                  |

These images can live in **different registries**. The recommended setup for most customers:

| Component    | Where to store                                             | ECS runtime auth                                    |
| ------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| Sensor image | ECR (same AWS account)                                     | Automatic via task execution role IAM — zero config |
| App image    | Customer's existing repo (JFrog, Quay, Harbor, GHCR, etc.) | `repositoryCredentials` → Secrets Manager           |

> **Why this works well:** Most customers already have their app images in a private registry outside ECR. Putting the sensor image in ECR (same account) means ECS pulls it automatically with no extra auth. The app image stays where it already is.

> **Important:** At **patch time**, the patching utility needs access to BOTH registries — it reads the sensor image and queries your app image for its entrypoint/command metadata. The `-pulltoken` must contain credentials for all registries referenced in the task definition.

## Prerequisites

- AWS CLI configured with ECS permissions
- Docker installed locally (to run the patching utility)
- CrowdStrike Falcon API credentials (CID, Client ID + Secret)
  - Required API scopes: **Falcon Images Download** (Read), **Sensor Download** (Read)
- Existing ECS Fargate task definition JSON file
- A container registry for hosting the sensor image (ECR recommended, or any OCI-compliant registry)
- **ECS task execution role** with permissions to pull images at runtime (see below)

### ECS Task Execution Role

Your ECS task definition must reference an execution role that allows ECS to pull container images on your behalf. If you already have tasks pulling from ECR, this is likely already set up.

**Minimum permissions for ECR (sensor image):**

Attach the AWS managed policy `AmazonECSTaskExecutionRolePolicy`, or add these permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "ecr:GetAuthorizationToken",
    "ecr:BatchCheckLayerAvailability",
    "ecr:GetDownloadUrlForLayer",
    "ecr:BatchGetImage"
  ],
  "Resource": "*"
}
```

**Additional permissions if app images are in a private registry (JFrog, Quay, etc.):**

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:<your-registry-creds-secret>"
}
```

**Verify the role is referenced in your task definition:**

```json
{
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  ...
}
```

> **Note:** If your task definition doesn't have `executionRoleArn`, ECS won't be able to pull from ECR or access Secrets Manager. This is the most common cause of "CannotPullContainerError" at task launch.

```bash
export FALCON_CLIENT_ID="<YOUR_FALCON_CLIENT_ID>"
export FALCON_CLIENT_SECRET="<YOUR_FALCON_CLIENT_SECRET>"
export AWS_REGION=<your_aws_region>
export FALCON_CID=<your_cid_with_checksum>
export TASK_FAMILY=<your_task_family_name>
```

## Deployment Steps

<div data-mode="guide">

### 1. Pull the Falcon Container sensor image

```bash
export LATESTSENSOR=$(bash <(curl -Ls https://github.com/CrowdStrike/falcon-scripts/releases/latest/download/falcon-container-sensor-pull.sh) \
  -t falcon-container \
  --platform x86_64 | tail -1) && echo $LATESTSENSOR
```

### 2. Push the sensor image to ECR

```bash
aws ecr create-repository \
  --repository-name falcon-sensor/falcon-container \
  --region $AWS_REGION

export SENSOR_IMAGE_REPO=$(aws ecr describe-repositories \
  --repository-name falcon-sensor/falcon-container | \
  jq -r '.repositories[].repositoryUri' | tail -1) && echo $SENSOR_IMAGE_REPO

docker tag "$LATESTSENSOR" "$SENSOR_IMAGE_REPO":latest
docker push "$SENSOR_IMAGE_REPO":latest
```

### 3. Create a pull token

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REGISTRY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

export IMAGE_PULL_TOKEN=$(echo "{\"auths\":{\"$ECR_REGISTRY\":{\"auth\":\"$(echo -n AWS:$(aws ecr get-login-password --region $AWS_REGION) | base64)\"}}}" | base64)
```

### 4. Export your existing task definition

```bash
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $AWS_REGION \
  --query 'taskDefinition' | \
  jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .tags)' \
  > taskdefinition.json
```

### 5. Patch the task definition with the Falcon sensor

```bash
docker run -v $(pwd):/var/run/spec \
  --rm "$SENSOR_IMAGE_REPO" \
  -cid $FALCON_CID \
  -image "$SENSOR_IMAGE_REPO" \
  -pulltoken $IMAGE_PULL_TOKEN \
  -ecs-spec-file /var/run/spec/taskdefinition.json > taskdefinitionwithfalcon.json
```

### 6. Register and deploy the patched task definition

```bash
aws ecs register-task-definition \
  --region $AWS_REGION \
  --cli-input-json file://taskdefinitionwithfalcon.json

aws ecs update-service \
  --region $AWS_REGION \
  --cluster <CLUSTER_NAME> \
  --service <SERVICE_NAME> \
  --task-definition $TASK_FAMILY \
  --force-new-deployment
```

### 7. Verify

```bash
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $AWS_REGION \
  --query 'taskDefinition.containerDefinitions[].name'
```

Expected output includes both your app container and `crowdstrike-falcon-init-container`.

</div>

<div data-mode="lab">

### 1. Provision ECS Infrastructure

> **What this does:** Creates an ECS Fargate cluster, a sample app task definition, and an ECS service so you have a working environment to patch with the Falcon sensor.

**Create an ECS cluster:**

```bash
aws ecs create-cluster \
  --cluster-name falcon-lab-cluster \
  --region $AWS_REGION
```

**Create the task execution role (if it doesn't exist):**

```bash
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

**Create a sample app task definition:**

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cat > sample-task-def.json <<'EOF'
{
  "family": "falcon-lab-app",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::ACCOUNT_ID:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "nginx",
      "image": "public.ecr.aws/nginx/nginx:latest",
      "portMappings": [{"containerPort": 80, "protocol": "tcp"}],
      "essential": true
    }
  ]
}
EOF

sed -i "s/ACCOUNT_ID/$AWS_ACCOUNT_ID/" sample-task-def.json

aws ecs register-task-definition \
  --region $AWS_REGION \
  --cli-input-json file://sample-task-def.json
```

**Get a subnet and security group for the service:**

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)

export SUBNET_ID=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=default-for-az,Values=true" \
  --query 'Subnets[0].SubnetId' --output text --region $AWS_REGION)

export SG_ID=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
  --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)
```

**Create the ECS service:**

```bash
export TASK_FAMILY=falcon-lab-app

aws ecs create-service \
  --cluster falcon-lab-cluster \
  --service-name falcon-lab-service \
  --task-definition $TASK_FAMILY \
  --desired-count 1 \
  --launch-type FARGATE \
  --enable-execute-command \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_ID],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
  --region $AWS_REGION
```

**Wait for the task to reach RUNNING:**

```bash
aws ecs wait services-stable \
  --cluster falcon-lab-cluster \
  --services falcon-lab-service \
  --region $AWS_REGION
```

### 2. Get your CrowdStrike CID with checksum

In the Falcon console: **Host setup and management > Deploy > Sensor downloads**. Copy the CID with checksum (already exported above as `$FALCON_CID`).

### 3. Pull the Falcon Container sensor image

```bash
export LATESTSENSOR=$(bash <(curl -Ls https://github.com/CrowdStrike/falcon-scripts/releases/latest/download/falcon-container-sensor-pull.sh) \
  -t falcon-container \
  --platform x86_64 | tail -1) && echo $LATESTSENSOR
```

### 4. Push the sensor image to ECR

```bash
aws ecr create-repository \
  --repository-name falcon-sensor/falcon-container \
  --region $AWS_REGION

export SENSOR_IMAGE_REPO=$(aws ecr describe-repositories \
  --repository-name falcon-sensor/falcon-container | \
  jq -r '.repositories[].repositoryUri' | tail -1) && echo $SENSOR_IMAGE_REPO

docker tag "$LATESTSENSOR" "$SENSOR_IMAGE_REPO":latest
docker push "$SENSOR_IMAGE_REPO":latest
```

### 5. Create a pull token for registry authentication

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REGISTRY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

export IMAGE_PULL_TOKEN=$(echo "{\"auths\":{\"$ECR_REGISTRY\":{\"auth\":\"$(echo -n AWS:$(aws ecr get-login-password --region $AWS_REGION) | base64)\"}}}" | base64)
```

### 6. Export your task definition (remove managed fields)

```bash
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $AWS_REGION \
  --query 'taskDefinition' | \
  jq 'del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .tags)' \
  > taskdefinition.json
```

### 7. Run the patching utility

```bash
docker run -v $(pwd):/var/run/spec \
  --rm "$SENSOR_IMAGE_REPO" \
  -cid $FALCON_CID \
  -image "$SENSOR_IMAGE_REPO" \
  -pulltoken $IMAGE_PULL_TOKEN \
  -ecs-spec-file /var/run/spec/taskdefinition.json > taskdefinitionwithfalcon.json
```

### 8. Register and deploy the patched task definition

```bash
aws ecs register-task-definition \
  --region $AWS_REGION \
  --cli-input-json file://taskdefinitionwithfalcon.json

aws ecs update-service \
  --region $AWS_REGION \
  --cluster falcon-lab-cluster \
  --service falcon-lab-service \
  --task-definition $TASK_FAMILY \
  --force-new-deployment
```

**Wait for the new deployment to stabilize:**

```bash
aws ecs wait services-stable \
  --cluster falcon-lab-cluster \
  --services falcon-lab-service \
  --region $AWS_REGION
```

### 9. Verify the sensor deployment

**Get the running task ARN:**

```bash
export TASK_ARN=$(aws ecs list-tasks \
  --cluster falcon-lab-cluster \
  --service-name falcon-lab-service \
  --query 'taskArns[0]' --output text \
  --region $AWS_REGION) && echo $TASK_ARN
```

**Exec into the container and check the AID:**

```bash
aws ecs execute-command \
  --region $AWS_REGION \
  --cluster falcon-lab-cluster \
  --task $TASK_ARN \
  --container nginx \
  --interactive \
  --command "/tmp/CrowdStrike/rootfs/bin/falconctl -g --aid"
```

A valid AID (32-character hex string) confirms the sensor is connected to the CrowdStrike cloud.

**Verify in the Falcon Console:**

1. Go to **Host setup and management > Manage endpoints > Host management**
2. Add a **Pod ID** filter
3. Set the value to your **ECS Task ID** (extract from the task ARN)
4. Verify the Host ID field has a value

**Verify the patched task definition structure:**

```bash
aws ecs describe-task-definition \
  --task-definition $TASK_FAMILY \
  --region $AWS_REGION \
  --query 'taskDefinition.containerDefinitions[].name'
```

Expected output should include both `nginx` and `crowdstrike-falcon-init-container`.

### 10. Cleanup

```bash
# Delete the ECS service
aws ecs update-service \
  --cluster falcon-lab-cluster \
  --service falcon-lab-service \
  --desired-count 0 \
  --region $AWS_REGION

aws ecs delete-service \
  --cluster falcon-lab-cluster \
  --service falcon-lab-service \
  --force \
  --region $AWS_REGION

# Delete the ECS cluster
aws ecs delete-cluster \
  --cluster falcon-lab-cluster \
  --region $AWS_REGION

# Delete the ECR repository
aws ecr delete-repository \
  --repository-name falcon-sensor/falcon-container \
  --force \
  --region $AWS_REGION

# Clean up local files
rm -f taskdefinition.json taskdefinitionwithfalcon.json sample-task-def.json
```

</div>

## What the Patched Task Definition Looks Like

Per-container changes applied by the patching utility:

```json
{
  "dependsOn": [
    {
      "condition": "COMPLETE",
      "containerName": "crowdstrike-falcon-init-container"
    }
  ],
  "entryPoint": [
    "/tmp/CrowdStrike/rootfs/lib64/ld-linux-x86-64.so.2",
    "--library-path",
    "/tmp/CrowdStrike/rootfs/lib64",
    "/tmp/CrowdStrike/rootfs/bin/bash",
    "/tmp/CrowdStrike/rootfs/entrypoint-ecs.sh",
    "// ORIGINAL CONTAINER ENTRYPOINT"
  ],
  "environment": [
    { "name": "FALCONCTL_OPTS", "value": "--cid=CID_WITH_CHECKSUM" }
  ],
  "linuxParameters": { "capabilities": { "add": ["SYS_PTRACE"] } },
  "mountPoints": [
    {
      "containerPath": "/tmp/CrowdStrike",
      "readOnly": true,
      "sourceVolume": "crowdstrike-falcon-volume"
    }
  ]
}
```

## ECS Runtime Auth for Mixed Registries

When your sensor image and app image are in different registries, ECS handles authentication differently for each:

**Sensor image in ECR (same account):** No extra config — the task execution role pulls it automatically via IAM. Just ensure the role has `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage`, and `ecr:GetAuthorizationToken`.

**App image in a private registry (JFrog, Quay, Harbor, etc.):** Add `repositoryCredentials` to the app container definition in your task definition **before** running the patching utility:

```json
{
  "name": "my-app",
  "image": "mycompany.jfrog.io/docker-local/my-app:v1.2.3",
  "repositoryCredentials": {
    "credentialsParameter": "arn:aws:secretsmanager:<region>:<account-id>:secret:jfrog-registry-creds"
  }
}
```

The Secrets Manager secret should contain:

```json
{
  "username": "<registry-username>",
  "password": "<registry-password-or-api-token>"
}
```

The task execution role also needs `secretsmanager:GetSecretValue` permission for this secret.

> **Note:** If your task definition already has `repositoryCredentials` (i.e., you're already pulling app images from a private registry today), the patching utility preserves it. Nothing extra to configure on the ECS side.

## Notes

- The `--copy` flag on the pull script supports Docker, Podman, and Skopeo runtimes. Skopeo is recommended for multi-arch images.
- The `-pulltoken` is for **patch time** only (so the utility can read image metadata). ECS runtime auth is handled separately via IAM (ECR) or `repositoryCredentials` (other registries).
- If your app containers are in a private registry that requires auth, the patching utility needs access to those registries to read the entrypoint/command metadata. The `-pulltoken` covers this.

## Gotchas

- **`parameter validation failed`:** You forgot to strip managed fields from the task definition before patching. See step 5.
- **Docker Desktop credential helper (`"credsStore": "desktop"`):** On macOS/Docker Desktop, `~/.docker/config.json` doesn't contain actual credentials — it delegates to the macOS Keychain. `cat ~/.docker/config.json | base64` gives the patching utility an empty/useless token. Symptom: `Failed to retrieve image details` with "credentials tried: 2". Fix: use the explicit `echo "{\"auths\":...}" | base64` method in step 4 to construct a self-contained token.
- **ECR token expiry:** ECR pull tokens expire after 12 hours. If your CI/CD pipeline takes longer or you deploy later, regenerate the token.
- **macOS `base64` difference:** On macOS, use `base64` without `-w 0` (macOS base64 doesn't wrap by default). On Linux, `-w 0` prevents line wrapping.
- **Pull token must cover ALL registries:** If the patching utility fails reading an image, it's usually because the pull token doesn't have creds for that image's registry. The token is a Docker config JSON — it can have auth entries for multiple registries.
- **App image entrypoint extraction:** The patching utility needs to query your app image to get its entrypoint. If your app image is in JFrog/Quay/etc. and the pull token is ECR-only, patching will fail. Use Option B in step 4 to cover both.
- **`repositoryCredentials` vs `-pulltoken`:** These serve different purposes. `-pulltoken` is for the patching utility at build/patch time. `repositoryCredentials` is for ECS at task launch time. You need both if your app images are in a non-ECR registry.
