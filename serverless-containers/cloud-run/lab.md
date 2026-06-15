# Falcon Sensor on Google Cloud Run — GitHub Actions + Artifact Registry Pipeline

> **Prerequisites:**
>
> - GCP project with Artifact Registry, Cloud Run, and IAM APIs enabled
> - GitHub repository with Actions enabled
> - Docker Desktop running locally
> - `gcloud` CLI authenticated (`gcloud auth list` shows your account)
> - CrowdStrike API client with **Falcon Images Download: Read** and **Sensor Download: Read** scopes
> - CrowdStrike CID with checksum
> - ~130 minutes

## Reference Docs

| Source                                           | Link                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| CrowdStrike falconutil-action                    | https://github.com/CrowdStrike/falconutil-action                                         |
| Deploy Falcon Container Sensor on Cloud Run      | https://falcon.crowdstrike.com/documentation/page/p6af9353                               |
| Deploy Falcon Container Sensor Embedded in Image | https://falcon.crowdstrike.com/documentation/page/k58f1a5e                               |
| GCP Artifact Registry Docker repos               | https://cloud.google.com/artifact-registry/docs/docker                                   |
| GCP Workload Identity Federation for GitHub      | https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines |
| GCP Cloud Run deployment                         | https://cloud.google.com/run/docs/deploying                                              |

---

## 1. Intro & Architecture

> **~5 min | Beginner**

Cloud Run is a fully managed serverless container platform — no host access, no kernel modules, no DaemonSets. The **only** way to deploy the Falcon sensor here is to embed it directly into the container image at build time using `falconutil patch-image`.

This lab builds a complete CI/CD pipeline:

1. Developers push unpatched images to Google Artifact Registry (GAR)
2. A security engineer triggers a GitHub Actions workflow
3. The workflow pulls the unpatched image from GAR, patches it with the Falcon sensor, and pushes the result back to GAR with a `-falcon` tag suffix
4. The patched image is deployed to Cloud Run with the sensor running alongside the application

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                             GitHub Actions Runner                                     │
│                                                                                      │
│                        ┌──────────────────────────────────┐                          │
│                        │  Falcon Container Sensor Image    │                          │
│                        │  falcon-container:latest          │                          │
│                        │  (contains falconutil binary +    │                          │
│                        │   sensor runtime)                 │                          │
│                        └────────────────┬─────────────────┘                          │
│                                         │                                            │
│                                         ▼                                            │
│  ┌───────────────────┐   ┌──────────────────────────────┐   ┌───────────────────┐   │
│  │ Auth to GCP (WIF) │──▶│     falconutil patch-image    │──▶│ Push patched      │   │
│  │ + GAR Docker login │   │                              │   │ image to GAR      │   │
│  └───────────────────┘   │  source: app:1.0             │   └───────────────────┘   │
│          ▲                │  sensor: falcon-container     │            │              │
│          │                │  target: app:1.0-falcon       │            │              │
│          │                └──────────────────────────────┘            │              │
└──────────┼───────────────────────────────────────────────────────────┼──────────────┘
           │ Workload Identity Federation (OIDC)                       │
           │                                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                       Google Artifact Registry (GAR)                                   │
│                                                                                      │
│  us-central1-docker.pkg.dev/<PROJECT>/falcon-lab/                                    │
│  ├── nginx:1.0                  (unpatched, dev pushed)                              │
│  ├── nginx:1.0-falcon           (patched by pipeline)                                │
│  ├── python-flask:1.0                                                                │
│  ├── python-flask:1.0-falcon                                                         │
│  ├── go-api:1.0                                                                │
│  ├── go-api:1.0-falcon                                                         │
│  └── falcon-container:latest    (sensor image, pulled from CrowdStrike registry)     │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼ Deploy :*-falcon only
                             ┌───────────────────────┐
                             │   Google Cloud Run     │
                             │   (2nd gen execution)  │
                             │                       │
                             │   falcon-sensor +     │
                             │   your application    │
                             └───────────────────────┘
```

**Tagging convention:** Unpatched images keep their original tag (`:1.0`). Patched images get a `-falcon` suffix (`:1.0-falcon`). Only `-falcon` tagged images are approved for Cloud Run deployment.

---

## 2. Core Concepts

> **~10 min | Intermediate**

### How `falconutil patch-image` Works

The Falcon Container sensor image ships with a utility binary called `falconutil`. When you run `falconutil patch-image`, it:

1. **Pulls** your application image (the "source")
2. **Injects** the Falcon sensor binaries and libraries as additional image layers
3. **Rewrites** the container entrypoint so the sensor launches first via `/opt/CrowdStrike/rootfs/bin/falcon-entrypoint`, then hands off to your original entrypoint
4. **Outputs** a new image (the "target") with the sensor embedded (~30-50MB larger)

At runtime, the sensor process runs in user space alongside your application — no kernel access needed.

### Key Parameters

| Flag                 | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `--source-image-uri` | The unpatched application image to read from GAR                   |
| `--target-image-uri` | Where to write the patched image (same GAR repo, `-falcon` suffix) |
| `--falcon-image-uri` | The Falcon sensor image (contains `falconutil` + sensor binaries)  |
| `--cid`              | Your CrowdStrike Customer ID with checksum                         |
| `--cloud-service`    | Set to `CLOUDRUN` for Cloud Run metadata collection                |

### The `-falcon` Suffix Convention

```
                      Dev pushes           Security pipeline patches
                      ──────────           ──────────────────────────
