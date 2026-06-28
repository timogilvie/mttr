#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${INSTANCE_ID:?INSTANCE_ID is required}"
: "${APP_IMAGE:?APP_IMAGE is required}"
: "${ECR_REGISTRY:?ECR_REGISTRY is required}"

DEPLOY_COMMAND="$(cat <<EOF
set -euo pipefail
cd /opt/mttr/app
if ! command -v aws >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl unzip
  rm -rf /tmp/aws /tmp/awscliv2.zip
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REGISTRY}
cp .env.ec2 .env.ec2.bak.\$(date +%Y%m%d%H%M%S)
grep -v '^APP_IMAGE=' .env.ec2 > .env.ec2.next || true
printf 'APP_IMAGE=${APP_IMAGE}\n' >> .env.ec2.next
mv .env.ec2.next .env.ec2
chmod 600 .env.ec2
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml pull migrate web worker caddy
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml run --rm migrate
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml up -d web worker caddy
docker compose --env-file .env.ec2 -f docker-compose.ec2.runtime.yml ps
docker image prune -f
EOF
)"

PARAMETERS_FILE="$(mktemp)"
export DEPLOY_COMMAND PARAMETERS_FILE
node - <<'NODE'
const fs = require('node:fs');
const script = process.env.DEPLOY_COMMAND;
const quoted = `'${script.replace(/'/g, `'\\''`)}'`;
fs.writeFileSync(
  process.env.PARAMETERS_FILE,
  JSON.stringify({ commands: [`bash -lc ${quoted}`] })
);
NODE

COMMAND_ID="$(
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --comment "Deploy mttr status app" \
    --parameters "file://${PARAMETERS_FILE}" \
    --query "Command.CommandId" \
    --output text
)"

rm -f "$PARAMETERS_FILE"

aws ssm wait command-executed \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,StandardOutputContent:StandardOutputContent,StandardErrorContent:StandardErrorContent}' \
  --output json
