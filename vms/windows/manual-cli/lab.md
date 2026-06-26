# Falcon Sensor for Windows — CLI Installation

> **What this deploys:** The Falcon sensor on a Windows host using CrowdStrike's official PowerShell install script. One command handles API auth, installer download, installation, CID configuration, and service start.

> **Prerequisites:**
>
> - Windows host accessible via RDP or PowerShell remoting (Windows Server 2016+, Windows 10/11)
> - Administrator access on the host
> - CrowdStrike API client with **Sensor Download: Read** scope
> - PowerShell 5.1+ (included in all modern Windows)
> - Outbound HTTPS (443) to your CrowdStrike cloud domain
> - ~15 minutes

## Reference Docs

| Source                                | Link                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| falcon-windows-install.ps1            | https://github.com/CrowdStrike/falcon-scripts/tree/main/powershell/install               |
| Deploy Falcon Sensor for Windows      | https://docs.crowdstrike.com/r/en-US/iopiipqy/9e52ceba                                  |
| CrowdStrike Installation Tokens       | https://docs.crowdstrike.com/r/en-US/kgsgkjd3/cf475d86                                  |

---

## 1. How the Sensor Works

> **~5 min | Beginner**

The Falcon sensor for Windows is a lightweight kernel-mode driver that monitors system activity — process creation, file operations, network connections, and registry changes. It streams telemetry to the CrowdStrike cloud over a persistent TLS connection.

```
┌─────────────────────────────────────┐
│ CsFalconService (userspace)         │
│ csagent.sys (kernel driver)         │──── Kernel Callbacks ────▶ Windows Kernel
└──────────────────┬──────────────────┘
                   │ TLS 443
                   ▼
┌─────────────────────────────────────┐
│ CrowdStrike Falcon Cloud            │
└─────────────────────────────────────┘
```

**Key facts:**
- Installs to `C:\Program Files\CrowdStrike\`
- Configuration tool: `C:\Program Files\CrowdStrike\falconctl.exe`
- Runs as Windows service: `CSFalconService`
- Installer is an MSI package (`.exe` wrapper)

---

## 2. Create API Credentials

> **~5 min | Beginner**

> **What this does:** Creates an OAuth2 API client in the Falcon console. The install script uses these credentials to authenticate, download the correct installer, and configure the sensor automatically.

1. Log in to the Falcon console at https://falcon.crowdstrike.com
2. Navigate to **Support and resources** > **Resources and tools** > **API clients and keys**
3. Click **Create API client**
4. Name it something descriptive (e.g., `windows-sensor-install`)
5. Enable the required scopes:

| Scope | Permission | When Needed |
|-------|-----------|-------------|
| **Sensor Download** | Read | Always required |
| **Installation Tokens** | Read | If your tenant enforces provisioning tokens |
| **Sensor Update Policies** | Read | If using `SensorUpdatePolicyName` |

6. Click **Create**
7. Copy the **Client ID** and **Client Secret** immediately — the secret is only shown once

---

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials (PowerShell as Administrator)

```powershell
$env:FALCON_CLIENT_ID = "<your-client-id>"
$env:FALCON_CLIENT_SECRET = "<your-client-secret>"
```

### 2. Run the install script

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/powershell/install/falcon-windows-install.ps1" -OutFile "$env:TEMP\falcon-windows-install.ps1"
& "$env:TEMP\falcon-windows-install.ps1"
```

### 3. Verify

```powershell
Get-Service CSFalconService
& "C:\Program Files\CrowdStrike\falconctl.exe" /g --aid
```

`Status: Running` and a valid 32-character AID confirms successful registration.

</div>

<div data-mode="lab">

## 3. Launch a Windows EC2 Instance

> **~10 min | Beginner**

> **What this does:** Provisions a Windows Server EC2 instance to use as your target host for sensor installation.

### Set environment variables

```bash
export AWS_REGION=<your-aws-region>
export KEY_NAME=<your-ec2-key-pair-name>
```

### Create a security group

