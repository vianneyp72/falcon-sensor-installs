# Falcon API Credentials

This document covers how to create and configure API credentials for automated Falcon sensor deployments.

## Creating a Falcon API Client

1. Log in to the Falcon Console at <https://falcon.crowdstrike.com>.
2. Navigate to **Support and resources > API clients and keys**.
3. Click **Create API client**.
4. Give the client a descriptive name (e.g., `sensor-deploy-automation`).
5. Select the required scopes listed below.
6. Click **Create** and record the **Client ID** and **Client Secret** immediately (the secret is only shown once).

## Required API Scopes

Only grant the scopes required for your specific deployment method.

### All Deployments

| Scope Name | Permission | Purpose |
|---|---|---|
| **Sensor download** | Read | Downloading sensor installers and pulling container images |

### VM / Host Deployments

| Scope Name | Permission | Purpose |
|---|---|---|
| **Sensor update policies** | Read | Querying sensor versions and update policies |
| **Host** | Read | Verifying host registration post-install |
| **Installation tokens** | Read | Retrieving installation tokens for sensor registration |

### Container Deployments (Kubernetes, ECS, Cloud Run)

| Scope Name | Permission | Purpose |
|---|---|---|
| **Falcon Images Download** | Read | Pulling Falcon container images from the CrowdStrike registry |

### Image at Runtime (IAR) / Container Image Patching

| Scope Name | Permission | Purpose |
|---|---|---|
| **Falcon Images Download** | Read | Pulling the base Falcon sensor layer for patching |
| **Falcon Container Image** | Read/Write | Pushing and pulling patched container images |
| **Falcon Container CLI** | Write | IAR agent communication — registering assessed images with the Falcon cloud |

## Environment Variable Setup

All labs in this repository expect the following environment variables to be set:

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export FALCON_CLOUD="us-1"  # Options: us-1, us-2, eu-1, us-gov-1
```

For CI/CD pipelines, store these as secrets (e.g., GitHub Actions secrets, GitLab CI variables, Jenkins credentials).

### Optional Variables

```bash
export FALCON_CID="<your-full-cid-with-checksum>"  # Required for some VM install methods
export FALCON_INSTALL_TOKEN="<installation-token>"   # If your tenant requires an installation token
```

### Verifying Credentials

You can verify your credentials are working by requesting a bearer token:

```bash
curl -s -X POST "https://api.crowdstrike.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${FALCON_CLIENT_ID}&client_secret=${FALCON_CLIENT_SECRET}" \
  | jq .access_token
```

A valid token in the response confirms the credentials are correct.
