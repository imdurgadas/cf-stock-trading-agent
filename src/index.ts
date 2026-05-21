import { Agent, callable, routeAgentRequest } from "agents";
import { TradingWorkflow, WatchlistAnalysisWorkflow } from "./workflow";
import * as KitePkg from "kiteconnect";
const KiteConnect = (KitePkg as any).KiteConnect || (KitePkg as any).default?.KiteConnect || KitePkg;

// Helper to escape special Markdown characters (*, _, `) in dynamic text fields to prevent Telegram parsing errors
function escapeMarkdown(text: any): string {
  if (text === undefined || text === null) return "N/A";
  return String(text)
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\` ");
}

// Helper to escape special HTML characters (<, >, &) in dynamic text fields to prevent Telegram HTML parsing errors
function escapeHtml(text: any): string {
  if (text === undefined || text === null) return "N/A";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Helper to abbreviate mutual fund names to a readable 12-character string for monospace tables
function abbreviateName(name: string): string {
  let clean = name.replace(/(Direct|Plan|Growth|Option|Mutual|Asset|Passive|Index|LargeMidcap|Scheme|Fund|Active|Flexi|Cap|Tax|Saver|Bluechip|ELSS)/gi, "").trim();
  clean = clean.replace(/\s+/g, " ");
  return clean.slice(0, 12).trim();
}

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
  AI: any;
}

export class TradingAgent extends Agent<Env> {
  private kite: any = null;
  private mcpServerId: string | null = null;

  async onStart() {
    // Connect to the MCP server on startup
    const { id } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    this.mcpServerId = id;
  }

  private async getMcpServerId(): Promise<string> {
    if (this.mcpServerId) {
      return this.mcpServerId;
    }
    const { id } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    this.mcpServerId = id;
    await this.mcp.waitForConnections();
    return id;
  }

  async initKite() {
    if (this.kite) {
      // Check for memory-cached expiry
      const expiry = await this.ctx.storage.get<number>("kite_token_expiry");
      if (expiry && Date.now() > expiry) {
        console.warn("[Agent] Kite session expired (45-minute TTL).");
        this.kite = null;
        await this.ctx.storage.delete("kite_access_token");
        await this.ctx.storage.delete("kite_token_expiry");
      } else {
        return this.kite;
      }
    }
    
    console.info("[Agent] Initializing Kite SDK...");
    const accessToken = await this.ctx.storage.get<string>("kite_access_token");
    const expiry = await this.ctx.storage.get<number>("kite_token_expiry");

    // Enforce 45-minute expiry
    if (accessToken && expiry && Date.now() > expiry) {
      console.warn("[Agent] Kite session expired (45-minute TTL). Cleaning up...");
      await this.ctx.storage.delete("kite_access_token");
      await this.ctx.storage.delete("kite_token_expiry");
      return new (KiteConnect as any)({ api_key: this.env.KITE_API_KEY });
    }

    try {
      this.kite = new (KiteConnect as any)({
        api_key: this.env.KITE_API_KEY
      });

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

    const serverId = await this.getMcpServerId();

    // 1. Get all symbols from all watchlists
    const watchlistResult = await this.mcp.callTool({
      serverId,
      name: "get_watchlist",
      arguments: { category: "ALL" }
    });
    if (watchlistResult.isError) throw new Error("MCP Watchlist Retrieval Error");
    const watchlists = JSON.parse((watchlistResult as any).content[0].text);
    
    // 2. Flatten unique symbols
    const allSymbols = new Set<string>();
    for (const key of Object.keys(watchlists)) {
      if (Array.isArray(watchlists[key])) {
        for (const sym of watchlists[key]) {
          allSymbols.add(sym);
        }
      }
    }

    // 3. Find opportunities across all watchlists combined
    const result = await this.mcp.callTool({
      serverId,
      name: "find_buy_opportunities",
      arguments: {
        ...criteria,
        symbols: Array.from(allSymbols)
      }
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
        const cleanSymbol = opportunity.symbol.split(".")[0];
        const orderId = await kite.placeOrder("regular", {
          exchange: "NSE",
          tradingsymbol: cleanSymbol,
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
      
      // Set 45-minute expiry
      const expiry = Date.now() + (45 * 60 * 1000);
      await this.ctx.storage.put("kite_access_token", response.access_token);
      await this.ctx.storage.put("kite_token_expiry", expiry);
      
      this.kite = kite;
      this.kite.setAccessToken(response.access_token);
      return { status: "success", user: response.user_name };
    } catch (err: any) {
      throw new Error(`Failed to generate Kite session: ${err.message}`);
    }
  }


  @callable()
  async getWatchlistAnalysis(symbols: string[]) {
    const serverId = await this.getMcpServerId();

    const result = await this.mcp.callTool({
      serverId,
      name: "analyze_multiple_stocks",
      arguments: { symbols }
    });

    if (result.isError) throw new Error("MCP Analysis Tool Error");
    return JSON.parse((result as any).content[0].text);
  }

  @callable()
  async getWatchlist(category: string) {
    const serverId = await this.getMcpServerId();

    const result = await this.mcp.callTool({
      serverId,
      name: "get_watchlist",
      arguments: { category }
    });

    if (result.isError) throw new Error("MCP get_watchlist Tool Error");
    const textContent = (result as any).content[0].text;
    const parsed = JSON.parse(textContent);
    return category === "ALL" ? parsed : parsed.symbols;
  }

  @callable()
  async generateAiAnalysisSummary(stockData: any[], contextName: string): Promise<string> {
    if (!this.env.AI) {
      console.warn("[Agent] AI binding is missing from env!");
      return "⚠️ Cloudflare Workers AI binding is not configured.";
    }

    const today = new Date().toISOString().split("T")[0];
    const safeContext = contextName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const cacheKey = `ai_cache_v3:stock:${safeContext}:${today}`;

    try {
      const cached = await this.ctx.storage.get<string>(cacheKey);
      if (cached) {
        console.info(`[Agent] Returning cached AI report for ${cacheKey}`);
        return cached.replace(/\$/g, "₹");
      }
    } catch (cacheErr: any) {
      console.warn(`[Agent] Cache read failed:`, cacheErr.message);
    }

    // Sort stockData: largest drop first
    const sortedData = [...stockData].sort((a, b) => (a.fall_pct || 0) - (b.fall_pct || 0));

    // Limit elements to prevent large tokens payload and potential worker timeouts
    const slicedData = sortedData.slice(0, 6).map(stock => ({
      symbol: stock.symbol,
      name: stock.name,
      price: stock.ltp,
      change: stock.fall_pct,
      quantity: stock.quantity,
      average_price: stock.average_price,
      pnl: stock.pnl,
      rsi: stock.rsi,
      adx: stock.adx,
      ema20_above: stock.price_above_ema20,
      ema50_above: stock.price_above_ema50,
      crossover: stock.is_ema_bullish_crossover,
      macd_bullish: stock.is_macd_bullish,
      bb_oversold: stock.is_near_bb_lower,
      volume_surge: stock.is_volume_surge
    }));

    const systemPrompt = `You are an elite high-conviction financial analyst and professional trading advisor.
Your job is to analyze technical indicators for a list of stocks/ETFs and output a structured JSON report.
You MUST output ONLY a valid JSON object matching the schema below. Do NOT include any markdown block formatting, code block backticks (like \`\`\`json), or conversational text. Output ONLY the raw JSON string.
Formatting constraints:
- Do NOT use double underscores (__text__) or HTML underline tags (<u>) anywhere.
- If you wish to emphasize words, use standard single asterisks (*bold*) for bolding.
- All monetary/currency references MUST be in Indian Rupees (INR / ₹). Do NOT use US Dollars ($). Ensure you write prices with prefix '₹' or suffix 'INR' (e.g. ₹110 instead of $110).

Schema:
{
  "portfolio_summary": "A brief 2-3 sentence overview of overall portfolio health and asset trend.",
  "assets": {
    "<SYMBOL>": {
      "recommendation": "BUY" | "HOLD" | "SELL",
      "actionable_insight": "A concise 3-4 sentence analysis paragraph detailing key momentum drivers (RSI, crossover, volume) or risk breakdown. If recommendation is HOLD, suggest a realistic, strategic target sell price based on current price, indicators, and moving averages, and briefly explain why."
    }
  }
}`;

    let portfolioTotals = null;
    if (contextName.toLowerCase().includes("portfolio")) {
      let totalInvested = 0;
      let totalCurrent = 0;
      for (const item of stockData) {
        const qty = item.quantity || 0;
        const avg = item.average_price || 0;
        const ltp = item.ltp || item.price || 0;
        totalInvested += qty * avg;
        totalCurrent += qty * ltp;
      }
      const totalPnL = totalCurrent - totalInvested;
      const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
      portfolioTotals = {
        total_invested: totalInvested,
        total_current_value: totalCurrent,
        net_returns: totalPnL,
        net_returns_pct: totalPnLPct
      };
    }

    const userPrompt = `Here is the technical indicator dataset for the "${contextName}":
${portfolioTotals ? `Overall Portfolio Totals:\n${JSON.stringify(portfolioTotals, null, 2)}\n\n` : ""}
Asset Details:\n${JSON.stringify(slicedData, null, 2)}

Provide the premium executive AI analysis report.`;

    try {
      console.info(`[Agent] Calling Workers AI (Llama 3.2 3B) for ${contextName}...`);
      const response = await this.env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 2048
      });
      console.info("[Agent] Workers AI returned a response.");
      
      let resultText: string = "";
      if (typeof response === "string") {
        resultText = response;
      } else if (response && typeof response === "object") {
        const respObj = response as any;
        if (respObj.choices && Array.isArray(respObj.choices) && respObj.choices[0]?.message?.content) {
          resultText = respObj.choices[0].message.content;
        } else if (respObj.result && typeof respObj.result.response === "string") {
          resultText = respObj.result.response;
        } else if (typeof respObj.response === "string") {
          resultText = respObj.response;
        } else if (typeof respObj.text === "string") {
          resultText = respObj.text;
        } else if (typeof respObj.text === "function") {
          resultText = await respObj.text();
        } else {
          resultText = JSON.stringify(response);
        }
      } else {
        resultText = "No response received from AI agent.";
      }

      if (resultText) {
        resultText = resultText.replace(/\$/g, "₹");
      }
      
      if (resultText && !resultText.startsWith("❌") && !resultText.startsWith("⚠️")) {
        try {
          await this.ctx.storage.put(cacheKey, resultText);
          console.info(`[Agent] Cached AI report under ${cacheKey}`);
          
          // Cleanup old keys
          const allKeys = await this.ctx.storage.list({ prefix: "ai_cache_v3:" });
          for (const [key] of allKeys) {
            if (!key.endsWith(`:${today}`)) {
              await this.ctx.storage.delete(key);
              console.info(`[Agent] Deleted stale cache key: ${key}`);
            }
          }
        } catch (cacheErr: any) {
          console.warn(`[Agent] Cache write/cleanup failed:`, cacheErr.message);
        }
      }

      return resultText;
    } catch (err: any) {
      console.error("[Agent] Workers AI run failed:", err.message);
      return `❌ Failed to generate AI analysis: ${err.message}`;
    }
  }

  @callable()
  async generateMFAiAnalysisSummary(mfData: any[], contextName: string): Promise<string> {
    if (!this.env.AI) {
      console.warn("[Agent] AI binding is missing from env!");
      return "⚠️ Cloudflare Workers AI binding is not configured.";
    }

    const today = new Date().toISOString().split("T")[0];
    const safeContext = contextName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const cacheKey = `ai_cache_v3:mf:${safeContext}:${today}`;

    try {
      const cached = await this.ctx.storage.get<string>(cacheKey);
      if (cached) {
        console.info(`[Agent] Returning cached AI report for ${cacheKey}`);
        return cached.replace(/\$/g, "₹");
      }
    } catch (cacheErr: any) {
      console.warn(`[Agent] Cache read failed:`, cacheErr.message);
    }

    // Sort mutual funds: cagr_3y descending
    const sortedMFData = [...mfData].sort((a, b) => {
      const returnsA = a.returns || a.mcpAnalysis?.returns || {};
      const returnsB = b.returns || b.mcpAnalysis?.returns || {};
      const cagrA = returnsA.trailing_3y_cagr || returnsA.trailing_1y_cagr || 0;
      const cagrB = returnsB.trailing_3y_cagr || returnsB.trailing_1y_cagr || 0;
      return cagrB - cagrA;
    });

    // Map mutual fund data to a compact object for prompt efficiency (limit to top 5)
    const mappedData = sortedMFData.slice(0, 5).map(item => {
      const isWatchlist = item.meta !== undefined;
      const meta = isWatchlist ? item.meta : item;
      const returns = item.returns || {};
      const risk = item.risk_metrics || {};
      const mcpReturns = item.mcpAnalysis?.returns || {};
      const mcpRisk = item.mcpAnalysis?.risk_metrics || {};

      return {
        name: meta.scheme_name || item.name,
        code: meta.scheme_code || item.schemeCode,
        house: meta.fund_house || item.fundHouse,
        quantity: item.quantity,
        average_price: item.average_price,
        last_price: item.last_price,
        invested_value: item.quantity && item.average_price ? (item.quantity * item.average_price) : undefined,
        current_value: item.quantity && item.last_price ? (item.quantity * item.last_price) : undefined,
        pnl: item.pnl,
        pnl_pct: item.pnl_pct || (item.average_price && item.average_price > 0 && item.last_price ? ((item.last_price - item.average_price) / item.average_price * 100) : undefined),
        cagr_1y: returns.trailing_1y_cagr || mcpReturns.trailing_1y_cagr,
        cagr_3y: returns.trailing_3y_cagr || mcpReturns.trailing_3y_cagr,
        sharpe: risk.sharpe_ratio || mcpRisk.sharpe_ratio,
        sortino: risk.sortino_ratio || mcpRisk.sortino_ratio,
        volatility: risk.annualized_volatility_pct || mcpRisk.annualized_volatility_pct
      };
    });

    const systemPrompt = `You are an elite mutual fund expert, portfolio strategist, and professional financial advisor.
Your job is to analyze risk/reward metrics (CAGR returns, Sharpe/Sortino ratios, Volatility) for mutual funds and output a structured JSON report.
You MUST output ONLY a valid JSON object matching the schema below. Do NOT include any markdown block formatting, code block backticks (like \`\`\`json), or conversational text. Output ONLY the raw JSON string.
Formatting constraints:
- Do NOT use double underscores (__text__) or HTML underline tags (<u>) anywhere.
- If you wish to emphasize words, use standard single asterisks (*bold*) for bolding.
- All monetary/currency references MUST be in Indian Rupees (INR / ₹). Do NOT use US Dollars ($). Ensure you write prices with prefix '₹' or suffix 'INR' (e.g. ₹110 instead of $110).

Schema:
{
  "portfolio_summary": "A brief 2-3 sentence overview of overall portfolio health and fund metrics trend.",
  "assets": {
    "<NAME_OR_CODE>": {
      "recommendation": "BUY" | "HOLD" | "SELL",
      "actionable_insight": "A concise 3-4 sentence analysis paragraph detailing key risk/reward drivers (Sharpe ratio, Sortino ratio, CAGR relative to volatility). If recommendation is HOLD, suggest under what conditions to sell/switch or what strategic performance parameters to track."
    }
  }
}`;

    let portfolioTotals = null;
    if (contextName.toLowerCase().includes("portfolio")) {
      let totalInvested = 0;
      let totalCurrent = 0;
      for (const item of mfData) {
        const qty = item.quantity || 0;
        const avg = item.average_price || 0;
        const ltp = item.last_price || 0;
        totalInvested += qty * avg;
        totalCurrent += qty * ltp;
      }
      const totalPnL = totalCurrent - totalInvested;
      const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
      portfolioTotals = {
        total_invested: totalInvested,
        total_current_value: totalCurrent,
        net_returns: totalPnL,
        net_returns_pct: totalPnLPct
      };
    }

    const userPrompt = `Here is the mutual fund performance dataset for the "${contextName}":
${portfolioTotals ? `Overall Portfolio Totals:\n${JSON.stringify(portfolioTotals, null, 2)}\n\n` : ""}
Fund Details:\n${JSON.stringify(mappedData, null, 2)}

Provide the premium AI portfolio analyst report.`;

    try {
      console.info(`[Agent] Calling Workers AI (Llama 3.2 3B) for Mutual Funds: ${contextName}...`);
      const response = await this.env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 2048
      });
      console.info("[Agent] Workers AI returned a response for Mutual Funds.");
      
      let resultText: string = "";
      if (typeof response === "string") {
        resultText = response;
      } else if (response && typeof response === "object") {
        const respObj = response as any;
        if (respObj.choices && Array.isArray(respObj.choices) && respObj.choices[0]?.message?.content) {
          resultText = respObj.choices[0].message.content;
        } else if (respObj.result && typeof respObj.result.response === "string") {
          resultText = respObj.result.response;
        } else if (typeof respObj.response === "string") {
          resultText = respObj.response;
        } else if (typeof respObj.text === "string") {
          resultText = respObj.text;
        } else if (typeof respObj.text === "function") {
          resultText = await respObj.text();
        } else {
          resultText = JSON.stringify(response);
        }
      } else {
        resultText = "No response received from AI agent.";
      }

      if (resultText) {
        resultText = resultText.replace(/\$/g, "₹");
      }

      if (resultText && !resultText.startsWith("❌") && !resultText.startsWith("⚠️")) {
        try {
          await this.ctx.storage.put(cacheKey, resultText);
          console.info(`[Agent] Cached AI report under ${cacheKey}`);
          
          // Cleanup old keys
          const allKeys = await this.ctx.storage.list({ prefix: "ai_cache_v3:" });
          for (const [key] of allKeys) {
            if (!key.endsWith(`:${today}`)) {
              await this.ctx.storage.delete(key);
              console.info(`[Agent] Deleted stale cache key: ${key}`);
            }
          }
        } catch (cacheErr: any) {
          console.warn(`[Agent] Cache write/cleanup failed:`, cacheErr.message);
        }
      }

      return resultText;
    } catch (err: any) {
      console.error("[Agent] Workers AI MF run failed:", err.message);
      return `❌ Failed to generate AI Mutual Fund analysis: ${err.message}`;
    }
  }

  @callable()
  async logFromWorkflow(msg: string) {
    console.info(`[Workflow Log] ${msg}`);
    return { status: "ok" };
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
  async getKiteHoldings() {
    const kite = await this.initKite();
    if (!kite.access_token) {
      throw new Error("Kite session expired or disconnected. Please login first.");
    }
    return await kite.getHoldings();
  }

  @callable()
  async getMutualFundHoldings() {
    const kite = await this.initKite();
    if (!kite.access_token) {
      throw new Error("Kite session expired or disconnected. Please login first.");
    }
    return await kite.getMFHoldings();
  }

  async getAvailableBalance(): Promise<string> {
    const isMock = await this.ctx.storage.get<boolean>("current_run_mock");
    if (isMock) {
      return "₹10,000.00 (Mock Account)";
    }

    try {
      const kite = await this.initKite();
      if (!kite.access_token) {
        return "Unknown (Kite Session Expired)";
      }

      const margins = await kite.getMargins();
      if (margins && margins.equity) {
        const netBalance = margins.equity.net;
        const availableCash = margins.equity.available?.cash;
        const balance = availableCash !== undefined ? availableCash : netBalance;
        return `₹${Number(balance).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      return "Unknown (No Equity Margin Data)";
    } catch (err: any) {
      console.error("[Agent] Failed to fetch Kite margins:", err.message);
      return "Unknown (Error fetching balance)";
    }
  }

  @callable()
  async handleTelegramUpdate(update: any) {
    // 0. Handle Callback Query (for Carousel Pagination)
    if (update.callback_query) {
      const cbQuery = update.callback_query;
      const callbackData = cbQuery.data;
      const messageId = cbQuery.message?.message_id;
      const chatId = cbQuery.message?.chat?.id;

      if (String(chatId) !== String(this.env.TELEGRAM_CHAT_ID)) return;

      const { answerTelegramCallback } = await import("./notifications");
      await answerTelegramCallback(cbQuery.id, this.env.TELEGRAM_BOT_TOKEN);

      if (callbackData && callbackData.startsWith("slide:")) {
        const parts = callbackData.split(":");
        const type = parts[1]; // "stock" | "mf"
        const slideIndex = parseInt(parts[2], 10);
        
        await this.handleSlideNavigation(chatId, messageId, type, slideIndex);
      }
      return;
    }

    const rawText = update.message?.text?.toLowerCase()?.trim();
    const chatId = update.message?.chat?.id;

    if (!rawText || String(chatId) !== String(this.env.TELEGRAM_CHAT_ID)) return;

    // Strip leading slash if present to make command routing resilient and clean
    const text = rawText.startsWith("/") ? rawText.slice(1) : rawText;

    // Check if we were waiting for a stock symbol for analysis.
    // If the input is NOT another command, we treat it as a symbol.
    const waitingForAnalyze = await this.ctx.storage.get<boolean>("waiting_for_analyze_symbol");
    if (waitingForAnalyze) {
      const isCommand = rawText.startsWith("/") || [
        "kite_login", "login", "kite_holdings", "holdings", "mock holdings",
        "mf", "mf holdings", "mock mf", "etf_analyze", "do analysis", "watchlist analysis",
        "it_analyze", "bank_analyze", "energy_analyze", "potential_analyze",
        "kite_analyze", "stock_analyze", "analyze_holdings", "mf_analyze", "analyze mf",
        "mf_watchlist", "mf_search", "search_mf", "search mf", "guidelines", "guide", "help",
        "kite_trade", "trade", "yes", "no", "analyze"
      ].some(cmd => text.startsWith(cmd));

      await this.ctx.storage.delete("waiting_for_analyze_symbol");
      if (!isCommand) {
        const symbol = text.toUpperCase().trim();
        await this.handleSingleStockAnalysis(symbol);
        return;
      }
    }

    // 1. Command: Kite Login
    if (text === "kite_login" || text === "kite login" || text === "login") {
      const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
      await this.sendBotMessage(`🔗 *Kite Login*: [Click here to login and authenticate](${loginUrl})\n\n💡 _Note: Sessions expire in 45 minutes for security._`);
      return;
    }

    // 2. Command: Get Kite Equity Holdings (Live or Mock)
    if (
      text === "kite_holdings" ||
      text === "get kite holdings" ||
      text === "kite holdings" ||
      text === "holdings" ||
      text === "mock holdings"
    ) {
      const useMock = text.includes("mock");
      await this.handleGetKiteHoldings(useMock);
      return;
    }

    // 3. Command: Get Mutual Fund Holdings (Live or Mock)
    if (
      text === "mf" ||
      text === "get mutual fund holdings" ||
      text === "mutual fund holdings" ||
      text === "get mf holdings" ||
      text === "mf holdings" ||
      text === "mock mf"
    ) {
      const useMock = text.includes("mock");
      await this.handleGetMFHoldings(useMock);
      return;
    }

    // 4. Command: Do ETF Watchlist Technical Analysis (No Kite Session Required!)
    if (
      text === "etf_analyze" ||
      text === "do analysis" ||
      text === "analyze watchlists" ||
      text === "watchlist analysis"
    ) {
      await this.sendBotMessage("🔍 *ETF Watchlist Technical Scan Started*...");
      await this.startWatchlistAnalysis();
      return;
    }

    // New Command: /analyze <symbol> or /analyze
    if (text === "analyze" || text.startsWith("analyze ")) {
      const parts = text.split(/\s+/);
      if (parts.length > 1 && parts[1].trim()) {
        const symbol = parts[1].toUpperCase().trim();
        await this.handleSingleStockAnalysis(symbol);
      } else {
        await this.ctx.storage.put("waiting_for_analyze_symbol", true);
        await this.sendBotMessage("🔍 *Stock Analysis*\n\nWhich stock would you like to analyze? Please reply with the stock symbol (e.g., `INFY`, `TCS`, or `RELIANCE`).");
      }
      return;
    }

    // New Watchlist Sector Commands
    if (text === "it_analyze" || text === "analyze it" || text === "analyze_it") {
      await this.handleSectorAnalysis("IT");
      return;
    }
    if (text === "bank_analyze" || text === "analyze bank" || text === "analyze_bank") {
      await this.handleSectorAnalysis("BANK");
      return;
    }
    if (text === "energy_analyze" || text === "analyze energy" || text === "analyze_energy") {
      await this.handleSectorAnalysis("ENERGY");
      return;
    }
    if (text === "potential_analyze" || text === "analyze potential" || text === "analyze_potential") {
      await this.handleSectorAnalysis("POTENTIAL");
      return;
    }

    // 5. Command: Do Technical Analysis of Kite Holdings (Kite Session Required)
    if (
      text === "kite_analyze" ||
      text === "stock_analyze" ||
      text === "analyze holdings" ||
      text === "analyze_holdings" ||
      text === "analyze_kite_holdings" ||
      text === "mock analyze holdings" ||
      text === "mock analyze"
    ) {
      const useMock = text.includes("mock");
      await this.handleAnalyzeHoldings(useMock);
      return;
    }

    // 6. Command: Do Mutual Fund Portfolio Diversification Analysis (Live or Mock)
    if (
      text === "mf_analyze" ||
      text === "analyze mf" ||
      text === "analyze_mf" ||
      text === "mf_analysis" ||
      text === "mock analyze mf"
    ) {
      const useMock = text.includes("mock");
      await this.handleAnalyzeMFHoldings(useMock);
      return;
    }

    // New Command: Deep Technical Analysis of Mutual Fund Watchlist
    if (
      text === "mf_watchlist" ||
      text === "mf watchlist" ||
      text === "analyze mf watchlist" ||
      text === "analyze_mf_watchlist"
    ) {
      await this.handleAnalyzeMFWatchlist();
      return;
    }

    // New AMFI Wildcard Mutual Fund Search Command
    if (
      text === "mf_search" ||
      text.startsWith("mf_search ") ||
      text === "search_mf" ||
      text.startsWith("search_mf ") ||
      text === "search mf" ||
      text.startsWith("search mf ")
    ) {
      const query = text.replace(/^(mf_search|search_mf|search mf)\s*/, "").trim();
      if (!query) {
        await this.sendBotMessage("🔍 *Mutual Fund Search*\n\n⚠️ Please provide a fund name or house query, e.g.:\n• `mf_search Mirae`\n• `mf_search Parag Parikh`\n• `mf_search Quant`\n• `mf_search Zerodha`\n\n💡 _This searches 17,000+ mutual fund plans on AMFI in real-time, focusing on Direct Growth plans!_");
        return;
      }
      await this.handleSearchMF(query);
      return;
    }

    // New Command: /guidelines
    if (text === "guidelines" || text === "guide" || text === "help") {
      let guide = `📘 <b>Trading Agent Technical Guidelines</b>\n\n`;
      guide += `📈 <b>Stocks & ETFs Technical Indicators</b>\n`;
      guide += `• <b>RSI (Relative Strength Index)</b>: Momentum scale. Below 30 is deep value / oversold (potential BUY); above 70 is overbought (potential SELL).\n`;
      guide += `• <b>ADX (Average Directional Index)</b>: Trend strength. Above 25 indicates a strong, high-conviction trend (up or down).\n`;
      guide += `• <b>EMA 20/50 Crossover</b>: A 20-day EMA moving above a 50-day EMA is a high-conviction 🚀 Bullish Crossover (key trend reversal signal).\n`;
      guide += `• <b>MACD Bullish</b>: Signals when short-term momentum shifts positive relative to the long-term trend.\n`;
      guide += `• <b>Bollinger Bands (BB Lower)</b>: Touching the lower band indicates a price dip / mean-reversion entry zone.\n`;
      guide += `• <b>Volume Surge</b>: Trading volume &gt;50% above the 20-day average, signaling institutional accumulation.\n\n`;
      guide += `📊 <b>Mutual Funds Risk & Return Metrics</b>\n`;
      guide += `• <b>CAGR (1Y/3Y)</b>: Compound Annual Growth Rate. Trailing returns over 1 and 3 years (Ideal is &gt;12%).\n`;
      guide += `• <b>Sharpe Ratio</b>: Return earned per unit of risk. <b>Ideal &gt;1.0</b>. Higher means smarter risk management.\n`;
      guide += `• <b>Sortino Ratio</b>: Return against bad/downside drops. <b>Ideal &gt;1.5</b>. Higher means superior downside crash protection.\n`;
      guide += `• <b>Volatility</b>: Fluctuation scale. <b>Ideal &lt;15%</b>. Lower means a smoother, more stable journey.\n`;
      guide += `• <b>AMFI Rating / Grade</b>: Rating (EXCELLENT, GOOD, AVERAGE, POOR) based on performance against peers.\n\n`;
      guide += `💡 <i>Use "/kite_analyze" or "/mf_analyze" to get premium AI reviews incorporating these indicators!</i>`;
      
      await this.sendBotHtmlMessage(guide);
      return;
    }

    // Help for trade command if run without arguments
    if (text === "kite_trade" || text === "trade") {
      await this.sendBotMessage("🛒 *Manual Trade Command*\n\n⚠️ Please specify the amount or symbol, e.g.:\n• `kite_trade 5000` (to buy active watchlist opportunities)\n• `kite_trade INFY 5000` (to buy a specific stock)");
      return;
    }

    // 5. Handle "kite_trade <symbol> <amount>" or "kite_trade <amount>" (also matches legacy "trade")
    const tradeSymbolMatch = text.match(/^(kite_trade|trade)\s+([a-zA-Z0-9\.\-_]+)\s+(\d+)$/);
    const tradeAmountMatch = text.match(/^(kite_trade|trade)\s+(\d+)$/);

    if (tradeSymbolMatch) {
      const symbol = tradeSymbolMatch[2].toUpperCase();
      const amount = parseInt(tradeSymbolMatch[3]);
      
      await this.ctx.storage.put("pending_amount", amount);
      await this.ctx.storage.put("pending_symbol", symbol);

      const balanceStr = await this.getAvailableBalance();
      await this.sendBotMessage(`⚠️ *Confirmation*: Buy *${symbol}* for ₹${amount}?\n💰 *Available Balance*: ${balanceStr}\n\nReply "yes" to confirm or "no" to cancel.`);
      return;
    } else if (tradeAmountMatch) {
      const amount = parseInt(tradeAmountMatch[1]);
      await this.ctx.storage.put("pending_amount", amount);
      await this.ctx.storage.delete("pending_symbol"); // Clear any specific symbol

      const opportunities = await this.ctx.storage.get<any[]>("last_opportunities");
      if (!opportunities || opportunities.length === 0) {
        await this.sendBotMessage("No pending opportunities found. Please wait for the next scan. To trade a specific stock, use `kite_trade <symbol> <amount>`.");
        return;
      }

      const symbols = opportunities.map(o => o.symbol).join(", ");
      const balanceStr = await this.getAvailableBalance();
      await this.sendBotMessage(`⚠️ *Confirmation*: Buy ${symbols} for ₹${amount}?\n💰 *Available Balance*: ${balanceStr}\n\nReply "yes" to confirm or "no" to cancel.`);
      return;
    }

    // 6. Handle "yes" confirmation
    if (text === "yes") {
      const amount = await this.ctx.storage.get<number>("pending_amount");
      const workflowId = await this.ctx.storage.get<string>("pending_workflow_id");

      if (!amount || !workflowId) {
        await this.sendBotMessage("Nothing to confirm. Use `kite_trade <amount>` or `kite_trade <symbol> <amount>` first.");
        return;
      }

      await this.sendBotMessage("🚀 *Executing...*");
      await this.approveWorkflow(workflowId);
      // Clean up
      await this.ctx.storage.delete("pending_amount");
      return;
    }

    // 7. Handle "no" cancellation
    if (text === "no") {
      await this.ctx.storage.delete("pending_amount");
      await this.ctx.storage.delete("pending_symbol");
      await this.sendBotMessage("❌ Trade cancelled.");
      return;
    }
  }

  private async handleGetKiteHoldings(useMock: boolean) {
    let holdings: any[] = [];
    if (useMock) {
      holdings = this.getMockHoldings();
    } else {
      try {
        holdings = await this.getKiteHoldings();
      } catch (err: any) {
        console.error("Failed to fetch holdings:", err.message);
        const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
        await this.sendBotMessage(`⚠️ *Kite Session Expired/Disconnected*\n\nCould not fetch holdings. Please login first:\n🔗 [Login to Kite](${loginUrl})\n\n💡 _Or type "mock holdings" to see a demo._`);
        return;
      }
    }

    if (!holdings || holdings.length === 0) {
      await this.sendBotMessage("📭 Your Kite account has no active equity holdings.");
      return;
    }

    // Filter valid holdings
    const validHoldings = holdings.filter(h => {
      const qty = (h.quantity || 0) + (h.t1_quantity || 0);
      return qty > 0;
    });

    let totalInvested = 0;
    let totalCurrent = 0;

    // Precalculate totals
    for (const h of validHoldings) {
      const qty = (h.quantity || 0) + (h.t1_quantity || 0);
      const avg = h.average_price || 0;
      const ltp = h.last_price || 0;
      totalInvested += qty * avg;
      totalCurrent += qty * ltp;
    }

    // 1. Send Header
    await this.sendBotHtmlMessage(`📊 <b>Kite Equity Holdings</b>`);

    // 2. Send Stock Items in chunks of 5
    const CHUNK_SIZE = 5;
    for (let i = 0; i < validHoldings.length; i += CHUNK_SIZE) {
      const chunk = validHoldings.slice(i, i + CHUNK_SIZE);
      let chunkMsg = "";

      for (const h of chunk) {
        const qty = (h.quantity || 0) + (h.t1_quantity || 0);
        const avg = h.average_price || 0;
        const ltp = h.last_price || 0;
        const invested = qty * avg;
        const current = qty * ltp;
        const pnl = h.pnl !== undefined ? h.pnl : (current - invested);
        const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

        const trend = pnl >= 0 ? "🟢" : "🔴";
        const sign = pnl >= 0 ? "+" : "";

        const symbol = escapeHtml(h.tradingsymbol);
        const exchange = escapeHtml(h.exchange || "NSE");

        chunkMsg += `• <b>${symbol}</b> (${exchange})\n`;
        chunkMsg += `  Qty: ${qty} | Avg: ₹${avg.toFixed(2)}\n`;
        chunkMsg += `  LTP: ₹${ltp.toFixed(2)} | Val: ₹${current.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
        chunkMsg += `  P&L: <b>${trend} ${sign}₹${pnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> (${sign}${pnlPct.toFixed(2)}%)\n\n`;
      }

      if (chunkMsg.trim()) {
        await this.sendBotHtmlMessage(chunkMsg);
      }
    }

    const totalPnL = totalCurrent - totalInvested;
    const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const totalTrend = totalPnL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPnL >= 0 ? "+" : "";

    // 3. Send Portfolio Summary
    let summaryMsg = `\n`;
    summaryMsg += `💰 <b>Total Invested</b>: ₹${totalInvested.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    summaryMsg += `📈 <b>Current Value</b>: ₹${totalCurrent.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    summaryMsg += `📊 <b>Total P&L</b>: <b>${totalTrend} ${totalSign}₹${totalPnL.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> (${totalSign}${totalPnLPct.toFixed(2)}%)`;
    
    if (useMock) {
      summaryMsg += `\n\n⚠️ <i>This is a Mock Account demo.</i>`;
    }

    await this.sendBotHtmlMessage(summaryMsg);
  }

  private async enrichMFHoldings(holdings: any[]): Promise<any[]> {
    const getFundHouseFromSchemeName = (schemeName: string): string => {
      const name = schemeName.trim();
      const houses = [
        "Parag Parikh", "PPFAS", "Mirae Asset", "Mirae", "SBI", "HDFC", "ICICI Prudential", "ICICI",
        "Axis", "Kotak", "Tata", "Nippon India", "Nippon", "Quant", "UTI", "DSP", "Motilal Oswal",
        "Bandhan", "Canara Robeco", "Canara", "Franklin Templeton", "Franklin", "HSBC", "Invesco",
        "LIC", "PGIM India", "PGIM", "Sundaram", "Union", "Zerodha", "Mahindra Manulife", "Mahindra",
        "Navi", "WhiteOak Capital", "WhiteOak", "Shriram", "Groww", "Quantum", "Taurus", "JM Financial", "JM"
      ];
      for (const house of houses) {
        if (name.toLowerCase().startsWith(house.toLowerCase())) {
          if (house === "PPFAS" || house === "Parag Parikh") return "Parag Parikh PPFAS";
          if (house === "Mirae" || house === "Mirae Asset") return "Mirae Asset";
          if (house === "ICICI" || house === "ICICI Prudential") return "ICICI Prudential";
          if (house === "Nippon" || house === "Nippon India") return "Nippon India";
          if (house === "Canara" || house === "Canara Robeco") return "Canara Robeco";
          if (house === "Franklin" || house === "Franklin Templeton") return "Franklin Templeton";
          if (house === "PGIM" || house === "PGIM India") return "PGIM India";
          if (house === "Mahindra" || house === "Mahindra Manulife") return "Mahindra Manulife";
          if (house === "WhiteOak" || house === "WhiteOak Capital") return "WhiteOak Capital";
          return house;
        }
      }
      const parts = name.split(/\s+/);
      return parts.slice(0, 2).join(" ");
    };

    const promises = holdings.map(async (h) => {
      const queryName = h.name || h.tradingsymbol || "";
      const cleanName = queryName.replace(/_/g, " ").trim();
      
      if (cleanName.length > 0) {
        try {
          const cached = await this.ctx.storage.get<any>(`mf_isin_mapping:${cleanName}`);
          if (cached) {
            console.debug(`[Enrich] Cache HIT for ${cleanName} -> Scheme Code ${cached.schemeCode}`);
            return {
              ...h,
              name: cached.schemeName,
              schemeCode: cached.schemeCode,
              fundHouse: cached.fundHouse
            };
          }
        } catch (cacheErr: any) {
          console.warn("[Enrich] Cache read failed:", cacheErr.message);
        }
      }

      let schemeCode = null;
      let schemeName = h.name || cleanName;

      if (cleanName.length > 0) {
        const isISIN = cleanName.startsWith("INF") && cleanName.length === 12;
        if (isISIN) {
          try {
            console.debug(`[Enrich] Resolving ISIN ${cleanName} via Stock MCP...`);
            const searchResults = await this.searchMutualFundsMCP(cleanName);
            if (searchResults && searchResults.length > 0) {
              const bestMatch = searchResults[0];
              schemeCode = bestMatch.scheme_code;
              schemeName = bestMatch.scheme_name;
              console.debug(`[Enrich] Resolved ISIN ${cleanName} to Scheme Code ${schemeCode} ("${schemeName}")`);
            }
          } catch (err: any) {
            console.error(`[Enrich] Failed to resolve ISIN ${cleanName} via MCP:`, err.message);
          }
        }

        // Fallback if ISIN resolution failed or wasn't an ISIN
        if (!schemeCode) {
          try {
            const searchRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(cleanName)}`);
            if (searchRes.ok) {
              const searchJson = await searchRes.json() as any[];
              if (searchJson && searchJson.length > 0) {
                // Find the best match containing Direct and Growth
                let bestMatch = searchJson[0];
                for (const match of searchJson) {
                  const matchLower = match.schemeName.toLowerCase();
                  if (matchLower.includes("direct") && matchLower.includes("growth")) {
                    bestMatch = match;
                    break;
                  }
                }
                
                schemeCode = bestMatch.schemeCode;
                schemeName = bestMatch.schemeName;
              }
            }
          } catch (e) {
            console.error(`Error enriching MF holding ${queryName}:`, e);
          }
        }
      }

      const fundHouse = getFundHouseFromSchemeName(schemeName);

      if (cleanName.length > 0 && schemeCode) {
        try {
          await this.ctx.storage.put(`mf_isin_mapping:${cleanName}`, {
            schemeCode,
            schemeName,
            fundHouse
          });
          console.debug(`[Enrich] Saved cache mapping for ${cleanName}`);
        } catch (cacheErr: any) {
          console.warn("[Enrich] Cache write failed:", cacheErr.message);
        }
      }

      return {
        ...h,
        name: schemeName,
        schemeCode: schemeCode || "N/A",
        fundHouse
      };
    });

    return Promise.all(promises);
  }

  private async handleGetMFHoldings(useMock: boolean) {
    let holdings: any[] = [];
    if (useMock) {
      holdings = this.getMockMFHoldings();
    } else {
      try {
        holdings = await this.getMutualFundHoldings();
      } catch (err: any) {
        console.error("Failed to fetch MF holdings:", err.message);
        const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
        await this.sendBotMessage(`⚠️ *Kite Session Expired/Disconnected*\n\nCould not fetch mutual fund holdings. Please login first:\n🔗 [Login to Kite](${loginUrl})\n\n💡 _Or type "mock mf" to see a demo._`);
        return;
      }
    }

    if (!holdings || holdings.length === 0) {
      await this.sendBotMessage("📭 Your Kite account has no active mutual fund holdings.");
      return;
    }

    await this.sendBotMessage(`🔍 *Retrieving Live NAVs & Mutual Fund Details*...`);
    
    // Enrich holdings with name, scheme code, and fund house
    const enriched = await this.enrichMFHoldings(holdings);

    // Filter valid holdings
    const validHoldings = enriched.filter(h => {
      const qty = h.quantity || 0;
      return qty > 0;
    });

    let totalInvested = 0;
    let totalCurrent = 0;

    // Precalculate totals
    for (const h of validHoldings) {
      const qty = h.quantity || 0;
      const avg = h.average_price || 0;
      const ltp = h.last_price || 0;
      totalInvested += qty * avg;
      totalCurrent += qty * ltp;
    }

    // 1. Send Header
    await this.sendBotHtmlMessage(`🌾 <b>Mutual Fund Holdings</b>`);

    // 2. Send MF Items in chunks of 4
    const CHUNK_SIZE = 4;
    for (let i = 0; i < validHoldings.length; i += CHUNK_SIZE) {
      const chunk = validHoldings.slice(i, i + CHUNK_SIZE);
      let chunkMsg = "";

      for (const h of chunk) {
        const qty = h.quantity || 0;
        const avg = h.average_price || 0;
        const ltp = h.last_price || 0; // last NAV
        const invested = qty * avg;
        const current = qty * ltp;
        const pnl = current - invested;
        const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

        const trend = pnl >= 0 ? "🟢" : "🔴";
        const sign = pnl >= 0 ? "+" : "";

        const fundName = escapeHtml(h.name);
        const fundHouse = escapeHtml(h.fundHouse);
        const schemeCode = escapeHtml(h.schemeCode);

        chunkMsg += `• <b>${fundName}</b>\n`;
        chunkMsg += `  House: <i>${fundHouse}</i> | Scheme: <code>${schemeCode}</code>\n`;
        chunkMsg += `  ISIN: ${escapeHtml(h.isin || "N/A")} | Units: ${qty.toFixed(3)}\n`;
        chunkMsg += `  Avg NAV: ₹${avg.toFixed(4)} | Last NAV: ₹${ltp.toFixed(4)}\n`;
        chunkMsg += `  Val: ₹${current.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
        chunkMsg += `  P&L: <b>${trend} ${sign}₹${pnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> (${sign}${pnlPct.toFixed(2)}%)\n\n`;
      }

      if (chunkMsg.trim()) {
        await this.sendBotHtmlMessage(chunkMsg);
      }
    }

    const totalPnL = totalCurrent - totalInvested;
    const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const totalTrend = totalPnL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPnL >= 0 ? "+" : "";

    // 3. Send Portfolio Summary
    let summaryMsg = `\n`;
    summaryMsg += `💰 <b>Total MF Invested</b>: ₹${totalInvested.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    summaryMsg += `📈 <b>Current MF Value</b>: ₹${totalCurrent.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    summaryMsg += `📊 <b>Total MF P&L</b>: <b>${totalTrend} ${totalSign}₹${totalPnL.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> (${totalSign}${totalPnLPct.toFixed(2)}%)`;

    if (useMock) {
      summaryMsg += `\n\n⚠️ <i>This is a Mock Account demo.</i>`;
    }

    await this.sendBotHtmlMessage(summaryMsg);
  }

  private cleanAndParseJSON(text: string): any {
    let cleaned = text.trim();
    // Locate the outermost curly braces to extract raw JSON
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
      // Fallback clean markdown code blocks
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(json)?\n?/, "");
      }
      if (cleaned.endsWith("```")) {
        cleaned = cleaned.replace(/```$/, "");
      }
      cleaned = cleaned.trim();
    }
    return JSON.parse(cleaned);
  }

  private getAiAssetAnalysis(assets: any, identifiers: (string | undefined | null)[]): any {
    if (!assets || typeof assets !== "object") return null;
    
    // Filter out null/undefined/empty identifiers
    const validIds = identifiers
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map(id => id.trim().toLowerCase());
    
    if (validIds.length === 0) return null;

    const keys = Object.keys(assets);
    
    // Helper to normalize strings for comparison (remove spaces, dots, dashes, etc.)
    const normalize = (s: string) => s.replace(/[^a-z0-9]/g, "");

    // 1. Exact match (case insensitive)
    for (const id of validIds) {
      for (const key of keys) {
        if (key.toLowerCase().trim() === id) {
          return assets[key];
        }
      }
    }

    // 2. Suffix/prefix stripping (like removing .NS, .BO, etc.)
    const cleanId = (s: string) => s.replace(/\.(ns|bo)$/, "").trim();
    const cleanIds = validIds.map(cleanId);
    
    for (const cid of cleanIds) {
      for (const key of keys) {
        const cKey = key.toLowerCase().trim().replace(/\.(ns|bo)$/, "");
        if (cKey === cid) {
          return assets[key];
        }
      }
    }

    // 3. Normalization (alphanumeric match)
    const normalizedIds = cleanIds.map(normalize);
    for (const nid of normalizedIds) {
      if (!nid) continue;
      for (const key of keys) {
        const nKey = normalize(key.toLowerCase());
        if (nKey === nid) {
          return assets[key];
        }
      }
    }

    // 4. Substring containment match (only if identifier has reasonable length, e.g. >= 3 chars)
    for (const cid of cleanIds) {
      if (cid.length < 3) continue;
      for (const key of keys) {
        const cKey = key.toLowerCase().trim().replace(/\.(ns|bo)$/, "");
        if (cKey.includes(cid) || cid.includes(cKey)) {
          return assets[key];
        }
      }
    }
    
    // 5. Normalized substring containment match
    for (const nid of normalizedIds) {
      if (nid.length < 3) continue;
      for (const key of keys) {
        const nKey = normalize(key.toLowerCase());
        if (nKey.includes(nid) || nid.includes(nKey)) {
          return assets[key];
        }
      }
    }

    return null;
  }

  private async handleSlideNavigation(chatId: number, messageId: number, type: string, slideIndex: number) {
    let key = "latest_stock_slides";
    if (type === "mf") {
      key = "latest_mf_slides";
    } else if (type.startsWith("watchlist_")) {
      const cat = type.replace("watchlist_", "").toLowerCase();
      key = `latest_watchlist_slides_${cat}`;
    }
    const slides = await this.ctx.storage.get<string[]>(key);
    
    if (!slides || slides.length === 0) {
      const { editTelegramMessage } = await import("./notifications");
      await editTelegramMessage(messageId, "⚠️ *Session Expired*: Please run the analysis command again.", {
        botToken: this.env.TELEGRAM_BOT_TOKEN,
        chatId: String(chatId),
        parseMode: "Markdown"
      });
      return;
    }

    const idx = Math.max(0, Math.min(slideIndex, slides.length - 1));
    const slideText = slides[idx];

    const buttons = [];
    if (idx > 0) {
      buttons.push({ text: "◀️ Prev", callback_data: `slide:${type}:${idx - 1}` });
    }
    buttons.push({ text: `${idx + 1} / ${slides.length}`, callback_data: `dummy` });
    if (idx < slides.length - 1) {
      buttons.push({ text: "Next ▶️", callback_data: `slide:${type}:${idx + 1}` });
    }

    const replyMarkup = {
      inline_keyboard: [buttons]
    };

    const { editTelegramMessage } = await import("./notifications");
    await editTelegramMessage(messageId, slideText, {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: String(chatId),
      parseMode: "Markdown",
      replyMarkup
    });
  }

  private async handleSingleStockAnalysis(symbol: string) {
    let cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) {
      await this.sendBotMessage("⚠️ Stock symbol cannot be empty.");
      return;
    }

    if (!cleanSymbol.includes(".")) {
      cleanSymbol = `${cleanSymbol}.NS`;
    }

    await this.sendBotMessage(`🔍 *Stock Analysis Started*\nAnalyzing *${cleanSymbol}* using technical indicators...`);

    try {
      const analysis = await this.getWatchlistAnalysis([cleanSymbol]);
      if (!analysis || analysis.length === 0) {
        await this.sendBotMessage(`❌ Could not retrieve analysis metrics for *${cleanSymbol}*. Please verify the symbol is correct.`);
        return;
      }

      const stock = analysis[0];
      
      // Fetch AI Analysis
      await this.sendBotMessage("🤖 *AI Analyst starting review...*");
      const aiSummary = await this.generateAiAnalysisSummary([stock], `Stock: ${cleanSymbol}`);
      
      let parsed: any = null;
      try {
        parsed = this.cleanAndParseJSON(aiSummary);
      } catch (e) {
        console.warn("Failed to parse AI summary as JSON for single stock:", e);
      }

      const changeSign = (stock.fall_pct || 0) >= 0 ? '+' : '';
      const rsiVal = stock.rsi ? stock.rsi.toFixed(1) : 'N/A';
      const adxVal = stock.adx ? stock.adx.toFixed(1) : 'N/A';
      const trendStrength = (stock.adx || 0) >= 25 ? 'Strong' : 'Weak';

      const signals = [];
      if (stock.is_ema_bullish_crossover) signals.push('Bullish Crossover 🚀');
      if (stock.is_macd_bullish) signals.push('MACD Bullish 📈');
      if (stock.is_near_bb_lower) signals.push('BB Near Lower Band ⚠️ (Oversold / Price Dip Entry Zone)');
      if (stock.is_volume_surge) signals.push('Volume Surge 🔥');
      if (signals.length === 0) signals.push('None (Neutral)');

      let message = `📈 *Stock Analysis: ${stock.name || cleanSymbol} (${cleanSymbol.replace(".NS", "")})*\n\n`;
      message += `• *LTP*: ₹${stock.ltp || 'N/A'} (${changeSign}${stock.fall_pct?.toFixed(2) || '0.00'}%)\n`;
      message += `• *RSI*: \`${rsiVal}\` | *ADX*: \`${adxVal}\` (${trendStrength} Trend)\n`;
      message += `• *EMA State*: Price is ${stock.price_above_ema20 ? 'Above' : 'Below'} EMA20 & ${stock.price_above_ema50 ? 'Above' : 'Below'} EMA50\n`;
      message += `• *Signals*: ${signals.join(', ')}\n\n`;

      if (parsed && parsed.assets) {
        const aiAsset = this.getAiAssetAnalysis(parsed.assets, [cleanSymbol, cleanSymbol.replace(".NS", "")]) || { recommendation: 'HOLD', actionable_insight: 'No specific AI analysis found.' };
        
        const recEmoji = aiAsset.recommendation === 'BUY' ? '🚀 BUY' : aiAsset.recommendation === 'SELL' ? '🚫 SELL' : '🤔 HOLD';
        message += `*AI Recommendation*: *${recEmoji}*\n`;
        message += `🤖 *AI Outlook*:\n${aiAsset.actionable_insight}`;
      } else {
        message += `🤖 *AI Analysis (Raw)*:\n${aiSummary}`;
      }

      await this.sendBotMessage(message);
    } catch (err: any) {
      console.error(`Failed handleSingleStockAnalysis for ${cleanSymbol}:`, err.message);
      await this.sendBotMessage(`❌ *Analysis Failed*: ${err.message}`);
    }
  }

  private async handleAnalyzeHoldings(useMock: boolean) {
    let holdings: any[] = [];
    if (useMock) {
      holdings = this.getMockHoldings();
    } else {
      try {
        holdings = await this.getKiteHoldings();
      } catch (err: any) {
        console.error("Failed to fetch holdings for analysis:", err.message);
        const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
        await this.sendBotMessage(`⚠️ *Kite Session Expired/Disconnected*\n\nCould not fetch holdings to analyze. Please login first:\n🔗 [Login to Kite](${loginUrl})\n\n💡 _Or type "mock analyze" to see a demo._`);
        return;
      }
    }

    if (!holdings || holdings.length === 0) {
      await this.sendBotMessage("📭 No holdings found to analyze.");
      return;
    }

    // Extract unique symbols and append .NS
    const symbols = holdings
      .map(h => h.tradingsymbol)
      .filter(sym => sym && !sym.startsWith("MOCK"))
      .map(sym => `${sym.toUpperCase()}.NS`);

    const uniqueSymbols = Array.from(new Set(symbols));

    if (uniqueSymbols.length === 0) {
      await this.sendBotMessage("📭 No NSE-listed equity holdings found to analyze.");
      return;
    }

    await this.sendBotMessage(`🔍 *Holdings Analysis Started*\nAnalyzing ${uniqueSymbols.length} holding(s) using our High-Conviction Technical Analysis strategy...`);

    try {
      const analysis = await this.getWatchlistAnalysis(uniqueSymbols);
      if (!analysis || analysis.length === 0) {
        await this.sendBotMessage("❌ Could not retrieve analysis metrics from the stock MCP server.");
        return;
      }

      // Enrich analysis with portfolio holdings information
      const enrichedAnalysis = analysis.map((stock: any) => {
        const cleanSymbol = stock.symbol.replace(".NS", "");
        const holding = holdings.find((h: any) => h.tradingsymbol?.toUpperCase() === cleanSymbol);
        return {
          ...stock,
          name: holding?.name || cleanSymbol,
          quantity: holding?.quantity,
          average_price: holding?.average_price,
          pnl: holding?.pnl || (holding?.quantity && holding?.average_price && stock.ltp ? (stock.ltp - holding.average_price) * holding.quantity : undefined)
        };
      });

      // Now fetch and send AI Portfolio analysis report
      try {
        await this.sendBotMessage("🤖 *AI Portfolio Analyst Analysis starting*...");
        const aiSummary = await this.generateAiAnalysisSummary(enrichedAnalysis, "Active Portfolio Holdings");
        let header = `🤖 *AI Portfolio Analyst Report*\n\n`;
        if (useMock) {
          header = `⚠️ *Mock Mode Demo*\n` + header;
        }

        let parsed: any = null;
        try {
          parsed = this.cleanAndParseJSON(aiSummary);
        } catch (e) {
          console.warn("Failed to parse AI summary as JSON. Falling back to single-text view:", e);
        }

        if (parsed && parsed.portfolio_summary && parsed.assets) {
          const slides: string[] = [];
          
          let totalInvested = 0;
          let totalCurrent = 0;
          for (const item of enrichedAnalysis) {
            const qty = item.quantity || 0;
            const avg = item.average_price || 0;
            const ltp = item.ltp || item.price || 0;
            totalInvested += qty * avg;
            totalCurrent += qty * ltp;
          }
          const totalPnL = totalCurrent - totalInvested;
          const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

          // Slide 0: Overview
          let slide0 = `${header}`;
          slide0 += `📊 *Portfolio Overview*\n`;
          slide0 += `• *Total Invested*: ₹${totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}\n`;
          slide0 += `• *Current Value*: ₹${totalCurrent.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}\n`;
          slide0 += `• *Net Returns*: *${totalPnL >= 0 ? '+' : ''}₹${totalPnL.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}* (*${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%*)\n\n`;
          slide0 += `🤖 *AI Summary*:\n${parsed.portfolio_summary}\n\n`;
          slide0 += `*Holdings Checklist*:\n`;
          for (const item of enrichedAnalysis) {
            const changeSign = (item.fall_pct || 0) >= 0 ? '+' : '';
            const rsiVal = item.rsi ? Math.round(item.rsi) : 'N/A';
            const adxVal = item.adx ? Math.round(item.adx) : 'N/A';
            const emaState = item.price_above_ema20 && item.price_above_ema50 ? '🟢' : '🔴';
            slide0 += `• *${item.symbol.replace(".NS", "")}*: ${emaState} | RSI: \`${rsiVal}\` | ADX: \`${adxVal}\` | LTP: \`₹${item.ltp}\` (${changeSign}${item.fall_pct?.toFixed(2)}%)\n`;
          }
          slide0 += `\n_Use the arrows below to browse detailed stock-by-stock AI analysis cards._`;
          slides.push(slide0);

          // Slide 1..N: Individual Asset Details
          for (let i = 0; i < enrichedAnalysis.length; i++) {
            const item = enrichedAnalysis[i];
            const sym = item.symbol;
            const cleanSym = sym.replace(".NS", "");
            const aiAsset = this.getAiAssetAnalysis(parsed.assets, [sym, cleanSym]) || { recommendation: 'HOLD', actionable_insight: 'No specific AI analysis found for this symbol.' };
            
            const changeSign = (item.fall_pct || 0) >= 0 ? '+' : '';
            const pnlVal = item.pnl || 0;
            const investedVal = (item.quantity || 0) * (item.average_price || 0);
            const pnlPct = investedVal > 0 ? (pnlVal / investedVal) * 100 : 0;
            
            const recEmoji = aiAsset.recommendation === 'BUY' ? '🚀 BUY' : aiAsset.recommendation === 'SELL' ? '🚫 SELL' : '🤔 HOLD';

            let slide = `${header}`;
            slide += `📈 *Asset ${i + 1} of ${enrichedAnalysis.length}: ${item.name} (${cleanSym})*\n\n`;
            slide += `• *LTP*: ₹${item.ltp} (${changeSign}${item.fall_pct?.toFixed(2)}%)\n`;
            slide += `• *RSI*: \`${item.rsi?.toFixed(1) || 'N/A'}\` | *ADX*: \`${item.adx?.toFixed(1) || 'N/A'}\` (Trend: ${item.adx > 25 ? 'Strong' : 'Weak'})\n`;
            slide += `• *EMA State*: Price is ${item.price_above_ema20 ? 'Above' : 'Below'} EMA20 & ${item.price_above_ema50 ? 'Above' : 'Below'} EMA50\n`;
            
            const signals = [];
            if (item.is_ema_bullish_crossover) signals.push('Bullish Crossover 🚀');
            if (item.is_macd_bullish) signals.push('MACD Bullish 📈');
            if (item.is_near_bb_lower) signals.push('BB Near Lower Band ⚠️ (Oversold / Price Dip Entry Zone)');
            if (item.is_volume_surge) signals.push('Volume Surge 🔥');
            if (signals.length === 0) signals.push('None (Neutral)');
            
            slide += `• *Signals*: ${signals.join(', ')}\n\n`;
            slide += `*My Position*:\n`;
            slide += `• ${item.quantity} units @ average ₹${item.average_price?.toFixed(2)}\n`;
            slide += `• Net P&L: *${pnlVal >= 0 ? '+' : ''}₹${pnlVal.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}* (*${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*)\n\n`;
            slide += `*AI Recommendation*: *${recEmoji}*\n`;
            slide += `🤖 *AI Outlook*:\n${aiAsset.actionable_insight}`;
            slides.push(slide);
          }

          await this.ctx.storage.put("latest_stock_slides", slides);

          const buttons = [];
          if (slides.length > 1) {
            buttons.push({ text: `1 / ${slides.length}`, callback_data: `dummy` });
            buttons.push({ text: "Next ▶️", callback_data: `slide:stock:1` });
          }
          const replyMarkup = {
            inline_keyboard: buttons.length > 0 ? [buttons] : []
          };
          
          await this.sendBotMessage(slides[0], replyMarkup);
        } else {
          await this.sendBotMessage(`${header}${aiSummary}`);
        }
      } catch (aiErr: any) {
        console.error("Failed to generate AI portfolio summary:", aiErr.message);
        await this.sendBotMessage(`⚠️ *AI Analysis Failed*: ${aiErr.message}`);
      }
    } catch (err: any) {
      console.error("Holdings analysis failed:", err.message);
      await this.sendBotMessage(`❌ *Analysis Failed*: ${err.message}`);
    }
  }

  async analyzeMutualFundMCP(schemeCode?: number) {
    const serverId = await this.getMcpServerId();

    const args = schemeCode !== undefined ? { scheme_code: schemeCode } : {};

    const result = await this.mcp.callTool({
      serverId,
      name: "analyze_mutual_fund",
      arguments: args
    });

    if (result.isError) throw new Error("MCP Mutual Fund Analysis Tool Error");
    return JSON.parse((result as any).content[0].text);
  }

  private async handleAnalyzeMFWatchlist() {
    await this.sendBotMessage("🔍 *Mutual Fund Watchlist Deep Technical Scan Started*...\nQuerying our Technical Analysis MCP Server...");
    try {
      const watchlistResults = await this.analyzeMutualFundMCP(); // calls with no schemeCode
      if (!watchlistResults || watchlistResults.length === 0) {
        await this.sendBotMessage("❌ Watchlist results are empty or could not be loaded.");
        return;
      }

      await this.sendBotMessage("🤖 *AI Mutual Fund Analyst deep analysis starting*...");
      const aiSummary = await this.generateMFAiAnalysisSummary(watchlistResults, "Mutual Fund Watchlist");
      let header = `🤖 *AI Mutual Fund Analyst Report*\n\n`;

      let parsed: any = null;
      try {
        parsed = this.cleanAndParseJSON(aiSummary);
      } catch (e) {
        console.warn("Failed to parse AI MF summary as JSON. Falling back to single-text view:", e);
      }

      if (parsed && parsed.portfolio_summary && parsed.assets) {
        const slides: string[] = [];

        // Slide 0: Overview
        let slide0 = `${header}`;
        slide0 += `📊 *Mutual Fund Watchlist Overview*\n`;
        slide0 += `🤖 *AI Outlook*:\n${parsed.portfolio_summary}\n\n`;
        slide0 += `*Watchlist Fund Checklist*:\n`;
        for (const item of watchlistResults) {
          const schemeName = item?.meta?.scheme_name || "N/A";
          const code = String(item?.meta?.scheme_code || "N/A");
          const returns1Y = item?.returns?.trailing_1y_cagr ? `${item.returns.trailing_1y_cagr.toFixed(1)}%` : 'N/A';
          const sharpe = item?.risk_metrics?.sharpe_ratio?.toFixed(1) ?? 'N/A';
          slide0 += `• *${schemeName}* (Scheme: \`${code}\`): 1Y: \`${returns1Y}\` | Sharpe: \`${sharpe}\`\n`;
        }
        slide0 += `\n_Use the arrows below to browse detailed fund-by-fund AI analysis cards._`;
        slides.push(slide0);

        // Slide 1..N: Individual Asset Details
        for (let i = 0; i < watchlistResults.length; i++) {
          const item = watchlistResults[i];
          const schemeName = item?.meta?.scheme_name || "N/A";
          const fundHouse = item?.meta?.fund_house || "N/A";
          const code = String(item?.meta?.scheme_code || "N/A");
          
          // Match AI recommendation by code or name
          const aiAsset = this.getAiAssetAnalysis(parsed.assets, [code, schemeName]) || { recommendation: 'HOLD', actionable_insight: 'No specific AI analysis found for this fund.' };
          
          const recEmoji = aiAsset.recommendation === 'BUY' ? '🚀 BUY' : aiAsset.recommendation === 'SELL' ? '🚫 SELL' : '🤔 HOLD';

          let slide = `${header}`;
          slide += `🌾 *Fund ${i + 1} of ${watchlistResults.length}: ${schemeName}*\n`;
          slide += `• House: \`${fundHouse}\` | Scheme: \`${code}\`\n`;
          slide += `• 1Y CAGR: \`${item?.returns?.trailing_1y_cagr ? item.returns.trailing_1y_cagr.toFixed(2) + '%' : 'N/A'}\` | 3Y CAGR: \`${item?.returns?.trailing_3y_cagr ? item.returns.trailing_3y_cagr.toFixed(2) + '%' : 'N/A'}\`\n`;
          slide += `• Sharpe: \`${item?.risk_metrics?.sharpe_ratio ? item.risk_metrics.sharpe_ratio.toFixed(2) : 'N/A'}\` | Sortino: \`${item?.risk_metrics?.sortino_ratio ? item.risk_metrics.sortino_ratio.toFixed(2) : 'N/A'}\`\n`;
          slide += `• Volatility: \`${item?.risk_metrics?.annualized_volatility_pct ? item.risk_metrics.annualized_volatility_pct.toFixed(2) + '%' : 'N/A'}\`\n\n`;
          slide += `*AI Recommendation*: *${recEmoji}*\n`;
          slide += `🤖 *AI Outlook*:\n${aiAsset.actionable_insight}`;
          slides.push(slide);
        }

        await this.ctx.storage.put("latest_watchlist_slides_mf", slides);

        const buttons = [];
        if (slides.length > 1) {
          buttons.push({ text: `1 / ${slides.length}`, callback_data: `dummy` });
          buttons.push({ text: "Next ▶️", callback_data: `slide:watchlist_mf:1` });
        }
        const replyMarkup = {
          inline_keyboard: buttons.length > 0 ? [buttons] : []
        };
        
        await this.sendBotMessage(slides[0], replyMarkup);
      } else {
        await this.sendBotMessage(`${header}${aiSummary}`);
      }
    } catch (err: any) {
      console.error("Failed to analyze MF watchlist:", err);
      await this.sendBotMessage(`❌ *Analysis Failed*: ${err.message}`);
    }
  }

  private async handleAnalyzeMFHoldings(useMock: boolean) {
    let holdings: any[] = [];
    if (useMock) {
      holdings = this.getMockMFHoldings();
    } else {
      try {
        holdings = await this.getMutualFundHoldings();
      } catch (err: any) {
        console.error("Failed to fetch MF holdings for analysis:", err.message);
        const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
        await this.sendBotMessage(`⚠️ *Kite Session Expired/Disconnected*\n\nCould not fetch mutual fund holdings to analyze. Please login first:\n🔗 [Login to Kite](${loginUrl})\n\n💡 _Or type "mock analyze mf" to see a demo._`);
        return;
      }
    }

    if (!holdings || holdings.length === 0) {
      await this.sendBotMessage("📭 No active mutual fund holdings found. Performing deep scan on our High-Conviction Mutual Fund Watchlist instead... 🔍");
      await this.handleAnalyzeMFWatchlist();
      return;
    }

    await this.sendBotMessage(`🔍 *Mutual Fund Portfolio Deep Risk Analysis Started*...\nQuerying our Technical Analysis MCP Server...`);

    // Enrich holdings with name, scheme code, and fund house
    const enriched = await this.enrichMFHoldings(holdings);

    // Call MCP Server tool sequentially for all holdings with a valid schemeCode to prevent memory spikes
    const analyzed = [];
    for (const h of enriched) {
      let mcpAnalysis = null;
      if (h.schemeCode && h.schemeCode !== "N/A" && typeof h.schemeCode === "number") {
        try {
          console.debug(`[MF Analyze] Running technical analysis for schemeCode ${h.schemeCode} ("${h.name}")...`);
          mcpAnalysis = await this.analyzeMutualFundMCP(h.schemeCode);
        } catch (e: any) {
          console.error(`Failed to analyze mutual fund via MCP for schemeCode ${h.schemeCode}:`, e.message);
        }
      }
      analyzed.push({
        ...h,
        mcpAnalysis
      });
    }

    let totalInvested = 0;
    let totalCurrent = 0;
    let topPerformer = { name: "", symbol: "", fundHouse: "", schemeCode: "", pnlPct: -Infinity, pnl: 0 };
    let underPerformer = { name: "", symbol: "", fundHouse: "", schemeCode: "", pnlPct: Infinity, pnl: 0 };
    const allocationData: { name: string; value: number; pct: number }[] = [];

    // Precalculate all values
    for (const h of analyzed) {
      const qty = h.quantity || 0;
      if (qty === 0) continue;

      const avg = h.average_price || 0;
      const ltp = h.last_price || 0;
      const invested = qty * avg;
      const current = qty * ltp;
      const pnl = current - invested;
      const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

      totalInvested += invested;
      totalCurrent += current;

      if (pnlPct > topPerformer.pnlPct) {
        topPerformer = { name: h.name, symbol: h.tradingsymbol, fundHouse: h.fundHouse, schemeCode: String(h.schemeCode), pnlPct, pnl };
      }
      if (pnlPct < underPerformer.pnlPct) {
        underPerformer = { name: h.name, symbol: h.tradingsymbol, fundHouse: h.fundHouse, schemeCode: String(h.schemeCode), pnlPct, pnl };
      }

      allocationData.push({ name: h.name, value: current, pct: 0 });
    }

    // Now call Workers AI to generate premium AI analysis for MF holdings
    try {
      await this.sendBotMessage("🤖 *AI Mutual Fund Analyst deep analysis starting*...");
      const aiSummary = await this.generateMFAiAnalysisSummary(analyzed, "Mutual Fund Portfolio Holdings");
      let header = `🤖 *AI Mutual Fund Analyst Report*\n\n`;
      if (useMock) {
        header = `⚠️ *Mock Mode Demo*\n` + header;
      }

      let parsed: any = null;
      try {
        parsed = this.cleanAndParseJSON(aiSummary);
      } catch (e) {
        console.warn("Failed to parse AI MF summary as JSON. Falling back to single-text view:", e);
      }

      if (parsed && parsed.portfolio_summary && parsed.assets) {
        const slides: string[] = [];
        
        const totalPnL = totalCurrent - totalInvested;
        const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

        // Slide 0: Overview
        let slide0 = `${header}`;
        slide0 += `📊 *Mutual Fund Portfolio Overview*\n`;
        slide0 += `• *Total Invested*: ₹${totalInvested.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}\n`;
        slide0 += `• *Current Value*: ₹${totalCurrent.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}\n`;
        slide0 += `• *Net Returns*: *${totalPnL >= 0 ? '+' : ''}₹${totalPnL.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}* (*${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%*)\n\n`;
        slide0 += `🤖 *AI Summary*:\n${parsed.portfolio_summary}\n\n`;
        slide0 += `*Mutual Fund Checklist*:\n`;
        for (const item of analyzed) {
          const returns = item.returns || item.mcpAnalysis?.returns || {};
          const cagr3y = returns.trailing_3y_cagr || returns.trailing_1y_cagr || 0;
          const pnlVal = item.pnl || 0;
          const pnlPct = item.pnl_pct || 0;
          const changeSign = pnlVal >= 0 ? '+' : '';
          slide0 += `• *${item.name}*: NAV \`₹${item.last_price || 'N/A'}\` | 3Y CAGR: \`${cagr3y.toFixed(1)}%\` | P&L: \`${changeSign}${pnlPct.toFixed(1)}%\`\n`;
        }
        slide0 += `\n_Use the arrows below to browse detailed mutual fund AI analysis cards._`;
        slides.push(slide0);

        // Slide 1..N: Individual Asset Details
        for (let i = 0; i < analyzed.length; i++) {
          const item = analyzed[i];
          const code = String(item.schemeCode || item.meta?.scheme_code);
          const name = item.name;
          const fundHouse = item.fundHouse || item.meta?.fund_house || 'N/A';
          const aiAsset = this.getAiAssetAnalysis(parsed.assets, [name, code, item.meta?.scheme_name]) || { recommendation: 'HOLD', actionable_insight: 'No specific AI analysis found for this fund.' };

          const returns = item.returns || item.mcpAnalysis?.returns || {};
          const risk = item.risk_metrics || item.mcpAnalysis?.risk_metrics || {};
          const cagr1y = returns.trailing_1y_cagr || 0;
          const cagr3y = returns.trailing_3y_cagr || 0;
          const sharpe = risk.sharpe_ratio || 0;
          const sortino = risk.sortino_ratio || 0;
          const volatility = risk.annualized_volatility_pct || 0;

          const pnlVal = item.pnl || 0;
          const investedVal = (item.quantity || 0) * (item.average_price || 0);
          const pnlPct = investedVal > 0 ? (pnlVal / investedVal) * 100 : 0;
          
          const recEmoji = aiAsset.recommendation === 'BUY' ? '🚀 BUY' : aiAsset.recommendation === 'SELL' ? '🚫 SELL' : '🤔 HOLD';

          let slide = `${header}`;
          slide += `🍀 *Fund ${i + 1} of ${analyzed.length}: ${name}*\n\n`;
          slide += `• *Scheme Code*: \`${code}\` | *House*: _${fundHouse}_\n`;
          slide += `• *Current NAV*: ₹${item.last_price} (Avg: ₹${item.average_price?.toFixed(2) || 'N/A'})\n`;
          slide += `• *CAGR returns*: 1Y: \`${cagr1y.toFixed(1)}%\` | 3Y: \`${cagr3y.toFixed(1)}%\` (Ideal: >12%)\n`;
          slide += `• *Risk Ratios*: Sharpe: \`${sharpe.toFixed(2)}\` | Sortino: \`${sortino.toFixed(2)}\` (Ideal: >1.5)\n`;
          slide += `• *Volatility*: \`${volatility.toFixed(2)}%\` (Stable: <15%)\n\n`;
          slide += `*My Position*:\n`;
          slide += `• ${item.quantity?.toFixed(3) || '0'} units @ average ₹${item.average_price?.toFixed(2)}\n`;
          slide += `• Net P&L: *${pnlVal >= 0 ? '+' : ''}₹${pnlVal.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}* (*${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%*)\n\n`;
          slide += `*AI Recommendation*: *${recEmoji}*\n`;
          slide += `🤖 *AI Outlook*:\n${aiAsset.actionable_insight}`;
          slides.push(slide);
        }

        await this.ctx.storage.put("latest_mf_slides", slides);

        const buttons = [];
        if (slides.length > 1) {
          buttons.push({ text: `1 / ${slides.length}`, callback_data: `dummy` });
          buttons.push({ text: "Next ▶️", callback_data: `slide:mf:1` });
        }
        const replyMarkup = {
          inline_keyboard: buttons.length > 0 ? [buttons] : []
        };
        
        await this.sendBotMessage(slides[0], replyMarkup);
      } else {
        await this.sendBotMessage(`${header}${aiSummary}`);
      }
    } catch (aiErr: any) {
      console.error("Failed to generate AI MF Holdings summary:", aiErr.message);
      await this.sendBotMessage(`⚠️ *AI Analysis Failed*: ${aiErr.message}`);
    }
  }

  private getMockHoldings() {
    return [
      {
        tradingsymbol: "NIFTYBEES",
        name: "Nippon India ETF Nifty BeES",
        quantity: 100,
        average_price: 250.50,
        last_price: 262.30,
        pnl: 1180.00,
        exchange: "NSE"
      },
      {
        tradingsymbol: "ITBEES",
        name: "Nippon India ETF IT BeES",
        quantity: 150,
        average_price: 40.20,
        last_price: 38.50,
        pnl: -255.00,
        exchange: "NSE"
      },
      {
        tradingsymbol: "GOLDBEES",
        name: "Nippon India ETF Gold BeES",
        quantity: 50,
        average_price: 60.10,
        last_price: 64.80,
        pnl: 235.00,
        exchange: "NSE"
      }
    ];
  }

  private getMockMFHoldings() {
    return [
      {
        tradingsymbol: "NIPPON_INDIA_SMALL_CAP",
        name: "Nippon India Small Cap Fund - Direct Plan - Growth Plan",
        isin: "INF204K01014",
        quantity: 1250.45,
        average_price: 85.30,
        last_price: 92.45,
        pnl: 8940.72,
        last_price_date: "2026-05-15"
      },
      {
        tradingsymbol: "SBI_CONTRA_FUND",
        name: "SBI Contra Fund - Direct Plan - Growth",
        isin: "INF179K01970",
        quantity: 500.00,
        average_price: 150.00,
        last_price: 145.20,
        pnl: -2400.00,
        last_price_date: "2026-05-15"
      }
    ];
  }

  private async sendBotMessage(text: string, replyMarkup?: any) {
    const { sendTelegramMessage } = await import("./notifications");
    console.debug("[Telegram] Sending message:", text);
    await sendTelegramMessage(text, {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_CHAT_ID,
      replyMarkup
    });
    console.debug("[Telegram] Message sent successfully.");
  }

  private async sendBotHtmlMessage(text: string) {
    const { sendTelegramMessage } = await import("./notifications");
    console.debug("[Telegram] Sending HTML message:", text);
    await sendTelegramMessage(text, {
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      chatId: this.env.TELEGRAM_CHAT_ID,
      parseMode: "HTML"
    });
    console.debug("[Telegram] HTML Message sent successfully.");
  }

  @callable()
  async handleKitePostback(data: any) {
    console.info("Kite Postback Received:", data);
    // You could send a Telegram message here for important updates
    return { status: "received" };
  }

  private async handleSectorAnalysis(category: string) {
    await this.sendBotMessage(`🔍 *Watchlist Sector Scan Started*: Scanning category *${category}*...`);
    try {
      const watchlist = await this.getWatchlist(category);
      if (!watchlist || watchlist.length === 0) {
        await this.sendBotMessage(`📭 Category *${category}* is empty or not found.`);
        return;
      }

      const analysis = await this.getWatchlistAnalysis(watchlist);
      if (!analysis || analysis.length === 0) {
        await this.sendBotMessage(`❌ Failed to fetch analysis for category *${category}*.`);
        return;
      }

      await this.generateAndSendSectorCarousel(category, analysis);
    } catch (err: any) {
      console.error(`Failed handleSectorAnalysis for ${category}:`, err.message);
      await this.sendBotMessage(`❌ *Sector Analysis Failed*: ${err.message}`);
    }
  }

  @callable()
  async sendWatchlistAnalysisCarousel(category: string, analysis: any[]) {
    await this.generateAndSendSectorCarousel(category, analysis);
  }

  private async generateAndSendSectorCarousel(category: string, analysis: any[]) {
    try {
      await this.sendBotMessage(`🤖 *AI Sector Analyst Analysis starting for ${category}*...`);
      const aiSummary = await this.generateAiAnalysisSummary(analysis, `Watchlist Sector: ${category}`);
      let header = `🤖 *AI Analyst Report: ${category}*\n\n`;

      let parsed: any = null;
      try {
        parsed = this.cleanAndParseJSON(aiSummary);
      } catch (e) {
        console.warn("Failed to parse AI sector summary as JSON. Falling back to single-text view:", e);
      }

      if (parsed && parsed.portfolio_summary && parsed.assets) {
        const slides: string[] = [];

        // Slide 0: Overview
        let slide0 = `${header}`;
        slide0 += `📊 *Sector Overview*\n`;
        slide0 += `🤖 *AI Outlook*:\n${parsed.portfolio_summary}\n\n`;
        slide0 += `*Asset Checklist*:\n`;
        for (const item of analysis) {
          const changeSign = (item.fall_pct || 0) >= 0 ? '+' : '';
          const rsiVal = item.rsi ? Math.round(item.rsi) : 'N/A';
          const adxVal = item.adx ? Math.round(item.adx) : 'N/A';
          const emaState = item.price_above_ema20 && item.price_above_ema50 ? '🟢' : '🔴';
          slide0 += `• *${item.symbol.replace(".NS", "")}*: ${emaState} | RSI: \`${rsiVal}\` | ADX: \`${adxVal}\` | LTP: \`₹${item.ltp}\` (${changeSign}${item.fall_pct?.toFixed(2)}%)\n`;
        }
        slide0 += `\n_Use the arrows below to browse detailed stock-by-stock AI analysis cards._`;
        slides.push(slide0);

        // Slide 1..N: Individual Asset Details
        for (let i = 0; i < analysis.length; i++) {
          const item = analysis[i];
          const sym = item.symbol;
          const cleanSym = sym.replace(".NS", "");
          const aiAsset = this.getAiAssetAnalysis(parsed.assets, [sym, cleanSym]) || { recommendation: 'HOLD', actionable_insight: 'No specific AI analysis found for this symbol.' };
          
          const recEmoji = aiAsset.recommendation === 'BUY' ? '🚀 BUY' : aiAsset.recommendation === 'SELL' ? '🚫 SELL' : '🤔 HOLD';

          let slide = `${header}`;
          slide += `📈 *Asset ${i + 1} of ${analysis.length}: ${cleanSym}*\n`;
          slide += `• Price: \`₹${item.ltp}\` (${(item.fall_pct || 0) >= 0 ? '+' : ''}${item.fall_pct?.toFixed(2)}%)\n`;
          slide += `• RSI: \`${item.rsi?.toFixed(1) ?? 'N/A'}\` | ADX: \`${item.adx?.toFixed(1) ?? 'N/A'}\`${(item.adx || 0) >= 25 ? ' 🔥' : ''}\n`;
          slide += `• EMA20/50: ${item.price_above_ema20 ? '✅ Above' : '❌ Below'}/${item.price_above_ema50 ? '✅' : '❌'} (Crossover: ${item.is_ema_bullish_crossover ? '🚀 BULLISH' : '❌'})\n`;
          
          const signals = [];
          if (item.is_ema_bullish_crossover) signals.push('Bullish Crossover 🚀');
          if (item.is_macd_bullish) signals.push('MACD Bullish 📈');
          if (item.is_near_bb_lower) signals.push('BB Near Lower Band ⚠️ (Oversold / Price Dip Entry Zone)');
          if (item.is_volume_surge) signals.push('Volume Surge 🔥');
          if (signals.length === 0) signals.push('None (Neutral)');
          
          slide += `• *Signals*: ${signals.join(', ')}\n\n`;
          slide += `*AI Recommendation*: *${recEmoji}*\n`;
          slide += `🤖 *AI Outlook*:\n${aiAsset.actionable_insight}`;
          slides.push(slide);
        }

        const catKey = category.toLowerCase();
        await this.ctx.storage.put(`latest_watchlist_slides_${catKey}`, slides);

        const buttons = [];
        if (slides.length > 1) {
          buttons.push({ text: `1 / ${slides.length}`, callback_data: `dummy` });
          buttons.push({ text: "Next ▶️", callback_data: `slide:watchlist_${catKey}:1` });
        }
        const replyMarkup = {
          inline_keyboard: buttons.length > 0 ? [buttons] : []
        };
        
        await this.sendBotMessage(slides[0], replyMarkup);
      } else {
        await this.sendBotMessage(`${header}${aiSummary}`);
      }
    } catch (aiErr: any) {
      console.error(`Failed to generate AI sector summary for ${category}:`, aiErr.message);
      await this.sendBotMessage(`⚠️ *AI Analysis Failed*: ${aiErr.message}`);
    }
  }

  async searchMutualFundsMCP(query: string) {
    const serverId = await this.getMcpServerId();

    const result = await this.mcp.callTool({
      serverId,
      name: "search_mutual_funds",
      arguments: { query }
    });

    if (result.isError) throw new Error("MCP search_mutual_funds Tool Error");
    return JSON.parse((result as any).content[0].text);
  }

  private async handleSearchMF(query: string) {
    await this.sendBotMessage(`🔍 *Searching AMFI Database* for direct growth schemes matching: "${query}"...`);
    try {
      const results = await this.searchMutualFundsMCP(query);
      if (!results || results.length === 0) {
        await this.sendBotMessage(`📭 No mutual funds found matching: "${query}".`);
        return;
      }

      // Filter matches to prioritize direct growth plans
      const directGrowth = results.filter((r: any) => {
        const name = r.scheme_name.toLowerCase();
        return name.includes("direct") && (name.includes("growth") || name.includes("direct plan"));
      });

      // If direct growth is empty, use all results
      const finalResults = directGrowth.length > 0 ? directGrowth : results;
      const limited = finalResults.slice(0, 15); // limit to 15 to fit in Telegram limits

      let message = `🔍 <b>AMFI Search Results</b> for: <i>"${escapeHtml(query)}"</i>\n\n`;

      for (const r of limited) {
        const schemeName = escapeHtml(r.scheme_name);
        const schemeCode = escapeHtml(r.scheme_code);
        const isinGrowth = escapeHtml(r.isin_growth || "N/A");
        const latestNav = escapeHtml(r.latest_nav ?? "N/A");
        const date = escapeHtml(r.date || "N/A");

        message += `• <b>${schemeName}</b>\n`;
        message += `  AMFI Code: <code>${schemeCode}</code>\n`;
        message += `  ISIN Growth: <code>${isinGrowth}</code>\n`;
        message += `  NAV: <b>₹${latestNav}</b> (${date})\n\n`;
      }

      message += `\n`;
      if (finalResults.length > 15) {
        message += `💡 <i>Showing top 15 of ${finalResults.length} matches. Try a more specific query if your fund is not listed.</i>\n\n`;
      }
      message += `📊 <i>Use command "/analyze_mf" or "analyze mf holdings" to trigger portfolio analysis.</i>`;

      await this.sendBotHtmlMessage(message);
    } catch (err: any) {
      console.error("Failed handleSearchMF:", err.message);
      await this.sendBotMessage(`❌ *Search Failed*: ${err.message}`);
    }
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
      const agent: any = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));
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
      // Acknowledge Telegram immediately to prevent timeout & retries, and process in background
      ctx.waitUntil(
        agent.handleTelegramUpdate(update).catch((err: any) => {
          console.error("[Agent] Error processing Telegram update:", err.message);
        })
      );
      return new Response("OK");
    }

    if (url.pathname === "/set-webhook") {
      const authError = validateAuth();
      if (authError) return authError;

      const webhookUrl = `${env.BASE_URL}/telegram-webhook`;
      
      // 1. Set Telegram Webhook
      const webhookResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}&drop_pending_updates=true`
      );
      const webhookResult: any = await webhookResponse.json();

      // 2. Set Bot Commands
      const commands = [
        { command: "guidelines", description: "View Technical Parameter Guidelines for Stocks and Mutual Funds" },
        { command: "kite_login", description: "Authenticate Zerodha Kite session (expires in 45 min)" },
        { command: "kite_holdings", description: "Fetch active Zerodha stock/ETF holdings" },
        { command: "kite_analyze", description: "Run AI technical analysis on Kite stock holdings" },
        { command: "analyze", description: "Run AI technical analysis on a specific stock (conversational)" },
        { command: "etf_analyze", description: "Scan ETF watchlist technical indicators" },
        { command: "mf", description: "Fetch active mutual fund holdings" },
        { command: "mf_analyze", description: "Run AI risk analysis on mutual fund holdings" },
        { command: "mf_watchlist", description: "Scan mutual fund watchlist risk/returns" },
        { command: "mf_search", description: "Search 17,000+ mutual funds on AMFI (e.g. Quant)" },
        { command: "it_analyze", description: "Scan IT sector watchlist technical metrics" },
        { command: "bank_analyze", description: "Scan Banking sector watchlist technical metrics" },
        { command: "energy_analyze", description: "Scan Energy sector watchlist technical metrics" },
        { command: "potential_analyze", description: "Scan Potential sector watchlist technical metrics" }
      ];

      const commandsResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands })
        }
      );
      const commandsResult: any = await commandsResponse.json();

      return new Response(
        JSON.stringify(
          {
            webhook: webhookResult,
            commands: commandsResult
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }


    return (await routeAgentRequest(request, env)) || new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const agent = await env.TRADING_AGENT.get(env.TRADING_AGENT.idFromName("default"));

    // 2:45 PM IST (9:15 AM UTC) -> Watchlist Analysis
    if (event.cron === "15 9 * * MON-FRI" || event.cron === "15 9 * * *") {
      await agent.startWatchlistAnalysis();
    } 
    // 3:10 PM IST (9:40 AM UTC) -> Trading Workflow
    else if (event.cron === "40 9 * * MON-FRI" || event.cron === "40 9 * * *") {
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
