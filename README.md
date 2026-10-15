# Showwork Functions & Publishing Worker

Standalone background processing, social publishing worker, and Netlify function service for Showwork (useshowwork.com).

## Roles & Architecture
- **Social Media Publishing Worker**: Autonomous native daemon running on InterServer Ubuntu VPS (`workers/publishing`).
- **Canonical Publishing Engine**: PostgreSQL-backed transactional scheduling, ownership fencing, one-time capabilities, immutable evidence (`lib/publishing`).
- **Netlify Functions & Crons**: Scheduled triggers and background jobs for inbox synchronization, customer notifications, and reporting (`netlify/functions`).
- **Deployment Templates**: Systemd unit files and health monitor configurations for Ubuntu 24.04 LTS (`deploy/vps`).

## Local Development & Testing
- Build native worker: `npm run worker:build`
- Verify configuration (offline check): `npm run worker:check`
- Run typecheck: `npm run typecheck`
