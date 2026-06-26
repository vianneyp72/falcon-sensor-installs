# Falcon Container Sensor Image Patching with GitHub Actions Lab

> **Prerequisites:**
> - AWS account with ECR access and permissions to create IAM roles
> - GitHub repository (public or private) with Actions enabled
> - Docker Desktop running locally
> - AWS CLI v2 configured (`aws sts get-caller-identity` works)
> - CrowdStrike API client with **Falcon Images Download: Read** and **Sensor Download: Read** scopes
> - CrowdStrike CID with checksum
> - ~105 minutes

## Reference Docs

| Source | Link |
|--------|------|
| CrowdStrike falconutil-action | https://github.com/CrowdStrike/falconutil-action |
| CrowdStrike falcon-container-sensor-pull.sh | https://github.com/CrowdStrike/falcon-scripts |
| Deploy Falcon Container Sensor Embedded in Image | Falcon docs (doc_id: `k58f1a5e`) |
| Deploy Falcon Container Sensor on ECS Fargate | Falcon docs (doc_id: `a5c297cc`) |
| AWS ECR User Guide | https://docs.aws.amazon.com/AmazonECR/latest/userguide/ |
| GitHub Actions OIDC with AWS | https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services |

---

## 1. Intro & Architecture

> **~5 min | Beginner**

Container image patching (also called "embedding") injects the CrowdStrike Falcon Container sensor directly into an application container image. At runtime, the sensor launches inside the container, monitors process activity, and sends telemetry to the CrowdStrike cloud — all without kernel access or privileged containers.

This is the go-to approach for serverless container platforms (ECS Fargate, Cloud Run, Azure Container Apps) where you can't run a DaemonSet or access the host kernel.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Actions Runner                         │
│                                                                     │
│  ┌──────────────┐    ┌─────────────────────┐    ┌───────────────┐  │
│  │ ECR Login    │───▶│ falconutil-action    │───▶│ Push patched  │  │
│  │ (OIDC role)  │    │                     │    │ image to ECR  │  │
│  └──────────────┘    │ source: :1.0        │    └───────────────┘  │
│                      │ sensor: falcon-ctr   │                       │
│                      │ target: :1.0-falcon  │                       │
│                      └─────────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │ ECR: apps/   │ │ ECR: apps/   │ │ ECR: apps/   │
        │ nginx        │ │ python-flask │ │ node-express │
        │              │ │              │ │              │
        │ :1.0         │ │ :1.0         │ │ :1.0         │
        │ :1.0-falcon  │ │ :1.0-falcon  │ │ :1.0-falcon  │
        └──────────────┘ └──────────────┘ └──────────────┘

        ┌──────────────────────────────────────────────┐
        │ ECR: falcon-sensor/falcon-container           │
        │ :latest  (pulled from CrowdStrike registry)  │
        └──────────────────────────────────────────────┘
```

**Tagging convention:** Unpatched images keep their original tag (`:1.0`). Patched images get a `-falcon` suffix (`:1.0-falcon`). Deployment manifests reference the `-falcon` tag — if it doesn't exist, the app hasn't been security-approved yet.

---

## 2. Core Concepts

> **~10 min | Intermediate**

### How `falconutil patch-image` Works

The Falcon Container sensor image ships with a utility binary called `falconutil`. When you run `falconutil patch-image`, it:

1. **Pulls** your application image (the "source")
2. **Injects** the Falcon sensor binaries and libraries into the image layers
3. **Rewrites** the container entrypoint so the sensor launches first, then hands off to your original entrypoint
4. **Outputs** a new image (the "target") with the sensor embedded

The patched image is ~30-50MB larger than the original. At runtime, the sensor process (`falcon-sensor`) runs alongside your application process inside the same container.

### Key Parameters

| Flag | Purpose |
|------|---------|
| `--source-image-uri` | The unpatched application image to read |
| `--target-image-uri` | Where to write the patched image |
| `--falcon-image-uri` | The Falcon sensor image (contains `falconutil` + sensor binaries) |
| `--cid` | Your CrowdStrike Customer ID with checksum |
| `--cloud-service` | Optional: `ECS_FARGATE`, `CLOUDRUN`, `ACA`, `ACI` |

### The `-falcon` Suffix Convention

```
                        Dev pushes           Security pipeline patches
                        ──────────           ──────────────────────────
