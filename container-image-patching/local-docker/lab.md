# Falcon Container Image Patching Lab

> **Prerequisites:**
>
> - Docker Desktop installed and running
> - CrowdStrike Falcon API client credentials (Falcon Images Download: Read, Sensor Download: Read)
> - Your CrowdStrike CID with checksum
> - `curl` and `jq` installed
> - ~60 minutes

## Reference Docs

| Source                                           | Link                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Deploy Falcon Container Sensor Embedded in Image | https://docs.crowdstrike.com/r/en-US/iopiipqy/k58f1a5e                                              |
| Retrieve Falcon Container Images from Registry   | https://docs.crowdstrike.com/r/en-US/qg0ygdwl/vc320402                                              |
| Get Started with Falcon Container Sensor         | https://docs.crowdstrike.com/r/en-US/iopiipqy/e58b97e0                                              |
| falcon-container-sensor-pull.sh (GitHub)         | https://github.com/CrowdStrike/falcon-scripts/tree/main/bash/containers/falcon-container-sensor-pull |
| CrowdStrike/falconutil-action (GitHub)           | https://github.com/CrowdStrike/falconutil-action                                                     |
| Flask Quickstart                                 | https://flask.palletsprojects.com/en/stable/quickstart/                                              |

---

## 1. Introduction & Architecture

> **~5 min | Beginner**

CrowdStrike Falcon Container Image Patching lets you embed the Falcon sensor directly into a container image at build time. The patched image runs the sensor alongside your application — no sidecar, no Kubernetes operator, no kernel module on the host.

This is ideal for:

- **Serverless containers** (ECS Fargate, Cloud Run, Azure Container Instances)
- **Non-Kubernetes Docker deployments**
- **Any environment where you can't install on the host**

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    BUILD TIME                                 │
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌─────────────┐ │
│  │  Your Flask  │     │   Falcon     │     │   Patched   │ │
│  │    Image     │ ──► │  falconutil  │ ──► │    Image    │ │
│  │  (source)    │     │ patch-image  │     │  (target)   │ │
│  └──────────────┘     └──────────────┘     └─────────────┘ │
│                              ▲                               │
│                              │                               │
│                    ┌─────────────────┐                       │
│                    │  Falcon Sensor  │                       │
│                    │     Image       │                       │
│                    └─────────────────┘                       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    RUN TIME                                   │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Patched Container                        │    │
│  │                                                      │    │
│  │   ┌────────────────┐    ┌───────────────────────┐   │    │
│  │   │ Falcon Sensor  │    │   Flask App (app.py)  │   │    │
│  │   │  (user-space)  │    │   Listening on :5000  │   │    │
│  │   └────────────────┘    └───────────────────────┘   │    │
│  │         │                                            │    │
│  │         ▼                                            │    │
│  │   Reports to Falcon Cloud (api.crowdstrike.com)      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

The `falconutil patch-image` command:

1. Pulls your source image
2. Injects the Falcon sensor binaries as additional layers
3. Replaces the entrypoint so the sensor starts first, then launches your app
4. Outputs a new target image ready to run

---

## 2. Prerequisites & Setup

<div data-mode="guide">

```bash
export FALCON_CLIENT_ID="<your_client_id>"
export FALCON_CLIENT_SECRET="<your_client_secret>"
export FALCON_CID="<your_cid_with_checksum>"
export FALCON_CLOUD="<YOUR_FALCON_CLOUD>"
```

</div>

<div data-mode="lab">

> **~5 min | Beginner**

### Step 1: Verify Docker is Running

> **What & Why:** All the patching work happens through Docker. The `falconutil` tool needs access to the Docker daemon to pull, modify, and push images.

- [ ] Confirm Docker is available:

```bash
docker info
```

You should see output showing the Docker server version and runtime details. If you get an error, start Docker Desktop.

### Step 2: Create API Credentials

> **What & Why:** The pull script authenticates to the CrowdStrike container registry using OAuth2 credentials. Without these, you can't download the Falcon sensor image.

- [ ] In the Falcon console, navigate to: **Support and resources** > **Resources and tools** > **API clients and keys**
- [ ] Click **Create API client** with these scopes:
  - **Falcon Images Download**: Read
  - **Sensor Download**: Read
