# API Documentation

MeshMonitor provides a comprehensive REST API for interacting with your Meshtastic network programmatically.

## Interactive API Documentation

The complete API reference is available through our interactive Swagger/OpenAPI documentation:

**Local Development:** `http://localhost:8080/api/v1/docs`

**Production:** `https://your-meshmonitor-instance/api/v1/docs`

## Features

The Swagger documentation provides:

- **Complete API endpoint reference** - All available endpoints with full descriptions
- **Interactive testing** - Try API calls directly from the browser
- **Request/response examples** - See exactly what to send and expect
- **Authentication details** - API token authentication requirements
- **Schema definitions** - Detailed data models for all API objects

## Authentication

Most API endpoints require authentication using an API token. See the [API Authentication](/development/api-auth.html) documentation for details on generating and using API tokens.

## Quick Start

1. Start MeshMonitor (locally or access your deployment)
2. Navigate to `/api/v1/docs` in your browser
3. Generate an API token from the Settings page
4. Use the "Authorize" button in Swagger to add your token
5. Try out the API endpoints interactively

## API Versioning

The current API is version 1 (`/api/v1/`). All endpoints are prefixed with `/api/v1/` to support future versioning.