ECR tag timeline:       :1.0                 :1.0-falcon
                        :1.1                 :1.1-falcon
                        :2.0                 :2.0-falcon

Deployment policy:      Only images with -falcon suffix may be deployed
```

This convention lets you enforce a gating policy: only `-falcon` tagged images are allowed in production (enforceable via OPA/Gatekeeper, ECS task definition validation, or deployment pipeline checks).

### GitHub Actions OIDC Authentication

Instead of storing long-lived AWS access keys as GitHub secrets, we use **OIDC federation**. GitHub's OIDC provider issues a short-lived JWT to the workflow run, which AWS STS exchanges for temporary credentials scoped to an IAM role. No secrets to rotate.

---

## Deployment Steps

<div data-mode="guide">

### 1. Add CrowdStrike Secrets to GitHub Repo

Navigate to your repo > **Settings** > **Secrets and variables** > **Actions** and add:

| Type | Name | Value |
|------|------|-------|
| Secret | `FALCON_CLIENT_SECRET` | Your CrowdStrike API client secret |
| Secret | `FALCON_CID` | Your CID with checksum |
| Variable | `FALCON_CLIENT_ID` | Your CrowdStrike API client ID |
| Variable | `FALCON_REGION` | Your CrowdStrike cloud (e.g., `us-1`) |

### 2. Add the `falconutil-action` Step to Your Workflow

Add this step to your existing CI/CD workflow (after your ECR login step):

```yaml
      - name: Patch image with Falcon sensor
        uses: crowdstrike/falconutil-action@v1.1.0
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          source_image_uri: <ECR_BASE>/<IMAGE_NAME>:<TAG>
          target_image_uri: <ECR_BASE>/<IMAGE_NAME>:<TAG>-falcon
          cid: ${{ secrets.FALCON_CID }}
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Push patched image
        run: docker push <ECR_BASE>/<IMAGE_NAME>:<TAG>-falcon
```

### 3. Push and Verify

Trigger the workflow and confirm the patched image appears in your registry with the `-falcon` suffix.

</div>

<div data-mode="lab">

## 3. Create ECR Repos & Push Sample Images

> **~15 min | Intermediate**

### Step 1: Create ECR Repositories

> **What & Why:** We need 4 ECR repos — 3 for application images and 1 for the Falcon sensor image. Keeping the sensor in your own ECR avoids rate-limiting from CrowdStrike's registry during CI/CD runs.

- [ ] **Console:** Navigate to **Amazon ECR** > **Private registry** > **Repositories** > Click **Create repository**

  Create each of these repositories (repeat 4 times):

  | Repository name | Tag immutability | Scan on push |
  |----------------|-----------------|--------------|
  | `apps/nginx` | Disabled | Enabled |
  | `apps/python-flask` | Disabled | Enabled |
  | `apps/node-express` | Disabled | Enabled |
  | `falcon-sensor/falcon-container` | Disabled | Disabled |

  For each:
  - Visibility: **Private**
  - Tag immutability: **Disabled** (we need to overwrite `:latest` for the sensor)
  - Scan on push: **Enabled** for app repos (gives you vulnerability data), **Disabled** for the sensor (CrowdStrike scans their own images)
  - Encryption: **AES-256** (default)
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
AWS_REGION=us-east-2
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

for repo in apps/nginx apps/python-flask apps/node-express falcon-sensor/falcon-container; do
  aws ecr create-repository \
    --repository-name "$repo" \
    --region $AWS_REGION \
    --image-scanning-configuration scanOnPush=true \
    --tags Key=cstag-purpose,Value="SE Tooling - Falcon Sensor Lab"
done

# Disable scan for sensor repo (CrowdStrike manages this)
aws ecr put-image-scanning-configuration \
  --repository-name falcon-sensor/falcon-container \
  --image-scanning-configuration scanOnPush=false \
  --region $AWS_REGION
```

</details>

### Step 2: Build Sample Application Images

> **What & Why:** We need realistic but minimal application images to patch. These Dockerfiles produce small, functional containers that represent what a dev team would push.

- [ ] Build and tag all 3 sample apps:

```bash
AWS_REGION=us-east-2
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ECR_BASE

# Build from the sample-apps/ directory in this lab
cd sample-apps/

# nginx
docker build -t ${ECR_BASE}/apps/nginx:1.0 ./nginx/

# python-flask
docker build -t ${ECR_BASE}/apps/python-flask:1.0 ./python-flask/

# node-express
docker build -t ${ECR_BASE}/apps/node-express:1.0 ./node-express/
```

