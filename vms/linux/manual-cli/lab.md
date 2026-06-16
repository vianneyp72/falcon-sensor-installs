# Falcon Sensor for Linux — Manual CLI Installation

> **What this deploys:** The Falcon kernel sensor on a Linux host via direct CLI commands. No automation tooling, no orchestration — just the sensor package, `falconctl`, and `systemctl`.

> **Prerequisites:**
>
> - Linux host accessible via SSH (Ubuntu/Debian or RHEL/Amazon Linux/CentOS)
> - Root or sudo access on the host
> - CrowdStrike API client with **Sensor Download: Read** scope
> - CrowdStrike CID with checksum
> - `curl` and `jq` installed on the host
> - Outbound HTTPS (443) to your CrowdStrike cloud domain
> - ~45 minutes

## Reference Docs

| Source                                | Link                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Deploy Falcon Sensor for Linux        | https://falcon.crowdstrike.com/documentation/page/cba4f917                                 |
| Sensor Download APIs                  | https://falcon.crowdstrike.com/documentation/page/c1f0f0b8                                 |
| falconctl Configuration Options       | https://falcon.crowdstrike.com/documentation/page/f4d593ca                                 |
| Installation Tokens                   | https://falcon.crowdstrike.com/documentation/page/cf475d86                                 |
| CrowdStrike OAuth2 APIs               | https://falcon.crowdstrike.com/documentation/page/a2a7fc0e                                 |

---

## 1. How the Sensor Works

> **~5 min | Beginner**

The Falcon sensor for Linux is a lightweight kernel-level agent. Once installed, it:

1. Loads a kernel module (`falcon-sensor.ko`) to observe system calls, process events, and file activity
2. Maintains a persistent TLS connection to the CrowdStrike Falcon cloud over port 443
3. Streams telemetry to the cloud for detection, prevention, and threat intelligence enrichment
4. Receives policy updates and prevention rules from the cloud in real time

```
Linux Host
═══════════════════════════════════════

  User Space
  ┌────────────────────────────────┐
  │  falcon-sensor (daemon)        │
  │    • Manages cloud connection  │
  │    • Applies prevention rules  │
  │    • Streams telemetry         │
  └───────────────┬────────────────┘
                  │
  Kernel Space    │
  ┌───────────────▼────────────────┐
  │  falcon-sensor.ko (module)     │
  │    • Intercepts system calls   │
  │    • Monitors process creation │
  │    • Tracks file/network I/O   │
  └───────────────┬────────────────┘
                  │
═══════════════════════════════════════
                  │ TLS 443
                  ▼
  ┌────────────────────────────────┐
  │  CrowdStrike Falcon Cloud      │
  │  (ts01-b.cloudsink.net)        │
  └────────────────────────────────┘
```

**Key facts:**
- The sensor installs to `/opt/CrowdStrike/`
- Configuration tool: `/opt/CrowdStrike/falconctl`
- Runs as `systemd` service: `falcon-sensor.service`
- Requires a valid CID to register with your tenant

---

## 2. Create API Credentials

> **~5 min | Beginner**

> **What this does:** Creates an OAuth2 API client in the Falcon console that allows you to download the sensor installer via the API. Without this, you'd have to manually download the package from the console UI.

1. Log in to the Falcon console at https://falcon.crowdstrike.com
2. Navigate to **Support and resources** > **Resources and tools** > **API clients and keys**
3. Click **Create API client**
4. Name it something descriptive (e.g., `linux-sensor-install`)
5. Enable the **Sensor download** scope with **Read** permission
6. Click **Create**
7. Copy the **Client ID** and **Client Secret** immediately — the secret is only shown once

Set these as environment variables on your Linux host:

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
```

Set your Falcon cloud region:

```bash
# Options: api.crowdstrike.com (US-1), api.us-2.crowdstrike.com (US-2),
#          api.eu-1.crowdstrike.com (EU-1), api.laggar.gcw.crowdstrike.com (US-GOV-1)
export FALCON_CLOUD="api.crowdstrike.com"
```

---

## 3. Authenticate & Download the Sensor Package

> **~10 min | Beginner**

> **What this does:** Requests a bearer token from the CrowdStrike OAuth2 API, then uses it to find and download the correct sensor installer for your Linux distribution.

### Step 1: Get a bearer token

```bash
ACCESS_TOKEN=$(curl -s -X POST "https://${FALCON_CLOUD}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${FALCON_CLIENT_ID}&client_secret=${FALCON_CLIENT_SECRET}" \
  | jq -r '.access_token')

echo "$ACCESS_TOKEN" | head -c 20 && echo "..."  # Verify you got a token (not null)
```

If you see `null`, double-check your client ID, secret, and cloud region.

> **Note:** Bearer tokens expire after **30 minutes**. If later commands return 401 errors, re-run this step.

### Step 2: Get your CID with checksum

```bash
FALCON_CID=$(curl -s -X GET "https://${FALCON_CLOUD}/sensors/queries/installers/ccid/v1" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  | jq -r '.resources[0]')

