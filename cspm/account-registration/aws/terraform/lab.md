# AWS CSPM Account Registration — Terraform (Organization-Level)

Deploy CrowdStrike Falcon Cloud Security to an AWS Organization using the official Terraform module. Start locally, verify IOMs flowing, then promote to GitHub Actions for production CI/CD.

> **Prerequisites:**
>
> - AWS Organization with admin access to the management account
> - AWS CLI configured with profiles for each member account (or cross-account role assumption)
> - Terraform >= 1.5.0 installed
> - CrowdStrike Falcon console access (Falcon Cloud Security subscription)
> - CrowdStrike API client with **CSPM Registration: Read + Write** scope
> - GitHub repository (for Section 8: CI/CD promotion)
> - ~90 minutes

## Reference Docs

| Source | Link |
|--------|------|
| CrowdStrike Terraform Module (Registry) | https://registry.terraform.io/modules/CrowdStrike/cloud-registration/aws |
| CrowdStrike Terraform Provider | https://registry.terraform.io/providers/CrowdStrike/crowdstrike |
| Module Source (GitHub) | https://github.com/CrowdStrike/terraform-aws-cloud-registration |
| Register AWS Org Using Terraform (Docs) | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/o0ad9e78 |
| Plan Your AWS Registration (Docs) | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/d2f7e2d8 |
| AWS Organizations CLI Reference | https://docs.aws.amazon.com/cli/latest/reference/organizations/ |

---

## 1. Architecture Overview

> **~5 min | Intermediate**

When you register an AWS Organization with Falcon Cloud Security, the Terraform module creates infrastructure in a **host account** first (your designated scanning/security account), then deploys to member accounts. The host account centralizes agentless scanning resources while each member account gets its own IAM reader role for asset inventory.

### What Gets Created

| Account | Resources | Purpose |
|---------|-----------|---------|
| Host (Security) | IAM reader role, agentless scanning roles, VPC, NAT Gateway, subnets | Centralized scanning infra + asset discovery |
| Member accounts | IAM reader role | Asset discovery (CrowdStrike assumes this role to enumerate resources) |

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    AWS Organization (r-n7ay)                              │
│                    OU: cs-demo (ou-n7ay-d9wrawm5)                        │
│                                                                          │
│  ┌─────────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  Security (494873120176)        │  │  Development (934822761019)  │  │
│  │  HOST ACCOUNT                   │  │                              │  │
│  │  - IAM Reader Role              │  │  - IAM Reader Role           │  │
│  │  - Agentless Integration Role   │  └──────────────────────────────┘  │
│  │  - Agentless Scanner Role       │                                    │
│  │  - Scanner VPC + Subnets        │  ┌──────────────────────────────┐  │
│  │  - NAT Gateway                  │  │  Production (517728567948)   │  │
│  └────────────────┬────────────────┘  │                              │  │
│                   │                    │  - IAM Reader Role           │  │
│                   │ TLS 443            │  └──────────────────────────────┘  │
│                   ▼                    │                                    │
│  ┌─────────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  CrowdStrike Falcon Cloud       │  │  Sandbox (019313283882)      │  │
│  │  - Asset Inventory              │  │                              │  │
│  │  - IOM Assessment               │  │  - IAM Reader Role           │  │
│  │  - IOA Detection                │  └──────────────────────────────┘  │
│  └─────────────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Key concept:** The host account (Security) must be deployed **first** because member accounts reference its role IDs for centralized scanning. The IAM reader role in each account uses an external ID and intermediate role ARN provided by CrowdStrike — Terraform resolves these automatically via the CrowdStrike provider.

---

## Deployment Steps

<div data-mode="guide">

### 1. Set API Credentials

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export TF_VAR_falcon_client_id="$FALCON_CLIENT_ID"
export TF_VAR_falcon_client_secret="$FALCON_CLIENT_SECRET"
```

### 2. Configure Terraform Variables

Edit `terraform.tfvars` with your organization details:

```hcl
organization_id = "o-xxxxxxxxxx"
primary_region  = "us-east-1"
account_id      = "<host-account-id>"
```

### 3. Deploy

```bash
cd ~/projects/falcon-sensor-installs-workspace/cspm/account-registration/aws/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

For member accounts, repeat with `is_host_account=false`:

```bash
terraform workspace new <account-name> 2>/dev/null || terraform workspace select <account-name>
terraform apply -var="account_id=<member-account-id>" -var="is_host_account=false"
```