### Step 3: Push Unpatched Images to ECR

> **What & Why:** Push the "raw" developer images to ECR. These represent what dev teams produce — functional but unprotected. The security pipeline will patch them next.

- [ ] Push all 3 images:

```bash
docker push ${ECR_BASE}/apps/nginx:1.0
docker push ${ECR_BASE}/apps/python-flask:1.0
docker push ${ECR_BASE}/apps/node-express:1.0
```

- [ ] **Verify in Console:** Navigate to **ECR** > **Repositories** > Click into each `apps/*` repo and confirm the `:1.0` tag appears.

---

## 4. Pull the Falcon Sensor Image

> **~10 min | Intermediate**

### Step 1: Set CrowdStrike API Credentials

> **What & Why:** The pull script authenticates to CrowdStrike's private registry using your API credentials to download the sensor image. This image contains both the `falconutil` binary and the sensor runtime.

- [ ] Export your CrowdStrike credentials:

```bash
export FALCON_CLIENT_ID=<your_client_id>
export FALCON_CLIENT_SECRET=<your_client_secret>
```

### Step 2: Pull the Falcon Container Sensor Image

> **What & Why:** CrowdStrike hosts sensor images in their own registry. The pull script handles authentication, registry selection (based on your cloud region), and downloads the correct architecture.

- [ ] Run the official pull script:

```bash
export LATESTSENSOR=$(bash <(curl -Ls https://github.com/CrowdStrike/falcon-scripts/releases/latest/download/falcon-container-sensor-pull.sh) \
  -t falcon-container \
  --platform x86_64 | tail -1)

echo "Pulled sensor image: $LATESTSENSOR"
```

> **What to look for:** The output should show a Docker image URI like `registry.crowdstrike.com/falcon-container/us-1/release/falcon-sensor:7.xx.x-xxx.container.x86_64.Release.US-1`

### Step 3: Push Sensor Image to Your ECR

> **What & Why:** Store the sensor image in your own ECR so CI/CD runners don't need CrowdStrike registry credentials at patch time. The `falconutil-action` will reference this copy.

- [ ] Tag and push:

```bash
docker tag $LATESTSENSOR ${ECR_BASE}/falcon-sensor/falcon-container:latest
docker push ${ECR_BASE}/falcon-sensor/falcon-container:latest
```

- [ ] **Verify in Console:** Navigate to **ECR** > **falcon-sensor/falcon-container** > Confirm `:latest` tag exists.

---

## 5. Patch Images Manually (Local Docker)

> **~10 min | Intermediate**

### Step 1: Run `falconutil patch-image` Locally

> **What & Why:** Before automating with GitHub Actions, run the patching locally so you understand exactly what the Action will do. This builds muscle memory for debugging when the pipeline doesn't work as expected.

- [ ] Patch the nginx image:

```bash
export FALCON_CID=<your_cid_with_checksum>

docker run --user 0:0 \
  -v ${HOME}/.docker/config.json:/root/.docker/config.json \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm ${ECR_BASE}/falcon-sensor/falcon-container:latest \
  falconutil patch-image \
  --source-image-uri ${ECR_BASE}/apps/nginx:1.0 \
  --target-image-uri ${ECR_BASE}/apps/nginx:1.0-falcon \
  --falcon-image-uri ${ECR_BASE}/falcon-sensor/falcon-container:latest \
  --cid $FALCON_CID
```

> **What to look for:** Output should end with something like:
> ```
> Successfully patched image and saved to <target_image_uri>
> ```

### Step 2: Verify the Patched Image

> **What & Why:** Confirm the patched image exists locally, is larger than the original (sensor adds ~30-50MB), and has a modified entrypoint.

- [ ] Compare image sizes:

```bash
docker images | grep "apps/nginx"
```

Expected output (sizes approximate):
```
<ecr>/apps/nginx   1.0-falcon   abc123   30 seconds ago   85MB
<ecr>/apps/nginx   1.0          def456   5 minutes ago    45MB
```

- [ ] Inspect the entrypoint change:

