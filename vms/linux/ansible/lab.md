# Falcon Sensor Deployment with Ansible Collection Lab

> **Prerequisites:**
>
> - GCP project with Compute Engine API enabled
> - `gcloud` CLI installed and authenticated
> - Python 3.7+ on your workstation
> - CrowdStrike Falcon console access (API client creation + Sensor Downloads)
> - Terraform >= 1.0 installed
> - ~70 minutes

## Reference Docs

| Source                                | Link                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| crowdstrike.falcon Ansible Collection | https://github.com/CrowdStrike/ansible_collection_falcon                                            |
| falcon_install Role README            | https://github.com/CrowdStrike/ansible_collection_falcon/blob/main/roles/falcon_install/README.md   |
| falcon_configure Role README          | https://github.com/CrowdStrike/ansible_collection_falcon/blob/main/roles/falcon_configure/README.md |
| GCP Console - Create a VM             | https://cloud.google.com/compute/docs/instances/create-start-instance                               |
| Terraform google_compute_instance     | https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance     |

---

## 1. Intro & Architecture

> **~5 min | Beginner**

The `crowdstrike.falcon` Ansible collection is CrowdStrike's official automation toolkit for sensor lifecycle management. Instead of manually SSHing into each host to copy and install packages, the collection talks directly to the Falcon API to download the correct sensor for each target OS, install it, configure the CID and tags, and start the service — all in one playbook run.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Your Workstation (Ansible Control Node)                                 │
│                                                                          │
│  ansible-playbook deploy-falcon.yml                                      │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  crowdstrike.falcon.falcon_install                                 │  │
│  │  • Authenticates to Falcon API (OAuth2)                            │  │
│  │  • Downloads correct .deb for target OS                            │  │
│  │  • Installs the package                                            │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │  crowdstrike.falcon.falcon_configure                               │  │
│  │  • Sets CID (auto-fetched from API)                                │  │
│  │  • Applies grouping tags                                           │  │
│  │  • Starts falcon-sensor service                                    │  │
│  └──────────┬────────────────────────────────────────┬──────────────┘  │
└─────────────┼────────────────────────────────────────┼─────────────────┘
              │ SSH                                     │ SSH
              ▼                                        ▼
┌────────────────────────┐       ┌────────────────────────┐
│  falcon-linux-deb-12   │       │  falcon-linux-deb-13   │
│  (Debian 12 Bookworm)  │       │  (Debian 13 Trixie)    │
└────────────┬───────────┘       └────────────┬───────────┘
             │                                │
             └──────────┬─────────────────────┘
                        │ HTTPS/443
                        ▼
            ┌───────────────────────┐
            │  CrowdStrike Cloud    │
            └───────────────────────┘