echo "CID: $FALCON_CID"
```

Save this — you'll need it during sensor configuration.

### Step 3: Find available sensor installers

Query for your OS family:

**Ubuntu / Debian:**

```bash
curl -s -X GET \
  "https://${FALCON_CLOUD}/sensors/combined/installers/v3?filter=platform:'linux'%2Bos:'Ubuntu'" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  | jq '.resources[:3] | .[] | {name, version, os, file_type}'
```

**RHEL / Amazon Linux / CentOS:**

```bash
curl -s -X GET \
  "https://${FALCON_CLOUD}/sensors/combined/installers/v3?filter=platform:'linux'%2Bos:'RHEL/CentOS/Oracle'" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  | jq '.resources[:3] | .[] | {name, version, os, file_type}'
```

Pick the most recent version from the response and note its `sha256` hash:

```bash
SENSOR_SHA=$(curl -s -X GET \
  "https://${FALCON_CLOUD}/sensors/combined/installers/v3?filter=platform:'linux'%2Bos:'Ubuntu'" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  | jq -r '.resources[0].sha256')

echo "Installer SHA: $SENSOR_SHA"
```

> **Tip:** Replace `'Ubuntu'` with `'RHEL/CentOS/Oracle'` or `'Amazon Linux'` to match your distribution.

### Step 4: Download the installer

```bash
curl -s -X GET \
  "https://${FALCON_CLOUD}/sensors/entities/download-installer/v3?id=${SENSOR_SHA}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -o falcon-sensor-installer
```

Verify the download:

```bash
ls -lh falcon-sensor-installer
file falcon-sensor-installer
```

You should see either a Debian package (.deb) or an RPM package (.rpm) depending on your OS filter.

---

## 4. Install the Sensor Package

> **~5 min | Beginner**

> **What this does:** Installs the Falcon sensor binary and kernel module onto the host using your distribution's package manager. The sensor won't start until you configure the CID in the next step.

**Ubuntu / Debian:**

```bash
sudo dpkg -i falcon-sensor-installer
```

If you encounter dependency errors:

```bash
sudo apt-get install -f -y
sudo dpkg -i falcon-sensor-installer
```

**RHEL / Amazon Linux / CentOS (yum):**

```bash
sudo yum install -y ./falcon-sensor-installer
```

**RHEL 8+ / Amazon Linux 2023 (dnf):**

```bash
sudo dnf install -y ./falcon-sensor-installer
```

### Verify installation

Confirm the sensor binary and falconctl are present:

```bash
ls /opt/CrowdStrike/falconctl
/opt/CrowdStrike/falconctl --version
```

---

## 5. Configure the Sensor with falconctl

> **~10 min | Beginner**

> **What this does:** Tells the sensor which CrowdStrike tenant to register with by setting your Customer ID (CID). This is the minimum configuration required — without it, the sensor cannot connect to the cloud.

### Step 1: Set the CID (required)

```bash
sudo /opt/CrowdStrike/falconctl -s --cid="${FALCON_CID}"
```

### Step 2: Set the cloud region (recommended)

Explicitly setting the cloud avoids auto-discovery delays on first boot:

```bash
sudo /opt/CrowdStrike/falconctl -s --cloud=us-1
```

Valid values: `us-1`, `us-2`, `eu-1`, `us-gov-1`, `us-gov-2`

### Step 3: Set a provisioning token (if required by your tenant)

If your CID enforces installation tokens:

```bash
sudo /opt/CrowdStrike/falconctl -s --provisioning-token="<your-token>"
```

> **Note:** Installation tokens are optional and configured per-tenant. Check with your Falcon admin if unsure whether your CID requires one.

### Verify the configuration

```bash
sudo /opt/CrowdStrike/falconctl -g --cid --cloud --provisioning-token
```

You should see your CID and cloud region echoed back.

---

## 6. Start & Verify Registration

> **~10 min | Beginner**

> **What this does:** Starts the sensor daemon, verifies it loaded the kernel module, and confirms it established a connection to the CrowdStrike cloud. This is where you'll know if everything worked.

### Step 1: Start the sensor

```bash
sudo systemctl start falcon-sensor
sudo systemctl enable falcon-sensor
```

### Step 2: Verify the service is running

```bash
sudo systemctl status falcon-sensor
```

Expected: `Active: active (running)`

### Step 3: Verify the kernel module loaded

```bash
lsmod | grep falcon
```

Expected output shows `falcon_lsm_serviceable` (or similar) loaded.

### Step 4: Verify cloud connectivity

```bash
sudo ss -tnp | grep falcon
```

Expected: an `ESTAB` connection to a CrowdStrike endpoint on port 443.

### Step 5: Check the Agent ID (AID)

```bash
sudo /opt/CrowdStrike/falconctl -g --aid
```

A valid AID (32-character hex string) confirms the sensor successfully registered with the Falcon cloud.

### Step 6: Find the host in the Falcon console

Navigate to **Host setup and management** > **Host management** and search for your host's hostname or AID. The host should appear within 5-10 minutes of starting the sensor.

---

## 7. Optional Configuration (Tags, Proxy, Tokens)

> **~10 min | Intermediate**

> **What this does:** Covers additional falconctl options for organizing hosts with tags, routing traffic through a proxy, and managing installation tokens.

### Sensor grouping tags

Tags let you organize hosts into logical groups for policy assignment and filtering:

```bash
sudo /opt/CrowdStrike/falconctl -s --tags="Environment/Production,Team/Platform"
```

**Tag rules:**
- Case-sensitive
- Allowed characters: letters, numbers, hyphens, underscores, forward slashes
- Maximum combined length: 256 characters
- Changes take effect after sensor restart

```bash
sudo systemctl restart falcon-sensor
```

Verify tags:

```bash
sudo /opt/CrowdStrike/falconctl -g --tags
```

### Proxy configuration

If your host routes HTTPS traffic through a proxy:

```bash
# Set proxy host and port
sudo /opt/CrowdStrike/falconctl -s --aph=proxy.example.com --app=8080