### 4. Verify

Navigate to **Falcon Console** > **Cloud security** > **Registration** and confirm all accounts show **IOM status: Active**.

</div>

<div data-mode="lab">

## 2. Create Falcon API Credentials

> **~10 min | Intermediate**

> **What & Why:** The CrowdStrike Terraform provider authenticates via OAuth2 API credentials. These credentials allow Terraform to look up your account's registration details (external ID, intermediate role ARN) and configure the module automatically.

- [ ] **Console:** Navigate to **Falcon Console** > **Support and resources** > **Resources and tools** > **API clients and keys**

- [ ] Click **Create API client** and configure:
  - Client name: `terraform-cspm-registration`
  - Description: `Terraform automation for CSPM account registration`
  - Scope: Check **CSPM Registration** > enable both **Read** and **Write**

- [ ] Copy the **Client ID** and **Client Secret** — you'll need these for Terraform variables

> **Important:** Store these credentials securely. Never commit them to version control. We'll use environment variables locally and GitHub Secrets for CI/CD.

- [ ] Set environment variables for local use:

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
```

---

## 3. Register Organization in Falcon Console

> **~10 min | Intermediate**

> **What & Why:** Before Terraform can deploy infrastructure, you must initiate the registration in the Falcon console. This tells CrowdStrike about your AWS Organization and generates the configuration (external IDs, role names) that Terraform will reference.

- [ ] **Console:** Navigate to **Falcon Console** > **Cloud security** > **Registration** > **AWS**

- [ ] Click **Register new account** > Select **Register an organization**

- [ ] Enter your organization details:
  - Organization ID: (auto-detected or enter manually)
  - Management account ID: select your management account
  - Host account: Select **494873120176** (Security)

- [ ] Under deployment method, select **Deploy Terraform templates**

- [ ] The console displays these instructions:

> 1. Download the Terraform template
> 2. Apply to the agentless scanning host account (494873120176) **first**
> 3. Apply to all other member accounts
> 4. Click Close — accounts will populate on the registration homepage

- [ ] Click **Download Terraform template** to get the pre-configured module

> **Note:** The downloaded template is pre-populated with your specific external IDs and account configuration. We'll replicate this using the public Terraform Registry module with variables, which is the recommended approach for CI/CD.

- [ ] Click **Close** to finish the wizard

---

## 4. Local Deploy: Host Account (Security — 494873120176)

> **~15 min | Intermediate**

> **What & Why:** The host account must be deployed first because it creates the agentless scanning roles and infrastructure that member accounts reference. This is the foundation that centralizes scanning operations.

### Step 1: Set up the Terraform project

- [ ] Navigate to the workspace directory:

```bash
cd ~/projects/falcon-sensor-installs-workspace/cspm/account-registration/aws/terraform
```

- [ ] Initialize Terraform:

```bash
terraform init
```

You should see:

```
Initializing provider plugins...
- Finding crowdstrike/crowdstrike versions matching ">= 0.0.58"...
- Finding hashicorp/aws versions matching ">= 5.0.0"...
- Installing crowdstrike/crowdstrike v0.7.2...
- Installing hashicorp/aws v5.x.x...
```

### Step 2: Configure variables for the host account

- [ ] Create `terraform.tfvars` (this file is gitignored):

```hcl
# terraform.tfvars — Host account deployment
falcon_client_id     = "" # Set via env: TF_VAR_falcon_client_id
falcon_client_secret = "" # Set via env: TF_VAR_falcon_client_secret

# AWS Organization
organization_id = "o-xxxxxxxxxx" # Your org ID from AWS Organizations console
primary_region  = "us-east-1"

# Host account
account_id = "494873120176"

# Feature toggles — IOMs are always enabled (base registration)
enable_sensor_management   = false
enable_realtime_visibility = false
enable_dspm                = false
enable_vulnerability_scanning = false

# Tags for resource identification
tags = {
  Environment = "security"
  ManagedBy   = "terraform"
  Purpose     = "crowdstrike-cspm"
}
```

> **Note:** For sensitive values, use environment variables instead of the tfvars file:
> ```bash
> export TF_VAR_falcon_client_id="$FALCON_CLIENT_ID"
> export TF_VAR_falcon_client_secret="$FALCON_CLIENT_SECRET"
> ```

### Step 3: Configure AWS credentials for the host account

- [ ] Ensure your AWS CLI can access the Security account (494873120176):

```bash
# Option A: Named profile
export AWS_PROFILE=security

