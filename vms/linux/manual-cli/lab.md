# Falcon Sensor for Linux — CLI Installation

> **What this deploys:** The Falcon sensor on a Linux host using CrowdStrike's official install script. One command handles API auth, package download, installation, CID configuration, and service start.

> **Prerequisites:**
>
> - Linux host accessible via SSH (Ubuntu/Debian, RHEL/CentOS/Amazon Linux, SLES)
> - Root or sudo access on the host
> - CrowdStrike API client with **Sensor Download: Read** scope
> - `curl` >= 7.55.0 installed on the host
> - Outbound HTTPS (443) to your CrowdStrike cloud domain
> - ~15 minutes

## Reference Docs

| Source                             | Link                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| falcon-linux-install.sh            | https://github.com/CrowdStrike/falcon-scripts/tree/main/bash/install                  |
| Deploy Falcon Sensor for Linux     | https://docs.crowdstrike.com/r/en-US/iopiipqy/cba4f917                               |
| falconctl Configuration Options    | https://docs.crowdstrike.com/r/en-US/iopiipqy/f4d593ca                               |
| Installation Tokens                | https://docs.crowdstrike.com/r/en-US/kgsgkjd3/cf475d86                               |

---

## 1. How the Sensor Works

> **~5 min | Beginner**

The Falcon sensor for Linux is a lightweight agent that attaches eBPF probes into the kernel from userspace. It observes system calls, process events, and file/network activity, then streams telemetry to the CrowdStrike cloud over a persistent TLS connection.

```
┌───────────────────────────────┐
│ falcon-sensor (userspace)     │──── eBPF ────▶ Linux Kernel
└───────────────┬───────────────┘
                │ TLS 443
                ▼
┌───────────────────────────────┐
│ CrowdStrike Falcon Cloud      │
└───────────────────────────────┘
```

**Key facts:**
- Installs to `/opt/CrowdStrike/`
- Configuration tool: `/opt/CrowdStrike/falconctl`
- Runs as `systemd` service: `falcon-sensor.service`
- Auto-detects distro and uses the correct package manager

---

## 2. Create API Credentials

> **~5 min | Beginner**

> **What this does:** Creates an OAuth2 API client in the Falcon console. The install script uses these credentials to authenticate, download the correct package, and configure the sensor automatically.

1. Log in to the Falcon console at https://falcon.crowdstrike.com
2. Navigate to **Support and resources** > **Resources and tools** > **API clients and keys**
3. Click **Create API client**
4. Name it something descriptive (e.g., `linux-sensor-install`)
5. Enable the required scopes:

| Scope | Permission | When Needed |
|-------|-----------|-------------|
| **Sensor Download** | Read | Always required |
| **Installation Tokens** | Read | If your tenant enforces provisioning tokens |
| **Sensor Update Policies** | Read | If using `FALCON_SENSOR_UPDATE_POLICY_NAME` |

6. Click **Create**
7. Copy the **Client ID** and **Client Secret** immediately — the secret is only shown once

---

## 3. Install the Sensor

> **~5 min | Beginner**

> **What this does:** Downloads and runs the official CrowdStrike install script. It handles everything — API authentication, package download for your distro, installation, CID registration, and service start.

### Set environment variables

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
```

> **Note:** The script auto-discovers your cloud region (us-1, us-2, eu-1). For us-gov-1 or us-gov-2, set it explicitly:
> ```bash
> export FALCON_CLOUD="us-gov-1"
> ```

### Run the install script

```bash
curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash
```

That's it. The script will:
1. Authenticate to the Falcon API
2. Detect your Linux distribution and architecture
3. Download the latest sensor package
4. Install it with the appropriate package manager (apt/yum/dnf/zypper)
5. Configure the CID and start the service

<details>
<summary>Common environment variables for customization</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `FALCON_CLOUD` | auto-discovered | Cloud region (`us-1`, `us-2`, `eu-1`, `us-gov-1`, `us-gov-2`) |
| `FALCON_CID` | auto | Customer ID (auto-detected from API credentials) |
| `FALCON_PROVISIONING_TOKEN` | unset | Installation token if required by your tenant |
| `FALCON_TAGS` | unset | Comma-separated sensor grouping tags |
| `FALCON_SENSOR_VERSION_DECREMENT` | 0 (latest) | Install N versions behind latest (e.g., `1` = N-1) |
| `FALCON_SENSOR_UPDATE_POLICY_NAME` | unset | Pin to a sensor update policy version |
| `FALCON_APH` | unset | Proxy host |
| `FALCON_APP` | unset | Proxy port |
| `FALCON_APD` | unset | Proxy enabled/disabled |
| `FALCON_BILLING` | default | Billing type (`default` or `metered`) |
| `FALCON_BACKEND` | auto | Sensor backend (`auto`, `bpf`, `kernel`) |
| `FALCON_INSTALL_ONLY` | false | Install without registering/starting |
| `FALCON_DOWNLOAD_ONLY` | false | Download package without installing |
| `PREP_GOLDEN_IMAGE` | false | Prepare sensor for golden image cloning |

</details>

### Example: Install with tags and a provisioning token

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export FALCON_TAGS="Environment/Production,Team/Platform"
export FALCON_PROVISIONING_TOKEN="1111AAAA"

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash
```

