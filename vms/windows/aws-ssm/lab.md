# Falcon Sensor on Windows VMs via AWS Systems Manager

Deploy the CrowdStrike Falcon sensor to Windows EC2 instances using AWS Systems Manager (SSM) Run Command. No RDP or direct network access required — SSM handles remote execution through the SSM Agent.

> **Prerequisites:**
>
> - AWS account with EC2 and Systems Manager access
> - CrowdStrike Falcon console access with **Sensor Download: Read** API scope
> - CrowdStrike CID with checksum
> - AWS CLI v2 configured (`aws sts get-caller-identity` works)
> - ~60 minutes

## Reference Docs

| Source | Link |
|--------|------|
| Install Falcon Sensor for Windows | https://docs.crowdstrike.com/r/en-US/iopiipqy/falcon-sensor-for-windows |
| AWS Systems Manager Run Command | https://docs.aws.amazon.com/systems-manager/latest/userguide/execute-remote-commands.html |
| SSM Agent on Windows | https://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-install-ssm-win.html |
| CrowdStrike Sensor Download API | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/vc320402 |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AWS Account                                       │
│                                                                         │
│  ┌─────────────────────┐         ┌──────────────────────────────────┐  │
│  │  Systems Manager     │         │  Windows EC2 Instance             │  │
│  │                     │  SSM    │                                    │  │
│  │  Run Command ───────┼────────►│  SSM Agent (pre-installed)        │  │
│  │  (PowerShell script)│         │       │                           │  │
│  │                     │         │       ▼                           │  │
│  └─────────────────────┘         │  Download & Install               │  │
│                                  │  CrowdStrike Falcon Sensor        │  │
│                                  │       │                           │  │
│                                  │       ▼                           │  │
│                                  │  falcon-sensor.exe (running)      │  │
│                                  └───────────────┬──────────────────┘  │
│                                                  │                      │
└──────────────────────────────────────────────────┼──────────────────────┘
                                                   │ TLS 443
                                                   ▼
                                        ┌───────────────────┐
                                        │  CrowdStrike Cloud │
                                        │  (Falcon Platform) │
                                        └───────────────────┘
```

---

## Deployment Steps

<div data-mode="guide">

### 1. Set Environment Variables

```bash
export AWS_REGION="us-east-1"
export FALCON_CLIENT_ID="<your_client_id>"
export FALCON_CLIENT_SECRET="<your_client_secret>"
export FALCON_CID="<your_cid_with_checksum>"
export INSTANCE_ID="<your_windows_instance_id>"
```

### 2. Download the Sensor Installer via API

```bash
TOKEN=$(curl -s -X POST "https://api.crowdstrike.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${FALCON_CLIENT_ID}&client_secret=${FALCON_CLIENT_SECRET}" | jq -r '.access_token')

SENSOR_SHA=$(curl -s -X GET "https://api.crowdstrike.com/sensors/combined/installers/v2?filter=platform:'windows'&sort=version|desc&limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.resources[0].sha256')

curl -s -X GET "https://api.crowdstrike.com/sensors/entities/download-installer/v2?id=${SENSOR_SHA}" \
  -H "Authorization: Bearer $TOKEN" \
  -o WindowsSensor.exe
```

### 3. Upload Sensor to S3

```bash
S3_BUCKET="falcon-sensor-installers-$(aws sts get-caller-identity --query Account --output text)"

aws s3 mb s3://${S3_BUCKET} --region $AWS_REGION 2>/dev/null
aws s3 cp WindowsSensor.exe s3://${S3_BUCKET}/WindowsSensor.exe
```

### 4. Install via SSM Run Command

```bash
aws ssm send-command \
  --document-name "AWS-RunPowerShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --parameters "commands=[
    'Read-S3Object -BucketName ${S3_BUCKET} -Key WindowsSensor.exe -File C:\\Windows\\Temp\\WindowsSensor.exe',
    'Start-Process -FilePath C:\\Windows\\Temp\\WindowsSensor.exe -ArgumentList \"/install /quiet /norestart CID=${FALCON_CID}\" -Wait',
    'Get-Service CsFalconService | Select-Object Status, DisplayName'
  ]" \
  --region $AWS_REGION \
  --output json
```

### 5. Verify

```bash
COMMAND_ID=$(aws ssm send-command \
  --document-name "AWS-RunPowerShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --parameters 'commands=["Get-Service CsFalconService"]' \
  --region $AWS_REGION \
  --query 'Command.CommandId' --output text)

sleep 10

aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --region $AWS_REGION \
  --query 'StandardOutputContent' --output text
```

Expected: `CsFalconService` with status `Running`.

</div>

<div data-mode="lab">

### 1. Launch a Windows EC2 Instance with SSM

> **What & Why:** We need a Windows instance with the SSM Agent running. Modern Windows Server AMIs include the SSM Agent by default — we just need the right IAM instance profile.

#### Create IAM Instance Profile for SSM

```bash
export AWS_REGION="us-east-1"

# Create the IAM role for SSM
aws iam create-role \
  --role-name FalconLabSSMRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach SSM managed policy
aws iam attach-role-policy \
  --role-name FalconLabSSMRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# Attach S3 read policy (to download sensor from S3)
aws iam attach-role-policy \
  --role-name FalconLabSSMRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Create instance profile and attach role
aws iam create-instance-profile --instance-profile-name FalconLabSSMProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name FalconLabSSMProfile \
  --role-name FalconLabSSMRole
```

> Wait ~10 seconds for IAM propagation before launching the instance.

#### Launch the Windows Instance

```bash
# Find the latest Windows Server 2022 AMI
WIN_AMI=$(aws ssm get-parameters-by-path \
  --path "/aws/service/ami-windows-latest" \
  --query "Parameters[?contains(Name,'Windows_Server-2022-English-Full-Base')].Value" \
  --output text --region $AWS_REGION)

# Launch instance
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $WIN_AMI \
  --instance-type t3.medium \
  --iam-instance-profile Name=FalconLabSSMProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=falcon-ssm-lab}]' \
  --region $AWS_REGION \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance ID: $INSTANCE_ID"