# Option B: Assume role from management account
aws sts assume-role \
  --role-arn "arn:aws:iam::494873120176:role/OrganizationAccountAccessRole" \
  --role-session-name "terraform-cspm" \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
  --output text
```

- [ ] Verify you're operating in the correct account:

```bash
aws sts get-caller-identity
```

Expected output should show account `494873120176`.

### Step 4: Plan and apply

- [ ] Run `terraform plan` to preview what will be created:

```bash
terraform plan -out=tfplan
```

You should see resources like:
- `module.fcs_host.module.asset_inventory[0].aws_iam_role.reader`
- `module.fcs_host.module.asset_inventory[0].aws_iam_role_policy_attachment.security_audit`
- `module.fcs_host.module.asset_inventory[0].aws_iam_role_policy.inline_read`

- [ ] Apply the plan:

```bash
terraform apply tfplan
```

- [ ] Note the outputs — you'll need `integration_role_unique_id` for member accounts:

```bash
terraform output
```

---

## 5. Local Deploy: Member Accounts

> **~10 min | Intermediate**

> **What & Why:** Each member account needs its own IAM reader role so CrowdStrike can discover and assess resources. For organization-level registration, these roles are lighter — just asset inventory, no scanning infra.

### Step 1: Deploy to Development (934822761019)

- [ ] Switch AWS credentials to the Development account:

```bash
export AWS_PROFILE=development
# Or assume role:
eval $(aws sts assume-role \
  --role-arn "arn:aws:iam::934822761019:role/OrganizationAccountAccessRole" \
  --role-session-name "terraform-cspm" \
  --query 'Credentials | join(" ", [join("=",["export AWS_ACCESS_KEY_ID",AccessKeyId]), join("=",["export AWS_SECRET_ACCESS_KEY",SecretAccessKey]), join("=",["export AWS_SESSION_TOKEN",SessionToken])])' \
  --output text)
```

- [ ] Apply using the member workspace (uses the same module with different variables):

```bash
terraform workspace new development 2>/dev/null || terraform workspace select development
terraform apply -var="account_id=934822761019" -var="is_host_account=false"
```

### Step 2: Deploy to Production (517728567948)

- [ ] Switch to Production account and apply:

```bash
terraform workspace new production 2>/dev/null || terraform workspace select production
# Switch AWS credentials to production account
terraform apply -var="account_id=517728567948" -var="is_host_account=false"
```

### Step 3: Deploy to Sandbox (019313283882)

- [ ] Switch to Sandbox account and apply:

```bash
terraform workspace new sandbox 2>/dev/null || terraform workspace select sandbox
# Switch AWS credentials to sandbox account
terraform apply -var="account_id=019313283882" -var="is_host_account=false"
```

> **Alternative approach:** Instead of workspaces, you can use separate `.tfvars` files per account. The GitHub Actions workflow in Section 8 uses a matrix strategy which is cleaner for CI/CD.

---

## 6. Verify in Falcon Console

> **~5 min | Intermediate**

> **What & Why:** After Terraform deploys the IAM roles, CrowdStrike begins discovering resources and running IOM assessments. Verification confirms the trust relationship is working correctly.

- [ ] **Console:** Navigate to **Falcon Console** > **Cloud security** > **Registration**

- [ ] Verify all 4 accounts show with **IOM status: Active**:

| Account | Account ID | Expected Status |
|---------|-----------|-----------------|
| Security (Host) | 494873120176 | Active |
| Development | 934822761019 | Active |
| Production | 517728567948 | Active |
| Sandbox | 019313283882 | Active |

- [ ] Navigate to **Cloud security** > **Dashboards** > **Cloud posture**

- [ ] Check that IOMs are populating (may take 5-15 minutes for first scan):
  - Misconfigurations should start appearing grouped by severity
  - Resource inventory should show discovered AWS resources

<details>
<summary>Troubleshooting: Account shows "Inactive"</summary>

1. Verify the IAM role exists in the target account:
```bash
aws iam get-role --role-name CrowdStrikeCSPMReader --profile <account-profile>
```

2. Check the trust policy includes the correct external ID:
```bash
aws iam get-role --role-name CrowdStrikeCSPMReader --query 'Role.AssumeRolePolicyDocument' --profile <account-profile>
```

3. Confirm `SecurityAudit` policy is attached:
```bash
aws iam list-attached-role-policies --role-name CrowdStrikeCSPMReader --profile <account-profile>
```

4. If the role was created but isn't being assumed, the external ID in the trust policy may not match. Re-run `terraform apply` to reconcile.

</details>

---

## 7. Day-2: Add a New Account & Register

> **~15 min | Intermediate**

> **What & Why:** In a real organization, new accounts get created regularly. This section walks through adding a new account to your OU and extending CSPM coverage to it — the exact workflow you'll repeat for every new account.

### Step 1: Create a new AWS account in the organization

- [ ] Create the account via AWS CLI:

```bash
aws organizations create-account \
  --email "loratusp72.aws5@gmail.com" \
  --account-name "Staging" \
  --iam-user-access-to-billing ALLOW