GAR tag timeline:     :1.0                 :1.0-falcon
                      :1.1                 :1.1-falcon
                      :2.0                 :2.0-falcon

Deployment policy:    Only images with -falcon suffix may be deployed to Cloud Run
```

### Workload Identity Federation (WIF)

Instead of storing a GCP service account key as a GitHub secret (long-lived credential, security risk), WIF lets GitHub Actions authenticate using OIDC:

1. GitHub's OIDC provider issues a short-lived JWT to the workflow run
2. GCP's Security Token Service exchanges it for a federated token
3. The federated token impersonates a service account with specific permissions

No secrets to rotate. Credentials are ephemeral and scoped to the workflow run.

### Cloud Run 2nd-Gen Execution Environment

The Falcon Container sensor **requires** Cloud Run's second-generation execution environment. Services default to first-gen, so you must explicitly set `--execution-environment gen2` when deploying.

---

## 3. Create GAR Repository & Push Sample Images

> **~15 min | Intermediate**

### Step 1: Enable Required APIs

> **What & Why:** Artifact Registry and Cloud Run APIs must be enabled before you can create repos or deploy services. IAM is needed for Workload Identity Federation.

- [ ] **Console:** Navigate to **APIs & Services** → **Enable APIs and Services** → Search and enable:
  - Artifact Registry API
  - Cloud Run Admin API
  - IAM Service Account Credentials API
  - Security Token Service API

<details>
<summary>CLI equivalent</summary>

```bash
export PROJECT_ID=$(gcloud config get-value project)

gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project $PROJECT_ID
```

</details>

### Step 2: Create an Artifact Registry Docker Repository

> **What & Why:** GAR organizes images in repositories. We'll create a single Docker repo called `falcon-lab` that holds all our images (app images + sensor image) under different paths.

- [ ] **Console:** Navigate to **Artifact Registry** → **Repositories** → Click **Create Repository**
  - Name: `falcon-lab`
  - Format: **Docker**
  - Mode: **Standard**
  - Location type: **Region**
  - Region: `us-central1`
  - Encryption: **Google-managed encryption key**
  - Immutable image tags: **Disabled** (we need to update the sensor `:latest`)
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
export REGION=us-central1

gcloud artifacts repositories create falcon-lab \
  --repository-format=docker \
  --location=$REGION \
  --description="Falcon sensor patching lab - app images and sensor"
```

</details>

### Step 3: Build Sample Application Images

> **What & Why:** We need realistic but minimal application images to represent what a dev team would push. These are the "unpatched" images the pipeline will process.

- [ ] Set environment variables:

```bash
export PROJECT_ID=$(gcloud config get-value project)
export REGION=us-central1
export GAR_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/falcon-lab"
```

- [ ] Create and build sample images:

```bash
# Create a temp directory for sample apps
mkdir -p /tmp/falcon-lab-samples && cd /tmp/falcon-lab-samples

# nginx - simple web server
mkdir -p nginx && cat > nginx/Dockerfile <<'EOF'
FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
EOF
echo "<h1>Falcon Lab - Nginx</h1>" > nginx/index.html

# python-flask - simple API
mkdir -p python-flask && cat > python-flask/Dockerfile <<'EOF'
FROM python:3.12-slim
RUN pip install flask gunicorn
WORKDIR /app
COPY app.py .
EXPOSE 8080
CMD ["gunicorn", "-b", "0.0.0.0:8080", "app:app"]
EOF
cat > python-flask/app.py <<'EOF'
from flask import Flask
app = Flask(__name__)

@app.route("/")
def hello():
    return {"status": "ok", "service": "python-flask", "patched": False}
EOF

# go-api - simple API (no external dependencies, uses Go stdlib)
mkdir -p go-api && cat > go-api/Dockerfile <<'EOF'
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY main.go .
RUN CGO_ENABLED=0 go build -o server main.go

FROM alpine:3.20
COPY --from=builder /app/server /server
EXPOSE 8080
CMD ["/server"]
EOF
cat > go-api/main.go <<'EOF'
package main

import (
	"encoding/json"
	"net/http"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"service": "go-api",
			"patched": false,
		})
	})
	http.ListenAndServe(":8080", nil)
}
EOF

# Build all three
docker build --platform linux/amd64 -t ${GAR_BASE}/nginx:1.0 ./nginx/
docker build --platform linux/amd64 -t ${GAR_BASE}/python-flask:1.0 ./python-flask/
docker build --platform linux/amd64 -t ${GAR_BASE}/go-api:1.0 ./go-api/
```

### Step 4: Push Unpatched Images to GAR

> **What & Why:** Push the "raw" developer images to GAR. These represent what dev teams produce — functional but unprotected. The security pipeline will patch them next.

- [ ] Authenticate Docker to GAR and push:

```bash
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet

docker push ${GAR_BASE}/nginx:1.0
docker push ${GAR_BASE}/python-flask:1.0
docker push ${GAR_BASE}/go-api:1.0
```

- [ ] **Verify in Console:** Navigate to **Artifact Registry** → **falcon-lab** → Confirm `nginx`, `python-flask`, and `go-api` appear with the `:1.0` tag.