```

#### Verify SSM Connectivity

Wait 2-3 minutes for the instance to boot and the SSM agent to register:

```bash
# Check instance is managed by SSM
aws ssm describe-instance-information \
  --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
  --region $AWS_REGION \
  --query 'InstanceInformationList[0].{PingStatus:PingStatus,Platform:PlatformName,AgentVersion:AgentVersion}'
```

Expected output:

```json
{
    "PingStatus": "Online",
    "PlatformName": "Microsoft Windows Server 2022 Datacenter",
    "AgentVersion": "3.x.x.x"
}
```

If `PingStatus` is not "Online", wait another minute and retry. The SSM Agent takes time to register after instance boot.

### 2. Set CrowdStrike API Credentials

> **What & Why:** The CrowdStrike API provides programmatic access to download the sensor installer. We use OAuth2 credentials to authenticate.

```bash
export FALCON_CLIENT_ID="<your_client_id>"
export FALCON_CLIENT_SECRET="<your_client_secret>"
export FALCON_CID="<your_cid_with_checksum>"
```

### 3. Download the Sensor Installer via API

> **What & Why:** Instead of downloading manually from the console, we use the Sensor Download API to get the latest Windows installer. This is automatable and ensures you always get the latest version.

```bash
# Get OAuth2 token
TOKEN=$(curl -s -X POST "https://api.crowdstrike.com/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${FALCON_CLIENT_ID}&client_secret=${FALCON_CLIENT_SECRET}" | jq -r '.access_token')

echo "Token obtained: ${TOKEN:0:10}..."

# Get latest Windows sensor metadata
curl -s -X GET "https://api.crowdstrike.com/sensors/combined/installers/v2?filter=platform:'windows'&sort=version|desc&limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq '.resources[0] | {name, version, sha256, file_size}'

