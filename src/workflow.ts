import { AgentWorkflow, AgentWorkflowStep, AgentWorkflowEvent } from "agents/workflows";
import { TradingAgent } from "./index";
import { sendTelegramMessage } from "./notifications";

export class TradingWorkflow extends AgentWorkflow<any, { amount: number }> {
  async run(event: AgentWorkflowEvent<{ amount: number }>, step: AgentWorkflowStep) {
    const agent = this.agent as TradingAgent;
    const env = this.env as any;
    const { amount } = event.payload;

    // 1. Analyze Market
    const opportunities = await step.do("analyze-market", async () => {
      await agent.logFromWorkflow(`Analyzing market... (Mock: ${event.payload.mock})`);
      const results = await agent.findOpportunities({
        min_fall_pct: -2.0,
        min_rsi: 50,
        mock: event.payload.mock
      });
      await agent.logFromWorkflow(`Found ${results?.length || 0} opportunities.`);
      return results;
    });

    if (!opportunities || opportunities.length === 0) {
      await agent.logFromWorkflow("No opportunities found today.");
      return;
    }

    // 2. Store state for interactive bot
    await step.do("store-state", async () => {
      await agent.logFromWorkflow("Storing state for bot via agent call...");
      await agent.storeTradeState(opportunities, this.workflowId);
    });

    // 3. Notify via Telegram
    await step.do("notify-user", async () => {
      await agent.logFromWorkflow("Starting notify-user step...");
      await agent.logFromWorkflow(`Env keys: ${Object.keys(env).join(", ")}`);
      
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        await agent.logFromWorkflow("CRITICAL: Telegram credentials missing from env!");
      }

      let loginStatus;
      try {
        await agent.logFromWorkflow("Checking Kite login status...");
        loginStatus = await agent.checkKiteLogin();
        await agent.logFromWorkflow(`Kite status: ${loginStatus.status}`);
      } catch (err: any) {
        await agent.logFromWorkflow(`Kite check failed: ${err.message}`);
        loginStatus = { status: "disconnected", loginUrl: "" };
      }
      
      let message = `🚀 *Stock Alert*
Found ${opportunities.length} buy opportunities.
Top Pick: ${opportunities[0].symbol} (RSI: ${opportunities[0].rsi.toFixed(1)})\n\n`;

      if (loginStatus.status === "disconnected") {
        const loginUrl = `${env.BASE_URL}/kite-login?token=${env.AUTH_TOKEN}`;
        message += `⚠️ *Action Required*: Your Kite session has expired.\n1. [Login to Kite](${loginUrl})\n2. After logging in, type "trade <amount>" below.\n\n`;
      } else {
        message += `Reply with \`trade <amount>\` (e.g., \`trade 1000\`) to continue.`;
      }

      await agent.logFromWorkflow("Calling sendTelegramMessage...");
      try {
        await sendTelegramMessage(message, {
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_CHAT_ID
        });
        await agent.logFromWorkflow("sendTelegramMessage completed successfully.");
      } catch (err: any) {
        await agent.logFromWorkflow(`sendTelegramMessage failed: ${err.message}`);
        throw err;
      }
    });

    // 4. Wait for Approval (Human-in-the-loop via Bot)
    await this.waitForApproval(step, {
      timeout: "1 hour",
      stepName: "User Approval"
    });

    // 5. Fetch the interactive amount set by the bot
    const finalAmount = await step.do("get-final-amount", async () => {
      return await agent.ctx.storage.get<number>("pending_amount") || amount;
    });

    // 6. Place Orders
    const results = await step.do("place-orders", async () => {
      return await agent.executeOrders({
        amount: finalAmount,
        opportunities: opportunities
      });
    });

    return results;
  }
}

export class WatchlistAnalysisWorkflow extends AgentWorkflow<any, {}> {
  async run(event: AgentWorkflowEvent<{}>, step: AgentWorkflowStep) {
    const agent = this.agent as TradingAgent;
    const env = this.env as any;

    // 1. Fetch Watchlist Analysis
    const analysis = await step.do("fetch-analysis", async () => {
      return await agent.getWatchlistAnalysis([
        "INFRABEES.NS",
        "PSUBNKBEES.NS",
        "NIFTYBEES.NS",
        "GOLDBEES.NS",
        "SILVER1.NS",
        "ITBEES.NS"
      ]);
    });

    // 2. Format & Send Telegram Message
    await step.do("send-telegram-report", async () => {
      let message = `📊 *Watchlist Analysis Report*\n\n`;
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
        message += `• RSI: ${stock.rsi.toFixed(1)} | ADX: ${stock.adx.toFixed(1)}${stock.adx >= 25 ? " 🔥" : ""}\n`;
        message += `• EMA20/50: ${stock.price_above_ema20 ? "✅ Above" : "❌ Below"}/${stock.price_above_ema50 ? "✅" : "❌"} (Crossover: ${stock.is_ema_bullish_crossover ? "🚀 BULLISH" : "❌"})\n`;
        message += `• MACD Bullish: ${stock.is_macd_bullish ? "🟢 Yes" : "🔴 No"}\n`;
        message += `• BB Lower Band: ${stock.is_near_bb_lower ? "⚠️ Yes (Oversold)" : "❌ No"}\n`;
        message += `• Volume Surge: ${stock.is_volume_surge ? "🔥 Yes" : "❌ No"}\n`;
        message += `• Recommendation: *${stock.recommendation}*\n`;
        message += `• Analysis: _${stock.comment}_\n\n`;
      }

      // Add Summary with explicit stock symbols listed
      message += `━━━━━━━━━━━━━━━\n`;
      message += `📈 *Market Sentiment Summary*:\n`;
      message += `• *Buy Opportunities* (${buyOpportunities.length}): ${buyOpportunities.length > 0 ? buyOpportunities.map(s => `*${s}*`).join(", ") : "_None_"}\n`;
      message += `• *Strong & Rising* (${strongRising.length}): ${strongRising.length > 0 ? strongRising.map(s => `*${s}*`).join(", ") : "_None_"}\n`;
      message += `• *Bearish/Weak* (${bearishWeak.length}): ${bearishWeak.length > 0 ? bearishWeak.map(s => `*${s}*`).join(", ") : "_None_"}\n\n`;

      if (buyOpportunities.length > 0) {
        message += `🚀 *Action*: Found ${buyOpportunities.length} dip opportunities (${buyOpportunities.join(", ")})! Check the Trading Workflow.`;
      } else if (strongRising.length > 0) {
        message += `💎 *Action*: Market is strong but not at a discount. No new entries recommended.`;
      } else {
        message += `⚠️ *Action*: Market looks weak. Stay cautious.`;
      }

      // Add Parameter Guide/Glossary
      message += `\n\n📖 *Technical Parameter Guide*:\n`;
      message += `• *RSI*: Relative Strength Index (<30 is Oversold/Deep Value; >70 is Overbought/Avoid).\n`;
      message += `• *ADX*: Average Directional Index (>25 indicates a strong, sustainable trend).\n`;
      message += `• *EMA20/50*: Exponential Moving Averages (Bullish if price > both). Bullish crossover signals key trend reversal.\n`;
      message += `• *MACD*: Moving Average Convergence Divergence (Bullish signals strong upward momentum).\n`;
      message += `• *BB Lower*: Bollinger Bands. Near lower band indicates a short-term oversold/mean-reversion entry point.\n`;
      message += `• *Volume Surge*: Trading volume > 1.5x of 20-day SMA, indicating institutional backing.`;

      await sendTelegramMessage(message, {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID
      });
    });
  }
}