---

## 4. Pull Falcon Sensor Image into GAR

> **~10 min | Intermediate**

### Step 1: Set CrowdStrike API Credentials

> **What & Why:** The pull script authenticates to CrowdStrike's private registry to download the sensor image. This image contains both the `falconutil` binary and the runtime sensor.

- [ ] Export your CrowdStrike credentials:

```bash
export FALCON_CLIENT_ID=<your_client_id>
export FALCON_CLIENT_SECRET=<your_client_secret>
```

### Step 2: Pull the Falcon Container Sensor Image

> **What & Why:** CrowdStrike hosts sensor images in their own registry. The pull script handles authentication, registry selection, and downloads the correct architecture.

- [ ] Run the official pull script:

```bash
export LATESTSENSOR=$(bash <(curl -Ls https://github.com/CrowdStrike/falcon-scripts/releases/latest/download/falcon-container-sensor-pull.sh) \
  -t falcon-container \
  --platform x86_64 | tail -1)

echo "Pulled sensor image: $LATESTSENSOR"
```

> **What to look for:** Output should show a Docker image URI like `registry.crowdstrike.com/falcon-container/us-1/release/falcon-sensor:7.xx.x-xxx.container.x86_64.Release.US-1`

### Step 3: Push Sensor Image to Your GAR

> **What & Why:** Store the sensor image in your own GAR so the GitHub Actions runner doesn't need CrowdStrike registry credentials at patch time. The `falconutil-action` will reference this copy.

- [ ] Tag and push:

```bash
docker tag $LATESTSENSOR ${GAR_BASE}/falcon-container:latest
docker push ${GAR_BASE}/falcon-container:latest
```

- [ ] **Verify in Console:** Navigate to **Artifact Registry** → **falcon-lab** → Confirm `falcon-container` with `:latest` tag exists.

### Step 4: Rebuild as amd64-Only Image

> **What & Why:** The pulled sensor image is multi-arch. When patching locally on an Apple Silicon Mac, `falconutil` needs an explicit amd64 image since Docker would otherwise pull the arm64 variant. Re-pull with an explicit platform flag and push back to overwrite the manifest list with a plain amd64 image.
>
> **Note:** This step is only needed when testing locally on a Mac (arm64). On GitHub Actions (`ubuntu-latest`), the runner is already amd64, so `docker pull` automatically resolves the multi-arch manifest to the correct variant without needing `--platform`.

- [ ] Pull and push as amd64 only:

```bash
docker pull --platform linux/amd64 ${GAR_BASE}/falcon-container:latest
docker push ${GAR_BASE}/falcon-container:latest
```

- [ ] Confirm the architecture is set:

```bash
docker image inspect ${GAR_BASE}/falcon-container:latest | grep Architecture
```

> **Expected output:** `"Architecture": "amd64"`

---

## 5. Patch an Image Manually (Local Docker)

> **~10 min | Intermediate**

### Step 1: Run `falconutil patch-image` Locally

> **What & Why:** Before automating with GitHub Actions, run the patching locally so you understand exactly what the Action does. This builds muscle memory for debugging when the pipeline doesn't work as expected.

- [ ] Patch the nginx image:

```bash
export FALCON_CID=<your_cid_with_checksum>

docker run --user 0:0 \
  -v ${HOME}/.docker/config.json:/root/.docker/config.json \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm ${GAR_BASE}/falcon-container:latest \
  falconutil patch-image \
  --source-image-uri ${GAR_BASE}/nginx:1.0 \
  --target-image-uri ${GAR_BASE}/nginx:1.0-falcon \
  --falcon-image-uri ${GAR_BASE}/falcon-container:latest \
  --cid $FALCON_CID \
  --image-pull-policy IfNotPresent \
  --cloud-service CLOUDRUN
```

> **What to look for:** Output should end with:
>
> ```
> Successfully patched image and saved to <target_image_uri>
> ```

### Step 2: Verify the Patched Image

> **What & Why:** Confirm the patched image exists locally, is larger than the original (sensor adds ~30-50MB), and has a modified entrypoint.

- [ ] Compare image sizes:

```bash
docker images | grep "falcon-lab/nginx"
```

Expected output (sizes approximate):

```
<gar>/nginx   1.0-falcon   abc123   30 seconds ago   85MB
<gar>/nginx   1.0          def456   5 minutes ago    45MB
```

- [ ] Inspect the entrypoint change:

```bash
# Original entrypoint
docker inspect ${GAR_BASE}/nginx:1.0 --format '{{.Config.Entrypoint}}'

# Patched entrypoint (should show Falcon wrapper)
docker inspect ${GAR_BASE}/nginx:1.0-falcon --format '{{.Config.Entrypoint}}'
```

> The patched image's entrypoint should reference `/opt/CrowdStrike/rootfs/bin/falcon-entrypoint`.

### Step 3: Push the Patched Image

- [ ] Push to GAR:

```bash
docker push ${GAR_BASE}/nginx:1.0-falcon
```

- [ ] **Verify in Console:** Navigate to **Artifact Registry** → **falcon-lab** → **nginx** → Confirm both `:1.0` and `:1.0-falcon` tags exist.

> You now understand the full flow manually. Next, we'll automate this with GitHub Actions.

---