# Get the SHA256 for download
SENSOR_SHA=$(curl -s -X GET "https://api.crowdstrike.com/sensors/combined/installers/v2?filter=platform:'windows'&sort=version|desc&limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.resources[0].sha256')

# Download the installer
curl -s -X GET "https://api.crowdstrike.com/sensors/entities/download-installer/v2?id=${SENSOR_SHA}" \
  -H "Authorization: Bearer $TOKEN" \
  -o WindowsSensor.exe

ls -lh WindowsSensor.exe
```

> **What to look for:** The file should be ~80-120MB.

### 4. Upload Sensor to S3

> **What & Why:** SSM Run Command can't directly transfer large files. We stage the installer in S3, then use PowerShell's `Read-S3Object` cmdlet (available on AWS Windows AMIs) to download it onto the target instance.

```bash
S3_BUCKET="falcon-sensor-installers-$(aws sts get-caller-identity --query Account --output text)"

aws s3 mb s3://${S3_BUCKET} --region $AWS_REGION 2>/dev/null
aws s3 cp WindowsSensor.exe s3://${S3_BUCKET}/WindowsSensor.exe

# Verify upload
aws s3 ls s3://${S3_BUCKET}/WindowsSensor.exe
```

### 5. Install Falcon Sensor via SSM Run Command

> **What & Why:** SSM Run Command executes PowerShell remotely on the instance without needing RDP access or opening any inbound ports. The SSM Agent pulls commands from the SSM service over HTTPS.

```bash
COMMAND_ID=$(aws ssm send-command \
  --document-name "AWS-RunPowerShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --parameters "commands=[
    'Write-Output \"Downloading sensor from S3...\"',
    'Read-S3Object -BucketName ${S3_BUCKET} -Key WindowsSensor.exe -File C:\\Windows\\Temp\\WindowsSensor.exe -Region ${AWS_REGION}',
    'Write-Output \"Installing Falcon sensor...\"',
    'Start-Process -FilePath C:\\Windows\\Temp\\WindowsSensor.exe -ArgumentList \"/install /quiet /norestart CID=${FALCON_CID}\" -Wait -NoNewWindow',
    'Write-Output \"Verifying installation...\"',
    'Start-Sleep -Seconds 10',
    'Get-Service CsFalconService | Select-Object Status, DisplayName',
    'Write-Output \"Sensor version:\"',
    'Get-ItemProperty \"HKLM:\\SYSTEM\\CrowdStrike\\{9b03c1d9-3138-44ed-9fae-d9f4c034b88d}\\{16e0423f-7058-48c9-a204-725362b67639}\\Default\" -Name AG 2>$null | Select-Object -ExpandProperty AG'
  ]" \
  --region $AWS_REGION \
  --comment "Install CrowdStrike Falcon sensor" \
  --query 'Command.CommandId' --output text)

echo "Command ID: $COMMAND_ID"
```

Wait for the command to complete:

```bash
# Wait for completion
aws ssm wait command-executed \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --region $AWS_REGION 2>/dev/null || true

# Get results
aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --region $AWS_REGION \
  --query '{Status:Status, Output:StandardOutputContent, Error:StandardErrorContent}'
```

Expected output:

```
Downloading sensor from S3...
Installing Falcon sensor...
Verifying installation...

Status      DisplayName
------      -----------
Running     CrowdStrike Falcon Sensor Service
```

### 6. Deep Verification

> **What & Why:** Beyond just checking the service status, verify the sensor is communicating with the CrowdStrike cloud and has a valid Agent ID (AID).

#### Check Sensor Service Status

```bash
COMMAND_ID=$(aws ssm send-command \
  --document-name "AWS-RunPowerShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --parameters 'commands=[
    "Write-Output \"=== Service Status ===\"",
    "Get-Service CsFalconService | Format-List Status, StartType, DisplayName",
    "Write-Output \"=== Agent ID (AID) ===\"",
    "$aid = Get-ItemProperty \"HKLM:\\SYSTEM\\CrowdStrike\\{9b03c1d9-3138-44ed-9fae-d9f4c034b88d}\\{16e0423f-7058-48c9-a204-725362b67639}\\Default\" -Name AG 2>$null; if ($aid) { $aid.AG } else { Write-Output \"AID not yet assigned (sensor still initializing)\" }",
    "Write-Output \"=== Falcon Process ===\"",
    "Get-Process -Name CSFalconService -ErrorAction SilentlyContinue | Select-Object ProcessName, Id, CPU, WorkingSet64"
  ]' \
  --region $AWS_REGION \
  --query 'Command.CommandId' --output text)

sleep 15

aws ssm get-command-invocation \
  --command-id $COMMAND_ID \
  --instance-id $INSTANCE_ID \
  --region $AWS_REGION \
  --query 'StandardOutputContent' --output text
```

#### Verify in Falcon Console

Navigate to **Host setup and management** > **Host management** in the Falcon console:

- Search for the hostname or AID
- Confirm the host shows as **Online** with the correct OS version
- Check the sensor version matches what was installed
- Verify the CID matches your tenant

> The host typically appears within 2-3 minutes of the sensor starting.

### 7. Cleanup

Remove all resources created during this lab:

```bash
# Terminate the EC2 instance
aws ec2 terminate-instances --instance-ids $INSTANCE_ID --region $AWS_REGION

# Wait for termination
aws ec2 wait instance-terminated --instance-ids $INSTANCE_ID --region $AWS_REGION

# Remove S3 bucket and contents
aws s3 rb s3://${S3_BUCKET} --force

# Remove IAM resources
aws iam remove-role-from-instance-profile \
  --instance-profile-name FalconLabSSMProfile \
  --role-name FalconLabSSMRole

aws iam delete-instance-profile --instance-profile-name FalconLabSSMProfile

aws iam detach-role-policy \
  --role-name FalconLabSSMRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam detach-role-policy \
  --role-name FalconLabSSMRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

aws iam delete-role --role-name FalconLabSSMRole

# Remove local installer
rm -f WindowsSensor.exe
```

#### Deregister from Falcon Console

In the Falcon console, navigate to **Host setup and management** > **Host management**, find the host, and hide it (it will auto-deregister after the instance is terminated).

</div>

---

## Quick Reference

| Action | Command |
|--------|---------|
| Check SSM connectivity | `aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE_ID"` |
| Run PowerShell via SSM | `aws ssm send-command --document-name "AWS-RunPowerShellScript" --instance-ids $INSTANCE_ID --parameters 'commands=[...]'` |
| Get command output | `aws ssm get-command-invocation --command-id $COMMAND_ID --instance-id $INSTANCE_ID` |
| Check sensor service | `Get-Service CsFalconService` |
| Get sensor AID | Registry key `HKLM:\SYSTEM\CrowdStrike\...\Default` property `AG` |
| Download sensor via API | `GET /sensors/entities/download-installer/v2?id=<sha256>` |

---

*Created: 2026-06-26 | Topics: falcon-sensor, windows, aws-ssm, systems-manager, ec2*