```bash
# Original entrypoint
docker inspect ${ECR_BASE}/apps/nginx:1.0 --format '{{.Config.Entrypoint}}'

# Patched entrypoint (should show Falcon wrapper)
docker inspect ${ECR_BASE}/apps/nginx:1.0-falcon --format '{{.Config.Entrypoint}}'
```

### Step 3: Push the Patched Image

- [ ] Push to ECR:

```bash
docker push ${ECR_BASE}/apps/nginx:1.0-falcon
```

- [ ] **Verify in Console:** Navigate to **ECR** > **apps/nginx** > Confirm both `:1.0` and `:1.0-falcon` tags exist.

> You now understand the full flow manually. Next, we'll automate this with GitHub Actions.

---

## 6. Create the GitHub Actions Workflow

> **~15 min | Intermediate**

### Step 1: Set Up IAM OIDC for GitHub Actions

> **What & Why:** GitHub Actions needs AWS credentials to pull/push ECR images. OIDC federation lets the runner assume an IAM role using a short-lived token — no long-lived access keys stored in GitHub secrets.

- [ ] **Console:** Navigate to **IAM** > **Identity providers** > Click **Add provider**
  - Provider type: **OpenID Connect**
  - Provider URL: `https://token.actions.githubusercontent.com`
  - Click **Get thumbprint**
  - Audience: `sts.amazonaws.com`
  - Click **Add provider**

- [ ] **Console:** Navigate to **IAM** > **Roles** > Click **Create role**
  - Trusted entity type: **Web identity**
  - Identity provider: `token.actions.githubusercontent.com`
  - Audience: `sts.amazonaws.com`
  - GitHub organization: `<your-github-org-or-username>`
  - Click **Next**
  - Attach policy: **Create inline policy** with this JSON:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "ECRPullPush",
      "Effect": "Allow",
      "Action": [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      "Resource": [
        "arn:aws:ecr:*:<ACCOUNT_ID>:repository/apps/*",
        "arn:aws:ecr:*:<ACCOUNT_ID>:repository/falcon-sensor/*"
      ]
    }
  ]
}
```

  - Role name: `github-actions-falcon-patching`
  - Click **Create role**

- [ ] **Edit the trust policy** to restrict to your specific repo:

  Navigate to the role > **Trust relationships** > **Edit trust policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_ORG>/<REPO_NAME>:*"
        }
      }
    }
  ]
}
```

<details>
<summary>CLI equivalent</summary>

```bash
# Create OIDC provider (only needed once per account)
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

# Create the IAM role (save trust-policy.json first)
aws iam create-role \
  --role-name github-actions-falcon-patching \
  --assume-role-policy-document file://trust-policy.json

# Attach inline policy (save ecr-policy.json first)
aws iam put-role-policy \
  --role-name github-actions-falcon-patching \
  --policy-name ecr-pull-push \
  --policy-document file://ecr-policy.json
```

</details>

### Step 2: Configure GitHub Repository Secrets & Variables

> **What & Why:** The workflow needs CrowdStrike credentials to run `falconutil` and the IAM role ARN for AWS authentication. Secrets are encrypted; variables are plaintext config.

- [ ] **GitHub:** Navigate to your repo > **Settings** > **Secrets and variables** > **Actions**

  **Secrets** (encrypted):
  | Name | Value |
  |------|-------|
  | `FALCON_CLIENT_SECRET` | Your CrowdStrike API client secret |
  | `FALCON_CID` | Your CID with checksum (e.g., `ABC123-DE-45`) |

  **Variables** (plaintext):
  | Name | Value |
  |------|-------|
  | `FALCON_CLIENT_ID` | Your CrowdStrike API client ID |
  | `FALCON_REGION` | Your CrowdStrike cloud (e.g., `us-1`, `us-2`, `eu-1`) |
  | `AWS_REGION` | `us-east-2` |
  | `AWS_ACCOUNT_ID` | Your 12-digit AWS account ID |
  | `AWS_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/github-actions-falcon-patching` |

### Step 3: Create the Workflow File

> **What & Why:** This workflow accepts an image name and tag as inputs, patches the image with the Falcon sensor, and pushes the result back to ECR with the `-falcon` suffix.

- [ ] Create `.github/workflows/patch-image.yml` in your repository:

