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
  private kite: any = null;

  async onStart() {
    // Connect to the MCP server on startup
    await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
  }

  async initKite() {
    if (this.kite) {
      // Check for memory-cached expiry
      const expiry = await this.ctx.storage.get<number>("kite_token_expiry");
      if (expiry && Date.now() > expiry) {
        console.warn("[Agent] Kite session expired (10-minute TTL).");
        this.kite = null;
        await this.ctx.storage.delete("kite_access_token");
        await this.ctx.storage.delete("kite_token_expiry");
      } else {
        return this.kite;
      }
    }
    
    console.log("[Agent] Initializing Kite SDK...");
    const accessToken = await this.ctx.storage.get<string>("kite_access_token");
    const expiry = await this.ctx.storage.get<number>("kite_token_expiry");

    // Enforce 10-minute expiry
    if (accessToken && expiry && Date.now() > expiry) {
      console.warn("[Agent] Kite session expired (10-minute TTL). Cleaning up...");
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

    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();

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
      
      // Set 10-minute expiry
      const expiry = Date.now() + (10 * 60 * 1000);
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
  async getWatchlist(category: string) {
    const { id: serverId } = await this.mcp.connect(this.env.MCP_SERVER_URL, {
      transport: { type: "streamable-http" }
    });
    await this.mcp.waitForConnections();

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
  async logFromWorkflow(msg: string) {
    console.log(`[Workflow Log] ${msg}`);
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
    const text = update.message?.text?.toLowerCase()?.trim();
    const chatId = update.message?.chat?.id;

    if (!text || String(chatId) !== String(this.env.TELEGRAM_CHAT_ID)) return;

    // 1. Command: Kite Login
    if (text === "kite login" || text === "login" || text === "/login") {
      const loginUrl = `${this.env.BASE_URL}/kite-login?token=${this.env.AUTH_TOKEN}`;
      await this.sendBotMessage(`🔗 *Kite Login*: [Click here to login and authenticate](${loginUrl})\n\n💡 _Note: Sessions expire in 10 minutes for security._`);
      return;
    }

    // 2. Command: Get Kite Equity Holdings (Live or Mock)
    if (
      text === "get kite holdings" ||
      text === "kite holdings" ||
      text === "holdings" ||
      text === "/holdings" ||
      text === "mock holdings"
    ) {
      const useMock = text.includes("mock");
      await this.handleGetKiteHoldings(useMock);
      return;
    }

    // 3. Command: Get Mutual Fund Holdings (Live or Mock)
    if (
      text === "get mutual fund holdings" ||
      text === "mutual fund holdings" ||
      text === "get mf holdings" ||
      text === "mf holdings" ||
      text === "mf" ||
      text === "/mf" ||
      text === "mock mf"
    ) {
      const useMock = text.includes("mock");
      await this.handleGetMFHoldings(useMock);
      return;
    }

    // 4. Command: Do Technical Analysis of Holdings (Live or Mock)
    if (
      text === "do analysis of the same using our method" ||
      text === "do analysis of the same" ||
      text === "do analysis" ||
      text === "analyze holdings" ||
      text === "analyze" ||
      text === "/analyze" ||
      text === "mock analyze"
    ) {
      const useMock = text.includes("mock");
      await this.handleAnalyzeHoldings(useMock);
      return;
    }

    // 5. Handle "trade <symbol> <amount>" or "trade <amount>"
    const tradeSymbolMatch = text.match(/^trade\s+([a-zA-Z0-9\.\-_]+)\s+(\d+)$/);
    const tradeAmountMatch = text.match(/^trade\s+(\d+)$/);

    if (tradeSymbolMatch) {
      const symbol = tradeSymbolMatch[1].toUpperCase();
      const amount = parseInt(tradeSymbolMatch[2]);
      
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
        await this.sendBotMessage("No pending opportunities found. Please wait for the next scan. To trade a specific stock, use `trade <symbol> <amount>`.");
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
        await this.sendBotMessage("Nothing to confirm. Use `trade <amount>` or `trade <symbol> <amount>` first.");
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

    let message = `📊 *Kite Equity Holdings*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    let totalInvested = 0;
    let totalCurrent = 0;

    for (const h of holdings) {
      const qty = (h.quantity || 0) + (h.t1_quantity || 0);
      if (qty === 0) continue;

      const avg = h.average_price || 0;
      const ltp = h.last_price || 0;
      const invested = qty * avg;
      const current = qty * ltp;
      const pnl = h.pnl !== undefined ? h.pnl : (current - invested);
      const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

      totalInvested += invested;
      totalCurrent += current;

      const trend = pnl >= 0 ? "🟢" : "🔴";
      const sign = pnl >= 0 ? "+" : "";

      message += `• *${h.tradingsymbol}* (${h.exchange || "NSE"})\n`;
      message += `  Qty: ${qty} | Avg: ₹${avg.toFixed(2)}\n`;
      message += `  LTP: ₹${ltp.toFixed(2)} | Val: ₹${current.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
      message += `  P&L: *${trend} ${sign}₹${pnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* (${sign}${pnlPct.toFixed(2)}%)\n\n`;
    }

    const totalPnL = totalCurrent - totalInvested;
    const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const totalTrend = totalPnL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPnL >= 0 ? "+" : "";

    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 *Total Invested*: ₹${totalInvested.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    message += `📈 *Current Value*: ₹${totalCurrent.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    message += `📊 *Total P&L*: *${totalTrend} ${totalSign}₹${totalPnL.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* (${totalSign}${totalPnLPct.toFixed(2)}%)\n`;
    
    if (useMock) {
      message += `\n⚠️ _This is a Mock Account demo._`;
    }

    await this.sendBotMessage(message);
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

    let message = `🌾 *Mutual Fund Holdings*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    let totalInvested = 0;
    let totalCurrent = 0;

    for (const h of holdings) {
      const qty = h.quantity || 0;
      if (qty === 0) continue;

      const avg = h.average_price || 0;
      const ltp = h.last_price || 0; // last NAV
      const invested = qty * avg;
      const current = qty * ltp;
      const pnl = h.pnl !== undefined ? h.pnl : (current - invested);
      const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;

      totalInvested += invested;
      totalCurrent += current;

      const trend = pnl >= 0 ? "🟢" : "🔴";
      const sign = pnl >= 0 ? "+" : "";

      message += `• *${h.tradingsymbol}* (ISIN: ${h.isin || "N/A"})\n`;
      message += `  Units: ${qty.toFixed(3)} | Avg NAV: ₹${avg.toFixed(4)}\n`;
      message += `  Last NAV: ₹${ltp.toFixed(4)} | Val: ₹${current.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
      message += `  P&L: *${trend} ${sign}₹${pnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* (${sign}${pnlPct.toFixed(2)}%)\n\n`;
    }

    const totalPnL = totalCurrent - totalInvested;
    const totalPnLPct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const totalTrend = totalPnL >= 0 ? "🟢" : "🔴";
    const totalSign = totalPnL >= 0 ? "+" : "";

    message += `━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💰 *Total MF Invested*: ₹${totalInvested.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    message += `📈 *Current MF Value*: ₹${totalCurrent.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    message += `📊 *Total MF P&L*: *${totalTrend} ${totalSign}₹${totalPnL.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* (${totalSign}${totalPnLPct.toFixed(2)}%)\n`;

    if (useMock) {
      message += `\n⚠️ _This is a Mock Account demo._`;
    }

    await this.sendBotMessage(message);
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

      let message = `🔍 *Holdings Technical Analysis*\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

      const buyOpportunities: string[] = [];
      const strongRising: string[] = [];
      const bearishWeak: string[] = [];

      for (const stock of analysis) {
        const trend = stock.is_st_green ? "🟢" : "🔴";
        const isBullish = stock.is_st_green && stock.price_above_ema20 && stock.price_above_ema50;
        const isDip = stock.fall_pct <= -2;

        if (isBullish) {
          if (isDip) {
            buyOpportunities.push(stock.symbol);
          } else {
            strongRising.push(stock.symbol);
          }
        } else {
          bearishWeak.push(stock.symbol);
        }

        message += `*${stock.symbol}* ${trend}\n`;
        message += `• Price: ₹${stock.ltp} (${stock.fall_pct >= 0 ? "+" : ""}${stock.fall_pct.toFixed(2)}%)\n`;
        message += `• RSI: ${stock.rsi?.toFixed(1) ?? "N/A"} | ADX: ${stock.adx?.toFixed(1) ?? "N/A"}${stock.adx >= 25 ? " 🔥" : ""}\n`;
        message += `• EMA20/50: ${stock.price_above_ema20 ? "✅ Above" : "❌ Below"}/${stock.price_above_ema50 ? "✅" : "❌"} (Crossover: ${stock.is_ema_bullish_crossover ? "🚀 BULLISH" : "❌"})\n`;
        message += `• MACD Bullish: ${stock.is_macd_bullish ? "🟢 Yes" : "🔴 No"}\n`;
        message += `• BB Lower Band: ${stock.is_near_bb_lower ? "⚠️ Yes (Oversold)" : "❌ No"}\n`;
        message += `• Volume Surge: ${stock.is_volume_surge ? "🔥 Yes" : "❌ No"}\n`;
        message += `• Recommendation: *${stock.recommendation}*\n`;
        message += `• Analysis: _${stock.comment}_\n\n`;
      }

      message += `━━━━━━━━━━━━━━━\n`;
      message += `📈 *Holdings Summary*:\n`;
      message += `• *Buy Opportunities (RSI Dip)* (${buyOpportunities.length}): ${buyOpportunities.length > 0 ? buyOpportunities.map(s => `*${s}*`).join(", ") : "_None_"}\n`;
      message += `• *Strong & Rising* (${strongRising.length}): ${strongRising.length > 0 ? strongRising.map(s => `*${s}*`).join(", ") : "_None_"}\n`;
      message += `• *Bearish/Weak* (${bearishWeak.length}): ${bearishWeak.length > 0 ? bearishWeak.map(s => `*${s}*`).join(", ") : "_None_"}\n\n`;

      if (buyOpportunities.length > 0) {
        message += `🚀 *Action*: Your holdings ${buyOpportunities.join(", ")} are currently in a high-conviction buy/dip zone! You can consider accumulating more.`;
      } else {
        message += `💎 *Action*: No high-conviction dip entries for your holdings right now. Let them ride!`;
      }

      if (useMock) {
        message += `\n\n⚠️ _This analysis is based on mock holdings._`;
      }

      await this.sendBotMessage(message);
    } catch (err: any) {
      console.error("Holdings analysis failed:", err.message);
      await this.sendBotMessage(`❌ *Analysis Failed*: ${err.message}`);
    }
  }

  private getMockHoldings() {
    return [
      {
        tradingsymbol: "NIFTYBEES",
        quantity: 100,
        average_price: 250.50,
        last_price: 262.30,
        pnl: 1180.00,
        exchange: "NSE"
      },
      {
        tradingsymbol: "ITBEES",
        quantity: 150,
        average_price: 40.20,
        last_price: 38.50,
        pnl: -255.00,
        exchange: "NSE"
      },
      {
        tradingsymbol: "GOLDBEES",
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
        isin: "INF204K01014",
        quantity: 1250.45,
        average_price: 85.30,
        last_price: 92.45,
        pnl: 8940.72,
        last_price_date: "2026-05-15"
      },
      {
        tradingsymbol: "SBI_CONTRA_FUND",
        isin: "INF179K01970",
        quantity: 500.00,
        average_price: 150.00,
        last_price: 145.20,
        pnl: -2400.00,
        last_price_date: "2026-05-15"
      }
    ];
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
