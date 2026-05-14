import { Agent, callable, routeAgentRequest } from "agents";
import { TradingWorkflow, WatchlistAnalysisWorkflow } from "./workflow";

export interface Env {
  TRADING_AGENT: DurableObjectNamespace<TradingAgent>;
  TRADING_WORKFLOW: Workflow;
  WATCHLIST_ANALYSIS_WORKFLOW: Workflow;
  MCP_SERVER_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

export class TradingAgent extends Agent<Env> {
  async onStart() {
    // Connect to the MCP server on startup
    await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
  }

  @callable()
  async findOpportunities(criteria: any) {
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
    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();
    return await this.mcp.callTool({
      serverId,
      name: "confirm_and_place_orders",
      arguments: {
        total_amount: params.amount,
        symbols: params.opportunities.map(o => o.symbol)
      }
    });
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
  async checkKiteLogin() {
    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();

    try {
      // Try to get holdings to verify session
      const holdingsResult = await this.mcp.callTool({
        serverId,
        name: "get_kite_holdings",
        arguments: {}
      });
      
      const holdings = JSON.parse((holdingsResult as any).content[0].text);
      if (holdings.status === "error" && holdings.error.includes("session")) {
        throw new Error("Session expired");
      }
      return { status: "connected" };
    } catch (err) {
      // Session expired or missing, get login URL
      const loginResult = await this.mcp.callTool({
        serverId,
        name: "kite_login",
        arguments: {}
      });
      const loginData = JSON.parse((loginResult as any).content[0].text);
      return { status: "disconnected", loginUrl: loginData.login_url };
    }
  }

  @callable()
  async startTradingWorkflow(amount: number) {
    return await this.runWorkflow("TRADING_WORKFLOW", { amount });
  }

  @callable()
  async startWatchlistAnalysis() {
    return await this.runWorkflow("WATCHLIST_ANALYSIS_WORKFLOW", {});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Manual triggers for testing
    if (url.pathname === "/test-trigger") {
      const amount = parseInt(url.searchParams.get("amount") || "1000");
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.startTradingWorkflow(amount);
      return new Response("✅ Trading workflow started. Check Telegram!", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/test-analysis") {
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.startWatchlistAnalysis();
      return new Response("✅ Watchlist analysis started. Check Telegram!", { headers: { "Content-Type": "text/plain" } });
    }

    if (url.pathname === "/approve") {
      const workflowId = url.searchParams.get("workflowId");
      if (!workflowId) return new Response("Missing workflowId", { status: 400 });
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.approveWorkflow(workflowId);
      return new Response("🚀 Approval received!", { headers: { "Content-Type": "text/plain" } });
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
    // Fallback for manual or single cron triggers
    else {
      await agent.startWatchlistAnalysis();
      await agent.startTradingWorkflow(1000);
    }
  }
};

export { TradingWorkflow, WatchlistAnalysisWorkflow };
