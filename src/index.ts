import { Agent, callable, routeAgentRequest } from "agents";
import { TradingWorkflow, WatchlistAnalysisWorkflow } from "./workflow";
import * as KitePkg from "kiteconnect";
const KiteConnect = (KitePkg as any).KiteConnect || (KitePkg as any).default?.KiteConnect || KitePkg;

export interface Env {
  TRADING_AGENT: DurableObjectNamespace<TradingAgent>;
  TRADING_WORKFLOW: Workflow;
  WATCHLIST_ANALYSIS_WORKFLOW: Workflow;
  MCP_SERVER_URL: string;
  KITE_API_KEY: string;
  KITE_API_SECRET: string;
  AUTH_TOKEN: string;
  BASE_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export class TradingAgent extends Agent<Env> {
  private kite: KiteConnect | null = null;

  async onStart() {
    // Connect to the MCP server on startup
    await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
  }

  async initKite() {
    if (this.kite) return this.kite;
    
    console.log("[Agent] Initializing Kite SDK...");
    if (!this.env.KITE_API_KEY) {
      console.warn("[Agent] KITE_API_KEY is missing from environment!");
    }

    try {
      this.kite = new (KiteConnect as any)({
        api_key: this.env.KITE_API_KEY
      });

      const accessToken = await this.ctx.storage.get<string>("kite_access_token");
      if (accessToken) {
        this.kite!.setAccessToken(accessToken);
      }
      return this.kite!;
    } catch (err: any) {
      console.error("[Agent] Failed to instantiate KiteConnect:", err.message);
      throw err;
    }
  }

  @callable()
  async findOpportunities(criteria: any) {
    if (criteria.mock) {
      return [{
        symbol: "MOCK_STOCK",
        rsi: 45.5,
        fall_pct: -2.5,
        ltp: 150.0,
        is_st_green: true
      }];
    }

    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();
    const result = await this.mcp.callTool({
      serverId,
      name: "find_buy_opportunities",
      arguments: criteria
    });
    if (result.isError) throw new Error("MCP Tool Error");
    const textContent = (result as any).content[0].text;
    const parsedContent = JSON.parse(textContent);
    return parsedContent.opportunities;
  }

  @callable()
  async executeOrders(params: { amount: number, opportunities: any[] }) {
    const kite = await this.initKite();
    
    const results = [];
    for (const opportunity of params.opportunities) {
      try {
        const orderId = await kite.placeOrder("regular", {
          exchange: "NSE",
          tradingsymbol: opportunity.symbol,
          transaction_type: "BUY",
          quantity: 1, // Simplified for now
          product: "CNC",
          order_type: "MARKET"
        });
        results.push({ symbol: opportunity.symbol, status: "success", orderId });
      } catch (err: any) {
        results.push({ symbol: opportunity.symbol, status: "error", message: err.message });
      }
    }
    return results;
  }

  @callable()
  async checkKiteLogin() {
    try {
      const kite = await this.initKite();
      if (!kite.access_token) return { status: "disconnected", loginUrl: this.getKiteLoginUrl() };

      await kite.getProfile();
      return { status: "connected" };
    } catch (err: any) {
      console.error("Kite Login Check Error:", err.message);
      return { status: "disconnected", loginUrl: this.getKiteLoginUrl() };
    }
  }

  getKiteLoginUrl() {
    return `https://kite.trade/connect/login?v=3&api_key=${this.env.KITE_API_KEY}`;
  }

  @callable()
  async setKiteRequestToken(requestToken: string) {
    const kite = new KiteConnect({
      api_key: this.env.KITE_API_KEY
    });

    try {
      const response = await kite.generateSession(requestToken, this.env.KITE_API_SECRET);
      await this.ctx.storage.put("kite_access_token", response.access_token);
      this.kite = kite;
      this.kite.setAccessToken(response.access_token);
      return { status: "success", user: response.user_name };
    } catch (err: any) {
      throw new Error(`Failed to generate Kite session: ${err.message}`);
    }
  }


  @callable()
  async getWatchlistAnalysis(symbols: string[]) {
    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();

    const result = await this.mcp.callTool({
      serverId,
      name: "analyze_multiple_stocks",
      arguments: { symbols }
    });

    if (result.isError) throw new Error("MCP Analysis Tool Error");
    return JSON.parse((result as any).content[0].text);
  }



  @callable()
  async storeTradeState(opportunities: any[], workflowId: string) {
    await this.ctx.storage.put("last_opportunities", opportunities);
    await this.ctx.storage.put("pending_workflow_id", workflowId);
    return { status: "success" };
  }

  @callable()
  async startWatchlistAnalysis() {
    return await this.runWorkflow("WATCHLIST_ANALYSIS_WORKFLOW", {});
  }

  @callable()
  async startTradingWorkflow(amount: number, mock: boolean = false) {
    // Store that we are starting a run
    await this.ctx.storage.put("current_run_mock", mock);
    return await this.runWorkflow("TRADING_WORKFLOW", { amount, mock });
  }

  @callable()
  async handleTelegramUpdate(update: any) {
    const text = update.message?.text?.toLowerCase();
    const chatId = update.message?.chat?.id;

    if (!text || String(chatId) !== String(this.env.TELEGRAM_CHAT_ID)) return;

    // 1. Handle "trade <amount>"
    const tradeMatch = text.match(/^trade\s+(\d+)$/);
    if (tradeMatch) {
      const amount = parseInt(tradeMatch[1]);
      await this.ctx.storage.put("pending_amount", amount);
      const opportunities = await this.ctx.storage.get<any[]>("last_opportunities");
      
      if (!opportunities || opportunities.length === 0) {
        await this.sendBotMessage("No pending opportunities found. Please wait for the next scan.");
        return;
      }

      const symbols = opportunities.map(o => o.symbol).join(", ");
      await this.sendBotMessage(`⚠️ *Confirmation*: Buy ${symbols} for ₹${amount}?\nReply "yes" to confirm or "no" to cancel.`);
      return;
    }

    // 2. Handle "yes" confirmation
    if (text === "yes") {
      const amount = await this.ctx.storage.get<number>("pending_amount");
      const workflowId = await this.ctx.storage.get<string>("pending_workflow_id");

      if (!amount || !workflowId) {
        await this.sendBotMessage("Nothing to confirm. Use `trade <amount>` first.");
        return;
      }

      await this.sendBotMessage("🚀 *Executing...*");
      await this.approveWorkflow(workflowId);
      // Clean up
      await this.ctx.storage.delete("pending_amount");
      return;
    }

    // 3. Handle "no" cancellation
    if (text === "no") {
      await this.ctx.storage.delete("pending_amount");
      await this.sendBotMessage("❌ Trade cancelled.");
      return;
    }
  }

  private async sendBotMessage(text: string) {
    const { sendTelegramMessage } = await import("./notifications");
    console.log("[Telegram] Sending message:", text);
    await sendTelegramMessage(text, {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_CHAT_ID
    });
    console.log("[Telegram] Message sent successfully.");
  }

  @callable()
  async handleKitePostback(data: any) {
    console.log("Kite Postback Received:", data);
    // You could send a Telegram message here for important updates
    return { status: "received" };
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    // Simple auth check for all sensitive routes
    const validateAuth = () => {
      if (!token || token !== env.AUTH_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return null;
    };

    // Manual triggers for testing
    if (url.pathname === "/test-trigger") {
      const authError = validateAuth();
      if (authError) return authError;

      const amount = parseInt(url.searchParams.get("amount") || "1000");
      const mock = url.searchParams.get("mock") === "true";
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.startTradingWorkflow(amount, mock);
      return new Response(`✅ Trading workflow started (Mock: ${mock}). Check Telegram!`, { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/test-analysis") {
      const authError = validateAuth();
      if (authError) return authError;

      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.startWatchlistAnalysis();
      return new Response("✅ Watchlist analysis started. Check Telegram!", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/kite-login") {
      const authError = validateAuth();
      if (authError) return authError;

      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      const loginUrl = await agent.getKiteLoginUrl();
      return Response.redirect(loginUrl);
    }

    if (url.pathname === "/kite-callback") {
      // Kite callbacks are authenticated by the request_token itself
      const requestToken = url.searchParams.get("request_token");
      if (!requestToken) return new Response("Missing request_token", { status: 400 });
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      const result = await agent.setKiteRequestToken(requestToken);
      return new Response(`🚀 Kite Session Active for ${result.user}!`, { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/kite-postback") {
      // Postbacks are usually public but we can verify signatures or payload
      const data = await request.json();
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.handleKitePostback(data);
      return new Response("OK");
    }

    if (url.pathname === "/approve") {
      const authError = validateAuth();
      if (authError) return authError;

      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return new Response("Missing workflowId", { status: 400 });
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.approveWorkflow(workflowId);
      return new Response("🚀 Approval received!", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/telegram-webhook") {
      const update = await request.json();
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.handleTelegramUpdate(update);
      return new Response("OK");
    }

    if (url.pathname === "/set-webhook") {
      const authError = validateAuth();
      if (authError) return authError;

      const webhookUrl = `${env.BASE_URL}/telegram-webhook`;
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
      const result = await response.json();
      return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
    }


    return (await routeAgentRequest(request, env)) || new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));

    // 2:45 PM IST (9:15 AM UTC) -> Watchlist Analysis
    if (event.cron === "15 9 * * *") {
      await agent.startWatchlistAnalysis();
    } 
    // 3:10 PM IST (9:40 AM UTC) -> Trading Workflow
    else if (event.cron === "40 9 * * *") {
      await agent.startTradingWorkflow(1000);
    }
    // Fallback for manual triggers
    else {
      await agent.startWatchlistAnalysis();
      await agent.startTradingWorkflow(1000);
    }
  }
};

export { TradingWorkflow, WatchlistAnalysisWorkflow };
