# Falcon Sensor for Linux — AWS Systems Manager (SSM) Distributor

> **What this deploys:** The Falcon sensor on Linux EC2 instances using AWS Systems Manager Distributor and the CrowdStrike SSM package. No SSH required — installs happen over the SSM control channel.

> **Prerequisites:**
>
> - AWS account with SSM permissions
> - EC2 instances with the SSM Agent installed and running (Amazon Linux 2/2023 include it by default)
> - IAM instance profile with `AmazonSSMManagedInstanceCore` policy attached
> - CrowdStrike API client with **Sensor Download: Read** scope
> - CrowdStrike CID with checksum
> - ~20 minutes

## Reference Docs

| Source                                    | Link                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| CrowdStrike SSM Distributor Package       | https://github.com/CrowdStrike/falcon-scripts/tree/main/aws/ssm                           |
| AWS SSM Distributor                       | https://docs.aws.amazon.com/systems-manager/latest/userguide/distributor.html              |
| Deploy Falcon via SSM                     | https://docs.crowdstrike.com/r/en-US/iopiipqy/cba4f917                                    |
| SSM Run Command                           | https://docs.aws.amazon.com/systems-manager/latest/userguide/execute-remote-commands.html  |

---

## 1. How SSM Distributor Works

> **~5 min | Beginner**

AWS Systems Manager Distributor is a package management feature that installs software on managed instances without SSH access. The SSM Agent on each instance communicates with the SSM service over HTTPS, receives commands, and executes them locally.

For Falcon sensor deployment:
- The CrowdStrike Distributor package contains the install/uninstall logic
- SSM Run Command triggers installation across one or many instances
- No inbound ports required — the agent initiates outbound connections
- Works with EC2 instances, on-premises servers, and hybrid environments

```
┌─────────────────────────────────┐
│ AWS Systems Manager Console/CLI │
└──────────────┬──────────────────┘
               │ HTTPS (SSM API)
               ▼
┌─────────────────────────────────┐
│ SSM Agent (on each EC2)         │
│ • Receives Run Command          │
│ • Executes install/configure    │
└──────────────┬──────────────────┘
               │ Installs
               ▼
┌─────────────────────────────────┐
│ falcon-sensor service           │──── TLS 443 ────▶ CrowdStrike Cloud
└─────────────────────────────────┘
```

---

## 2. Create API Credentials

> **~5 min | Beginner**

> **What this does:** Creates an OAuth2 API client in the Falcon console for the SSM package to authenticate and download the sensor.

1. Log in to the Falcon console at https://falcon.crowdstrike.com
2. Navigate to **Support and resources** > **Resources and tools** > **API clients and keys**
3. Click **Create API client**
4. Name: `ssm-distributor-install`
5. Enable scopes:

| Scope | Permission | When Needed |
|-------|-----------|-------------|
| **Sensor Download** | Read | Always required |
| **Installation Tokens** | Read | If your tenant enforces provisioning tokens |

6. Click **Create**
7. Copy the **Client ID** and **Client Secret** immediately

---

## Deployment Steps

<div data-mode="guide">

### 1. Set environment variables

```bash
export AWS_REGION=<your-aws-region>
export FALCON_CID="<your-cid-with-checksum>"
```

### 2. Install via SSM Distributor

```bash
aws ssm send-command \
  --document-name "AWS-ConfigureAWSPackage" \
  --parameters '{
    "action": ["Install"],
    "name": ["CrowdStrike-FalconSensor"],
    "additionalArguments": ["{\"SSM_CS_CCID\":\"'"$FALCON_CID"'\",\"SSM_CS_INSTALLPARAMS\":\"--tags=SSM-Deployed\"}"]
  }' \
  --targets "Key=tag:Name,Values=<YOUR_INSTANCE_TAG>" \
  --region $AWS_REGION
```

### 3. Verify

```bash
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo /opt/CrowdStrike/falconctl -g --aid"]' \
  --targets "Key=tag:Name,Values=<YOUR_INSTANCE_TAG>" \
  --region $AWS_REGION
```

A valid 32-character AID confirms registration.

</div>

<div data-mode="lab">

## 3. Launch EC2 Instances with SSM Access

> **~10 min | Intermediate**

> **What this does:** Provisions EC2 instances with the required IAM role for SSM connectivity, then verifies they appear as managed instances.

### Create the IAM instance profile

```bash
export AWS_REGION=<your-aws-region>

aws iam create-role \
  --role-name FalconSSMLabRole \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name FalconSSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam create-instance-profile \
  --instance-profile-name FalconSSMLabProfile

aws iam add-role-to-instance-profile \
  --instance-profile-name FalconSSMLabProfile \
  --role-name FalconSSMLabRole
```

> Wait ~10 seconds for IAM propagation before launching instances.

### Launch two instances

```bash
export INSTANCE_IDS=$(aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.micro \
  --count 2 \
  --iam-instance-profile Name=FalconSSMLabProfile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=falcon-ssm-lab}]' \
  --query 'Instances[*].InstanceId' --output text \
  --region $AWS_REGION) && echo $INSTANCE_IDS

aws ec2 wait instance-running --instance-ids $INSTANCE_IDS --region $AWS_REGION
```

### Verify SSM connectivity

Wait 1-2 minutes for the SSM agent to register, then:

```bash
aws ssm describe-instance-information \
  --filters "Key=tag:Name,Values=falcon-ssm-lab" \
  --query 'InstanceInformationList[*].[InstanceId,PingStatus]' \
  --output table \
  --region $AWS_REGION
```

