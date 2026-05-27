#!/bin/bash
cd /tmp/cc-agent/66919772/project
npm run build 2>&1
code=$?
if [ $code -ne 0 ]; then
  echo '{"systemMessage": "Build FAILED — run npm run build to see errors."}'
  exit 2
fi
