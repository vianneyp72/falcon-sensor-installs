# FCS CLI Image Scanning with GitHub Actions

Scan container images for vulnerabilities in your CI/CD pipeline using the CrowdStrike FCS CLI via GitHub Actions. Only images that pass your Image Assessment Policy get pushed to the registry.

Official GH: https://github.com/CrowdStrike/fcs-action
Official Docs: https://docs.crowdstrike.com/r/en-US/qg0ygdwl/mac3b7b7

> **Performance note:** The FCS CLI sends only package inventories to CrowdStrike for assessment — your image content never leaves the runner. Typical scan time is 30-90 seconds depending on image size and layer count.

> **Prerequisites:**
> - GitHub account with a repository you control
> - CrowdStrike Falcon Cloud Security subscription
> - API client credentials with scopes: **Falcon Container CLI (R/W)**, **Falcon Container Image (R/W)**, **Cloud Security Tools Download (R)**
> - Docker installed locally (for testing the build)
> - ~45 minutes

## Reference Docs

| Source | Link |
|--------|------|
| CrowdStrike fcs-action | https://github.com/CrowdStrike/fcs-action |
| Image Assessment with FCS CLI | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/mac3b7b7 |
| CI/CD Pipeline Integration | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/wc4a46fa |
| Shift Security Left | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/eb7306b8 |
| GitHub Actions Encrypted Secrets | https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions |
| GitHub Container Registry (ghcr.io) | https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry |

---

## Architecture

```
GitHub Actions Runner ── fcs-action ── Image Assessment
  docker build         scan image       CrowdStrike Cloud
       │                   │                   │
       ▼                   ▼                   ▼
  Local Image ──────► Inventory Only ────► Pass/Fail
       │                                       │
       ▼                                       ▼
  Push to ghcr.io ◄──── Gate (exit code 0) ────┘
```

---

## Deployment Steps

<div data-mode="guide">

### 1. Add CrowdStrike Secrets to GitHub Repo

Navigate to your repo > **Settings** > **Secrets and variables** > **Actions** and add:

| Type | Name | Value |
|------|------|-------|
| Secret | `FALCON_CLIENT_SECRET` | Your CrowdStrike API client secret |
| Variable | `FALCON_CLIENT_ID` | Your CrowdStrike API client ID |
| Variable | `FALCON_REGION` | Your CrowdStrike cloud (e.g., `us-1`) |

### 2. Add the `fcs-action` Step to Your Workflow

Add this step after your `docker build` step:

```yaml
      - name: CrowdStrike FCS Image Scan
        uses: crowdstrike/fcs-action@v4
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          scan_type: image
          image: <your-image>:<tag>
          report_formats: json
          output_path: ./fcs-results.json
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}
```

### 3. Push and Check Results

```bash
git add .github/workflows/<your-workflow>.yml
git commit -m "add fcs-action image scan"
git push
```

Check results in **Actions** tab or in the Falcon console under **Cloud Security** > **Image Assessment** > **CI Images**.

</div>

<div data-mode="lab">

### 1. Create the Demo Flask App

> **~10 min | Beginner**

> **What & Why:** We need a simple app with a Dockerfile to build. We'll intentionally pin an older version of a package so the scan has something to flag.

Create a new directory for the project:

```bash
mkdir fcs-scan-demo && cd fcs-scan-demo
```

#### app.py

```python
from flask import Flask

app = Flask(__name__)

@app.route("/")
def hello():
    return "<h1>FCS Scan Demo</h1><p>This image passed CrowdStrike image assessment.</p>"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
```

#### requirements.txt (intentionally vulnerable)

```
flask==2.3.2
werkzeug==2.3.3
jinja2==3.1.2
```

> **What this does:** These pinned versions contain known CVEs (e.g., Werkzeug 2.3.3 has GHSA-2g68-c3qc-8985). This ensures the scanner has findings to report when we test the "fail" case.

#### Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 5000
CMD ["python", "app.py"]
```

#### Verify the build locally

```bash
docker build -t fcs-scan-demo:local .
docker run --rm -p 5000:5000 fcs-scan-demo:local
# Visit http://localhost:5000 — then Ctrl+C to stop
```

---

### 2. Create the GitHub Repository

> **~10 min | Beginner**

> **What & Why:** The GitHub Actions workflow runs on push events in this repo. We also need to configure the CrowdStrike API credentials as repository secrets.

#### Initialize and push

```bash
git init
git add app.py requirements.txt Dockerfile
git commit -m "initial commit: demo flask app"
```

Create the repo on GitHub (using `gh` CLI or the web UI):

```bash
gh repo create fcs-scan-demo --private --source=. --push
```

#### Configure secrets

Add your CrowdStrike API credentials as repository secrets:

```bash
gh secret set FALCON_CLIENT_SECRET
# Paste your API client secret when prompted

gh variable set FALCON_CLIENT_ID --body "YOUR_CLIENT_ID_HERE"
gh variable set FALCON_REGION --body "us-1"
```

> **What this does:** `FALCON_CLIENT_SECRET` is stored encrypted as a GitHub Secret (never logged). `FALCON_CLIENT_ID` and `FALCON_REGION` are stored as variables (non-sensitive, visible in logs). The region must match your Falcon tenant: `us-1`, `us-2`, or `eu-1`.

---

### 3. Write the GitHub Actions Workflow

> **~15 min | Intermediate**

> **What & Why:** This is the core of the lab — a workflow that builds your image, scans it with CrowdStrike's fcs-action, and only pushes to ghcr.io if the image has no fixable HIGH/CRITICAL vulnerabilities.

Create the workflow file:

```bash
mkdir -p .github/workflows
```

#### .github/workflows/build-scan-push.yml

```yaml
name: Build, Scan & Push

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  IMAGE_NAME: ghcr.io/${{ github.repository }}
  IMAGE_TAG: ${{ github.sha }}

jobs:
  build-scan-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Build container image
        run: |
          docker build -t ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }} .

      - name: CrowdStrike FCS Image Scan
        id: fcs-scan
        uses: crowdstrike/fcs-action@v4
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          scan_type: image
          image: ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}
          fail_on: high
          policy_rule: fail
          report_formats: json
          output_path: ./fcs-results.json
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Locate report
        if: always()
        run: |
          if [ -f "./fcs-results.json" ]; then
            echo "report_found=true" >> $GITHUB_ENV
          else
            echo "report_found=false" >> $GITHUB_ENV
            echo "::warning::No report file found"
          fi

      - name: Gate - fail on fixable high or critical vulnerabilities
        if: env.report_found == 'true'
        run: |
          # Only count vulns where a fix version exists (not "No fix" or null)
          FIXABLE_COUNT=$(jq '[.. | objects | select((.severity? == "HIGH" or .severity? == "CRITICAL") and .fix_version? != null and .fix_version? != "" and (.fix_version? | tostring | test("No fix") | not))] | length' ./fcs-results.json 2>/dev/null || echo "0")

          # Total HIGH/CRITICAL for info
          TOTAL_COUNT=$(jq '[.. | objects | select(.severity? == "HIGH" or .severity? == "CRITICAL")] | length' ./fcs-results.json 2>/dev/null || echo "0")

          echo "Total HIGH/CRITICAL: $TOTAL_COUNT"
          echo "Fixable HIGH/CRITICAL: $FIXABLE_COUNT"

          if [ "$FIXABLE_COUNT" -gt "0" ]; then
            echo "::error::Image has $FIXABLE_COUNT fixable HIGH/CRITICAL vulnerabilities. Blocking push."
            echo "## Scan Results" >> $GITHUB_STEP_SUMMARY
            echo "**BLOCKED:** $FIXABLE_COUNT fixable HIGH/CRITICAL vulnerabilities (out of $TOTAL_COUNT total)" >> $GITHUB_STEP_SUMMARY
            exit 1
          else
            echo "No fixable HIGH/CRITICAL vulnerabilities. Passing (${TOTAL_COUNT} unfixable OS-level findings ignored)."
          fi

      - name: Log in to ghcr.io
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Push image to ghcr.io
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: |
          docker push ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}
          docker tag ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }} ${{ env.IMAGE_NAME }}:latest
          docker push ${{ env.IMAGE_NAME }}:latest