```

**Key differences from bare Ansible:**

- No need to download `.deb` files manually — the collection fetches them via API
- No OS-specific branching (`when: ansible_os_family`) — the roles detect the OS automatically
- CID is auto-fetched from the API — you don't need to copy it from the console
- Idempotent — re-running won't reinstall if the sensor is already present

---

## 2. Prerequisites & Ansible Setup

> **~10 min | Intermediate**

### Step 1: Install Ansible

> **What & Why:** Ansible runs on your workstation and connects to target VMs via SSH. The `crowdstrike.falcon` collection also requires the FalconPy SDK on the control node to authenticate with the Falcon API.

- [ ] Install Ansible and the FalconPy dependency:

```bash
pip3 install ansible crowdstrike-falconpy
```

- [ ] Verify:

```bash
ansible --version
```

> Look for `ansible [core 2.15+]` — the collection requires 2.15 or newer.

### Step 2: Install the crowdstrike.falcon collection

> **What & Why:** The collection provides the `falcon_install` and `falcon_configure` roles that handle the entire sensor lifecycle. Without it, you'd write all the installation logic yourself.

- [ ] Install from Galaxy:

```bash
ansible-galaxy collection install crowdstrike.falcon
```

> Look for: `crowdstrike.falcon:<version> was installed successfully`

### Step 3: Create a Falcon API Client

> **What & Why:** The collection authenticates to the Falcon API to download the sensor installer and fetch your CID. You need an API client with the right scopes.

- [ ] **Console:** Navigate to **Support and resources** → **Resources and tools** → **API clients and keys** → Click **Create API client**
  - Client name: `ansible-lab`
  - Scope: Check **Sensor Download** [read] and **Sensor update policies** [read]
  - Click **Create**

- [ ] Copy the **Client ID** and **Client Secret** — you'll need them in the playbook

> ⚠️ **The secret is only shown once.** Copy it immediately. If you lose it, you'll need to create a new client.

<details>
<summary>CLI equivalent (via FalconPy)</summary>

There's no CLI to create API clients — this must be done in the console. But you can verify your credentials work:

```bash
python3 -c "
from falconpy import OAuth2
auth = OAuth2(client_id='<YOUR_CLIENT_ID>', client_secret='<YOUR_CLIENT_SECRET>')
print(auth.token()['status_code'])  # Should print 201
"
```

</details>

---

## Deployment Steps

<div data-mode="guide">

### 1. Set API credentials

```bash
export FALCON_CLIENT_ID="<your-client-id>"
export FALCON_CLIENT_SECRET="<your-client-secret>"
```

### 2. Write the inventory

Create `inventory.ini` targeting your existing hosts:

```ini
[falcon_hosts]
host1 ansible_host=<IP_ADDRESS_1>
host2 ansible_host=<IP_ADDRESS_2>

[falcon_hosts:vars]
ansible_user=<YOUR_SSH_USERNAME>
ansible_ssh_private_key_file=~/.ssh/<YOUR_KEY>
ansible_ssh_common_args=-o StrictHostKeyChecking=no
```

### 3. Write the playbook

Create `deploy-falcon.yml`:

```yaml
---
- name: Deploy CrowdStrike Falcon Sensor
  hosts: falcon_hosts
  vars:
    falcon_client_id: "{{ lookup('env', 'FALCON_CLIENT_ID') }}"
    falcon_client_secret: "{{ lookup('env', 'FALCON_CLIENT_SECRET') }}"
    falcon_tags: "ansible-deployed"

  roles:
    - role: crowdstrike.falcon.falcon_install
      vars:
        falcon_sensor_version_decrement: 2

    - role: crowdstrike.falcon.falcon_configure
      vars:
        falcon_tags: "{{ falcon_tags }}"
```

### 4. Run the playbook

```bash
ansible-playbook -i inventory.ini deploy-falcon.yml
```

Look for `failed=0` in the PLAY RECAP.

### 5. Verify

```bash
ansible -i inventory.ini falcon_hosts -m command -a "/opt/CrowdStrike/falconctl -g --aid" --become
```

A valid 32-character AID on each host confirms registration.

</div>

<div data-mode="lab">

## 3. Create 2 GCE VMs

> **~10 min | Intermediate**

### Step 1: Create the Debian 12 VM

> **What & Why:** These are your target hosts where the Falcon sensor will be deployed. We create them in the GCP Console first for muscle memory, then import them into Terraform later.

- [ ] **Console:** Navigate to **Compute Engine** → **VM Instances** → Click **Create Instance**
  - Name: `falcon-linux-deb-12`
  - Region: `<YOUR_GCP_REGION>` / Zone: `<YOUR_GCP_ZONE>`
  - Machine type: `e2-medium`
  - Boot disk: Click **Change** → Select **Debian** → **Debian GNU/Linux 12 (Bookworm)** → Click **Select**
  - Networking → Network tags: Add `falcon-lab`
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
gcloud compute instances create falcon-linux-deb-12 \
  --machine-type=e2-medium \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=falcon-lab \
  --zone=<YOUR_GCP_ZONE>
```

</details>

### Step 2: Create the Debian 13 VM

