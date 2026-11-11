#!/usr/bin/env bash
# Cria as filas na subida do LocalStack, antes de o healthcheck passar: a de
# entrada com sua DLQ (redrive após 6 recebimentos) e a de eventos, sem DLQ.
# Idempotente: create-queue com os mesmos atributos não falha.
#
# Usage: executado pelo LocalStack, montado em /etc/localstack/init/ready.d/;
#   sem argumentos.
# Exit: 0 com as três filas criadas; diferente de 0 se alguma criação falhar.
set -euo pipefail

readonly ATTRIBUTES=/tmp/wager-transactions-attributes.json

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true

DLQ_URL=$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

cat > "$ATTRIBUTES" <<EOF
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"6\"}"
}
EOF
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "file://$ATTRIBUTES"

awslocal sqs create-queue --queue-name wagering-events.fifo --attributes FifoQueue=true
