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
    kite_login - Generate secure Zerodha Kite Connect login link (45 mins TTL)
    kite_holdings - View active NSE equity and ETF holdings
    kite_analyze - Run stock-mcp technical analysis on NSE holdings
    kite_trade - View pending trade scan or trigger custom orders
    mf - View mutual fund holdings with live NAVs
    mf_analyze - Run mutual fund portfolio risk & returns analysis
    mf_watchlist - Run deep technical & risk scan on default 9-fund watchlist
    mf_search - Search AMFI master database for Direct Growth schemes
    analyze - Run AI technical analysis on a specific stock (conversational)
    etf_analyze - Run automated ETF watchlist technical analysis
    it_analyze - Run IT sector watchlist technical analysis
    bank_analyze - Run banking sector watchlist technical analysis
    energy_analyze - Run energy sector watchlist technical analysis
    potential_analyze - Run high-growth structural stocks watchlist analysis
    ```
5. Send. The menu will immediately populate in your chat window.

### 2. Available Commands Reference

The bot supports resilient command patterns, allowing you to trigger them with or without a leading slash (`/`), alongside standard friendly text patterns.

| Command | Resilient Aliases | Demo (Mock Data) | Description |
| :--- | :--- | :--- | :--- |
| `/kite_login` | `kite_login` / `login` | N/A | Generates a secure authorization link to Zerodha Kite. **Session lasts 45 minutes.** |
| `/kite_holdings` | `kite_holdings` / `holdings` | `mock holdings` | Fetches active equity/ETF holdings, formats P&L status, and prints totals. |
| `/kite_analyze` | `kite_analyze` / `stock_analyze` / `analyze_holdings` | `mock analyze` | **Equity Holdings Scan**: Extracts active equity symbols, maps to NSE (`.NS`), and runs stock-mcp High-Conviction scans. |
| `/analyze` | `analyze` / `analyze <symbol>` | N/A | **Single Stock Analysis**: Runs a deep technical scan on a specific stock and provides AI insights. Can be run with a symbol (e.g. `analyze INFY`) or conversationally. |
| `/kite_trade <amount>` | `kite_trade <symbol> <amount>` / `trade <amount>` | N/A | Starts an order flow scan or targets a specific stock to buy (e.g. `kite_trade INFY 5000`). |
| `/mf` | `mf` / `mf holdings` / `mutual fund holdings` | `mock mf` | Fetches active mutual fund holdings, average costs, current NAVs, and returns. |
| `/mf_analyze` | `mf_analyze` / `analyze mf` / `mf_analysis` | `mock analyze mf` | **MF Portfolio Card**: Evaluates active mutual fund holdings returns, top/under-performers, and asset allocation. |
| `/mf_watchlist` | `mf_watchlist` / `mf watchlist` / `analyze mf watchlist` | N/A | **MF Watchlist Scan**: Runs the deep technical indicator, CAGR, Sharpe/Sortino ratios, and graded analysis on our default **9-fund High-Conviction Mutual Fund watchlist** on-demand. **No Kite session required!** |
| `/mf_search <query>` | `mf_search <query>` / `search_mf <query>` | N/A | **AMFI Search Engine**: Searches the 17,000+ active mutual fund registry from AMFI in real-time, matching wildcards (e.g. `mf_search Mirae`) and prioritizing direct growth schemes. |
| `/etf_analyze` | `etf_analyze` / `do analysis` | N/A | **ETF Watchlist Scan**: Runs the technical analysis on the default **ETF** watchlist on-demand. **No Kite session required!** |
| `/it_analyze` | `it_analyze` / `analyze it` | N/A | **IT Watchlist Scan**: Evaluates the full technical indicators of the active IT sector watchlist on-demand. |
| `/bank_analyze` | `bank_analyze` / `analyze bank` | N/A | **Banking Watchlist Scan**: Evaluates the full technical indicators of the active private and PSU banking watchlist on-demand. |
| `/energy_analyze` | `energy_analyze` / `analyze energy` | N/A | **Energy Watchlist Scan**: Evaluates the full technical indicators of the active utility/energy sector watchlist on-demand. |
| `/potential_analyze` | `potential_analyze` / `analyze potential` | N/A | **High-Growth Scan**: Evaluates active under-the-radar structural growth stocks (CDSL, RVNL, etc.) on-demand. |

---

## Usage & Testing

### Manual Triggers (Local)
- **Watchlist Report**: [http://localhost:8787/test-analysis?token=your_auth_token](http://localhost:8787/test-analysis?token=your_auth_token)
- **Trading Scan**: [http://localhost:8787/test-trigger?token=your_auth_token](http://localhost:8787/test-trigger?token=your_auth_token)
- **Kite Login Portal**: [http://localhost:8787/kite-login?token=your_auth_token](http://localhost:8787/kite-login?token=your_auth_token)

### Scheduled Events
- **2:45 PM IST (Mon-Fri)**: Sector Watchlist Analysis & Glossary delivery.
- **3:10 PM IST (Mon-Fri)**: Automated High-Conviction scan and trade approval request.