- [ ] **Console:** Navigate to **Compute Engine** → **VM Instances** → Click **Create Instance**
  - Name: `falcon-linux-deb-13`
  - Region: `<YOUR_GCP_REGION>` / Zone: `<YOUR_GCP_ZONE>`
  - Machine type: `e2-medium`
  - Boot disk: Click **Change** → Select **Debian** → **Debian GNU/Linux 13 (Trixie)** → Click **Select**
  - Networking → Network tags: Add `falcon-lab`
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
gcloud compute instances create falcon-linux-deb-13 \
  --machine-type=e2-medium \
  --image-family=debian-13 \
  --image-project=debian-cloud \
  --tags=falcon-lab \
  --zone=<YOUR_GCP_ZONE>
```

</details>

### Step 3: Lock down SSH to your IP only

> **What & Why:** GCP's default VPC includes a `default-allow-ssh` rule that allows port 22 from `0.0.0.0/0` — meaning anyone on the internet can attempt SSH connections to your VMs. Unlike AWS Security Groups which deny all inbound by default, GCP's default network is permissive. We'll add firewall rules scoped to our `falcon-lab` tag that allow SSH only from your IP.

- [ ] Find your public IP:

```bash
curl -s ifconfig.me
```

- [ ] **Console:** Navigate to **VPC network** → **Firewall** → Click **Create Firewall Rule**
  - Name: `falcon-lab-allow-ssh`
  - Network: `default`
  - Priority: `1000`
  - Direction: **Ingress**
  - Action on match: **Allow**
  - Targets: **Specified target tags** → `falcon-lab`
  - Source IPv4 ranges: `<YOUR_PUBLIC_IP>/32`
  - Protocols and ports: Check **TCP** → `22`
  - Click **Create**

- [ ] Create a second rule to deny all other SSH:
  - Name: `falcon-lab-deny-ssh`
  - Network: `default`
  - Priority: `1001`
  - Direction: **Ingress**
  - Action on match: **Deny**
  - Targets: **Specified target tags** → `falcon-lab`
  - Source IPv4 ranges: `0.0.0.0/0`
  - Protocols and ports: Check **TCP** → `22`
  - Click **Create**

<details>
<summary>CLI equivalent</summary>

```bash
MY_IP=$(curl -s ifconfig.me)

gcloud compute firewall-rules create falcon-lab-allow-ssh \
  --network=default \
  --priority=1000 \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges="${MY_IP}/32" \
  --target-tags=falcon-lab

gcloud compute firewall-rules create falcon-lab-deny-ssh \
  --network=default \
  --priority=1001 \
  --direction=INGRESS \
  --action=DENY \
  --rules=tcp:22 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=falcon-lab
```

</details>

> **How this works:** GCP evaluates firewall rules by priority (lower number = higher priority). Traffic from your IP matches the allow rule at priority 1000 first. Traffic from any other IP skips the allow rule, then hits the deny rule at priority 1001 — blocking it before the permissive `default-allow-ssh` (priority 65534) is ever reached.

### Step 4: Verify both are running

- [ ] **Console:** On the **VM Instances** page, confirm both show a green checkmark under **Status**

> Save for Terraform: Note the external IPs shown for each VM — you'll need them for the Ansible inventory.

### Step 5: Initialize SSH keys

> **What & Why:** Ansible connects via SSH. Running `gcloud compute ssh` once per VM pushes your SSH key to GCE metadata so Ansible can connect without `gcloud` in the loop.

- [ ] Run once per VM to initialize keys:

```bash
gcloud compute ssh falcon-linux-deb-12 --zone=<YOUR_GCP_ZONE> --command="echo connected"
gcloud compute ssh falcon-linux-deb-13 --zone=<YOUR_GCP_ZONE> --command="echo connected"
```

> Look for: `connected` printed for each. If prompted to create a key, say yes.

---

## 4. Write the Ansible Inventory & Playbook

> **~15 min | Intermediate**

### Step 1: Create the project structure

> **What & Why:** A clean Ansible project separates inventory (which hosts), playbook (what to do), and variables (secrets). This structure scales from 2 VMs to 2,000.

- [ ] Create the Ansible files in this lab folder:

```bash
cd <PATH_TO_YOUR_LAB_FOLDER>
mkdir -p group_vars/all
```

### Step 2: Write the inventory

> **What & Why:** The inventory tells Ansible which hosts to target and how to connect. We group by OS version so we can apply different tags per group later.

- [ ] Create `inventory.ini`:

```ini
[debian12]
falcon-linux-deb-12 ansible_host=<EXTERNAL_IP_1>