```yaml
name: Patch Container Image with Falcon Sensor

on:
  workflow_dispatch:
    inputs:
      image_name:
        description: 'ECR repository name (e.g., apps/nginx)'
        required: true
        type: choice
        options:
          - apps/nginx
          - apps/python-flask
          - apps/node-express
      image_tag:
        description: 'Image tag to patch (e.g., 1.0)'
        required: true
        type: string
        default: '1.0'

permissions:
  id-token: write   # Required for OIDC
  contents: read

env:
  ECR_BASE: ${{ vars.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com

jobs:
  patch:
    name: Patch ${{ inputs.image_name }}:${{ inputs.image_tag }}
    runs-on: ubuntu-latest

    steps:
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Patch image with Falcon sensor
        uses: crowdstrike/falconutil-action@v1.1.0
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          source_image_uri: ${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}
          target_image_uri: ${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon
          cid: ${{ secrets.FALCON_CID }}
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Push patched image to ECR
        run: |
          docker push ${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon

      - name: Verify patched image
        run: |
          echo "## Patch Summary" >> $GITHUB_STEP_SUMMARY
          echo "| Field | Value |" >> $GITHUB_STEP_SUMMARY
          echo "|-------|-------|" >> $GITHUB_STEP_SUMMARY
          echo "| Source | \`${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}\` |" >> $GITHUB_STEP_SUMMARY
          echo "| Target | \`${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon\` |" >> $GITHUB_STEP_SUMMARY
          echo "| Status | Patched successfully |" >> $GITHUB_STEP_SUMMARY

          # Verify image exists in ECR
          aws ecr describe-images \
            --repository-name ${{ inputs.image_name }} \
            --image-ids imageTag=${{ inputs.image_tag }}-falcon \
            --region ${{ vars.AWS_REGION }}
```

> A reference copy of this workflow is at `workflows/patch-image.yml` in this lab folder.

---

## 7. Run & Verify

> **~10 min | Intermediate**

### Step 1: Trigger the Workflow

> **What & Why:** Manually dispatch the workflow to patch each image. This simulates what a security team would do — or what an automated trigger would invoke.

- [ ] **GitHub:** Navigate to your repo > **Actions** > **Patch Container Image with Falcon Sensor** > Click **Run workflow**
  - Branch: `main`
  - Image name: `apps/nginx`
  - Image tag: `1.0`
  - Click **Run workflow**

- [ ] Watch the workflow run. Click into the job to see each step's logs.

- [ ] Repeat for the other two images:
  - `apps/python-flask` : `1.0`
  - `apps/node-express` : `1.0`

### Step 2: Verify Patched Images in ECR

> **What & Why:** Confirm all 3 images now have both their original tag and the patched `-falcon` tag.

- [ ] **Console:** Navigate to **ECR** > **Repositories** > Click into each `apps/*` repo

  **Expected state:**
  | Repository | Tags present |
  |-----------|-------------|
  | `apps/nginx` | `:1.0`, `:1.0-falcon` |
  | `apps/python-flask` | `:1.0`, `:1.0-falcon` |
  | `apps/node-express` | `:1.0`, `:1.0-falcon` |

<details>
<summary>CLI equivalent</summary>

```bash
for repo in apps/nginx apps/python-flask apps/node-express; do
  echo "=== $repo ==="
  aws ecr describe-images --repository-name "$repo" --region $AWS_REGION \
    --query 'imageDetails[].imageTags' --output text
done
```

</details>

### Step 3: Verify in Falcon Console (Optional)

> **What & Why:** If you actually deploy a patched container (e.g., `docker run` locally or in ECS), the Falcon sensor inside will phone home and register in the Falcon console.

- [ ] Run the patched image locally to register the sensor:

```bash
docker run --rm -d --name nginx-falcon \
  -e FALCONCTL_OPT_CID=$FALCON_CID \
  ${ECR_BASE}/apps/nginx:1.0-falcon

# Wait ~30 seconds for sensor to register
sleep 30

# Check Falcon console: Host setup and management > Host management
# Look for a host with the container name
```

- [ ] Clean up:

```bash
docker stop nginx-falcon
```

---

## 8. Connect Back to Terraform

> **~15 min | Intermediate**

You've built everything by hand — now let's make it repeatable. We'll import your existing resources into Terraform so you can tear down and recreate this entire lab with one command.

### Step 1: Initialize Terraform

> **What & Why:** `terraform init` downloads the AWS provider plugin so Terraform can manage your ECR repos and IAM role.