```

> **What this does:**
> 1. Builds the image locally on the runner
> 2. Runs FCS CLI scan — only the package inventory is sent to CrowdStrike
> 3. Parses the JSON report to count fixable HIGH/CRITICAL vulnerabilities
> 4. Gates: if any fixable HIGH/CRITICAL vulns exist, the workflow fails and the push never happens
> 5. On pass: logs into ghcr.io and pushes the image with SHA and `latest` tags

> **Important:** The `fcs-action` exit code for image scans is controlled by the **Image Assessment Policy** in the Falcon console, not by the `fail_on` parameter (which only works for IaC scans). That's why we parse the JSON report ourselves to enforce a severity gate. Unfixable OS-level CVEs (glibc, perl, etc.) are excluded so developers aren't blocked on issues they can't resolve.

#### Commit and push the workflow

```bash
git add .github/workflows/build-scan-push.yml
git commit -m "add fcs-action image scan workflow"
git push
```

---

### 4. Test the Gate — Fail Case

> **~10 min | Intermediate**

> **What & Why:** The first run should FAIL because our `requirements.txt` pins vulnerable packages with known fixable CVEs. This proves the gate is working — vulnerable images never reach ghcr.io.

#### Watch the workflow run

```bash
gh run watch
```

Or open the Actions tab in your browser:

```bash
gh browse --settings  # navigate to Actions tab
```

#### Expected result

The workflow should fail at the "Gate - fail on fixable high or critical vulnerabilities" step with output like:

```
Total HIGH/CRITICAL: 42
Fixable HIGH/CRITICAL: 5
Error: Image has 5 fixable HIGH/CRITICAL vulnerabilities. Blocking push.
```

The scan finds many total HIGH/CRITICAL CVEs (mostly unfixable OS-level packages in the base image), but only blocks on the ones **you can actually fix** — the vulnerable Flask, Werkzeug, and Jinja2 packages.

#### Verify no image was pushed

```bash
gh api user/packages/container/fcs-scan-demo/versions 2>&1 | head -5
# Should return 404 or empty — no versions exist yet
```

#### View findings in Falcon console

Navigate to **Cloud Security** > **Image Assessment** > **CI Images** in the Falcon console. You'll see your scanned image with its vulnerabilities listed — CrowdStrike severity, NVD/CVSS severity, affected packages, and available fixes.

---

### 5. Fix Vulnerabilities & Pass

> **~10 min | Intermediate**

> **What & Why:** Now we update the vulnerable packages so the image passes assessment. This demonstrates the developer feedback loop — fix locally, push, scan passes, image reaches registry.

#### Update requirements.txt

Replace the contents with updated versions:

```
flask==3.1.1
werkzeug==3.1.3
jinja2==3.1.6
```

#### Commit and push

```bash
git add requirements.txt
git commit -m "fix: upgrade packages to resolve CVEs"
git push
```

#### Watch it pass

```bash
gh run watch
```

#### Expected result

The gate step should output:

```
Total HIGH/CRITICAL: 37
Fixable HIGH/CRITICAL: 0
No fixable HIGH/CRITICAL vulnerabilities. Passing (37 unfixable OS-level findings ignored).
```

All steps pass. The remaining HIGH/CRITICAL findings are unfixable OS-level CVEs in the `python:3.11-slim` base image (glibc, perl, ncurses, etc.) — these can't be resolved by the app developer and are correctly ignored.

#### Verify the image exists in ghcr.io

```bash
gh api user/packages/container/fcs-scan-demo/versions --jq '.[0].metadata.container.tags'
# Should show: ["<sha>", "latest"]
```

#### Verify in Falcon console

Back in **Cloud Security** > **Image Assessment** > **CI Images**, the latest scan should show the image with only non-actionable findings remaining.

---

### 6. Cleanup

Remove all resources created during this lab:

```bash
# Delete the GitHub repository
gh repo delete fcs-scan-demo --yes