[debian13]
falcon-linux-deb-13 ansible_host=<EXTERNAL_IP_2>

[falcon_hosts:children]
debian12
debian13

[falcon_hosts:vars]
ansible_user=<YOUR_GCP_USERNAME>
ansible_ssh_private_key_file=~/.ssh/google_compute_engine
ansible_ssh_common_args=-o StrictHostKeyChecking=no
```

> Replace `<EXTERNAL_IP_*>` with the IPs from Step 3.3. Your GCP username is usually your email prefix (check with `gcloud config get account`).

### Step 3: Encrypt the API credentials with Ansible Vault

> **What & Why:** API secrets should never be in plaintext. Ansible Vault encrypts them at rest so the file is safe to commit to version control. The playbook decrypts them at runtime when you provide the vault password.

- [ ] Create the encrypted vars file:

```bash
ansible-vault create group_vars/all/vault.yml
```

- [ ] When the editor opens, add:

```yaml
vault_falcon_client_id: "<YOUR_CLIENT_ID>"
vault_falcon_client_secret: "<YOUR_CLIENT_SECRET>"
```

Save and exit. The file is now encrypted.

> ⚠️ **Remember your vault password.** You'll need it every time you run the playbook.

### Step 4: Create the variable reference file

> **What & Why:** This unencrypted file maps vault variables to the names the collection expects. It separates "what variables exist" (visible) from "what their values are" (encrypted).

- [ ] Create `group_vars/all/falcon.yml`:

```yaml
---
falcon_client_id: "{{ vault_falcon_client_id }}"
falcon_client_secret: "{{ vault_falcon_client_secret }}"
falcon_sensor_version_decrement: 2
```

> We use `falcon_sensor_version_decrement: 2` to install N-2 (two versions behind latest) — this is CrowdStrike's recommended practice for production stability.

### Step 5: Write the playbook

> **What & Why:** This is the main deployment file. It calls two roles from the collection: `falcon_install` (downloads + installs) and `falcon_configure` (sets CID, tags, starts the service). The collection handles OS detection internally — one playbook works for both Debian 12 and Debian 13.

- [ ] Create `deploy-falcon.yml`:

```yaml
---
- name: Deploy CrowdStrike Falcon Sensor
  hosts: falcon_hosts
  vars:
    falcon_tags: "<YOUR_CLOUD>/<YOUR_REGION>,Lab,ansible-deployed"

  roles:
    - role: crowdstrike.falcon.falcon_install
      vars:
        falcon_sensor_version_decrement: 2

    - role: crowdstrike.falcon.falcon_configure
      vars:
        falcon_tags: "{{ falcon_tags }}"