## 6. Set Up Workload Identity Federation

> **~15 min | Intermediate**

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  WORKLOAD IDENTITY FEDERATION (WIF) — How GitHub Actions authenticates to GCP       │
│  without storing any keys                                                           │
│                                                                                     │
│  ┌────────────┐       ┌────────────────┐       ┌────────────────┐                  │
│  │ GitHub     │──────►│ WIF Pool +     │──────►│ Service Account │                  │
│  │ Actions    │ OIDC  │ Provider       │ Trust │ github-actions- │                  │
│  │ Runner     │ Token │ (Step 2 & 3)   │       │ falcon (Step 1) │                  │
│  └────────────┘       └────────────────┘       └────────────────┘                  │
│        │                      │                         │                           │
│   Sends a short-lived    Validates the token       Gets a GCP access                │
│   JWT: "I'm repo         and checks: "Is this      token with the SA's             │
│   vianneyp72/cloud-run"  from a repo I trust?"     permissions (Step 4)            │
│                                                                                     │
│  Result: GitHub Actions can push/pull from Artifact Registry — zero stored keys     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

> **Plain-English Walkthrough (for beginners):**
>
> Think of WIF like a hotel keycard system:
>
> 1. **Service Account (Step 1)** — This is the "hotel room" with specific permissions (push/pull images). Nobody can get in without a valid keycard.
>
> 2. **Workload Identity Pool (Step 2)** — This is the hotel's "front desk system." It says "I accept keycards issued by certain providers."
>
> 3. **OIDC Provider (Step 3)** — This registers GitHub as a trusted keycard issuer. When a GitHub Actions workflow runs, GitHub gives it a short-lived ID token (like a digital passport) that says "I am repo X, running workflow Y."
>
> 4. **IAM Binding (Step 4)** — This is the rule that says "If someone shows up with a valid keycard from GitHub AND they're from repo `vianneyp72/cloud-run`, give them access to the hotel room (service account)." This is the most confusing step — you're not granting roles TO the service account, you're telling GCP who is allowed to BECOME the service account.
>
> 5. **Provider Resource Name (Step 5)** — This is the full address your GitHub workflow uses to say "I want to authenticate through this specific front desk." You'll paste it into GitHub as a variable.
>
> **The big win:** No JSON key files, no secrets that can leak, no manual rotation. The token lives for ~60 seconds and is never stored anywhere.

### Step 1: Create a Service Account for GitHub Actions

> **What & Why:** The GitHub Actions runner needs a GCP identity to pull/push images in GAR. This service account will be impersonated via WIF — the runner never holds a key.

- [ ] **Console:** Navigate to **IAM & Admin** → **Service Accounts** → Click **Create Service Account**
  - Name: `github-actions-falcon`
  - ID: `github-actions-falcon`
  - Description: `Used by GitHub Actions to patch container images in GAR`
  - Click **Create and Continue**
  - Grant role: **Artifact Registry Writer** (`roles/artifactregistry.writer`)
  - Click **Continue** → **Done**

<details>
<summary>CLI equivalent</summary>

```bash
gcloud iam service-accounts create github-actions-falcon \
  --display-name="GitHub Actions - Falcon Patching" \
  --description="Used by GitHub Actions to patch container images in GAR"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:github-actions-falcon@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

</details>

### Step 2: Create a Workload Identity Pool

> **What & Why:** The pool is a container for external identity providers. It tells GCP "I trust tokens from these sources."

- [ ] **Console:** Navigate to **IAM & Admin** → **Workload Identity Federation** → Click **Create Pool**
  - Name: `github-actions-pool`
  - Pool ID: `github-actions-pool`
  - Description: `Pool for GitHub Actions OIDC tokens`
  - Click **Continue**

<details>
<summary>CLI equivalent</summary>

```bash
gcloud iam workload-identity-pools create github-actions-pool \
  --location="global" \
  --display-name="GitHub Actions Pool" \
  --description="Pool for GitHub Actions OIDC tokens"
```

</details>

### Step 3: Add a GitHub OIDC Provider to the Pool

> **What & Why:** This connects GitHub's OIDC provider to your pool and maps the GitHub token claims into GCP attributes for access control.

- [ ] **Console:** In the pool you just created, click **Add Provider**
  - Provider type: **OpenID Connect (OIDC)**
  - Provider name: `github`
  - Provider ID: `github`
  - Issuer URL: `https://token.actions.githubusercontent.com`
  - Audiences: **Default audience** (leave as-is)
  - Click **Continue**
  - Attribute mapping:
    - `google.subject` = `assertion.sub`
    - `attribute.repository` = `assertion.repository`
    - `attribute.actor` = `assertion.actor`
  - Attribute condition (restricts to your repo):
    ```
    assertion.repository == "<GITHUB_ORG>/<REPO_NAME>"
    ```
  - Click **Save**

<details>
<summary>CLI equivalent</summary>

```bash
export GITHUB_ORG=<your-github-org-or-username>
export GITHUB_REPO=<your-repo-name>

gcloud iam workload-identity-pools providers create-oidc github \
  --location="global" \
  --workload-identity-pool="github-actions-pool" \
  --display-name="GitHub" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository == '${GITHUB_ORG}/${GITHUB_REPO}'"
```

</details>

### Step 4: Allow the Provider to Impersonate the Service Account

