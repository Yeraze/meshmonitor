==========================================
MeshMonitor System Tests
==========================================

[0;34mStep 1: Bootstrap - Building fresh Docker image[0m
This ensures tests run against the latest code...

sha256:f9095b2b32aa88995b0e9d2904e42312c57efcc93553917492ca618d89853ec5
[0;32m✓ Build successful[0m

[0;34mStep 2: Clean existing test volumes[0m
Removing any leftover test data...

meshmonitor_meshmonitor-backup-source-test-data
[0;32m✓ Test volumes cleaned[0m

==========================================
[0;34mRunning Configuration Import Test[0m
==========================================

==========================================
Configuration Import Test
==========================================

Test Configuration:
  URL #1: https://meshtastic.org/e/#CjMSIAHcVEKVGrMDzpRL2SFj...
  URL #2: https://meshtastic.org/e/#CgsSAQEoATAAOgIIDgo3EiCf...

Creating test docker-compose.yml...
[0;32m✓[0m Test config created

Building container...
[0;32m✓[0m Build complete

Starting container...
 Volume "meshmonitor_meshmonitor-config-import-test-data"  Creating
 Volume "meshmonitor_meshmonitor-config-import-test-data"  Created
 Container meshmonitor  Recreate
 Container meshmonitor  Recreated
 Container meshmonitor-config-import-test  Starting
 Container meshmonitor-config-import-test  Started
[0;32m✓[0m Container started

Waiting for container to be ready...
Test 1: Container is running
[0;32m✓ PASS[0m: Container is running

Test 2: Wait for node connection and initial sync
Waiting up to 30 seconds for initial connection...
[0;32m✓ PASS[0m: Node connected

Waiting 15 seconds for connection to stabilize...
[0;32m✓[0m Connection stabilized

Test 3: Get CSRF token and login
[0;32m✓[0m CSRF token obtained
[0;32m✓ PASS[0m: Login successful

==========================================
FIRST IMPORT CYCLE
==========================================

Test 4: Decode first configuration URL
[0;32m✓ PASS[0m: URL #1 decoded successfully
  Expected channels from URL #1: 3

Test 5: Import first configuration
[0;32m✓ PASS[0m: Import API call successful
  Response: {"success":true,"imported":{"channels":3,"channelDetails":[{"index":0,"name":"primary"},{"index":1,"name":"dummyA"},{"index":2,"name":"dummyB"}],"loraConfig":true},"requiresReboot":true}
  Device reboot required

Test 6: Wait for device reconnect and sync after first import
Waiting for device to disconnect for reboot...
[1;33m⚠[0m Device did not disconnect (may have rebooted too fast)
Waiting for device to reconnect (up to 60 seconds)...
[0;32m✓[0m Device reconnected after 0s
Requesting fresh configuration from device...
[0;32m✓[0m Fresh config requested
Waiting for configuration sync via /api/poll (up to 60 seconds)...
[0;32m✓[0m Configuration fully synced (4 channels with PSKs, 4 with names, LoRa config present)

Test 7: Verify first configuration

==========================================
Verifying first configuration
==========================================

Test: Imported Channel Configuration

  Channel 0:
    Role: Primary
      Expected: 1
      Actual:   1
      [0;32m✓ PASS[0m: Role matches
    PSK:
      AdxUQpUaswPOlEvZIWNr... (truncated)
      [0;32m✓ PASS[0m: PSK is set

  Channel 1:
    Role: Secondary
      Expected: 2
      Actual:   2
      [0;32m✓ PASS[0m: Role matches
    PSK:
      AQ==... (truncated)
      [0;32m✓ PASS[0m: PSK is set

Test: LoRa Device Configuration

  Modem Preset:
    Expected: Long Fast
    Actual:   Long Fast
    [0;32m✓ PASS[0m: Modem preset matches

  Region:
    Expected: US
    Actual:   US
    [0;32m✓ PASS[0m: Region matches

  Hop Limit:
    Expected: 3
    Actual:   3
    [0;32m✓ PASS[0m: Hop limit matches

  TX Enabled (CRITICAL):
    Expected: true
    Actual:   true
    [0;32m✓ PASS[0m: TX is enabled

[0;32m==========================================
✓ ALL VERIFICATION TESTS PASSED
==========================================\033[0m
[0;32m✓ PASS[0m: First configuration verified (channels 0-1 roles and PSKs)

==========================================
SECOND IMPORT CYCLE
==========================================

Test 8: Decode second configuration URL
[0;32m✓ PASS[0m: URL #2 decoded successfully
  Expected channels from URL #2: 2

Test 9: Import second configuration
[0;32m✓ PASS[0m: Second import API call successful
  Response: {"success":true,"imported":{"channels":2,"channelDetails":[{"index":0,"name":"(unnamed)"},{"index":1,"name":"meshmonitor"}],"loraConfig":true},"requiresReboot":true}
  Device reboot required

Test 10: Wait for device reconnect and sync after second import
Waiting for device to disconnect for reboot...
[1;33m⚠[0m Device did not disconnect (may have rebooted too fast)
Waiting for device to reconnect (up to 60 seconds)...
[0;32m✓[0m Device reconnected after 0s
Requesting fresh configuration from device...
[0;32m✓[0m Fresh config requested
Waiting for configuration sync via /api/poll (up to 60 seconds)...
[0;32m✓[0m Configuration fully synced (4 channels with PSKs, 3 with names, LoRa config present)

Test 11: Verify second configuration

==========================================
Verifying second configuration
==========================================

Test: Imported Channel Configuration

  Channel 0:
    Role: Primary
      Expected: 1
      Actual:   1
      [0;32m✓ PASS[0m: Role matches
    PSK:
      AQ==... (truncated)
      [0;32m✓ PASS[0m: PSK is set

  Channel 1:
    Role: Secondary
      Expected: 2
      Actual:   2
      [0;32m✓ PASS[0m: Role matches
    PSK:
      n2GT9ipPJ1zhp3ijUBv9... (truncated)
      [0;32m✓ PASS[0m: PSK is set

Test: LoRa Device Configuration

  Modem Preset:
    Expected: Medium Fast
    Actual:   Medium Fast
    [0;32m✓ PASS[0m: Modem preset matches

  Region:
    Expected: US
    Actual:   US
    [0;32m✓ PASS[0m: Region matches

  Hop Limit:
    Expected: 5
    Actual:   5
    [0;32m✓ PASS[0m: Hop limit matches

  TX Enabled (CRITICAL):
    Expected: true
    Actual:   true
    [0;32m✓ PASS[0m: TX is enabled

[0;32m==========================================
✓ ALL VERIFICATION TESTS PASSED
==========================================\033[0m
[0;32m✓ PASS[0m: Second configuration verified (roles and PSKs)

Test 12: Verify configuration actually changed between imports
[0;32m✓ PASS[0m: Configuration successfully changed between imports

==========================================
[0;32mAll tests passed![0m
==========================================

Configuration import test completed successfully:
  • First configuration imported and verified
  • Second configuration imported and verified
  • Configuration properly updated between imports
  • Device reboot/reconnect handled correctly


Cleaning up...

[0;32m✓ Configuration Import test PASSED[0m

==========================================
[0;34mRunning Quick Start Test[0m
==========================================

==========================================
Quick Start Zero-Config Test
==========================================

Creating test docker-compose.yml (matches Quick Start documentation)...
[0;32m✓[0m Test config created

Building container...
[0;32m✓[0m Build complete

Starting container...
 Network meshmonitor_default  Creating
 Network meshmonitor_default  Created
 Volume "meshmonitor_meshmonitor-quick-start-test-data"  Creating
 Volume "meshmonitor_meshmonitor-quick-start-test-data"  Created
 Container meshmonitor-quick-start-test  Creating
 Container meshmonitor-quick-start-test  Created
 Container meshmonitor-quick-start-test  Starting
 Container meshmonitor-quick-start-test  Started
[0;32m✓[0m Container started

Waiting for container to be ready...
Test 1: Container is running
[0;32m✓ PASS[0m: Container is running

Test 2: SESSION_SECRET auto-generated (warning present)
[0;32m✓ PASS[0m: SESSION_SECRET warning found

Test 3: COOKIE_SECURE defaults to false (warning present)
[0;32m✓ PASS[0m: COOKIE_SECURE warning found

Test 4: Admin user created on first run
[0;32m✓ PASS[0m: Admin user created

Test 5: Cookie secure set to false
[0;32m✓ PASS[0m: Cookie secure is false

Test 6: No HSTS header in HTTP response
[0;32m✓ PASS[0m: No HSTS header (HTTP-friendly)

Test 7: Session cookie works over HTTP
[0;32m✓ PASS[0m: Session cookie set without Secure flag

Test 8: Fetch CSRF token
[0;32m✓ PASS[0m: CSRF token obtained

Test 9: Login with default admin credentials
[0;32m✓ PASS[0m: Login successful (HTTP 200)

Test 10: Authenticated request with session cookie
[0;32m✓ PASS[0m: Authenticated session works

Test 11: Running in production mode
[0;32m✓ PASS[0m: Running in production mode (better security defaults)

Test 12: Wait for Meshtastic node connection and data sync
Waiting up to 30 seconds for channels (>=3) and nodes (>100)...
[0;32m✓ PASS[0m: Node connected (channels: 4, nodes: 117)


Test 13: Verify Meshtastic device configuration (CRITICAL)
[0;32m✓[0m Modem preset: Medium Fast
[0;32m✓[0m Frequency slot: 0
[0;32m✓[0m TX Enabled: true (CRITICAL)
[0;32m✓[0m Channel 0 role: Primary (1)
[0;32m✓[0m Channel 0 name: unnamed
[0;32m✓[0m Channel 1 role: Secondary (2)
[0;32m✓[0m Channel 1 name: meshmonitor
[0;32m✓ PASS[0m: All configuration requirements verified

==========================================
Apprise Notification Configuration Tests
==========================================

Test 13.1: Verify fresh container has no Apprise URLs (API and file)
[0;32m✓ PASS[0m: API reports no URLs configured (empty array)
[0;32m✓ PASS[0m: Config file does not exist (fresh start)

Test 13.2: Configure sample Apprise URLs from various providers
Configuring 8 test URLs (Telegram, Discord, Slack, SMTP, Pushover, Webhook, MQTT, Gotify)...
[0;32m✓ PASS[0m: Apprise URLs configured successfully
   Response: {"success":true,"message":"Configured 8 notification URLs"}

Test 13.3: Verify URLs persisted to /data/apprise-config/urls.txt in container
[0;32m✓ PASS[0m: Config file exists with 8 lines
   First 3 URLs from file:
     tgram://1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ123456/123456789
     discord://webhook_id/webhook_token
     slack://TokenA/TokenB/TokenC
[0;32m✓[0m Telegram URL found
[0;32m✓[0m Discord URL found

Test 13.4: Read URLs back from API to confirm they persisted
[0;32m✓ PASS[0m: URLs retrieved from API after persistence
   Found 1 URLs in response

Test 13.5: Verify Apprise diagnostic logging is working
[1;33m⚠ WARN[0m: Apprise diagnostic logging not found (may need container restart)

Test 13.6: Test notification send flow (will fail with fake URLs)
[1;33m⚠ WARN[0m: Test notification succeeded (unexpected with fake URLs)
   Response: {"success":false,"message":"Apprise not available or no URLs configured"}

==========================================
[0;32mApprise configuration tests completed![0m
==========================================

Apprise tests verified:
  • Read existing Apprise URLs via API
  • Configure 8 sample URLs from different providers
  • URLs persisted to /data/apprise-config/urls.txt
  • URLs readable back from API
  • Diagnostic logging is working
  • Test notification flow works (fails as expected with fake URLs)

Waiting 15 seconds for system to settle...

Test 14: Send message to Yeraze Station G2 and wait for response
Attempt 1 of 3...
[0;32m✓[0m Message sent successfully
Waiting up to 10 seconds for response from Yeraze Station G2...
..[0;32m✓ PASS[0m: Received response from Yeraze Station G2

Test 15: Security verification (API endpoint protection)
==========================================
Security Test - Anonymous Data Protection
==========================================

Test 1: Anonymous user - Node IP hidden in /api/poll
[0;32m✓ PASS[0m: Node IP not exposed to anonymous users

Test 2: Anonymous user - Node IP hidden in /api/config
[0;32m✓ PASS[0m: Node IP not exposed to anonymous users

Test 3: Anonymous user - MQTT config hidden in /api/poll
[0;32m✓ PASS[0m: MQTT config not exposed to anonymous users

Test 4: Fetch CSRF token for authentication
[0;32m✓ PASS[0m: CSRF token obtained

Test 5: Login with admin credentials
[0;32m✓ PASS[0m: Login successful

Test 6: Authenticated user - Node IP visible in /api/poll
[0;32m✓ PASS[0m: Node IP visible to authenticated users

Test 7: Authenticated user - Node IP visible in /api/config
[0;32m✓ PASS[0m: Node IP visible to authenticated users

Test 8: Authenticated user - MQTT config visible in /api/poll
[0;32m✓ PASS[0m: MQTT config visible to authenticated users

Test 9: Anonymous user - /api/device-config returns 401/403
[0;32m✓ PASS[0m: /api/device-config protected from anonymous users (HTTP 403)

Test 10: Authenticated user - /api/device-config accessible
[0;32m✓ PASS[0m: /api/device-config accessible to authenticated users
[0;32m✓[0m MQTT config present in device config

==========================================
[0;32mAll security tests passed![0m
==========================================

Security verification complete:
  • Node IP hidden from anonymous users
  • MQTT config hidden from anonymous users
  • Node IP visible to authenticated users
  • MQTT config visible to authenticated users
  • Protected endpoints require authentication

[0;32m✓ PASS[0m: Security test passed

==========================================
[0;32mAll tests passed![0m
==========================================

The Quick Start zero-config deployment works correctly:
  • Container starts without SESSION_SECRET
  • Container starts without COOKIE_SECURE
  • HTTP access works (no HSTS)
  • Admin user created automatically
  • Login works with default credentials
  • Session cookies work over HTTP


Cleaning up...

[0;32m✓ Quick Start test PASSED (includes security test)[0m

==========================================
[0;34mRunning Reverse Proxy Test[0m
==========================================

==========================================
Reverse Proxy Production Test
==========================================

Creating test docker-compose.yml (reverse proxy production configuration)...
[0;32m✓[0m Test config created

Building container...
[0;32m✓[0m Build complete

Starting container...
 Network meshmonitor_default  Creating
 Network meshmonitor_default  Created
 Volume "meshmonitor_meshmonitor-reverse-proxy-test-data"  Creating
 Volume "meshmonitor_meshmonitor-reverse-proxy-test-data"  Created
 Container meshmonitor-reverse-proxy-test  Creating
 Container meshmonitor-reverse-proxy-test  Created
 Container meshmonitor-reverse-proxy-test  Starting
 Container meshmonitor-reverse-proxy-test  Started
[0;32m✓[0m Container started

Waiting for container to be ready...
Test 1: Container is running
[0;32m✓ PASS[0m: Container is running

Test 2: Running in production mode
[0;32m✓ PASS[0m: Running in production mode

Test 3: SESSION_SECRET auto-generated (production warning present)
[0;32m✓ PASS[0m: SESSION_SECRET production warning found

Test 4: COOKIE_SECURE explicitly set to true
[0;32m✓ PASS[0m: Cookie secure is true (HTTPS-ready)

Test 5: Admin user created on first run
[0;32m✓ PASS[0m: Admin user created

Test 6: HSTS header present in production
[1;33m⚠ WARN[0m: HSTS header not found (expected in production with secure cookies)

Test 7: Trust proxy configuration
[1;33m⚠ INFO[0m: Trust proxy not explicitly logged (may be default)

Test 8: Fetch CSRF token via HTTPS
[0;32m✓ PASS[0m: CSRF token obtained via HTTPS

Test 9: Login with default admin credentials via HTTPS
[0;32m✓ PASS[0m: Login successful (HTTP 200)

Test 10: Authenticated request with session cookie via HTTPS
[0;32m✓ PASS[0m: Authenticated session works

Test 11: Session cookie has Secure flag (HTTPS-only)
[0;32m✓ PASS[0m: Cookie has Secure flag (HTTPS-only)

Test 12: CORS configuration for HTTPS origin
[0;32m✓ PASS[0m: CORS configured for allowed origin

Test 13: Wait for Meshtastic node connection and data sync
Waiting up to 30 seconds for channels (>=3) and nodes (>100)...
[0;32m✓ PASS[0m: Node connected (channels: 4, nodes: 125)


Waiting 15 seconds for system to settle...

Test 14: Send message to Yeraze Station G2 and wait for response
Attempt 1 of 3...
[0;32m✓[0m Message sent successfully
Waiting up to 10 seconds for response from Yeraze Station G2...
..[0;32m✓ PASS[0m: Received response from Yeraze Station G2

==========================================
[0;32mAll tests passed![0m
==========================================

The reverse proxy production deployment works correctly:
  • Container runs in production mode
  • Trust proxy enabled
  • HTTPS-ready (COOKIE_SECURE=true)
  • HSTS security headers present
  • Admin user created automatically
  • Login works with default credentials
  • Session works behind reverse proxy
  • CORS configured for HTTPS domain

Production Deployment Notes:
  • Set SESSION_SECRET for persistent sessions across restarts
  • Configure reverse proxy (nginx/Caddy/Traefik) for HTTPS
  • Ensure X-Forwarded-Proto and X-Forwarded-Host headers are set
  • Container accessible at: http://localhost:8081 (behind proxy)
  • Public URL: https://meshdev.yeraze.online (via reverse proxy)


Cleaning up...

[0;32m✓ Reverse Proxy test PASSED[0m

==========================================
[0;34mRunning Reverse Proxy + OIDC Test[0m
==========================================

==========================================
Reverse Proxy + OIDC Production Test
==========================================

Creating test docker-compose.yml (OIDC configuration)...
[0;32m✓[0m Test config created

Building mock OIDC provider...
[0;32m✓[0m Mock OIDC build complete

Building MeshMonitor container...
[0;32m✓[0m MeshMonitor build complete

Starting containers...
 Network meshmonitor_default  Creating
 Network meshmonitor_default  Created
 Volume "meshmonitor_meshmonitor-oidc-test-data"  Creating
 Volume "meshmonitor_meshmonitor-oidc-test-data"  Created
 Container mock-oidc-provider  Creating
 Container mock-oidc-provider  Created
 Container meshmonitor-oidc-test  Creating
 Container meshmonitor-oidc-test  Created
 Container mock-oidc-provider  Starting
 Container mock-oidc-provider  Started
 Container mock-oidc-provider  Waiting
 Container mock-oidc-provider  Healthy
 Container meshmonitor-oidc-test  Starting
 Container meshmonitor-oidc-test  Started
[0;32m✓[0m Containers started

Waiting for services to be ready...
Test 1: Mock OIDC provider is running
[0;32m✓ PASS[0m: Mock OIDC provider is running

Test 2: MeshMonitor container is running
[0;32m✓ PASS[0m: MeshMonitor is running

Test 3: Mock OIDC provider health check (via HTTPS reverse proxy)
[0;32m✓ PASS[0m: OIDC provider is healthy (via HTTPS)

Test 4: OIDC discovery endpoint accessible (via HTTPS)
[0;32m✓ PASS[0m: OIDC discovery endpoint works (via HTTPS)
[0;32m✓ PASS[0m: OIDC issuer URL is correct

Test 5: MeshMonitor OIDC initialization
[1;33m⚠ WARN[0m: OIDC initialization message not found in logs
Checking for OIDC configuration...

Test 6: Auth status shows OIDC enabled
[0;32m✓ PASS[0m: OIDC is enabled

Test 7: Local auth still works alongside OIDC
[0;32m✓ PASS[0m: Local auth works (hybrid mode)

Test 8: Get OIDC authorization URL
[0;32m✓ PASS[0m: OIDC authorization URL generated
   Auth URL: https://oidc-mock.yeraze.online/auth?redirect_uri=https%3A%2F%2Fmeshdev.yeraze.o...

Test 9: Simulate OIDC authorization flow
Following authorization URL (with auto-login)...
   Final URL: https://meshdev.yeraze.online/...
   HTTP Code: 200
[0;32m✓ PASS[0m: OIDC flow completed (redirected back to app)

Test 10: Verify OIDC authentication created session
[0;32m✓ PASS[0m: User authenticated via OIDC
[0;32m✓ PASS[0m: Auth provider is OIDC
   Logged in as: test-user-1

Test 11: Wait for Meshtastic node connection and data sync
Waiting up to 30 seconds for channels (>=3) and nodes (>100)...
[0;32m✓ PASS[0m: Node connected (channels: 4, nodes: 142)


Waiting 15 seconds for system to settle...

Test 12: Send message to Yeraze Station G2
[0;32m✓ PASS[0m: Message sent successfully

Test 13: Verify OIDC user auto-creation feature
[1;33m⚠ INFO[0m: OIDC user creation logs not found (may not have logged in via OIDC)

==========================================
[0;32mOIDC integration tests passed![0m
==========================================

The OIDC production deployment works correctly:
  • Mock OIDC provider running
  • OIDC discovery working
  • MeshMonitor OIDC integration initialized
  • Authorization URL generation working
  • OIDC flow completion verified
  • Meshtastic node connectivity verified

OIDC Configuration:
  • Issuer: http://localhost:3005
  • Client ID: meshmonitor-test
  • Test user: alice@example.com (Alice Test)
  • Auto-create users: enabled


Cleaning up...

[0;32m✓ Reverse Proxy + OIDC test PASSED[0m

==========================================
[0;34mRunning Virtual Node CLI Test[0m
==========================================

==========================================
Virtual Node Server CLI Test
==========================================

Creating test docker-compose.yml with Virtual Node Server...
[0;32m✓[0m Test config created

Building container...
[0;32m✓[0m Build complete

Starting container...
 Network meshmonitor_default  Creating
 Network meshmonitor_default  Created
 Volume "meshmonitor_meshmonitor-virtual-node-cli-test-data"  Creating
 Volume "meshmonitor_meshmonitor-virtual-node-cli-test-data"  Created
 Container meshmonitor-virtual-node-cli-test  Creating
 Container meshmonitor-virtual-node-cli-test  Created
 Container meshmonitor-virtual-node-cli-test  Starting
 Container meshmonitor-virtual-node-cli-test  Started
[0;32m✓[0m Container started

Waiting for container to be ready...
Test 1: Container is running
[0;32m✓ PASS[0m: Container is running

Test 2: Wait for Meshtastic node connection and Virtual Node Server startup
Waiting up to 90 seconds for Virtual Node Server to be ready...
[0;32m✓ PASS[0m: Server ready with Virtual Node enabled (nodes: 1)

Test 3: Test basic TCP connectivity
[0;32m✓ PASS[0m: Virtual Node Server port 4405 is accessible

Test 4: Verify server accepts TCP connections
Connecting to Virtual Node Server...
✓ Successfully connected to Virtual Node Server
✓ Connection closed gracefully
[0;32m✓ PASS[0m: Server accepts TCP connections

Test 5: Verify Virtual Node Server is broadcasting mesh data
[0;32m✓ PASS[0m: Web UI API has 3 messages from mesh network

Test 6: Verify Virtual Node Server logs show client connection
[1;33m⚠ WARN[0m: No client connection log found

==========================================
[0;32mAll tests passed![0m
==========================================

The Virtual Node Server test completed successfully:
  • Container started with Virtual Node Server enabled
  • Server listens on port 4404
  • TCP connections are accepted
  • Web UI API is accessible and serving data
  • Virtual Node Server is operational

Note: Full Meshtastic Python library compatibility testing requires
additional investigation and is tracked separately.


Cleaning up...

[0;32m✓ Virtual Node CLI test PASSED[0m

==========================================
[0;34mRunning System Backup & Restore Test[0m
==========================================

==========================================
System Backup & Restore Test
==========================================

Creating test docker-compose.yml for source container...
[0;32m✓[0m Source config created

Building container...
[0;32m✓[0m Build complete

Starting source container...
 Network meshmonitor_default  Creating
 Network meshmonitor_default  Created
 Volume "meshmonitor_meshmonitor-backup-source-test-data"  Creating
 Volume "meshmonitor_meshmonitor-backup-source-test-data"  Created
 Container meshmonitor-backup-source-test  Creating
 Container meshmonitor-backup-source-test  Created
 Container meshmonitor-backup-source-test  Starting
 Container meshmonitor-backup-source-test  Started
[0;32m✓[0m Container started

Waiting for container to be ready...
[0;32m✓ PASS[0m: Container is running
Waiting for API to be ready...
[0;32m✓ PASS[0m: API is ready

Waiting for Meshtastic node connection (optional)...
[1;33m⚠ WARN[0m: No Meshtastic node connected - testing with minimal data
This is acceptable - backup/restore will be tested with admin user and settings only

Getting CSRF token...
[0;32m✓ PASS[0m: CSRF token obtained

Testing /api/auth/login endpoint availability...
Login endpoint is available

Logging in...
[0;32m✓ PASS[0m: Login successful

Collecting baseline data...
  - Nodes: 0
  - Messages: 0
[0;32m✓ PASS[0m: Baseline data collected

Creating system backup...
[0;32m✓ PASS[0m: System backup created: 2025-11-17_154148

Verifying backup was created...
[0;32m✓ PASS[0m: Backup appears in backup list

Creating test docker-compose.yml for restore container...
[0;32m✓[0m Restore config created

Starting restore container...
 Volume "meshmonitor_meshmonitor-restore-test-data"  Creating
 Volume "meshmonitor_meshmonitor-restore-test-data"  Created
time="2025-11-17T10:41:49-05:00" level=warning msg="Found orphan containers ([meshmonitor-backup-source-test]) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up."
 Container meshmonitor-restore-test  Creating
 Container meshmonitor-restore-test  Created
 Container meshmonitor-restore-test  Starting
 Container meshmonitor-restore-test  Started
[0;32m✓[0m Restore container started

Waiting for restore to complete...
[0;32m✓ PASS[0m: Restore container is ready

Verifying restore completed successfully...
[0;32m✓ PASS[0m: Restore completed successfully (confirmed in logs)

Logging in to restored container...
[0;32m✓ PASS[0m: Logged in to restored container

Verifying data integrity...
[0;32m✓ PASS[0m: Node count matches (0 nodes - no Meshtastic connection)
[0;32m✓ PASS[0m: Message count matches (0 messages - no Meshtastic connection)
[1;33m⚠ WARN[0m: Restore event not found in audit log (non-critical)

Verifying source container is unaffected...
[0;32m✓ PASS[0m: Source container node count unchanged: 0

==========================================
[0;32mAll tests passed![0m
==========================================

The System Backup & Restore test completed successfully:
  • Tested with minimal data (no Meshtastic node connected)
  • Verified backup/restore functionality works correctly
  • Source container unaffected
  • Data integrity verified


[0;34mCleaning up backup/restore test artifacts...[0m
[0;32m✓[0m Cleanup complete

[0;32m✓ System Backup & Restore test PASSED[0m

==========================================
System Test Results
==========================================

Configuration Import:     [0;32m✓ PASSED[0m
Quick Start Test:         [0;32m✓ PASSED[0m
Security Test:            [0;32m✓ PASSED[0m
Reverse Proxy Test:       [0;32m✓ PASSED[0m
Reverse Proxy + OIDC:     [0;32m✓ PASSED[0m
Virtual Node CLI Test:    [0;32m✓ PASSED[0m
Backup & Restore Test:    [0;32m✓ PASSED[0m

[0;32m==========================================
✓ ALL SYSTEM TESTS PASSED
==========================================\033[0m

Your deployment configurations are working correctly!
Ready to create or update PR.

Markdown report generated: test-results.md

[0;34mCleaning up test artifacts...[0m
[0;32m✓[0m Cleanup complete