- [ ] From the lab folder, run:

```bash
cd ~/projects/falcon-sensor-installs/container-image-patching/github-actions
terraform init
```

### Step 2: Update `terraform.tfvars`

> **What & Why:** Fill in your actual values so Terraform matches what you created manually.

- [ ] Edit `terraform.tfvars` with your values:

```hcl
aws_region     = "us-east-2"
aws_account_id = "<your-12-digit-account-id>"
github_org     = "<your-github-username-or-org>"
github_repo    = "<your-repo-name>"
```

### Step 3: Import Existing Resources

> **What & Why:** `terraform import` tells Terraform "this resource in my .tf file corresponds to this real thing that already exists." After import, Terraform tracks it in state and can manage its lifecycle.

- [ ] Import each resource:

```bash
# ECR repositories
terraform import aws_ecr_repository.apps["nginx"] apps/nginx
terraform import aws_ecr_repository.apps["python-flask"] apps/python-flask
terraform import aws_ecr_repository.apps["node-express"] apps/node-express
terraform import aws_ecr_repository.falcon_sensor falcon-sensor/falcon-container

# IAM OIDC provider
OIDC_ARN=$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, 'token.actions.githubusercontent.com')].Arn" --output text)
terraform import aws_iam_openid_connect_provider.github $OIDC_ARN

# IAM role
terraform import aws_iam_role.github_actions github-actions-falcon-patching

# IAM role policy
terraform import aws_iam_role_policy.ecr_access github-actions-falcon-patching:ecr-pull-push
```

### Step 4: Validate with terraform plan

> **What & Why:** After importing, `terraform plan` should show "No changes" — meaning your .tf files perfectly describe what already exists.

- [ ] Run:

```bash
terraform plan
```

> Look for: `No changes. Your infrastructure matches the configuration.`
> If you see planned changes, read what Terraform wants to modify and update your .tf files to match the actual state.

### Step 5: Test the Lifecycle

- [ ] Destroy everything:

```bash
terraform destroy
```

- [ ] Recreate from scratch:

```bash
terraform apply
```

> You now have a fully repeatable lab environment. Next time, skip the manual steps and just run `terraform apply`.

---

## 9. Cleanup

When you're done with the lab:

```bash
# Option 1: Terraform (if you completed Section 8)
terraform destroy

# Option 2: Manual
for repo in apps/nginx apps/python-flask apps/node-express falcon-sensor/falcon-container; do
  # Delete all images first (required before repo deletion)
  aws ecr list-images --repository-name "$repo" --region $AWS_REGION \
    --query 'imageIds[*]' --output json | \
    xargs -I {} aws ecr batch-delete-image --repository-name "$repo" \
    --region $AWS_REGION --image-ids '{}'
  # Delete the repo
  aws ecr delete-repository --repository-name "$repo" --region $AWS_REGION --force
done

# Delete IAM role and OIDC provider
aws iam delete-role-policy --role-name github-actions-falcon-patching --policy-name ecr-pull-push
aws iam delete-role --role-name github-actions-falcon-patching
```

</div>

---

## 10. Challenges

> **~15 min | Advanced**

### Challenge 1: Add FCS CLI Vulnerability Scan Before Patching

**Scenario:** Your security policy requires that images pass a vulnerability scan *before* they get the Falcon sensor embedded. If an image has CRITICAL vulnerabilities, it should be rejected — don't waste time patching an image that needs to be rebuilt.

Add a scan step using `crowdstrike/fcs-action` that runs before the patching step. The workflow should fail if critical vulnerabilities are found.

<details>
<summary>Hint</summary>

The `crowdstrike/fcs-action` uses `scan_type: image` and the `image` input for the image URI. Check the exit code — non-zero means findings above your threshold.

```yaml
- name: Scan image for vulnerabilities
  uses: crowdstrike/fcs-action@v4.0.1
  with:
    falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
    falcon_region: ${{ vars.FALCON_REGION }}
    scan_type: image
    image: ${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}
  env:
    FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}
```

</details>

<details>
<summary>Solution</summary>

Add this step between the ECR login and the `falconutil-action` step:

```yaml
      - name: Scan image for vulnerabilities
        id: scan
        uses: crowdstrike/fcs-action@v4.0.1
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          scan_type: image
          image: ${{ env.ECR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Check scan results
        if: steps.scan.outputs.exit-code != '0'
        run: |
          echo "::error::Image failed vulnerability scan. Fix vulnerabilities before patching."
          exit 1
```