> **What & Why:** This IAM binding says "tokens from my GitHub repo (via the WIF pool) can act as this service account." Without it, authentication succeeds but authorization fails.

- [ ] Export the project number (needed for the principal set reference):

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
```

- [ ] **Console:**
  1. Navigate to **IAM & Admin** → **Service Accounts**
  2. Click the **github-actions-falcon** service account to open its details
  3. Click the **Permissions** tab (not the IAM tab on the left — this is the tab *within* the service account page)
  4. Under **"Principals with access to this service account"**, click **Grant Access**
  5. In the **"New principals"** field, paste:
     ```
     principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/<GITHUB_ORG>/<REPO_NAME>
     ```
  6. Assign the role: **Workload Identity User** (`roles/iam.workloadIdentityUser`)
  7. Click **Save**

> **Note:** This is NOT the same as granting roles to the service account itself (which is what "Manage Access" on the IAM page does). You are granting *other identities* (your WIF pool) permission to *impersonate* this service account.

<details>
<summary>CLI equivalent</summary>

```bash
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
  github-actions-falcon@${PROJECT_ID}.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions-pool/attribute.repository/${GITHUB_ORG}/${GITHUB_REPO}"
```

</details>

### Step 5: Note the WIF Provider Resource Name

> **What & Why:** The GitHub Actions workflow needs the full provider resource name to request a token. Copy this now — you'll paste it into GitHub as a variable.

- [ ] Get the provider resource name:

```bash
export WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions-pool/providers/github"
echo $WIF_PROVIDER
```

> The format is: `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions-pool/providers/github`

---

## 7. Create the GitHub Actions Workflow

> **~15 min | Intermediate**

### Step 1: Configure GitHub Repository Secrets & Variables

> **What & Why:** The workflow needs CrowdStrike credentials for `falconutil` and GCP identifiers for WIF authentication. Secrets are encrypted; variables are plaintext config.

- [ ] **GitHub:** Navigate to your repo → **Settings** → **Secrets and variables** → **Actions**

  **Secrets** (encrypted):
  | Name | Value |
  |------|-------|
  | `FALCON_CLIENT_SECRET` | Your CrowdStrike API client secret |
  | `FALCON_CID` | Your CID with checksum (e.g., `ABCDEF123456-78`) |

  **Variables** (plaintext):
  | Name | Value |
  |------|-------|
  | `FALCON_CLIENT_ID` | Your CrowdStrike API client ID |
  | `FALCON_REGION` | Your CrowdStrike cloud (e.g., `us-1`, `us-2`, `eu-1`) |
  | `GCP_PROJECT_ID` | Your GCP project ID |
  | `GCP_REGION` | `us-central1` |
  | `GCP_WIF_PROVIDER` | The full provider resource name from Step 5 above |
  | `GCP_SERVICE_ACCOUNT` | `github-actions-falcon@<PROJECT_ID>.iam.gserviceaccount.com` |

### Step 2: Create the Workflow File

> **What & Why:** This workflow accepts an image name and tag as inputs, authenticates to GCP via WIF, patches the image with the Falcon sensor, and pushes the result back to GAR with the `-falcon` suffix.

- [ ] Create `.github/workflows/patch-cloudrun-image.yml` in your repository:

```yaml
name: Patch Cloud Run Image with Falcon Sensor

on:
  workflow_dispatch:
    inputs:
      image_name:
        description: "Image name in GAR (e.g., nginx)"
        required: true
        type: choice
        options:
          - nginx
          - python-flask
          - go-api
      image_tag:
        description: "Image tag to patch (e.g., 1.0)"
        required: true
        type: string
        default: "1.0"

permissions:
  id-token: write # Required for WIF OIDC
  contents: read

env:
  GAR_BASE: ${{ vars.GCP_REGION }}-docker.pkg.dev/${{ vars.GCP_PROJECT_ID }}/falcon-lab