# Enable the proxy (APD=FALSE means "don't go direct — use the proxy")
sudo /opt/CrowdStrike/falconctl -s --apd=FALSE

# Restart for proxy changes to take effect
sudo systemctl restart falcon-sensor
```

Verify proxy settings:

```bash
sudo /opt/CrowdStrike/falconctl -g --aph --app --apd
```

> **Note:** The Falcon sensor does not support proxy authentication (no username/password). Your proxy must allow unauthenticated traffic to CrowdStrike cloud domains.

### Installation tokens via API

If you need to create a provisioning token programmatically (requires **Installation Tokens: Read/Write** scope):

```bash
curl -s -X POST "https://${FALCON_CLOUD}/installation-tokens/entities/tokens/v1" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"label": "linux-deploy-token", "expires_timestamp": "2027-12-31T00:00:00Z"}' \
  | jq '.resources[0].value'
```

---

## 8. Troubleshooting

> **~5 min | Beginner**

> **What this does:** Covers the most common failure scenarios and how to diagnose them.

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `systemctl status` shows `inactive (dead)` | CID not set | Run `falconctl -s --cid=<CID>` then start again |
| `falconctl -g --aid` returns blank | Sensor hasn't connected to cloud yet | Check outbound 443 with `ss -tnp`, verify cloud region |
| `dpkg: dependency problems` | Missing shared libraries | Run `sudo apt-get install -f -y` |
| `nothing provides libnl3` (rpm) | Missing dependency on minimal installs | `sudo yum install libnl3` |
| Sensor in **Reduced Functionality Mode** | Secure Boot blocking unsigned kernel module | Import CrowdStrike signing key via `mokutil` |
| 401 from API calls | Bearer token expired (30 min lifetime) | Re-run the token request from Step 3 |
| Host not appearing in console | DNS/firewall blocking CrowdStrike domains | Verify `ts01-b.cloudsink.net` resolves and 443 is open |

### Checking sensor logs

```bash
# Systemd journal (preferred)
sudo journalctl -u falcon-sensor --since "10 minutes ago"

# Syslog fallback
sudo grep falcon /var/log/syslog 2>/dev/null || sudo grep falcon /var/log/messages | tail -20
```

### Full configuration dump

```bash
sudo /opt/CrowdStrike/falconctl -g --cid --aid --version --tags --cloud --aph --app --apd
```

---

## 9. Quick Reference

| Action | Command |
|--------|---------|
| Install (deb) | `sudo dpkg -i <package>.deb` |
| Install (rpm) | `sudo yum install -y ./<package>.rpm` |
| Set CID | `sudo /opt/CrowdStrike/falconctl -s --cid=<CID>` |
| Set cloud region | `sudo /opt/CrowdStrike/falconctl -s --cloud=us-1` |
| Set provisioning token | `sudo /opt/CrowdStrike/falconctl -s --provisioning-token=<TOKEN>` |
| Set tags | `sudo /opt/CrowdStrike/falconctl -s --tags="Tag1,Tag2"` |
| Start sensor | `sudo systemctl start falcon-sensor` |
| Enable on boot | `sudo systemctl enable falcon-sensor` |
| Stop sensor | `sudo systemctl stop falcon-sensor` |
| Restart sensor | `sudo systemctl restart falcon-sensor` |
| Check status | `sudo systemctl status falcon-sensor` |
| Get AID | `sudo /opt/CrowdStrike/falconctl -g --aid` |
| Get all config | `sudo /opt/CrowdStrike/falconctl -g --cid --aid --version --tags --cloud` |
| Check kernel module | `lsmod \| grep falcon` |
| Check connectivity | `sudo ss -tnp \| grep falcon` |
| Uninstall (deb) | `sudo apt-get remove falcon-sensor` |
| Uninstall (rpm) | `sudo yum remove falcon-sensor` |

---

*Created: 2026-06-16 | Topics: falcon-sensor, linux, manual-install, cli, vm*