# Or if you want to keep the repo, just delete the package:
gh api -X DELETE user/packages/container/fcs-scan-demo 2>/dev/null

# Clean up local directory
cd ..
rm -rf fcs-scan-demo
```

</div>

---

## Optional Enhancements

> **~10 min | Advanced**

> **What & Why:** Production pipelines typically add PR annotations, scan result comments, and badges so developers get feedback without leaving GitHub.

### Add PR comment with scan results

Add this step after the scan (requires `pull-requests: write` permission):

```yaml
      - name: Comment scan results on PR
        if: github.event_name == 'pull_request' && always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const exitCode = '${{ steps.fcs-scan.outputs.exit-code }}';
            const status = exitCode === '0' ? 'PASSED' : 'FAILED';
            const icon = exitCode === '0' ? ':white_check_mark:' : ':x:';
            const body = `## ${icon} CrowdStrike Image Scan: ${status}\n\n` +
              `**Image:** \`${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}\`\n` +
              `**Exit Code:** ${exitCode}\n\n` +
              `View full results in the [Security tab](/${process.env.GITHUB_REPOSITORY}/security/code-scanning).`;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body,
            });
```

### Add a scan status badge to README

Add to your repo's `README.md`:

```markdown
![Image Scan](https://github.com/YOUR_USER/fcs-scan-demo/actions/workflows/build-scan-push.yml/badge.svg)
```

### Multi-architecture builds

For production images targeting both amd64 and arm64:

```yaml
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build multi-arch image
        run: |
          docker buildx build \
            --platform linux/amd64,linux/arm64 \
            --tag ${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }} \
            --load .
```

---

## FCS CLI Exit Codes

| Exit Code | Meaning | Pipeline Action |
|-----------|---------|----------------|
| `0` | Scan completed successfully | Report generated (does NOT mean "no vulns") |
| `1` | Scan error or policy violation | Fail the pipeline |
| `201` | Authentication error | Fail — check credentials |
| `202` | Connection timeout | Fail — check network/region |
| `203` | Image not found | Fail — check image name/tag |
| `204` | Invalid input | Fail — check workflow config |

> **Important:** For image scans, exit code `0` means the scan completed and the report was generated — it does NOT mean the image is free of vulnerabilities. The `fail_on` parameter only works for IaC scans. For image scans, you must parse the JSON report to enforce your own severity gate (as shown in the workflow above).

---

## Challenges

### Challenge 1: Add severity threshold per branch

**Scenario:** Your team wants to allow medium-severity vulnerabilities through in dev environments but block everything high/critical on `main`. Modify the gate step to use different thresholds per branch.

<details>
<summary>Hint</summary>

Since the gate is a bash step parsing JSON, you can change the `jq` filter based on `$GITHUB_REF`. On feature branches, only check for CRITICAL. On main, check for HIGH or CRITICAL.

</details>

<details>
<summary>Solution</summary>

Replace the gate step's severity filter with branch-aware logic:

```yaml
      - name: Gate - severity threshold
        if: env.report_found == 'true'
        run: |
          if [ "$GITHUB_REF" = "refs/heads/main" ]; then
            SEVERITY_FILTER='(.severity? == "HIGH" or .severity? == "CRITICAL")'
            echo "Branch: main — blocking on HIGH and CRITICAL"
          else
            SEVERITY_FILTER='(.severity? == "CRITICAL")'
            echo "Branch: feature — blocking on CRITICAL only"
          fi

          FIXABLE_COUNT=$(jq "[.. | objects | select(${SEVERITY_FILTER} and .fix_version? != null and .fix_version? != \"\" and (.fix_version? | tostring | test(\"No fix\") | not))] | length" ./fcs-results.json 2>/dev/null || echo "0")

          if [ "$FIXABLE_COUNT" -gt "0" ]; then
            echo "::error::Image has $FIXABLE_COUNT fixable vulnerabilities above threshold."
            exit 1
          fi