- [ ] Save the Client ID and Secret somewhere safe

### Step 3: Export Environment Variables

> **What & Why:** Setting these as environment variables keeps them out of your command history and makes the subsequent commands cleaner.

- [ ] Export your credentials:

```bash
export FALCON_CLIENT_ID="<your_client_id>"
export FALCON_CLIENT_SECRET="<your_client_secret>"
export FALCON_CID="<your_cid_with_checksum>"
export FALCON_CLOUD="<YOUR_FALCON_CLOUD>"
```

> **What to look for:** Run `echo $FALCON_CLIENT_ID` to confirm the variable is set. You should see your client ID, not an empty line.

</div>

---

## 3. Build the Flask App

<div data-mode="guide">

Assumes you already have a container image built and tagged locally (e.g., `flask-hello:original`). Skip to the next section.

</div>

<div data-mode="lab">

> **~10 min | Beginner**

### Step 1: Create the Project Files

> **What & Why:** We're building the simplest possible Flask app so the focus stays on the patching process, not the application code.

- [ ] Create the app directory and files:

```bash
mkdir -p flask-app
cd flask-app
```

- [ ] Create `app.py`:

```python
from flask import Flask

app = Flask(__name__)

@app.route("/")
def hello():
    return "Hello, World! This is my Flask app.\n"

@app.route("/health")
def health():
    return "OK\n"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
```

- [ ] Create `requirements.txt`:

```
flask==3.1.1
```

- [ ] Create `Dockerfile`:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 5000

CMD ["python", "app.py"]
```

### Step 2: Build the Image

> **What & Why:** This produces your "source image" — the unpatched application image that we'll add the Falcon sensor to in a later step.

- [ ] Build the Docker image:

```bash
docker buildx build --platform linux/amd64 -t flask-hello:original .
```

- [ ] Verify it was created:

```bash
docker images flask-hello
```

You should see:

```
REPOSITORY    TAG        IMAGE ID       CREATED         SIZE
flask-hello   original   abc123...      5 seconds ago   ~150MB
```

### Step 3: Run the Original Image

> **What & Why:** Running the unpatched image first gives you a baseline to compare against after patching. You'll see that the app works the same way in both cases.

- [ ] Run the container:

```bash
docker run -d --name flask-original -p 5000:5000 flask-hello:original
```

- [ ] Test it:

```bash
curl http://localhost:5000/
```

Expected output:

```
Hello, World! This is my Flask app.
```

- [ ] Check the health endpoint:

```bash
curl http://localhost:5000/health
```

Expected output:

```
OK
```

- [ ] Look at the running processes inside the container:

```bash
docker exec flask-original ps aux
```

You should see only the Python/Flask process — no sensor yet.

- [ ] Stop and remove the container:

```bash
docker stop flask-original && docker rm flask-original
```

</div>

---

## 4. Pull the Falcon Container Sensor

<div data-mode="guide">

```bash
export LATESTSENSOR=$(curl -sSL "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh" | /bin/bash -s -- -t falcon-container --platform x86_64 | tail -1)

