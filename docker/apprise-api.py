#!/usr/bin/env python3
"""
Minimal Apprise API Server for MeshMonitor
Provides a simple REST API for sending notifications via Apprise
"""
import os
import json
import apprise
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

CONFIG_DIR = os.getenv('APPRISE_CONFIG_DIR', '/apprise-config')
PORT = int(os.getenv('APPRISE_PORT', '8000'))

# Global Apprise object
apobj = apprise.Apprise()

def load_config():
    """Load Apprise URLs from config file"""
    config_file = os.path.join(CONFIG_DIR, 'urls.txt')
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
            apobj.clear()
            for url in urls:
                apobj.add(url)
        print(f"✅ Loaded {len(urls)} notification URLs from config")
    else:
        print(f"⚠️  No config file found at {config_file}")

def save_config(urls):
    """Save Apprise URLs to config file"""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    config_file = os.path.join(CONFIG_DIR, 'urls.txt')
    with open(config_file, 'w') as f:
        for url in urls:
            f.write(f"{url}\n")
    load_config()

class AppriseHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        """Custom logging to stdout"""
        print(f"[Apprise API] {format % args}")

    def send_json_response(self, code, data):
        """Helper to send JSON response"""
        self.send_response(code)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        """Handle CORS preflight"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests"""
        parsed = urlparse(self.path)

        # Health check
        if parsed.path == '/health' or parsed.path == '/':
            self.send_json_response(200, {
                'status': 'ok',
                'urls_configured': len(apobj),
                'version': apprise.__version__
            })

        # Get configured URLs (masked for security)
        elif parsed.path == '/urls':
            urls = [{'masked': url[:20] + '...'} for url in apobj.urls()]
            self.send_json_response(200, {
                'count': len(apobj),
                'urls': urls
            })

        else:
            self.send_json_response(404, {'error': 'Not found'})

    def do_POST(self):
        """Handle POST requests"""
        parsed = urlparse(self.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')

        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_json_response(400, {'error': 'Invalid JSON'})
            return

        # Send notification
        if parsed.path.startswith('/notify'):
            title = data.get('title', 'MeshMonitor')
            body_text = data.get('body', '')
            notify_type = data.get('type', 'info')

            if not body_text:
                self.send_json_response(400, {'error': 'Body is required'})
                return

            # Map type to Apprise notification type
            type_map = {
                'info': apprise.NotifyType.INFO,
                'success': apprise.NotifyType.SUCCESS,
                'warning': apprise.NotifyType.WARNING,
                'failure': apprise.NotifyType.FAILURE,
                'error': apprise.NotifyType.FAILURE
            }
            apprise_type = type_map.get(notify_type, apprise.NotifyType.INFO)

            try:
                # Send notification
                result = apobj.notify(
                    title=title,
                    body=body_text,
                    notify_type=apprise_type
                )

                if result:
                    self.send_json_response(200, {
                        'success': True,
                        'message': 'Notification sent',
                        'sent_to': len(apobj)
                    })
                else:
                    self.send_json_response(500, {
                        'success': False,
                        'error': 'Failed to send notification'
                    })
            except Exception as e:
                self.send_json_response(500, {
                    'success': False,
                    'error': str(e)
                })

        # Configure URLs
        elif parsed.path == '/config':
            urls = data.get('urls', [])
            if not urls:
                self.send_json_response(400, {'error': 'URLs array is required'})
                return

            try:
                save_config(urls)
                self.send_json_response(200, {
                    'success': True,
                    'message': f'Configured {len(urls)} URLs',
                    'count': len(urls)
                })
            except Exception as e:
                self.send_json_response(500, {
                    'success': False,
                    'error': str(e)
                })

        else:
            self.send_json_response(404, {'error': 'Not found'})

def run_server():
    """Start the HTTP server"""
    load_config()
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, AppriseHandler)
    print(f"🚀 Apprise API server starting on http://0.0.0.0:{PORT}")
    print(f"📁 Config directory: {CONFIG_DIR}")
    print(f"📊 Loaded {len(apobj)} notification URLs")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
