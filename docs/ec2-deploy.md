# EC2 Deployment For status.hokus.ai

This deployment runs the monitor MVP on one small EC2 instance:

- `caddy`: public HTTPS reverse proxy for `status.hokus.ai`.
- `web`: Fastify API and Vite dashboard on the private Docker network.
- `worker`: long-running 15-minute monitor.
- `migrate`: one-shot database migration against Neon.
- Neon: persistent Postgres.

## AWS Resources

Create or confirm these resources:

1. EC2 instance, Ubuntu 24.04 LTS or Amazon Linux 2023, `t3.small` or `t4g.small`.
2. Security group allowing inbound TCP `22` from your IP and TCP `80`/`443` from `0.0.0.0/0`.
3. Elastic IP attached to the instance.
4. Route 53 `A` record: `status.hokus.ai` -> Elastic IP.
5. IAM instance profile with read-only access required by the monitor.

Do not use AWS access keys on disk if an instance profile is available.

Create a dedicated role/profile rather than reusing unrelated EC2 roles:

```bash
aws iam create-role \
  --role-name mttr-status-monitor \
  --assume-role-policy-document file://deploy/ec2/trust-policy.json

aws iam put-role-policy \
  --role-name mttr-status-monitor \
  --policy-name mttr-status-monitor-readonly \
  --policy-document file://deploy/ec2/mttr-monitor-policy.json

aws iam create-instance-profile --instance-profile-name mttr-status-monitor
aws iam add-role-to-instance-profile \
  --instance-profile-name mttr-status-monitor \
  --role-name mttr-status-monitor
```

## Instance Bootstrap

Install Docker and Git on the instance. For Ubuntu:

```bash
bash deploy/ec2/install-docker-ubuntu.sh
```

Log out and back in so the Docker group membership applies.

## App Setup

Clone the repo and create the production env file:

```bash
sudo mkdir -p /opt/mttr
sudo chown "$USER":"$USER" /opt/mttr
git clone <repo-url> /opt/mttr/app
cd /opt/mttr/app
cp .env.ec2.example .env.ec2
chmod 600 .env.ec2
```

For a private GitHub repo, install a deploy key on the instance or clone with an HTTPS token. Do
not bake a GitHub token into EC2 user data.

Edit `.env.ec2`:

- `ACME_EMAIL`: email for Let's Encrypt notices.
- `DATABASE_URL`: Neon direct connection string.
- `POOLED_DATABASE_URL`: Neon pooled connection string.
- `OPENROUTER_API_KEY`.
- `HEALTH_REPORT_S3_URI`.
- `SLACK_WEBHOOK_URL` if Slack alerts should be enabled.

## Deploy

Run migrations first:

```bash
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml run --rm migrate
```

Start the web, worker, and Caddy services:

```bash
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml up -d web worker caddy
```

Check health:

```bash
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml ps
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml logs --tail=100 web
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml logs --tail=100 worker
curl -I https://status.hokus.ai/healthz
```

## Updates

GitHub Actions is the preferred deployment path. The `Deploy EC2` workflow builds the app image,
pushes it to ECR, and uses SSM Run Command to pull and restart the Compose services on the instance.
It assumes:

- ECR repository: `932100697590.dkr.ecr.us-east-1.amazonaws.com/mttr-status`.
- GitHub OIDC role: `arn:aws:iam::932100697590:role/mttr-status-github-deploy`.
- Instance ID: `i-06d14e7c3ee5056eb`.
- Runtime Compose file: `/opt/mttr/app/docker-compose.ec2.runtime.yml`.

The instance role must include `AmazonSSMManagedInstanceCore` and
`AmazonEC2ContainerRegistryReadOnly` so GitHub can deploy without SSH and the instance can pull
from ECR.

Manual instance updates are still possible:

```bash
cd /opt/mttr/app
git pull --ff-only
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml build
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml run --rm migrate
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml up -d web worker caddy
```

Runtime image deploys use:

```bash
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml pull migrate web worker caddy
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml run --rm migrate
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml up -d web worker caddy
```

## Rollback

Stop the worker first so it cannot write new run state during rollback:

```bash
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml stop worker
git checkout <previous-good-sha>
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml build
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml up -d web
curl -I https://status.hokus.ai/healthz
docker compose --env-file .env.ec2 -f docker-compose.ec2.yml up -d worker caddy
```

If a schema migration must be rolled back, restore Neon from backup or branch before restarting the
worker.
