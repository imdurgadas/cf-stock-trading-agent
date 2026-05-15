# Trading Agent Architecture

This project leverages the **Cloudflare Agents SDK** to create a durable, stateful trading bot.

## Components

### 1. TradingAgent (Durable Object)
The core "brain" of the operation. It inherits from `Agent<Env>` and provides:
- **MCP Client**: Manages a persistent connection to the technical analysis server.
- **Kite SDK**: Manages direct connection to Zerodha Kite for order placement.
- **RPC Methods**: Marked with `@callable()`, these allow Workflows to trigger market analysis and order placement.
- **Scheduling**: Uses Cron triggers to send periodic reports and trigger trades.

### 2. TradingWorkflow (AgentWorkflow)
Handles the main trading logic with human-in-the-loop:
1.  **Market Scan**: Calls the Agent to find buy opportunities (-2% dip, RSI > 50).
2.  **Notification**: Sends a Telegram message with an approval link and Kite login link if session is expired.
3.  **Wait for Approval**: Uses `this.waitForApproval()` to pause execution for up to 1 hour.
4.  **Execution**: If approved, calls the Agent to place orders via the Kite SDK.

### 3. WatchlistAnalysisWorkflow (AgentWorkflow)
A reporting workflow that:
1.  Fetches technical data for a pre-defined set of ETFs.
2.  Categorizes them into "Rising", "Opportunities", or "Bearish".
3.  Sends a formatted summary to the user via Telegram.

## Communication Flow

```mermaid
sequenceDiagram
    participant C as Cron Trigger
    participant A as TradingAgent (DO)
    participant W as TradingWorkflow
    participant M as MCP Server
    participant K as Kite API
    participant T as Telegram

    C->>A: scheduled()
    A->>W: runWorkflow()
    W->>A: findOpportunities (RPC)
    A->>M: tools/call (MCP)
    M-->>A: Stock Data
    A-->>W: List of Opportunities
    W->>T: sendTelegramMessage (Approval Link)
    T-->>User: Click Approve
    User->>A: /approve (Fetch)
    A->>W: approveWorkflow()
    W->>A: executeOrders (RPC)
    A->>K: placeOrder (SDK)
    K-->>A: Order Result
    A-->>W: Success
```

## Security & Reliability
- **Durable fiber**: Workflows ensure that even if a step fails or the worker is evicted, it resumes from the last successful checkpoint.
- **Gated Orders**: No money is spent without explicit approval from the user's Telegram interaction.
- **Session Persistence**: Kite access tokens are stored securely in the Durable Object's persistent storage.