> Look for: `PingStatus: Online` for both instances. If they show as `ConnectionLost`, wait another minute and retry.

---

## 4. Install via SSM Distributor

> **~5 min | Beginner**

### Set environment variables

```bash
export FALCON_CID="<your-cid-with-checksum>"
```

### Run the SSM command

```bash
export COMMAND_ID=$(aws ssm send-command \
  --document-name "AWS-ConfigureAWSPackage" \
  --parameters '{
    "action": ["Install"],
    "name": ["CrowdStrike-FalconSensor"],
    "additionalArguments": ["{\"SSM_CS_CCID\":\"'"$FALCON_CID"'\",\"SSM_CS_INSTALLPARAMS\":\"--tags=SSM-Lab-Deployed\"}"]
  }' \
  --targets "Key=tag:Name,Values=falcon-ssm-lab" \
  --query 'Command.CommandId' --output text \
  --region $AWS_REGION) && echo $COMMAND_ID
```

### Monitor the command execution

```bash
aws ssm list-command-invocations \
  --command-id $COMMAND_ID \
  --details \
  --query 'CommandInvocations[*].[InstanceId,Status,StatusDetails]' \
  --output table \
  --region $AWS_REGION
```

> Look for `Status: Success` for each instance. If `InProgress`, wait and retry.

---

## 5. Verify Registration

> **~5 min | Beginner**

### Check sensor status via SSM (no SSH needed)

```bash
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo systemctl status falcon-sensor","sudo /opt/CrowdStrike/falconctl -g --aid --cid --version --tags"]' \
  --targets "Key=tag:Name,Values=falcon-ssm-lab" \
  --region $AWS_REGION \
  --query 'Command.CommandId' --output text
```

Retrieve the output:

```bash
aws ssm get-command-invocation \
  --command-id <COMMAND_ID_FROM_ABOVE> \
  --instance-id <ONE_OF_YOUR_INSTANCE_IDS> \
  --query '[StandardOutputContent]' --output text \
  --region $AWS_REGION
```

> Look for: `Active: active (running)` and a valid 32-character AID.

### Verify cloud connectivity

```bash
aws ssm send-command \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["sudo ss -tnp | grep falcon"]' \
  --targets "Key=tag:Name,Values=falcon-ssm-lab" \
  --region $AWS_REGION
```

> Look for: `ESTAB` connection on port 443.

### Find hosts in the Falcon console

1. Navigate to **Host setup and management** > **Host management**
2. Search for `falcon-ssm-lab`
3. Both instances should appear with:
   - **Status:** Online (green dot)
   - **OS:** Amazon Linux 2023
   - **Tags:** `SSM-Lab-Deployed`

---

## 6. Cleanup

```bash
# Terminate EC2 instances
aws ec2 terminate-instances --instance-ids $INSTANCE_IDS --region $AWS_REGION
aws ec2 wait instance-terminated --instance-ids $INSTANCE_IDS --region $AWS_REGION

# Remove IAM resources
aws iam remove-role-from-instance-profile \
  --instance-profile-name FalconSSMLabProfile \
  --role-name FalconSSMLabRole

aws iam delete-instance-profile \
  --instance-profile-name FalconSSMLabProfile

aws iam detach-role-policy \
  --role-name FalconSSMLabRole \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

aws iam delete-role --role-name FalconSSMLabRole
```

</div>

---

## 5. Uninstall via SSM

> **~2 min | Beginner**

```bash
aws ssm send-command \
  --document-name "AWS-ConfigureAWSPackage" \
  --parameters '{
    "action": ["Uninstall"],
    "name": ["CrowdStrike-FalconSensor"]
  }' \
  --targets "Key=tag:Name,Values=<YOUR_INSTANCE_TAG>" \
  --region $AWS_REGION
```

---

## 6. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Instance not appearing in SSM | Missing IAM role or SSM agent not running | Attach `AmazonSSMManagedInstanceCore` policy; verify agent: `systemctl status amazon-ssm-agent` |
| Command status `Failed` | Package not available in region or invalid parameters | Check `aws ssm get-command-invocation --details` for error output |
| Sensor installed but no AID | Outbound 443 blocked | Verify security group/NACL allows egress to `*.cloudsink.net:443` |
| `AccessDeniedException` on send-command | Caller lacks SSM permissions | Ensure your IAM user/role has `ssm:SendCommand` on the target instances |

---

## 7. Quick Reference

| Action | Command |
|--------|---------|
| Install via SSM | `aws ssm send-command --document-name "AWS-ConfigureAWSPackage" --parameters '{"action":["Install"],"name":["CrowdStrike-FalconSensor"],...}'` |
| Uninstall via SSM | `aws ssm send-command --document-name "AWS-ConfigureAWSPackage" --parameters '{"action":["Uninstall"],"name":["CrowdStrike-FalconSensor"]}'` |
| Check command status | `aws ssm list-command-invocations --command-id <ID> --details` |
| Run ad-hoc command | `aws ssm send-command --document-name "AWS-RunShellScript" --parameters 'commands=[...]'` |
| List managed instances | `aws ssm describe-instance-information --query 'InstanceInformationList[*].[InstanceId,PingStatus]'` |
| Get AID via SSM | `aws ssm send-command ... --parameters 'commands=["sudo /opt/CrowdStrike/falconctl -g --aid"]'` |

---

*Created: 2026-06-26 | Topics: falcon-sensor, linux, aws-ssm, distributor, ec2*
