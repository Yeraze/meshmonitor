#!/bin/sh
# Test Docker Socket Access
# Verifies that the upgrader container can access and use the Docker socket

set -e

# Configuration
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
TEST_RESULT_FILE="${TEST_RESULT_FILE:-/data/.docker-socket-test}"

# Test Docker socket access
test_docker_socket() {
  local result=""
  local exit_code=0

  # Check 1: Socket file exists
  if [ ! -e "$DOCKER_SOCKET" ]; then
    result="FAIL: Docker socket not found at $DOCKER_SOCKET"
    echo "$result" > "$TEST_RESULT_FILE"
    return 1
  fi

  # Check 2: Socket is readable
  if [ ! -r "$DOCKER_SOCKET" ]; then
    result="FAIL: Docker socket exists but is not readable (check permissions)"
    echo "$result" > "$TEST_RESULT_FILE"
    return 1
  fi

  # Check 3: Socket is writable
  if [ ! -w "$DOCKER_SOCKET" ]; then
    result="FAIL: Docker socket exists but is not writable (check permissions)"
    echo "$result" > "$TEST_RESULT_FILE"
    return 1
  fi

  # Check 4: Can execute docker commands
  if ! docker version >/dev/null 2>&1; then
    result="FAIL: Docker socket is accessible but 'docker version' failed (check Docker installation or socket permissions)"
    echo "$result" > "$TEST_RESULT_FILE"
    return 1
  fi

  # Check 5: Can list containers
  if ! docker ps >/dev/null 2>&1; then
    result="FAIL: Docker socket is accessible but 'docker ps' failed (check permissions)"
    echo "$result" > "$TEST_RESULT_FILE"
    return 1
  fi

  # Check 6: Can inspect a container (test with meshmonitor container)
  if docker inspect meshmonitor >/dev/null 2>&1; then
    result="PASS: Docker socket is fully accessible and functional"
    exit_code=0
  else
    result="WARN: Docker socket works but cannot inspect meshmonitor container (may not exist yet)"
    exit_code=0  # This is a warning, not a failure
  fi

  echo "$result" > "$TEST_RESULT_FILE"
  return $exit_code
}

# Run the test
if test_docker_socket; then
  exit 0
else
  exit 1
fi
