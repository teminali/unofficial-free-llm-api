#!/bin/sh
# One request, then a streamed one. Set ULA_KEY to a key from the API page (or `unofficial-free-llm-api key create`).
# MODEL is any id from: curl -s -H "Authorization: Bearer $ULA_KEY" http://localhost:8420/v1/models
set -eu
BASE="${ULA_BASE:-http://localhost:8420/v1}"
MODEL="${MODEL:-deepseek-chat}"

echo "--- one answer"
curl -s "$BASE/chat/completions" \
  -H "Authorization: Bearer $ULA_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$MODEL\", \"messages\": [{\"role\": \"user\", \"content\": \"Say hello in five words.\"}]}"
echo

echo "--- streamed (-N: do not buffer)"
curl -sN "$BASE/chat/completions" \
  -H "Authorization: Bearer $ULA_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$MODEL\", \"stream\": true, \"messages\": [{\"role\": \"user\", \"content\": \"Write a haiku about rain.\"}]}"