```

> **Important:** Do NOT add `become: true` at the play level. The roles handle privilege escalation internally.

### Step 6: Test connectivity

- [ ] Verify Ansible can reach all hosts:

```bash
ansible -i inventory.ini falcon_hosts -m ping
```

> Look for: `SUCCESS` with `"pong"` for both hosts. If any show `UNREACHABLE`, double-check the IP and SSH key path.

---

## 5. Deploy the Sensor

> **~10 min | Intermediate**

### Step 1: Run the playbook

> **What & Why:** This single command deploys the Falcon sensor to both VMs. The collection authenticates to the Falcon API, downloads the correct package for each OS version, installs it, sets the CID (auto-fetched), applies your tags, and starts the service.

- [ ] Deploy:

```bash
ansible-playbook -i inventory.ini deploy-falcon.yml --ask-vault-pass
```

> Enter your vault password when prompted.

> Look for the **PLAY RECAP** at the end:
>
> ```
> falcon-linux-deb-12  : ok=X  changed=X  unreachable=0  failed=0
> falcon-linux-deb-13  : ok=X  changed=X  unreachable=0  failed=0
> ```
>
> You want `failed=0` across both hosts.

### Step 2: Verify idempotency

> **What & Why:** Running the same playbook again should show mostly `ok` (green) instead of `changed` (yellow). This proves the collection is idempotent — it won't reinstall a sensor that's already present and configured correctly.

- [ ] Run again:

```bash
ansible-playbook -i inventory.ini deploy-falcon.yml --ask-vault-pass
```

> Look for: Most tasks show `ok`. The collection skips installation if the sensor is already at the correct version.

---

## 6. Verify in Falcon Console

> **~5 min | Intermediate**

### Step 1: Confirm hosts registered

> **What & Why:** The sensor phones home to CrowdStrike cloud after starting. Hosts should appear within 2-5 minutes.

- [ ] **Console:** Navigate to **Host setup and management** → **Manage endpoints** → **Host management**
- [ ] Search for: `falcon-linux-deb-12`, `falcon-linux-deb-13`

> Look for:
>
> - **Status:** Online (green dot)
> - **Platform:** Linux
> - **OS:** Debian 12 / Debian 13
> - **Sensor version:** N-2 (two behind latest, as configured)
> - **Tags:** `<YOUR_CLOUD>/<YOUR_REGION>,Lab,ansible-deployed`

### Step 2: Verify tags are applied

- [ ] Click on any host → Check the **Grouping Tags** field in the detail panel

> Tags should show: `<YOUR_CLOUD>/<YOUR_REGION>,Lab,ansible-deployed`

> ⚠️ **Hosts not appearing?** Check:
>
> - VPC firewall allows egress to `*.cloudsink.net:443`
> - Run: `ansible -i inventory.ini falcon_hosts -m command -a "systemctl status falcon-sensor" --become`

### Step 3: Deep verification via SSH

- [ ] Check sensor process is running on each host:

```bash
ansible -i inventory.ini falcon_hosts -m command -a "ps aux | grep falcon-sensor" --become
```

- [ ] Verify the Agent ID (AID) is set:

```bash
ansible -i inventory.ini falcon_hosts -m command -a "/opt/CrowdStrike/falconctl -g --aid" --become
```

> Look for: a 32-character hex string on each host.

- [ ] Verify cloud connectivity:

```bash
ansible -i inventory.ini falcon_hosts -m command -a "ss -tnp | grep falcon" --become
```

> Look for: `ESTAB` connection on port 443.

---

## 7. Connect Back to Terraform

> **~15 min | Intermediate**

You've built everything by hand — now let's make it repeatable. We'll import your existing GCE VMs into Terraform so you can tear down and recreate the infrastructure with one command.

> Note: Terraform manages the **infrastructure** (VMs, network). Ansible manages the **configuration** (sensor deployment). Together: `terraform apply` creates the VMs, then `ansible-playbook` deploys the sensor.

### Step 1: Initialize Terraform

> **What & Why:** `terraform init` downloads the Google provider plugin so Terraform can manage GCE resources. Think of it like `pip install` for infrastructure.

- [ ] From this lab folder:

```bash
cd <PATH_TO_YOUR_LAB_FOLDER>
terraform init
```

> Look for: `Terraform has been successfully initialized!`

### Step 2: Fill in your terraform.tfvars

> **What & Why:** The `.tfvars` file contains your specific values (project ID, zone). It's gitignored so secrets don't leak.

- [ ] Edit `terraform.tfvars` and replace the placeholder values with your actual GCP project ID and public IP:

```hcl
project_id   = "<YOUR_GCP_PROJECT_ID>"
region       = "<YOUR_GCP_REGION>"
zone         = "<YOUR_GCP_ZONE>"
machine_type = "e2-medium"
my_ip_cidr   = "<YOUR_PUBLIC_IP>/32"  # Run: curl -s ifconfig.me
```

### Step 3: Import existing VMs and firewall rules

> **What & Why:** `terraform import` tells Terraform "this resource in my `.tf` file corresponds to this real VM that already exists." After import, Terraform tracks it in state.

- [ ] Import each resource:

```bash
terraform import google_compute_instance.falcon_linux_deb_12 projects/<YOUR_PROJECT>/zones/<YOUR_GCP_ZONE>/instances/falcon-linux-deb-12

