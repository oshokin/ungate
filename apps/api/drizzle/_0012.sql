-- Migration 0012: persisted Cloudflare tunnel protocol
ALTER TABLE app_settings ADD COLUMN tunnel_protocol text NOT NULL DEFAULT 'http2';