```

</details>

---

### Challenge 2: Scheduled re-scanning

**Scenario:** New CVEs are discovered daily. An image that passed last week might be vulnerable today. Add a scheduled workflow that re-scans your latest published image nightly.

<details>
<summary>Hint</summary>

Use `on: schedule` with a cron expression. Pull the already-published image from ghcr.io (don't rebuild) and scan it.

</details>

<details>
<summary>Solution</summary>

Create `.github/workflows/nightly-rescan.yml`:

```yaml
name: Nightly Image Re-scan

on:
  schedule:
    - cron: '0 6 * * *'  # 6 AM UTC daily

jobs:
  rescan:
    runs-on: ubuntu-latest
    permissions:
      packages: read

    steps:
      - name: Log in to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Pull latest image
        run: docker pull ghcr.io/${{ github.repository }}:latest

      - name: CrowdStrike FCS Scan
        uses: crowdstrike/fcs-action@v4
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          scan_type: image
          image: ghcr.io/${{ github.repository }}:latest
          report_formats: json
          output_path: ./rescan-results.json
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Check for new fixable vulnerabilities
        run: |
          FIXABLE_COUNT=$(jq '[.. | objects | select((.severity? == "HIGH" or .severity? == "CRITICAL") and .fix_version? != null and .fix_version? != "" and (.fix_version? | tostring | test("No fix") | not))] | length' ./rescan-results.json 2>/dev/null || echo "0")
          if [ "$FIXABLE_COUNT" -gt "0" ]; then
            echo "::warning::Image now has $FIXABLE_COUNT fixable HIGH/CRITICAL vulnerabilities. Rebuild recommended."
          fi
```

</details>

---

### Challenge 3: Combined IaC + Image scanning

**Scenario:** Your repo also contains Terraform files. Add IaC scanning to the same workflow so both infrastructure misconfigurations AND image vulnerabilities are caught before merge.

<details>
<summary>Hint</summary>

The `fcs-action` supports `scan_type: iac` in addition to `scan_type: image`. You can run both in the same job or as parallel jobs.

</details>

<details>
<summary>Solution</summary>

Add a parallel job:

```yaml
  iac-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: CrowdStrike IaC Scan
        uses: crowdstrike/fcs-action@v4
        with:
          falcon_client_id: ${{ vars.FALCON_CLIENT_ID }}
          falcon_region: ${{ vars.FALCON_REGION }}
          scan_type: iac
          path: ./terraform/
          fail_on: high
          report_formats: sarif
          output_path: ./iac-results.sarif
        env:
          FALCON_CLIENT_SECRET: ${{ secrets.FALCON_CLIENT_SECRET }}

      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: ./iac-results.sarif
          category: iac-scan
```

Note: IaC scanning uses `fail_on` to set the threshold locally, unlike image scanning which relies on the console policy.

</details>

---

## Quick Reference

| Item | Value |
|------|-------|
| GitHub Action | `crowdstrike/fcs-action@v4` |
| Scan type | `image` |
| Report format | `json` (SARIF not supported for image scans) |
| Required secrets | `FALCON_CLIENT_SECRET` |
| Required variables | `FALCON_CLIENT_ID`, `FALCON_REGION` |
| API scopes | Falcon Container CLI (R/W), Falcon Container Image (R/W), Cloud Security Tools Download (R) |
| Registry | `ghcr.io` (uses `GITHUB_TOKEN` for auth) |
| Gate mechanism | Parse JSON report with `jq` for fixable HIGH/CRITICAL |
| `fail_on` parameter | Only works for IaC scans, NOT image scans |
| Falcon console path | Cloud Security > Image Assessment > CI Images |
| Data sent to CrowdStrike | Package inventory only (image stays on runner) |

---

*Created: 2026-06-16 | Topics: fcs-cli, image-scanning, github-actions, ci-cd, shift-left, container-security*
