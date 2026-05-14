# Cloudflare Automated Stock Trading Agent

An automated stock trading agent built on Cloudflare Workers, using **Workflows**, **Durable Objects (Agents)**, and the **Model Context Protocol (MCP)**.

## Features
- 📊 **Watchlist Analysis**: Daily reports sent to Telegram at 2:45 PM IST.
- 🚀 **Automated Trading**: Scans for buy opportunities at 3:10 PM IST.
- 👤 **Human-in-the-Loop**: Orders are only placed after you approve them via a Telegram link.
- 🤖 **MCP Integration**: Uses a dedicated MCP server for technical analysis and Kite API execution.

## Prerequisites
1.  **Cloudflare Account**: With Workers, Workflows, and Durable Objects enabled.
2.  **Telegram Bot**: Created via [@BotFather](https://t.me/botfather).
3.  **MCP Server**: A running instance of the `stock-mcp` server (e.g., at `https://stock-mcp.durgadas.in/mcp`).

## Setup Instructions

### 1. Clone & Install
```bash
npm install
```

### 2. Configure Environment
Update `wrangler.jsonc` or set secrets for the following:
- `MCP_SERVER_URL`: The URL of your MCP server.
- `TELEGRAM_BOT_TOKEN`: Your bot's token.
- `TELEGRAM_CHAT_ID`: Your personal Telegram ID.

To set secrets for production:
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### 3. Local Development
Create a `.dev.vars` file for local testing:
```env
TELEGRAM_BOT_TOKEN="your_token_here"
TELEGRAM_CHAT_ID="your_chat_id_here"
```
Run the local dev server:
```bash
npm start
```

### 4. Deployment
Deploy to Cloudflare:
```bash
npm run deploy
```

## Usage & Testing

### Manual Triggers (Local)
- **Watchlist Report**: [http://localhost:8787/test-analysis](http://localhost:8787/test-analysis)
- **Trading Scan**: [http://localhost:8787/test-trigger](http://localhost:8787/test-trigger)

### Scheduled Events
- **2:45 PM IST**: Watchlist Analysis Report.
- **3:10 PM IST**: Trading Scan & Approval Request.