terraform import google_compute_instance.falcon_linux_deb_13 projects/<YOUR_PROJECT>/zones/<YOUR_GCP_ZONE>/instances/falcon-linux-deb-13

terraform import google_compute_firewall.falcon_lab_allow_ssh projects/<YOUR_PROJECT>/global/firewalls/falcon-lab-allow-ssh

terraform import google_compute_firewall.falcon_lab_deny_ssh projects/<YOUR_PROJECT>/global/firewalls/falcon-lab-deny-ssh
```

> Look for: `Import successful!` for each.

### Step 4: Validate with terraform plan

> **What & Why:** After importing, `terraform plan` should show no changes — meaning your `.tf` files accurately describe what exists. If it shows differences, update the config to match reality.

- [ ] Run:

```bash
terraform plan
```

> Look for: `No changes. Your infrastructure matches the configuration.`
>
> If you see planned changes (common ones: `metadata_startup_script`, `scheduling` block), add `lifecycle { ignore_changes = [...] }` for computed fields, or update the `.tf` to match.

### Step 5: Test the lifecycle

- [ ] Destroy everything:

```bash
terraform destroy
```

- [ ] Recreate from scratch:

```bash
terraform apply
```

- [ ] Re-run Ansible to deploy the sensor to the fresh VMs:

```bash
ansible-playbook -i inventory.ini deploy-falcon.yml --ask-vault-pass
```

---

## 8. Challenges

### Challenge 1: Per-Group Tags via Inventory Variables

**Scenario:** Your team runs web servers on Debian 12 and databases on Debian 13. They want each group to automatically get different sensor grouping tags without modifying the playbook.

<details>
<summary>Hint</summary>

Create `group_vars/debian12/falcon.yml` and `group_vars/debian13/falcon.yml` with different `falcon_tags` values. Ansible merges group variables automatically — group-level vars override `all` vars.

</details>

<details>
<summary>Solution</summary>

```bash
mkdir -p group_vars/debian12 group_vars/debian13
```

`group_vars/debian12/falcon.yml`:

```yaml
falcon_tags: "<YOUR_CLOUD>/<YOUR_REGION>,Production,WebTier"
```

`group_vars/debian13/falcon.yml`:

```yaml
falcon_tags: "<YOUR_CLOUD>/<YOUR_REGION>,Production,DatabaseTier"
```

Remove `falcon_tags` from the play-level vars in `deploy-falcon.yml`, and the role will pick up the group-specific values automatically. Re-run:

```bash
ansible-playbook -i inventory.ini deploy-falcon.yml --ask-vault-pass
```

</details>

---

### Challenge 2: Use a Sensor Update Policy Instead of Version Decrement

**Scenario:** Your security team manages sensor versions via Falcon Sensor Update Policies (e.g., "Production Linux - N-2"). Use the policy name to determine which version to install instead of hardcoding `falcon_sensor_version_decrement`.

<details>
<summary>Hint</summary>

The `falcon_install` role accepts `falcon_sensor_update_policy_name` as a variable. Set it to the exact policy name from your Falcon console. This overrides `falcon_sensor_version_decrement`.

</details>

<details>
<summary>Solution</summary>

Update `deploy-falcon.yml`:

```yaml
---
- name: Deploy CrowdStrike Falcon Sensor
  hosts: falcon_hosts
  roles:
    - role: crowdstrike.falcon.falcon_install
      vars:
        falcon_sensor_update_policy_name: "Production Linux - N-2"

    - role: crowdstrike.falcon.falcon_configure
      vars:
        falcon_tags: "{{ falcon_tags }}"