jobs:
  patch:
    name: Patch ${{ inputs.image_name }}:${{ inputs.image_tag }}
    runs-on: ubuntu-latest

    steps:
      - name: Authenticate to Google Cloud (WIF)
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Login to Artifact Registry
        run: |
          gcloud auth configure-docker ${{ vars.GCP_REGION }}-docker.pkg.dev --quiet

      - name: Pull source image (workaround for credential helper)
        run: |
          docker pull ${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}

      - name: Patch image with Falcon sensor
        uses: crowdstrike/falconutil-action@v1.1.0
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          source_image_uri: ${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}
          target_image_uri: ${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon
          cid: ${{ secrets.FALCON_CID }}
          cloud_service: CLOUDRUN
          image_pull_policy: IfNotPresent
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Push patched image to GAR
        run: |
          docker push ${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon

      - name: Summary
        run: |
          echo "## Patch Summary" >> $GITHUB_STEP_SUMMARY
          echo "| Field | Value |" >> $GITHUB_STEP_SUMMARY
          echo "|-------|-------|" >> $GITHUB_STEP_SUMMARY
          echo "| Source | \`${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}\` |" >> $GITHUB_STEP_SUMMARY
          echo "| Target | \`${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}-falcon\` |" >> $GITHUB_STEP_SUMMARY
          echo "| Cloud Service | CLOUDRUN |" >> $GITHUB_STEP_SUMMARY
          echo "| Status | Patched successfully |" >> $GITHUB_STEP_SUMMARY
```

> **Important:** The `image_pull_policy: IfNotPresent` combined with the explicit `docker pull` step is a workaround — `falconutil` does not support Docker credential helpers (like the `gcloud` helper). By pulling the image first, it's available locally and `falconutil` doesn't need to authenticate to GAR directly.

---

## 8. Run & Verify the Pipeline

> **~10 min | Intermediate**

### Step 1: Trigger the Workflow

> **What & Why:** Manually dispatch the workflow to patch each image. This simulates what a security team would do after a developer pushes a new version.

- [ ] **GitHub:** Navigate to your repo → **Actions** → **Patch Cloud Run Image with Falcon Sensor** → Click **Run workflow**
  - Branch: `main`
  - Image name: `nginx`
  - Image tag: `1.0`
  - Click **Run workflow**

- [ ] Watch the workflow run. Click into the job to see each step's logs.

- [ ] Repeat for the other two images:
  - `python-flask` : `1.0`
  - `go-api` : `1.0`

<details>
<summary>CLI equivalent (using gh CLI)</summary>

```bash
gh workflow run patch-cloudrun-image.yml \
  -f image_name=nginx \
  -f image_tag=1.0

gh workflow run patch-cloudrun-image.yml \
  -f image_name=python-flask \
  -f image_tag=1.0

gh workflow run patch-cloudrun-image.yml \
  -f image_name=go-api \
  -f image_tag=1.0
```

</details>

### Step 2: Verify Patched Images in GAR

> **What & Why:** Confirm all 3 images now have both their original tag and the patched `-falcon` tag in Artifact Registry.

- [ ] **Console:** Navigate to **Artifact Registry** → **falcon-lab** → Click into each image

  **Expected state:**
  | Image | Tags present |
  |-------|-------------|
  | `nginx` | `:1.0`, `:1.0-falcon` |
  | `python-flask` | `:1.0`, `:1.0-falcon` |
  | `go-api` | `:1.0`, `:1.0-falcon` |

<details>
<summary>CLI equivalent</summary>

```bash
for img in nginx python-flask go-api; do
  echo "=== $img ==="
  gcloud artifacts docker tags list \
    ${REGION}-docker.pkg.dev/${PROJECT_ID}/falcon-lab/${img} \
    --format="table(tag)"
done
```

</details>

---

## 9. Deploy Patched Image to Cloud Run

> **~10 min | Intermediate**

### Step 1: Deploy the Patched nginx Image

> **What & Why:** Deploy the `-falcon` tagged image to Cloud Run. The embedded sensor starts automatically via the modified entrypoint, monitors the application, and reports telemetry to CrowdStrike.

- [ ] **Console:** Navigate to **Cloud Run** → Click **Create Service**
  - Container image URL: Click **Select** → **Artifact Registry** → `falcon-lab` → `nginx` → Select `:1.0-falcon`
  - Service name: `nginx-falcon`
  - Region: `us-central1`
  - Authentication: **Allow unauthenticated invocations** (for testing)
  - Click **Container, Networking, Security** to expand:
    - **Container** tab:
      - Container port: `8080`
    - **General** tab (under Execution environment):
      - Execution environment: **Second generation**
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
gcloud run deploy nginx-falcon \
  --image=${GAR_BASE}/nginx:1.0-falcon \
  --platform=managed \
  --region=$REGION \
  --port=8080 \
  --execution-environment=gen2 \
  --allow-unauthenticated \
  --set-env-vars="CS_CLOUD_SERVICE=CLOUDRUN"
```

</details>

> **Critical:** The `--execution-environment=gen2` flag (or selecting "Second generation" in console) is mandatory. The Falcon Container sensor will not function on Cloud Run's first-generation environment.

### Step 2: Verify the Deployment

> **What & Why:** Confirm the service is running, accessible, and the Falcon sensor has registered with the CrowdStrike cloud.

- [ ] Get the service URL:

```bash
SERVICE_URL=$(gcloud run services describe nginx-falcon \
  --region=$REGION --format='value(status.url)')
echo $SERVICE_URL
```

- [ ] Test the endpoint:

```bash
curl -s $SERVICE_URL
```

> Expected: The nginx welcome page HTML.

### Step 3: Verify in Falcon Console

> **What & Why:** Once the Cloud Run service processes a request (triggers a cold start), the Falcon sensor inside registers with the CrowdStrike cloud.

- [ ] Curl the endpoint a few times to ensure it cold-starts:

```bash
for i in {1..3}; do curl -s -o /dev/null -w "%{http_code}\n" $SERVICE_URL; done
```

- [ ] **Falcon Console:** Navigate to **Host setup and management** → **Host management** → Filter by:
  - Look for hosts with the Cloud Run service name or container metadata
  - The host should appear within 1-2 minutes of the first request

> If the host doesn't appear, check Cloud Run logs for sensor startup errors (look for `falcon-sensor` in the log stream).

---

## 10. Connect Back to Terraform

> **~15 min | Intermediate**

You've built everything by hand — now let's make it repeatable. We'll import your existing resources into Terraform so you can tear down and recreate this entire lab with one command.

### Step 1: Initialize Terraform

> **What & Why:** `terraform init` downloads the Google provider plugin so Terraform can manage your GCP resources.

- [ ] From the lab folder, run:

```bash
cd ~/projects/falcon-sensor-installs-workspace/serverless-containers/cloud-run
terraform init
```

### Step 2: Update `terraform.tfvars`

> **What & Why:** Fill in your actual values so Terraform matches what you created manually.

- [ ] Edit `terraform.tfvars` with your values:

```hcl
project_id     = "<your-project-id>"
project_number = "<your-project-number>"
region         = "us-central1"
github_org     = "<your-github-org-or-username>"
github_repo    = "<your-repo-name>"
```

### Step 3: Import Existing Resources

> **What & Why:** `terraform import` tells Terraform "this resource in my .tf file corresponds to this real thing that already exists." After import, Terraform tracks it in state and can manage its lifecycle.

- [ ] Import each resource:

```bash
# Artifact Registry repository
terraform import google_artifact_registry_repository.falcon_lab projects/${PROJECT_ID}/locations/${REGION}/repositories/falcon-lab

# Service account
terraform import google_service_account.github_actions projects/${PROJECT_ID}/serviceAccounts/github-actions-falcon@${PROJECT_ID}.iam.gserviceaccount.com

# Workload Identity Pool
terraform import google_iam_workload_identity_pool.github projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github-actions-pool

# Workload Identity Pool Provider
terraform import google_iam_workload_identity_pool_provider.github projects/${PROJECT_ID}/locations/global/workloadIdentityPools/github-actions-pool/providers/github

# Cloud Run service
terraform import google_cloud_run_v2_service.nginx_falcon projects/${PROJECT_ID}/locations/${REGION}/services/nginx-falcon
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

## 11. Challenges

> **~15 min | Advanced**

### Challenge 1: Add FCS Vulnerability Scan Before Patching

**Scenario:** Your security policy requires that images pass a vulnerability scan _before_ they get the Falcon sensor embedded. If an image has critical vulnerabilities, it should be rejected — don't waste time patching an image that needs to be rebuilt.

Add a scan step using `crowdstrike/fcs-action` that runs before the patching step in the workflow.

<details>
<summary>Hint</summary>

The `crowdstrike/fcs-action` uses `scan_type: image` and the `image` input for the image URI. Add it between the "Pull source image" step and the "Patch image" step.

</details>

<details>
<summary>Solution</summary>

Add these steps between "Pull source image" and "Patch image with Falcon sensor":

```yaml
- name: Scan image for vulnerabilities
  id: scan
  uses: crowdstrike/fcs-action@v4.0.1
  with:
    falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
    falcon_region: ${{ vars.FALCON_REGION }}
    scan_type: image
    image: ${{ env.GAR_BASE }}/${{ inputs.image_name }}:${{ inputs.image_tag }}
  env:
    FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

- name: Gate on scan results
  if: steps.scan.outputs.exit-code != '0'
  run: |
    echo "::error::Image failed vulnerability scan. Fix vulnerabilities before patching."
    exit 1
```

The workflow will now fail before patching if the image has critical/high findings.

</details>

---

### Challenge 2: Matrix Strategy — Patch All Images in Parallel

**Scenario:** You have 3 images to patch and don't want to manually trigger the workflow 3 times. Create a "patch-all" workflow that uses a matrix strategy to patch all images in parallel with a single button click.

<details>
<summary>Hint</summary>

Use `strategy.matrix` with a list of image names. Each matrix entry runs as a separate parallel job. Keep the same steps but reference `${{ matrix.image }}` instead of `${{ inputs.image_name }}`.

</details>

<details>
<summary>Solution</summary>

Create `.github/workflows/patch-all-cloudrun-images.yml`:

```yaml
name: Patch All Cloud Run Images

on:
  workflow_dispatch:
    inputs:
      image_tag:
        description: "Tag to patch across all images"
        required: true
        default: "1.0"

permissions:
  id-token: write
  contents: read

env:
  GAR_BASE: ${{ vars.GCP_REGION }}-docker.pkg.dev/${{ vars.GCP_PROJECT_ID }}/falcon-lab

jobs:
  patch:
    name: Patch ${{ matrix.image }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        image:
          - nginx
          - python-flask
          - go-api
      fail-fast: false

    steps:
      - name: Authenticate to Google Cloud (WIF)
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Login to Artifact Registry
        run: gcloud auth configure-docker ${{ vars.GCP_REGION }}-docker.pkg.dev --quiet

      - name: Pull source image
        run: docker pull ${{ env.GAR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}

      - name: Patch image with Falcon sensor
        uses: crowdstrike/falconutil-action@v1.1.0
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          source_image_uri: ${{ env.GAR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}
          target_image_uri: ${{ env.GAR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}-falcon
          cid: ${{ secrets.FALCON_CID }}
          cloud_service: CLOUDRUN
          image_pull_policy: IfNotPresent
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Push patched image
        run: docker push ${{ env.GAR_BASE }}/${{ matrix.image }}:${{ inputs.image_tag }}-falcon
```

This patches all 3 images in parallel (~3 min total instead of ~9 min sequentially).

</details>

---

### Challenge 3: Automated Trigger via Pub/Sub (Bonus)

**Scenario:** Instead of manually triggering the workflow, set up a Cloud Pub/Sub notification that fires when a new image is pushed to GAR. Use a Cloud Function or GitHub webhook to automatically trigger the patching workflow for any new `:X.Y` tag (but not for tags that already end in `-falcon`).

<details>
<summary>Hint</summary>

1. Enable Artifact Registry Pub/Sub notifications on the `falcon-lab` repo
2. Create a Cloud Function that receives Pub/Sub messages, filters for new tags (excluding `-falcon`), and calls the GitHub Actions API to dispatch the workflow
3. Use the `gh api` format: `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`

</details>

<details>
<summary>Solution</summary>

**Step 1:** GAR automatically publishes to the topic `gcr` when images are pushed (for Docker-format repos). Create a subscription:

```bash
gcloud pubsub subscriptions create gar-falcon-trigger \
  --topic=gcr \
  --push-endpoint=<YOUR_CLOUD_FUNCTION_URL>
```

**Step 2:** Cloud Function (Python) that dispatches the GitHub workflow:

```python
import functions_framework
import json
import base64
import requests
import os

@functions_framework.cloud_event
def trigger_patching(cloud_event):
    """Triggered by Pub/Sub message when image is pushed to GAR."""
    data = json.loads(base64.b64decode(cloud_event.data["message"]["data"]))

    # Only process INSERT actions (new tags)
    if data.get("action") != "INSERT":
        return

    tag = data.get("tag", "")
    digest = data.get("digest", "")

    # Skip if it's already a patched image
    if tag.endswith("-falcon"):
        return

    # Extract image name from the full path
    # Format: us-central1-docker.pkg.dev/PROJECT/falcon-lab/IMAGE:TAG
    image_name = tag.split("/")[-1].split(":")[0]
    image_tag = tag.split(":")[-1]

    # Dispatch GitHub Actions workflow
    resp = requests.post(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPO']}/actions/workflows/patch-cloudrun-image.yml/dispatches",
        headers={
            "Authorization": f"token {os.environ['GITHUB_PAT']}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "ref": "main",
            "inputs": {
                "image_name": image_name,
                "image_tag": image_tag,
            },
        },
    )
    print(f"Dispatched workflow for {image_name}:{image_tag} - Status: {resp.status_code}")
```

This creates a fully automated pipeline: dev pushes image → GAR → Pub/Sub → Cloud Function → GitHub Actions → patched image back in GAR.

</details>

---

## 12. Quick Reference

| Action                  | Console Path                                     | CLI Command                                                                                                                                                |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create GAR repo         | Artifact Registry → Create Repository            | `gcloud artifacts repositories create <name> --repository-format=docker --location=<region>`                                                               |
| List image tags         | Artifact Registry → Repo → Image                 | `gcloud artifacts docker tags list <image-path>`                                                                                                           |
| GAR Docker login        | —                                                | `gcloud auth configure-docker <region>-docker.pkg.dev`                                                                                                     |
| Pull CrowdStrike sensor | —                                                | `bash <(curl -Ls .../falcon-container-sensor-pull.sh) -t falcon-container --platform x86_64`                                                               |
| Patch image locally     | —                                                | `docker run ... falconutil patch-image --source-image-uri <src> --target-image-uri <tgt> --falcon-image-uri <sensor> --cid <cid> --cloud-service CLOUDRUN` |
| Create service account  | IAM → Service Accounts → Create                  | `gcloud iam service-accounts create <name>`                                                                                                                |
| Create WIF pool         | IAM → Workload Identity Federation → Create Pool | `gcloud iam workload-identity-pools create <name> --location=global`                                                                                       |
| Add OIDC provider       | WIF Pool → Add Provider                          | `gcloud iam workload-identity-pools providers create-oidc <name> ...`                                                                                      |
| Deploy to Cloud Run     | Cloud Run → Create Service                       | `gcloud run deploy <name> --image=<uri> --execution-environment=gen2`                                                                                      |
| Trigger GH Actions      | Actions → Workflow → Run                         | `gh workflow run patch-cloudrun-image.yml -f image_name=nginx -f image_tag=1.0`                                                                            |
| Get project number      | —                                                | `gcloud projects describe $PROJECT_ID --format='value(projectNumber)'`                                                                                     |

---

## Cleanup

When you're done with the lab:

```bash
# Option 1: Terraform (if you completed Section 10)
terraform destroy

# Option 2: Manual
# Delete Cloud Run service
gcloud run services delete nginx-falcon --region=$REGION --quiet

# Delete all images in GAR repo
gcloud artifacts docker images delete \
  ${REGION}-docker.pkg.dev/${PROJECT_ID}/falcon-lab --delete-tags --quiet

# Delete GAR repository
gcloud artifacts repositories delete falcon-lab \
  --location=$REGION --quiet

# Delete WIF provider and pool
gcloud iam workload-identity-pools providers delete github \
  --location=global \
  --workload-identity-pool=github-actions-pool --quiet

gcloud iam workload-identity-pools delete github-actions-pool \
  --location=global --quiet

# Delete service account
gcloud iam service-accounts delete \
  github-actions-falcon@${PROJECT_ID}.iam.gserviceaccount.com --quiet
```

---

_Created: 2026-06-15 | Topics: cloud-security, falcon-sensor, cloud-run, artifact-registry, github-actions, workload-identity-federation, image-patching, serverless_
