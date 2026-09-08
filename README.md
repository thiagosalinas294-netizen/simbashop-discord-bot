# SIMBA SHOP Discord Bot

Shoppex webhook receiver + Discord embeds.

## What it does

- Receives Shoppex webhooks at `/webhooks/shoppex`
- Sends paid orders to a Discord sales channel
- Sends stock/restock events to a Discord restock channel
- Uses environment variables for secrets

## Important

Do not commit `.env`, Discord tokens, Shoppex API keys, or webhook secrets.

Signature verification is intentionally disabled in the first deployment. Before production use, enable it after confirming the exact signature headers/formula from the Shoppex webhook configuration.

## Render

- Build Command: `npm install`
- Start Command: `npm start`
- Environment: Node

Required variables:

- `DISCORD_TOKEN`
- `SALES_CHANNEL_ID`
- `RESTOCK_CHANNEL_ID`
- `SHOPPEX_WEBHOOK_SECRET`

Temporary:
- `VERIFY_WEBHOOK=false`