```

To find your policy names, in the Falcon console: **Host setup and management** → **Sensor update policy** → copy the policy name exactly.

Your API client needs **Sensor update policies [read]** scope (which we added in Step 2.3).

</details>

---

### Challenge 3: Dynamic Inventory with falcon_hosts Plugin (Stretch)

**Scenario:** You don't want to maintain a static inventory file. Use the `crowdstrike.falcon.falcon_hosts` inventory plugin to dynamically pull hosts from the Falcon console based on tags, then run a compliance check.

<details>
<summary>Hint</summary>

Create a file ending in `falcon.yml` (e.g., `inventory_falcon.yml`) with the plugin config. Use `filter` with FQL to target hosts by tag. The plugin requires `falcon_client_id` and `falcon_client_secret`.

</details>

<details>
<summary>Solution</summary>

Create `inventory_falcon.yml`:

```yaml
---
plugin: crowdstrike.falcon.falcon_hosts
client_id: "{{ lookup('env', 'FALCON_CLIENT_ID') }}"
client_secret: "{{ lookup('env', 'FALCON_CLIENT_SECRET') }}"
filter: "tags:'<YOUR_CLOUD>/<YOUR_REGION>'"
hostnames:
  - hostname
compose:
  ansible_host: external_ip
```

Set env vars and test:

```bash
export FALCON_CLIENT_ID="<your-id>"
export FALCON_CLIENT_SECRET="<your-secret>"
ansible-inventory -i inventory_falcon.yml --graph
```

This pulls all hosts tagged `<YOUR_CLOUD>/<YOUR_REGION>` from your Falcon tenant as live inventory — no static file needed.

</details>

---

## 9. Cleanup

Remove all lab infrastructure:

```bash
terraform destroy
```

Or manually via gcloud:

```bash
gcloud compute instances delete falcon-linux-deb-12 --zone=<YOUR_GCP_ZONE> --quiet
gcloud compute instances delete falcon-linux-deb-13 --zone=<YOUR_GCP_ZONE> --quiet
gcloud compute firewall-rules delete falcon-lab-allow-ssh --quiet
gcloud compute firewall-rules delete falcon-lab-deny-ssh --quiet
```

Remove Ansible artifacts:

```bash
rm -rf group_vars/ inventory.ini deploy-falcon.yml
```

</div>

---

## Quick Reference

### Ansible Commands

| Action               | Command                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| Install collection   | `ansible-galaxy collection install crowdstrike.falcon`                                          |
| Ping hosts           | `ansible -i inventory.ini falcon_hosts -m ping`                                                 |
| Deploy sensor        | `ansible-playbook -i inventory.ini deploy-falcon.yml --ask-vault-pass`                          |
| Dry run (check mode) | `ansible-playbook -i inventory.ini deploy-falcon.yml --check --ask-vault-pass`                  |
| Create vault file    | `ansible-vault create group_vars/all/vault.yml`                                                 |
| Edit vault file      | `ansible-vault edit group_vars/all/vault.yml`                                                   |
| Ad-hoc sensor status | `ansible -i inventory.ini falcon_hosts -m command -a "systemctl status falcon-sensor" --become` |

### Console Paths

| Action                 | Path                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| Create API client      | **Support and resources** → **Resources and tools** → **API clients and keys** |
| Create VM              | **Compute Engine** → **VM Instances** → **Create Instance**                    |
| Verify hosts           | **Host setup and management** → **Manage endpoints** → **Host management**     |
| Sensor update policies | **Host setup and management** → **Sensor update policy**                       |

### Key Collection Variables

| Variable                           | Purpose               | Example                |
| ---------------------------------- | --------------------- | ---------------------- |
| `falcon_client_id`                 | API auth              | `"abc123..."`          |
| `falcon_client_secret`             | API auth              | `"xyz789..."`          |
| `falcon_cloud`                     | API region            | `us-1`, `us-2`, `eu-1` |
| `falcon_sensor_version_decrement`  | Install N-x version   | `2`                    |
| `falcon_sensor_update_policy_name` | Policy-driven version | `"Prod Linux"`         |
| `falcon_tags`                      | Grouping tags         | `"GCP,Production"`     |
| `falcon_provisioning_token`        | Install token         | `"ABCD1234"`           |

---

_Created: 2026-06-09 | Topics: crowdstrike, falcon-sensor, ansible, gcp, gce, terraform, debian_