```

- [ ] Wait for the account to be created (check status):

```bash
aws organizations describe-create-account-status \
  --create-account-request-id <request-id-from-previous-command>
```

- [ ] Move the new account into the `cs-demo` OU:

```bash
# Get the new account ID from the output
NEW_ACCOUNT_ID="<new-12-digit-id>"

aws organizations move-account \
  --account-id $NEW_ACCOUNT_ID \
  --source-parent-id r-n7ay \
  --destination-parent-id ou-n7ay-d9wrawm5
```

### Step 2: Deploy CSPM registration to the new account

- [ ] Create a new workspace and apply:

```bash
cd ~/projects/falcon-sensor-installs-workspace/cspm/account-registration/aws/terraform

terraform workspace new staging 2>/dev/null || terraform workspace select staging
```

- [ ] Assume role into the new account and apply:

```bash
# The OrganizationAccountAccessRole is auto-created for accounts created via Organizations
eval $(aws sts assume-role \
  --role-arn "arn:aws:iam::${NEW_ACCOUNT_ID}:role/OrganizationAccountAccessRole" \
  --role-session-name "terraform-cspm" \
  --query 'Credentials | join(" ", [join("=",["export AWS_ACCESS_KEY_ID",AccessKeyId]), join("=",["export AWS_SECRET_ACCESS_KEY",SecretAccessKey]), join("=",["export AWS_SESSION_TOKEN",SessionToken])])' \
  --output text)

terraform apply -var="account_id=${NEW_ACCOUNT_ID}" -var="is_host_account=false"
```

### Step 3: Verify the new account

- [ ] **Console:** Navigate to **Cloud security** > **Registration** > verify the new account appears with **Active** status

- [ ] IOMs should begin populating within 5-15 minutes for the new account

> **For GitHub Actions (Section 8):** Adding a new account is as simple as adding its ID to the `accounts` matrix in the workflow file and pushing. The pipeline handles the rest.

---

## 8. Promote to GitHub Actions

> **~20 min | Intermediate**

> **What & Why:** Local `terraform apply` doesn't scale — you need approval gates, audit trails, and automated drift detection. This section converts the local workflow into a GitHub Actions pipeline using OIDC (no long-lived AWS keys) and a matrix strategy for multi-account deployment.

### Step 1: Set up OIDC trust between GitHub and AWS

> **What & Why:** Instead of storing long-lived AWS access keys in GitHub Secrets, OIDC lets GitHub Actions request short-lived credentials by proving its identity to AWS. This is the AWS-recommended approach.

- [ ] Create the OIDC provider in your management account (one-time setup):

```bash
aws iam create-open-id-connect-provider \
  --url "https://token.actions.githubusercontent.com" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"
```

- [ ] Create an IAM role for GitHub Actions to assume:

```bash
cat > /tmp/github-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::494873120176:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<YOUR_ORG>/<YOUR_REPO>:*"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name GitHubActions-CSPM-Deployer \
  --assume-role-policy-document file:///tmp/github-trust-policy.json
```

- [ ] Attach permissions (the role needs to create IAM roles in member accounts):

```bash
aws iam attach-role-policy \
  --role-name GitHubActions-CSPM-Deployer \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

> **In production:** Use a scoped policy instead of AdministratorAccess. The minimum required permissions are: `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:GetRole`, `iam:ListAttachedRolePolicies`, `sts:AssumeRole`.

### Step 2: Add secrets to GitHub repository

- [ ] Navigate to your GitHub repository > **Settings** > **Secrets and variables** > **Actions**

- [ ] Add the following repository secrets:

| Secret Name | Value |
|-------------|-------|
| `FALCON_CLIENT_ID` | Your CrowdStrike API Client ID |
| `FALCON_CLIENT_SECRET` | Your CrowdStrike API Client Secret |
| `AWS_ROLE_ARN` | `arn:aws:iam::494873120176:role/GitHubActions-CSPM-Deployer` |
| `AWS_ORG_ID` | Your AWS Organization ID |

### Step 3: Create the repository structure

- [ ] Set up the repo structure for multi-account Terraform:

```
cspm-registration/
├── .github/
│   └── workflows/
│       └── cspm-deploy.yml
├── modules/
│   └── account-registration/
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── providers.tf
├── accounts.json            # Account inventory
├── backend.tf               # S3 remote state
└── README.md
```

- [ ] Create `accounts.json` — the source of truth for which accounts to register:

```json
{
  "host_account": "494873120176",
  "member_accounts": [
    { "id": "934822761019", "name": "development" },
    { "id": "517728567948", "name": "production" },
    { "id": "019313283882", "name": "sandbox" }
  ]
}
```

### Step 4: Create the GitHub Actions workflow

- [ ] Create `.github/workflows/cspm-deploy.yml`:

```yaml
name: Deploy CSPM Registration

on:
  push:
    branches: [main]
    paths:
      - 'cspm-registration/**'
      - '.github/workflows/cspm-deploy.yml'
  pull_request:
    branches: [main]
    paths:
      - 'cspm-registration/**'

permissions:
  id-token: write   # Required for OIDC
  contents: read
  pull-requests: write

env:
  TF_VAR_falcon_client_id: ${{ secrets.FALCON_CLIENT_ID }}
  TF_VAR_falcon_client_secret: ${{ secrets.FALCON_CLIENT_SECRET }}
  TF_VAR_organization_id: ${{ secrets.AWS_ORG_ID }}
  AWS_REGION: us-east-1

jobs:
  # ---------------------------------------------------------
  # Job 1: Deploy to host account FIRST (required before members)
  # ---------------------------------------------------------
  deploy-host:
    name: "Host: Security (494873120176)"
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    outputs:
      integration_role_id: ${{ steps.apply.outputs.integration_role_id }}
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~> 1.5"

      - name: Terraform Init
        working-directory: cspm-registration
        run: terraform init

      - name: Terraform Apply (Host)
        id: apply
        working-directory: cspm-registration
        run: |
          terraform workspace new host 2>/dev/null || terraform workspace select host
          terraform apply -auto-approve \
            -var="account_id=494873120176" \
            -var="is_host_account=true"
          echo "integration_role_id=$(terraform output -raw integration_role_unique_id)" >> "$GITHUB_OUTPUT"

  # ---------------------------------------------------------
  # Job 2: Deploy to all member accounts (parallel via matrix)
  # ---------------------------------------------------------
  deploy-members:
    name: "Member: ${{ matrix.account.name }}"
    runs-on: ubuntu-latest
    needs: deploy-host
    if: github.event_name == 'push'
    strategy:
      matrix:
        account:
          - { id: "934822761019", name: "development" }
          - { id: "517728567948", name: "production" }
          - { id: "019313283882", name: "sandbox" }
      fail-fast: false
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~> 1.5"

      - name: Assume role into member account
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: "arn:aws:iam::${{ matrix.account.id }}:role/OrganizationAccountAccessRole"
          aws-region: ${{ env.AWS_REGION }}
          role-chaining: true

      - name: Terraform Init & Apply
        working-directory: cspm-registration
        run: |
          terraform init
          terraform workspace new ${{ matrix.account.name }} 2>/dev/null || terraform workspace select ${{ matrix.account.name }}
          terraform apply -auto-approve \
            -var="account_id=${{ matrix.account.id }}" \
            -var="is_host_account=false"

  # ---------------------------------------------------------
  # Job 3: Plan-only on pull requests (no apply)
  # ---------------------------------------------------------
  plan:
    name: "Plan: ${{ matrix.account.name }}"
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    strategy:
      matrix:
        account:
          - { id: "494873120176", name: "host" }
          - { id: "934822761019", name: "development" }
          - { id: "517728567948", name: "production" }
          - { id: "019313283882", name: "sandbox" }
      fail-fast: false
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~> 1.5"

      - name: Terraform Init & Plan
        working-directory: cspm-registration
        run: |
          terraform init
          terraform workspace new ${{ matrix.account.name }} 2>/dev/null || terraform workspace select ${{ matrix.account.name }}
          terraform plan \
            -var="account_id=${{ matrix.account.id }}" \
            -var="is_host_account=${{ matrix.account.id == '494873120176' }}"
```