echo "FROM $LATESTSENSOR" | docker buildx build --platform linux/amd64 -t falcon-sensor:amd64 --load -
```

</div>

<div data-mode="lab">

> **~10 min | Beginner**

### Step 1: Download the Pull Script

> **What & Why:** CrowdStrike provides a shell script that handles OAuth authentication and pulls the correct sensor image for your architecture. This saves you from manually constructing registry auth tokens.

- [ ] Download the script:

```bash
export LATESTSENSOR=$(curl -sSL "https://raw.githubusercontent.com/CrowdStrike/falcon-scripts/main/bash/containers/falcon-container-sensor-pull/falcon-container-sensor-pull.sh" | /bin/bash -s -- -t falcon-container --platform x86_64 | tail -1)
```

> If you're on Apple Silicon (M1/M2/M3), use `--platform aarch64` instead of `x86_64`.

- [ ] Verify the sensor image was pulled:

```bash
echo $LATESTSENSOR
docker images | grep falcon
```

You should see something like:

```
registry.crowdstrike.com/falcon-container/us-1/release/falcon-sensor   7.xx.x-xxxx   ...   ~200MB
```

### Step 2: Create a Single-Platform Sensor Tag

> **What & Why:** The pull script stores the image as a multi-arch manifest index (even though you only pulled one platform's layers). `falconutil` can't resolve a specific platform from a local multi-arch index via the Docker socket — it tries a registry pull that fails for local-only images. Re-building with `docker buildx --platform` creates a single-platform image that `falconutil` can use directly with `--image-pull-policy IfNotPresent`.

> **Note:** Docker's containerd image store preserves the full OCI manifest index from the registry. So even with `--platform x86_64` on the pull script, the local tag points to a manifest index containing entries for ALL platforms (amd64 with layers, arm64 with 0B). The tag points to the index, not to the platform-specific manifest inside it.

- [ ] Create a single-platform amd64 tag:

```bash
echo "FROM $LATESTSENSOR" | docker buildx build --platform linux/amd64 -t falcon-sensor:amd64 --load -
```

- [ ] Verify it's single-platform:

```bash
docker image ls --tree | grep -A2 "falcon-sensor:amd64"
```

You should see only one platform entry:
```
falcon-sensor:amd64                    ...
└─ linux/amd64                         ...
```

</div>

---

## 5. Patch the Image

<div data-mode="guide">

```bash
docker run --platform linux/amd64 --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm falcon-sensor:amd64 \
  falconutil patch-image \
  --source-image-uri flask-hello:original \
  --target-image-uri flask-hello:patched \
  --falcon-image-uri falcon-sensor:amd64 \
  --cid $FALCON_CID \
  --image-pull-policy IfNotPresent
```

</div>

<div data-mode="lab">

> **~10 min | Beginner**

### Step 1: Run falconutil patch-image

> **What & Why:** This is the core step. `falconutil` takes your original Flask image, injects the Falcon sensor layers, rewires the entrypoint, and produces a new patched image — all in one command.

- [ ] Patch the image:

```bash
docker run --platform linux/amd64 --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm falcon-sensor:amd64 \
  falconutil patch-image \
  --source-image-uri flask-hello:original \
  --target-image-uri flask-hello:patched \
  --falcon-image-uri falcon-sensor:amd64 \
  --cid $FALCON_CID \
  --image-pull-policy IfNotPresent
