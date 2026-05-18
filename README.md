# Cloudflare Automated Stock Trading Agent

An automated stock trading agent built on Cloudflare Workers, using **Workflows**, **Durable Objects (Agents)**, and the **Model Context Protocol (MCP)**.

## Features
- 📊 **Watchlist Analysis**: Reports sent to Telegram at 2:45 PM IST on Weekdays (Mon-Fri).
- 🚀 **Automated Trading**: Scans for buy opportunities at 3:10 PM IST on Weekdays (Mon-Fri).
- 👤 **Human-in-the-Loop**: Orders are only placed after you approve them via Telegram, displaying your live available Zerodha balance for informed confirmation.
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

You need to obtain your Telegram credentials and configure them so the agent knows who you are and where to route messages.

#### 🔑 How to Get Your Telegram Bot Token
1. Open Telegram, search for the official bot creator **[@BotFather](https://t.me/botfather)** and start a chat.
2. Send the `/newbot` command.
3. Choose a friendly name for your bot (e.g., `My Trading Agent`).
4. Choose a unique username ending in `bot` (e.g., `my_durable_trading_bot`).
5. BotFather will reply with your secure HTTP API token (format: `1234567890:ABCdef...`). This is your `TELEGRAM_BOT_TOKEN`.

#### 🆔 How to Get Your Personal Chat ID
To make sure only *you* can send commands to your trading bot, you must restrict access to your unique Telegram numerical user ID:
1. Search for **[@userinfobot](https://t.me/userinfobot)** or **[@GetIDsBot](https://t.me/getidsbot)** on Telegram and start a chat.
2. Click **Start** or send `/start`.
3. The bot will instantly reply with your numerical ID (e.g. `987654321`). This is your `TELEGRAM_CHAT_ID`.

#### ⚙️ Save Your Configuration
Update `wrangler.jsonc` or store secrets in Cloudflare:
- `MCP_SERVER_URL`: The URL of your MCP server.
- `TELEGRAM_BOT_TOKEN`: The token you received from BotFather.
- `TELEGRAM_CHAT_ID`: Your numerical personal chat ID.

To save secrets securely in your production Cloudflare environment:
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

## Telegram Webhook Setup & Routing

For your Telegram bot to forward user messages to the Cloudflare Worker, a connection known as a **Webhook** must be registered. Once registered, Telegram remembers that whenever anyone sends a message to your bot, it must immediately send an HTTP `POST` request containing that message data (an `Update`) directly to your Worker's `/telegram-webhook` endpoint.

### 1. How Telegram Routes Messages to Cloudflare
When a user chats with your bot:
1. **User** sends a message on Telegram.
2. **Telegram Servers** look up the active webhook registered for your bot token.
3. **Telegram** POSTs a JSON payload to your Cloudflare Worker URL: `https://your-worker-domain.com/telegram-webhook`.
4. **Cloudflare Worker** receives the webhook, verifies the sender chat ID against your `TELEGRAM_CHAT_ID`, parses the message content, and triggers the corresponding action in the `TradingAgent` Durable Object.

### 2. Setting Up Your Webhook
To register your Worker's URL with Telegram:
1. Deploy your Cloudflare Worker so it has a public `BASE_URL` (e.g. `https://cf-stock-trading-agent.durgadas.in`).
2. Make a single HTTP request to the `/set-webhook` path of your deployed worker, appending your secret `AUTH_TOKEN`:
   ```text
   https://<your-worker-domain>/set-webhook?token=<your_auth_token>
   ```
3. Your Cloudflare Worker will execute a secure API request to Telegram (`/setWebhook?url=...`) using your `TELEGRAM_BOT_TOKEN`.
4. The endpoint will return a success response showing that the webhook is active:
   ```json
   {
     "ok": true,
     "result": true,
     "description": "Webhook was set"
   }
   ```

---

## 🤖 Bot Commands & Interactive Menu

### 1. Adding Menu Suggestions in Telegram
To display a command suggestion menu when you type `/` in the chat, register them with Telegram's **@BotFather**:
1. Open Telegram and message **@BotFather**.
2. Send the `/setcommands` command.
3. Choose your trading bot from the list.
4. Copy and paste the list below:
   ```text
    login - Generate secure Zerodha Kite Connect login link
    holdings - View active NSE equity and ETF holdings
    mf - View mutual fund holdings with live NAVs
    analyze - Run daily sector watchlists technical analysis scans (No Kite session required)
    analyze_holdings - Run stock-mcp technical analysis on NSE holdings (Kite session required)
    analyze_mf - Run mutual fund portfolio health & asset diversification analysis
    trade - View pending trade scan or trigger custom orders
    ```
5. Send. The menu will immediately populate in your chat window.

### 2. Available Commands Reference

The bot supports natural language command patterns, alongside standard slash commands.

| Live Command | Short/Alternative | Demo (Mock Data) | Description |
| :--- | :--- | :--- | :--- |
| `kite login` | `login` / `/login` | N/A | Generates a 10-minute secure authorization link to Zerodha Kite. |
| `get kite holdings` | `holdings` / `/holdings` | `mock holdings` | Fetches active equity/ETF holdings, formats P&L status, and prints totals. |
| `get mutual fund holdings` | `mf` / `mf holdings` / `/mf` | `mock mf` | Fetches active mutual fund holdings, average costs, current NAVs, and returns. |
| `analyze` | `do analysis` / `/analyze` / `watchlist analysis` | N/A | **Watchlist Scan**: Runs daily sector watchlist technical analysis scans. **No Kite session required!** |
| `analyze_kite_holdings` | `analyze holdings` / `/analyze_holdings` / `/analyze_kite_holdings` | `mock analyze` | **Equity Holdings Scan**: Extracts holding symbols, maps them to NSE (`.NS`), and runs stock-mcp High-Conviction scans. |
| `analyze_mf` | `analyze mf` / `/analyze_mf` / `/mf_analysis` | `mock analyze mf` | **MF Health Card**: Evaluates mutual fund returns, top/under-performers, and asset allocation percentage weights. |
| `trade <amount>` | `trade <symbol> <amount>` | N/A | Starts an order flow scan or targets a specific stock to buy (e.g. `trade INFY 5000`). |

---

## Usage & Testing

### Manual Triggers (Local)
- **Watchlist Report**: [http://localhost:8787/test-analysis?token=your_auth_token](http://localhost:8787/test-analysis?token=your_auth_token)
- **Trading Scan**: [http://localhost:8787/test-trigger?token=your_auth_token](http://localhost:8787/test-trigger?token=your_auth_token)
- **Kite Login Portal**: [http://localhost:8787/kite-login?token=your_auth_token](http://localhost:8787/kite-login?token=your_auth_token)

### Scheduled Events
- **2:45 PM IST (Mon-Fri)**: Sector Watchlist Analysis & Glossary delivery.
- **3:10 PM IST (Mon-Fri)**: Automated High-Conviction scan and trade approval request.