### Step 5: Adding a new account (Day-2 with CI/CD)

> **What & Why:** With the pipeline in place, onboarding a new account is a one-line change — add the account to the matrix and push. No local Terraform required.

- [ ] Add the new account to the matrix in `cspm-deploy.yml`:

```yaml
# Under deploy-members > strategy > matrix > account, add:
- { id: "<new-account-id>", name: "staging" }
```

- [ ] Also add to the `plan` job matrix:

```yaml
- { id: "<new-account-id>", name: "staging" }
```

- [ ] Commit and push:

```bash
git add .github/workflows/cspm-deploy.yml
git commit -m "feat: register staging account with CSPM"
git push
```

The pipeline will automatically deploy to the new account on merge to `main`.

---

## 9. Cleanup

> **~5 min | Intermediate**

> **What & Why:** Destroy resources in reverse order — member accounts first, then host. This avoids dependency errors where member accounts reference host account role IDs.

- [ ] Destroy member accounts first:

```bash
cd ~/projects/falcon-sensor-installs-workspace/cspm/account-registration/aws/terraform

for ws in development production sandbox; do
  terraform workspace select $ws
  terraform destroy -auto-approve -var="account_id=<account-id>" -var="is_host_account=false"
done
```

- [ ] Then destroy the host account:

```bash
terraform workspace select default
terraform destroy -auto-approve
```

- [ ] Deregister from Falcon Console:
  - Navigate to **Cloud security** > **Registration**
  - Select all accounts > **Actions** > **Delete**

</div>

---

## 10. Optional Features

> The following features can be enabled by changing variables in `terraform.tfvars`. Each adds additional AWS resources beyond the base IAM reader role.

<details>
<summary>Enable Real-Time Visibility & Detection (IOAs)</summary>

### What it adds

- CloudTrail (or uses existing)
- EventBridge rules (write events + read events)
- EventBridge IAM role to forward events to CrowdStrike

### Configuration

```hcl
# In terraform.tfvars
enable_realtime_visibility = true
use_existing_cloudtrail    = true  # Set to true if you already have an org-level trail
```

### For GitHub Actions

Add this variable to both the host and member apply steps:

```yaml
terraform apply -auto-approve \
  -var="account_id=${{ matrix.account.id }}" \
  -var="is_host_account=false" \
  -var="enable_realtime_visibility=true" \
  -var="use_existing_cloudtrail=true"
```

> **Note:** If you don't have an existing CloudTrail, set `use_existing_cloudtrail = false` and the module will create one. This adds cost (~$2/month per 100K events).

</details>

<details>
<summary>Enable Sensor Management (1-Click Install)</summary>

### What it adds

- Lambda function (sensor installation orchestrator)
- IAM role for Lambda execution
- Secrets Manager secret (Falcon API credentials)
- CloudWatch Log Group (1-day retention)
- SSM document management role

### Configuration

```hcl
# In terraform.tfvars
enable_sensor_management = true
```

### Additional API scope required

Your Falcon API client needs an additional scope:
- **Sensor Management: Read + Write**

Update your API client in the Falcon console before applying.

</details>

<details>
<summary>Enable DSPM & Vulnerability Scanning</summary>

### What it adds (host account only)

- Integration Role (`CrowdStrikeAgentlessScanningIntegrationRole`)
- Scanner Role (`CrowdStrikeAgentlessScanningScannerRole`)
- Instance Profile for scanner EC2 instances
- VPC with private subnets (scanner + database tiers)
- NAT Gateway (for scanner outbound connectivity)
- Security Groups
- DB Subnet Group + Redshift Subnet Group
- SSM Parameter (`/CrowdStrike/AgentlessScanning/Root`)
- Secrets Manager secret (`CrowdStrikeDSPMClientSecret`)

### Configuration

```hcl
# In terraform.tfvars
enable_dspm                    = true
enable_vulnerability_scanning  = true
agentless_scanning_regions     = ["us-east-1"]

# Optional: disable NAT Gateway to save cost in lab environments
agentless_scanning_create_nat_gateway = true

# Control which data stores are scanned
dspm_s3_access       = true
dspm_dynamodb_access = true
dspm_rds_access      = true
dspm_redshift_access = false  # Disable if you don't use Redshift
dspm_ebs_access      = true
```