```

> **What to look for:** The output should show the patching progress and end with a success message indicating the target image was created.

If you're on macOS with Docker Desktop, the `/var/run/docker.sock` mount should work as-is. If you get a permission error, ensure Docker Desktop has file sharing enabled for `/var/run/docker.sock`.

### Step 2: Verify the Patched Image Exists

> **What & Why:** Confirming the image was created ensures the patching succeeded before you try to run it.

- [ ] List both images:

```bash
docker images flask-hello
```

You should now see two tags:

```
REPOSITORY    TAG       IMAGE ID       CREATED          SIZE
flask-hello   patched   def456...      10 seconds ago   ~350MB
flask-hello   original  abc123...      5 minutes ago    ~150MB
```

Notice the patched image is larger — that's the sensor binaries that were injected.

</div>

---

## 6. Run the Patched Image

<div data-mode="guide">

Verify the patched image has the Falcon entrypoint:

```bash
docker inspect flask-hello:patched --format '{{.Config.Entrypoint}}'
```

</div>

<div data-mode="lab">

> **~10 min | Beginner**

### Step 1: Run the Patched Container

> **What & Why:** Running the patched image proves that the Falcon sensor starts alongside your Flask app without breaking anything. The app should behave identically to before.

- [ ] Run it:

```bash
docker run -d --name flask-patched -p 5000:5000 flask-hello:patched
```

### Step 2: Test the Application Still Works

> **What & Why:** Image patching should be transparent to your application. If these endpoints respond the same as before, the sensor was injected without breaking your app.

- [ ] Test the main endpoint:

```bash
curl http://localhost:5000/
```

Expected output (same as before):

```
Hello, World! This is my Flask app.
```

- [ ] Test health:

```bash
curl http://localhost:5000/health
```

Expected output:

```
OK
```

### Step 3: Verify the Falcon Sensor is Running

> **What & Why:** This confirms the sensor is actually running inside the container. You should see the `falcon-sensor` process alongside your Python app.

- [ ] Check running processes:

```bash
docker exec flask-patched ps aux
```

You should see both:

- The Falcon sensor process (`falcon-sensor`)
- Your Flask app (`python app.py`)

- [ ] Check the sensor's AID (Agent ID):

```bash
docker exec flask-patched /opt/CrowdStrike/rootfs/bin/falconctl -g --aid
```

If the sensor has connected to the CrowdStrike cloud, you'll see an AID value. If it shows empty, the sensor may still be initializing — wait 30 seconds and try again.

- [ ] View sensor logs:

```bash
docker logs flask-patched 2>&1 | head -20
```

Look for lines indicating the sensor started successfully.

### Step 4: Clean Up

- [ ] Stop and remove the container when you're done:

```bash
docker stop flask-patched && docker rm flask-patched
```

</div>

---

## 7. Verify in Falcon Console

> **~5 min | Beginner**

### Step 1: Check the Host in the Console

> **What & Why:** The ultimate verification — your container should appear as a managed host in the Falcon console, proving end-to-end connectivity.

- [ ] In the Falcon console, navigate to: **Host setup and management** > **Host management**
- [ ] Search for your container by its AID or hostname
- [ ] You should see it listed with the container's hostname and sensor version

> **Note:** It may take 1-2 minutes for the host to appear after the container starts. If you stopped the container quickly, it may not have had time to register.

---

## 8. Challenges

> **~15 min | Mixed**

### Challenge 1: Add Sensor Grouping Tags

**Scenario:** Your security team requires all container sensors to have the tags `lab` and `flask-app` for policy assignment. Patch the image again with these tags applied.

<details>
<summary>Hint</summary>

The `--falconctl-opts` flag passes configuration to the sensor. Tags are set with `--tags=`.

</details>

<details>
<summary>Solution</summary>

```bash
docker run --platform linux/amd64 --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm falcon-sensor:amd64 \
  falconutil patch-image \
  --source-image-uri flask-hello:original \
  --target-image-uri flask-hello:patched-tagged \
  --falcon-image-uri falcon-sensor:amd64 \
  --cid $FALCON_CID \
  --image-pull-policy IfNotPresent \
  --falconctl-opts "--tags=lab,flask-app"
```

Run it and verify tags were applied:

```bash
docker run -d --name flask-tagged -p 5000:5000 flask-hello:patched-tagged
docker exec flask-tagged /opt/CrowdStrike/rootfs/bin/falconctl -g --tags
docker stop flask-tagged && docker rm flask-tagged
```

</details>

---

### Challenge 2: Multi-Stage Build with Patching

**Scenario:** Your CI/CD pipeline builds the Flask image and patches it in one workflow. Write a shell script called `build-and-patch.sh` that:

1. Builds the Flask image
2. Patches it with `falconutil`
3. Verifies the patched image exists
4. Prints the image size difference

<details>
<summary>Hint</summary>

Use `docker images --format` to extract the image size programmatically. Chain the build and patch commands with `&&` for fail-fast behavior.

</details>

<details>
<summary>Solution</summary>

```bash
#!/bin/bash
set -e

echo "=== Building Flask image ==="
docker buildx build --platform linux/amd64 -t flask-hello:original ./flask-app

echo "=== Patching with Falcon sensor ==="
docker run --platform linux/amd64 --user 0:0 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --rm falcon-sensor:amd64 \
  falconutil patch-image \
  --source-image-uri flask-hello:original \
  --target-image-uri flask-hello:patched \
  --falcon-image-uri falcon-sensor:amd64 \
  --cid $FALCON_CID \
  --image-pull-policy IfNotPresent

echo "=== Image Size Comparison ==="
ORIGINAL=$(docker images flask-hello:original --format '{{.Size}}')
PATCHED=$(docker images flask-hello:patched --format '{{.Size}}')
echo "Original: $ORIGINAL"
echo "Patched:  $PATCHED"