```bash
MY_IP=$(curl -s ifconfig.me)

export SG_ID=$(aws ec2 create-security-group \
  --group-name falcon-windows-lab-sg \
  --description "Falcon sensor lab - RDP from my IP" \
  --query 'GroupId' --output text \
  --region $AWS_REGION)

aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 3389 \
  --cidr "${MY_IP}/32" \
  --region $AWS_REGION
```

### Launch the instance

```bash
export INSTANCE_ID=$(aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base \
  --instance-type t3.medium \
  --key-name $KEY_NAME \
  --security-group-ids $SG_ID \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=falcon-windows-lab}]' \
  --query 'Instances[0].InstanceId' --output text \
  --region $AWS_REGION) && echo $INSTANCE_ID

aws ec2 wait instance-running --instance-ids $INSTANCE_ID --region $AWS_REGION
```

### Get the Administrator password

Wait 4-5 minutes for the password to become available:

```bash
aws ec2 get-password-data \
  --instance-id $INSTANCE_ID \
  --priv-launch-key ~/.ssh/<your-key-file>.pem \
  --query 'PasswordData' --output text \
  --region $AWS_REGION
```

### Get the public IP

```bash
export PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text \
  --region $AWS_REGION) && echo $PUBLIC_IP
```

### Connect via RDP

Use your RDP client to connect:
- **Host:** The public IP from above
- **Username:** `Administrator`
- **Password:** The decrypted password from above

---

## 4. Install the Sensor

> **~5 min | Beginner**

> **What this does:** Downloads and runs the CrowdStrike PowerShell install script on the Windows instance.

### Open PowerShell as Administrator (on the Windows instance)

Right-click the PowerShell icon in the taskbar and select **Run as Administrator**.

### Run the install script

```powershell
$env:FALCON_CLIENT_ID = "<your-client-id>"
$env:FALCON_CLIENT_SECRET = "<your-client-secret>"

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/powershell/install/falcon-windows-install.ps1" -OutFile "$env:TEMP\falcon-windows-install.ps1"
& "$env:TEMP\falcon-windows-install.ps1"
```

The script will:
1. Authenticate to the Falcon API
2. Download the latest Windows sensor installer
3. Install the sensor silently
4. Configure the CID and start the service

---

## 5. Verify Registration

> **~5 min | Beginner**

### Check service status

```powershell
Get-Service CSFalconService
```

Expected: `Status: Running`

### Check the kernel driver

```powershell
Get-WmiObject Win32_SystemDriver | Where-Object { $_.Name -like "*csagent*" }
```

Expected: `State: Running`

### Check Agent ID (AID)

```powershell
& "C:\Program Files\CrowdStrike\falconctl.exe" /g --aid
```

A valid AID (32-character hex string) confirms successful registration.

### Verify cloud connectivity

```powershell
Get-NetTCPConnection -RemotePort 443 | Where-Object {
  (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq "CSFalconService"
}
```

> Look for: an `Established` connection on port 443.

### Get full sensor configuration

```powershell
& "C:\Program Files\CrowdStrike\falconctl.exe" /g --cid --aid --version --tags --cloud
```

### Find the host in the Falcon console

1. Navigate to **Host setup and management** > **Host management**
2. Search for `falcon-windows-lab` or paste the AID
3. Verify the host shows **Online** (green dot)
4. Confirm OS shows as Windows Server 2022

### Test a detection (optional)

Open Command Prompt and run:

```cmd
powershell -Command "Invoke-WebRequest -Uri 'https://www.crowdstrike.com' -OutFile C:\temp\test.exe" 2>nul
```

Check for the event in **Endpoint detections** > **Activity** within a few minutes.

---

## 6. Cleanup

### Uninstall the sensor (on the Windows instance)

```powershell
$env:FALCON_CLIENT_ID = "<your-client-id>"
$env:FALCON_CLIENT_SECRET = "<your-client-secret>"

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/powershell/install/falcon-windows-uninstall.ps1" -OutFile "$env:TEMP\falcon-windows-uninstall.ps1"
& "$env:TEMP\falcon-windows-uninstall.ps1"
```

### Terminate the instance (from your local machine)

```bash
aws ec2 terminate-instances --instance-ids $INSTANCE_ID --region $AWS_REGION
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID --region $AWS_REGION

aws ec2 delete-security-group --group-id $SG_ID --region $AWS_REGION
```