### Example: Install a specific version (N-1)

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export FALCON_SENSOR_VERSION_DECREMENT=1

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash
```

### Example: Download only (for air-gapped staging)

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export FALCON_DOWNLOAD_ONLY=true
export FALCON_DOWNLOAD_PATH="/tmp/falcon-packages"

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash
```

### Alternative: Pre-authenticate with an access token

For batch installs across many hosts, generate a token once and reuse it to avoid hitting the OAuth endpoint per-host:

```bash
# On your workstation — get the token
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
export GET_ACCESS_TOKEN=true

TOKEN=$(curl -sL https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | bash)

# On each target host — install using the token
export FALCON_ACCESS_TOKEN="$TOKEN"
export FALCON_CLOUD="us-1"

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash
```

> **Note:** Access tokens expire after 30 minutes.

---

## 4. Verify Registration

> **~5 min | Beginner**

> **What this does:** Confirms the sensor is running, the kernel module is loaded, and the host registered with the Falcon cloud.

### Check service status

```bash
sudo systemctl status falcon-sensor
```

Expected: `Active: active (running)`

### Verify kernel module

```bash
lsmod | grep falcon
```

Expected: `falcon_lsm_serviceable` (or similar) loaded.

### Verify cloud connectivity

```bash
sudo ss -tnp | grep falcon
```

Expected: an `ESTAB` connection on port 443.

### Check Agent ID (AID)

```bash
sudo /opt/CrowdStrike/falconctl -g --aid
```

A valid AID (32-character hex string) confirms successful registration.

### Find the host in the Falcon console

Navigate to **Host setup and management** > **Host management** and search for your hostname or AID. The host should appear within 5-10 minutes.

---

## 5. Post-Install Configuration

> **~5 min | Intermediate**

> **What this does:** Additional falconctl options you can apply after installation for tags, proxy, or cloud pinning.

### Add or change sensor grouping tags

```bash
sudo /opt/CrowdStrike/falconctl -s --tags="Environment/Production,Team/Platform"
sudo systemctl restart falcon-sensor
```

Tag rules: case-sensitive, max 256 chars combined, allowed chars: `a-z A-Z 0-9 - _ /`

### Configure a proxy

```bash
sudo /opt/CrowdStrike/falconctl -s --aph=proxy.example.com --app=8080 --apd=FALSE
sudo systemctl restart falcon-sensor
```

> **Note:** The sensor does not support authenticated proxies.

### Verify all configuration

```bash
sudo /opt/CrowdStrike/falconctl -g --cid --aid --version --tags --cloud --aph --app --apd
```

---

## 6. Uninstall

> **~2 min | Beginner**

> **What this does:** Removes the sensor using the official uninstall script.

```bash
curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-uninstall.sh | sudo bash
```

If your sensor has uninstall protection enabled, provide credentials so the script can retrieve the maintenance token:

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-uninstall.sh | sudo bash
```

Or provide a maintenance token directly:

```bash
export FALCON_MAINTENANCE_TOKEN="<token>"

curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-uninstall.sh | sudo bash
```

---

## 7. Troubleshooting

> **~5 min | Beginner**

### Debug the install script

```bash
curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh | sudo bash -x
```

### Common issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Script fails with auth error | Invalid credentials or wrong cloud | Verify `FALCON_CLIENT_ID`, `FALCON_CLIENT_SECRET`, `FALCON_CLOUD` |
| `systemctl status` shows `inactive (dead)` | CID not set | Re-run install script or set manually with `falconctl -s --cid=<CID>` |
| `falconctl -g --aid` returns blank | Sensor hasn't connected yet | Check outbound 443: `sudo ss -tnp \| grep falcon` |
| Sensor in **Reduced Functionality Mode** | Secure Boot blocking kernel module | Import CrowdStrike signing key via `mokutil` |
| Host not appearing in console | DNS/firewall blocking CrowdStrike domains | Verify `ts01-b.cloudsink.net` resolves and 443 is open |
| cURL security warning | cURL < 7.55.0 | Upgrade cURL or set `ALLOW_LEGACY_CURL=true` (not recommended) |

### Sensor logs

```bash
sudo journalctl -u falcon-sensor --since "10 minutes ago"
```

---

## 8. Quick Reference

| Action | Command |
|--------|---------|
| Install (one-liner) | `curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-install.sh \| sudo bash` |
| Uninstall | `curl -L https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/install/falcon-linux-uninstall.sh \| sudo bash` |
| Set tags | `sudo /opt/CrowdStrike/falconctl -s --tags="Tag1,Tag2"` |
| Start sensor | `sudo systemctl start falcon-sensor` |
| Stop sensor | `sudo systemctl stop falcon-sensor` |
| Restart sensor | `sudo systemctl restart falcon-sensor` |
| Check status | `sudo systemctl status falcon-sensor` |
| Get AID | `sudo /opt/CrowdStrike/falconctl -g --aid` |
| Get all config | `sudo /opt/CrowdStrike/falconctl -g --cid --aid --version --tags --cloud` |
| Check kernel module | `lsmod \| grep falcon` |
| Check connectivity | `sudo ss -tnp \| grep falcon` |
| Debug install | `curl -L .../falcon-linux-install.sh \| sudo bash -x` |

---

*Created: 2026-06-16 | Topics: falcon-sensor, linux, cli, vm, falcon-scripts*