echo "=== Done! Run with: docker run -d -p 5000:5000 flask-hello:patched ==="
```

</details>

---

### Challenge 3: Verify Sensor Connectivity Programmatically

**Scenario:** You need a health check script that confirms both the Flask app AND the Falcon sensor are healthy inside the running container. Write a script that exits with code 0 only if both are confirmed running.

<details>
<summary>Hint</summary>

Use `docker exec` with `pgrep` or `ps` to check for both processes. Combine checks with `&&`.

</details>

<details>
<summary>Solution</summary>

```bash
#!/bin/bash
CONTAINER="flask-patched"

echo "Checking Flask app..."
FLASK_OK=$(docker exec $CONTAINER pgrep -f "python app.py" > /dev/null 2>&1 && echo "yes" || echo "no")

echo "Checking Falcon sensor..."
SENSOR_OK=$(docker exec $CONTAINER pgrep -f "falcon-sensor" > /dev/null 2>&1 && echo "yes" || echo "no")

echo "Checking app responds on :5000..."
APP_OK=$(curl -sf http://localhost:5000/health > /dev/null 2>&1 && echo "yes" || echo "no")

echo ""
echo "Results:"
echo "  Flask app running: $FLASK_OK"
echo "  Falcon sensor running: $SENSOR_OK"
echo "  App HTTP response: $APP_OK"

if [[ "$FLASK_OK" == "yes" && "$SENSOR_OK" == "yes" && "$APP_OK" == "yes" ]]; then
  echo ""
  echo "All checks passed!"
  exit 0
else
  echo ""
  echo "One or more checks failed."
  exit 1
fi
```

</details>

---

## 9. Quick Reference

| Action             | Command                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build Flask image  | `docker buildx build --platform linux/amd64 -t flask-hello:original .`                                                                                                                                                                                                                       |
| Run original       | `docker run -d -p 5000:5000 flask-hello:original`                                                                                                                                                                                                              |
| Pull sensor image  | `curl -sSL ".../falcon-container-sensor-pull.sh" \| /bin/bash -s -- -t falcon-container --platform x86_64`                                                                                                                                                     |
| Tag sensor locally | `echo "FROM $LATESTSENSOR" \| docker buildx build --platform linux/amd64 -t falcon-sensor:amd64 --load -`                                                                                                                                                    |
| Patch the image    | `docker run --platform linux/amd64 --user 0:0 -v /var/run/docker.sock:/var/run/docker.sock --rm falcon-sensor:amd64 falconutil patch-image --source-image-uri flask-hello:original --target-image-uri flask-hello:patched --falcon-image-uri falcon-sensor:amd64 --cid $FALCON_CID --image-pull-policy IfNotPresent` |
| Run patched        | `docker run -d -p 5000:5000 flask-hello:patched`                                                                                                                                                                                                               |
| Verify sensor PID  | `docker exec <container> ps aux \| grep falcon`                                                                                                                                                                                                                |
| Check AID          | `docker exec <container> /opt/CrowdStrike/rootfs/bin/falconctl -g --aid`                                                                                                                                                                                       |
| Check sensor tags  | `docker exec <container> /opt/CrowdStrike/rootfs/bin/falconctl -g --tags`                                                                                                                                                                                      |

---

## 10. Further Reading

- [Deploy Falcon Container Sensor Embedded in Image](https://docs.crowdstrike.com/r/en-US/iopiipqy/k58f1a5e) — Full CrowdStrike documentation
- [CrowdStrike/falconutil-action](https://github.com/CrowdStrike/falconutil-action) — GitHub Action for CI/CD pipelines
- [falcon-container-sensor-pull.sh](https://github.com/CrowdStrike/falcon-scripts/tree/main/bash/containers/falcon-container-sensor-pull) — Pull script source and docs
- [Flask Documentation](https://flask.palletsprojects.com/) — Flask framework reference
- [Docker Best Practices](https://docs.docker.com/build/building/best-practices/) — Dockerfile best practices

---

_Created: 2026-06-09 | Topics: crowdstrike, falcon-sensor, container-security, image-patching, docker, flask, python_