</div>

---

## 5. Post-Install Configuration

> **~5 min | Intermediate**

> **What this does:** Additional falconctl options you can apply after installation for tags, proxy, or grouping.

### Add or change sensor grouping tags

```powershell
& "C:\Program Files\CrowdStrike\falconctl.exe" /s --tags="Environment/Production,Team/Platform"
Restart-Service CSFalconService
```

### Configure a proxy

```powershell
& "C:\Program Files\CrowdStrike\falconctl.exe" /s --aph=proxy.example.com --app=8080 --apd=FALSE
Restart-Service CSFalconService
```

### Verify all configuration

```powershell
& "C:\Program Files\CrowdStrike\falconctl.exe" /g --cid --aid --version --tags --cloud --aph --app --apd
```

---

## 6. Uninstall

> **~2 min | Beginner**

> **What this does:** Removes the sensor using the official uninstall script.

```powershell
$env:FALCON_CLIENT_ID = "<your-client-id>"
$env:FALCON_CLIENT_SECRET = "<your-client-secret>"

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/powershell/install/falcon-windows-uninstall.ps1" -OutFile "$env:TEMP\falcon-windows-uninstall.ps1"
& "$env:TEMP\falcon-windows-uninstall.ps1"
```

If uninstall protection is enabled, the script uses the API credentials to retrieve the maintenance token automatically.

Or provide a maintenance token directly:

```powershell
$env:FALCON_MAINTENANCE_TOKEN = "<token>"

Invoke-WebRequest -Uri "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/powershell/install/falcon-windows-uninstall.ps1" -OutFile "$env:TEMP\falcon-windows-uninstall.ps1"
& "$env:TEMP\falcon-windows-uninstall.ps1"
```

---

## 7. Troubleshooting

> **~5 min | Beginner**

### Common issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Script fails with auth error | Invalid credentials or wrong cloud | Verify `FALCON_CLIENT_ID`, `FALCON_CLIENT_SECRET`, `FALCON_CLOUD` |
| `CSFalconService` not running | Installation incomplete or CID not set | Re-run install script |
| `falconctl /g --aid` returns blank | Sensor hasn't connected yet | Check outbound 443 connectivity |
| TLS/certificate errors | Proxy or firewall intercepting HTTPS | Add CrowdStrike domains to proxy allowlist |
| Host not appearing in console | DNS/firewall blocking CrowdStrike domains | Verify `ts01-b.cloudsink.net` resolves and 443 is open |

### Check Windows Event Logs

```powershell
Get-WinEvent -LogName Application -MaxEvents 20 | Where-Object { $_.ProviderName -like "*CrowdStrike*" }
```

### Verify DNS resolution

```powershell
Resolve-DnsName ts01-b.cloudsink.net
```

---

## 8. Quick Reference

| Action | Command |
|--------|---------|
| Install (PowerShell) | `Invoke-WebRequest -Uri ".../falcon-windows-install.ps1" -OutFile "$env:TEMP\falcon-windows-install.ps1"; & "$env:TEMP\falcon-windows-install.ps1"` |
| Uninstall | `Invoke-WebRequest -Uri ".../falcon-windows-uninstall.ps1" -OutFile "$env:TEMP\falcon-windows-uninstall.ps1"; & "$env:TEMP\falcon-windows-uninstall.ps1"` |
| Set tags | `& "C:\Program Files\CrowdStrike\falconctl.exe" /s --tags="Tag1,Tag2"` |
| Start service | `Start-Service CSFalconService` |
| Stop service | `Stop-Service CSFalconService` |
| Restart service | `Restart-Service CSFalconService` |
| Check status | `Get-Service CSFalconService` |
| Get AID | `& "C:\Program Files\CrowdStrike\falconctl.exe" /g --aid` |
| Get all config | `& "C:\Program Files\CrowdStrike\falconctl.exe" /g --cid --aid --version --tags --cloud` |
| Check driver | `Get-WmiObject Win32_SystemDriver \| Where-Object { $_.Name -like "*csagent*" }` |

---

*Created: 2026-06-26 | Topics: falcon-sensor, windows, cli, vm, powershell, falcon-scripts*
