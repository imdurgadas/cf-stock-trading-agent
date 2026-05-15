import { Agent, callable, routeAgentRequest } from "agents";
import { WatchlistAnalysisWorkflow } from "./workflow";

export interface Env {
  TRADING_AGENT: DurableObjectNamespace<TradingAgent>;
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
  async startWatchlistAnalysis() {
    return await this.runWorkflow("WATCHLIST_ANALYSIS_WORKFLOW", {});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Manual triggers for testing

    if (url.pathname === "/test-analysis") {
      const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
      await agent.startWatchlistAnalysis();
      return new Response("✅ Watchlist analysis started. Check Telegram!", { headers: { "Content-Type": "text/plain" } });
    }


    return (await routeAgentRequest(request, env)) || new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));

    await agent.startWatchlistAnalysis();
  }
};

export { WatchlistAnalysisWorkflow };