### Cost impact

- NAT Gateway: ~$32/month per region
- VPC resources: Minimal
- Scanner instances (launched by CrowdStrike on demand): Variable

> **In production:** Use `agentless_scanning_regions` to limit scanning to regions where you have workloads. Each region creates a separate VPC + NAT Gateway.

</details>

---

## 11. Challenges

### Challenge 1: Drift Detection Workflow

**Scenario:** Your security team wants to be alerted if someone manually deletes or modifies the CrowdStrike IAM roles. Create a scheduled GitHub Actions workflow that runs `terraform plan` nightly and opens an issue if drift is detected.

<details>
<summary>Hint</summary>

Use `on: schedule` with a cron expression and the `github-script` action to create issues. Check `terraform plan -detailed-exitcode` — exit code 2 means changes detected.

</details>

<details>
<summary>Solution</summary>

```yaml
name: CSPM Drift Detection
on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 6 AM UTC

jobs:
  detect-drift:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        account:
          - { id: "494873120176", name: "host" }
          - { id: "934822761019", name: "development" }
          - { id: "517728567948", name: "production" }
          - { id: "019313283882", name: "sandbox" }
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - uses: hashicorp/setup-terraform@v3

      - name: Check for drift
        id: plan
        continue-on-error: true
        working-directory: cspm-registration
        run: |
          terraform init
          terraform workspace select ${{ matrix.account.name }}
          terraform plan -detailed-exitcode \
            -var="account_id=${{ matrix.account.id }}" \
            -var="is_host_account=${{ matrix.account.id == '494873120176' }}"

      - name: Create issue on drift
        if: steps.plan.outcome == 'failure'
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `CSPM Drift Detected: ${{ matrix.account.name }} (${{ matrix.account.id }})`,
              body: 'Terraform plan detected changes in the CSPM registration for this account. Please investigate.',
              labels: ['drift', 'security']
            })
```

</details>

### Challenge 2: Branch Protection + Plan-Only on PR

**Scenario:** You want to enforce that no one can push directly to `main` — all changes must go through a PR where the plan output is visible as a comment.

<details>
<summary>Hint</summary>

Use the `terraform plan` output with `actions/github-script` to post the plan as a PR comment. Set up branch protection rules requiring the plan job to pass before merge.

</details>

<details>
<summary>Solution</summary>

Add this step to the `plan` job after `terraform plan`:

```yaml
      - name: Post plan to PR
        uses: actions/github-script@v7
        with:
          script: |
            const output = `#### Terraform Plan: \`${{ matrix.account.name }}\`
            \`\`\`
            ${process.env.PLAN_OUTPUT}
            \`\`\`
            *Pushed by: @${{ github.actor }}*`;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: output
            })
```

Then in GitHub > Settings > Branches > Add rule for `main`:
- Require PR before merge
- Require status checks: all `plan` jobs must pass

</details>

---

## 12. Quick Reference

| Variable | Value | Where Used |
|----------|-------|------------|
| `falcon_client_id` | (from API client) | CrowdStrike provider auth |
| `falcon_client_secret` | (from API client) | CrowdStrike provider auth |
| `organization_id` | Your AWS Org ID | Module: org-level registration |
| `primary_region` | `us-east-1` | Where IAM roles are created |
| Host account | `494873120176` | Deploy first, scanning infra |
| Development | `934822761019` | Member — IAM reader only |
| Production | `517728567948` | Member — IAM reader only |
| Sandbox | `019313283882` | Member — IAM reader only |
| OU | `ou-n7ay-d9wrawm5` (cs-demo) | Where new accounts go |

### Deploy Order

```
1. Host account (494873120176)  ←  ALWAYS first
2. Member accounts (any order)  ←  Can be parallel
```

### API Scopes Required

| Scope | Required For |
|-------|-------------|
| CSPM Registration: Read + Write | Always (base registration) |
| Sensor Management: Read + Write | Only if `enable_sensor_management = true` |

### Key Terraform Commands

```bash
terraform init                              # Download providers
terraform plan -out=tfplan                  # Preview changes
terraform apply tfplan                      # Deploy
terraform destroy                           # Tear down
terraform workspace list                    # Show all workspaces
terraform workspace select <name>           # Switch account context
terraform output integration_role_unique_id # Get role ID for members
```

---

*Created: 2026-06-18 | Topics: cspm, aws, terraform, github-actions, organization-registration, iac*