The workflow will now fail before patching if the image has critical/high findings, saving you from embedding the sensor into a vulnerable image that shouldn't be deployed anyway.

</details>

---

### Challenge 2: Matrix Strategy — Patch All Images in Parallel

**Scenario:** You have 3 images to patch and don't want to manually trigger the workflow 3 times. Create a "patch-all" workflow that uses a matrix strategy to patch all images in parallel with a single button click.

<details>
<summary>Hint</summary>

Use `strategy.matrix` with a list of image configurations. Each matrix entry runs as a separate parallel job.

</details>

<details>
<summary>Solution</summary>

Create `.github/workflows/patch-all-images.yml`:

```yaml
name: Patch All Images

on:
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Tag to patch across all images'
        required: true
        default: '1.0'

permissions:
  id-token: write
  contents: read

env:
  ECR_BASE: ${{ vars.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com

jobs:
  patch:
    name: Patch ${{ matrix.image }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        image:
          - apps/nginx
          - apps/python-flask
          - apps/node-express
      fail-fast: false  # Don't cancel others if one fails

    steps:
      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: Login to Amazon ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Patch image with Falcon sensor
        uses: crowdstrike/falconutil-action@v1.1.0
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          source_image_uri: ${{ env.ECR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}
          target_image_uri: ${{ env.ECR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}-falcon
          cid: ${{ secrets.FALCON_CID }}
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Push patched image
        run: docker push ${{ env.ECR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}-falcon
```

This patches all 3 images in parallel (~3 min total instead of ~9 min sequentially).

</details>

---

### Challenge 3: Prevent Unpatched Deployments (Bonus)

**Scenario:** Create an ECR lifecycle policy that deletes untagged image manifests after 1 day, and write a simple shell script that checks whether a given image:tag has a corresponding `-falcon` tag before allowing deployment.

<details>
<summary>Hint</summary>

Use `aws ecr describe-images` to check if the `-falcon` suffixed tag exists. Exit non-zero if it doesn't.

</details>

<details>
<summary>Solution</summary>

`deploy-gate.sh`:

```bash
#!/bin/bash
# Usage: ./deploy-gate.sh apps/nginx 1.0
REPO=$1
TAG=$2
REGION=${AWS_REGION:-us-east-2}

echo "Checking if ${REPO}:${TAG}-falcon exists..."

if aws ecr describe-images \
  --repository-name "$REPO" \
  --image-ids imageTag="${TAG}-falcon" \
  --region "$REGION" > /dev/null 2>&1; then
  echo "PASS: Patched image ${REPO}:${TAG}-falcon exists. Deployment allowed."
  exit 0
else
  echo "FAIL: No patched image found. Run the patching pipeline first."
  exit 1
fi
```

For the lifecycle policy (add to Terraform or apply via console):

```json
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Remove untagged images after 1 day",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 1
      },
      "action": {
        "type": "expire"
      }
    }
  ]
}
```

</details>

---

## 11. Quick Reference

| Action | Console Path | CLI Command |
|--------|-------------|-------------|
| Create ECR repo | ECR > Repositories > Create | `aws ecr create-repository --repository-name <name>` |
| List image tags | ECR > Repo > Images | `aws ecr describe-images --repository-name <name>` |
| ECR Docker login | — | `aws ecr get-login-password \| docker login --username AWS --password-stdin <ecr-url>` |
| Pull CrowdStrike sensor | — | `bash <(curl -Ls .../falcon-container-sensor-pull.sh) -t falcon-container --platform x86_64` |
| Patch image locally | — | `docker run ... falconutil patch-image --source-image-uri <src> --target-image-uri <tgt> --falcon-image-uri <sensor> --cid <cid>` |
| Trigger GH Actions | Actions > Workflow > Run workflow | `gh workflow run patch-image.yml -f image_name=apps/nginx -f image_tag=1.0` |
| Create OIDC provider | IAM > Identity providers > Add | `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com ...` |
| Assume role (GH Action) | — | `aws-actions/configure-aws-credentials@v4` with `role-to-assume` |

---

*Created: 2026-06-15 | Topics: container-security, falcon-sensor, ecr, github-actions, ci-cd, image-patching*
