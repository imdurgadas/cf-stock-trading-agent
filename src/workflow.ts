import { AgentWorkflow, AgentWorkflowStep, AgentWorkflowEvent } from "agents/workflows";
import { TradingAgent } from "./index";
import { sendTelegramMessage } from "./notifications";

export class TradingWorkflow extends AgentWorkflow<any, { amount: number, mock?: boolean }> {
  async run(event: AgentWorkflowEvent<{ amount: number, mock?: boolean }>, step: AgentWorkflowStep) {
    const agent = (this as any).agent;
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
        message += `⚠️ *Action Required*: Your Kite session has expired.\n1. [Login to Kite](${loginUrl})\n2. After logging in, type "kite_trade <amount>" below.\n\n`;
      } else {
        message += `Reply with \`kite_trade <amount>\` (e.g., \`kite_trade 1000\`) to continue.`;
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

    // 5. Fetch the interactive trade parameters set by the bot
    const tradeParams = await step.do("get-final-trade-params", async () => {
      const pendingAmount = (await agent.ctx.storage.get("pending_amount")) as number;
      const pendingSymbol = (await agent.ctx.storage.get("pending_symbol")) as string;
      return {
        amount: pendingAmount || amount,
        symbol: pendingSymbol || null
      };
    });

    // 6. Place Orders
    const results = await step.do("place-orders", async () => {
      const targetOpportunities = tradeParams.symbol
        ? [{ symbol: tradeParams.symbol }]
        : opportunities;

      const res = await agent.executeOrders({
        amount: tradeParams.amount,
        opportunities: targetOpportunities
      });

      // Cleanup
      await agent.ctx.storage.delete("pending_symbol");
      return res;
    });

    return results;
  }
}

export class WatchlistAnalysisWorkflow extends AgentWorkflow<any, {}> {
  async run(event: AgentWorkflowEvent<{}>, step: AgentWorkflowStep) {
    const agent = (this as any).agent;
    const env = this.env as any;

    // 1. Fetch Watchlist categories from MCP
    const watchlists = await step.do("fetch-watchlists", async () => {
      return await agent.getWatchlist("ALL");
    });

    const categories = ["ETF"];
    const reports: Record<string, any[]> = {};

    // 2. Fetch analysis for each category in separate steps
    for (const cat of categories) {
      if (watchlists[cat] && watchlists[cat].length > 0) {
        reports[cat] = await step.do(`fetch-analysis-${cat}`, async () => {
          return await agent.getWatchlistAnalysis(watchlists[cat]);
        });
      }
    }

    // 3. Format and send Telegram reports sector by sector
    for (const cat of categories) {
      const analysis = reports[cat];
      if (!analysis || analysis.length === 0) continue;

      await step.do(`send-telegram-report-${cat}`, async () => {
        let message = `📂 *Watchlist Sector: ${cat}*\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

        for (const stock of analysis) {
          const trend = stock.is_st_green ? "🟢" : "🔴";

          message += `*${stock.symbol}* ${trend}\n`;
          message += `• Price: ₹${stock.ltp} (${stock.fall_pct >= 0 ? "+" : ""}${stock.fall_pct.toFixed(2)}%)\n`;
          message += `• RSI: ${stock.rsi?.toFixed(1) ?? "N/A"} | ADX: ${stock.adx?.toFixed(1) ?? "N/A"}${stock.adx >= 25 ? " 🔥" : ""}\n`;
          message += `• EMA20/50: ${stock.price_above_ema20 ? "✅ Above" : "❌ Below"}/${stock.price_above_ema50 ? "✅" : "❌"} (Crossover: ${stock.is_ema_bullish_crossover ? "🚀 BULLISH" : "❌"})\n`;
          message += `• MACD Bullish: ${stock.is_macd_bullish ? "🟢 Yes" : "🔴 No"}\n`;
          message += `• BB Lower Band: ${stock.is_near_bb_lower ? "⚠️ Yes (Oversold)" : "❌ No"}\n`;
          message += `• Volume Surge: ${stock.is_volume_surge ? "🔥 Yes" : "❌ No"}\n\n`;
        }

        await sendTelegramMessage(message, {
          botToken: env.TELEGRAM_BOT_TOKEN,
          chatId: env.TELEGRAM_CHAT_ID
        });
      });

      // 3b. Call Workers AI to generate and send watchlist AI analysis
      await step.do(`send-telegram-ai-report-${cat}`, async () => {
        await agent.logFromWorkflow(`Generating AI summary for category ${cat}...`);
        try {
          const aiSummary = await agent.generateAiAnalysisSummary(analysis, `Watchlist Sector: ${cat}`);
          await sendTelegramMessage(`🤖 *AI Analyst Report: ${cat}*\n━━━━━━━━━━━━━━━━━━━━━\n\n${aiSummary}`, {
            botToken: env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID
          });
        } catch (aiErr: any) {
          await agent.logFromWorkflow(`AI analysis failed: ${aiErr.message}`);
          await sendTelegramMessage(`⚠️ *AI Analyst Report Failed for ${cat}*: ${aiErr.message}`, {
            botToken: env.TELEGRAM_BOT_TOKEN,
            chatId: env.TELEGRAM_CHAT_ID
          });
        }
      });
    }


  }
}
