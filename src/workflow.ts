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
      let uptrendCount = 0;
      let opportunityCount = 0;

      for (const stock of analysis) {
        const trend = stock.is_st_green ? "🟢" : "🔴";
        const isBullish = stock.is_st_green && stock.price_above_ema20 && stock.price_above_ema50;
        const isDip = stock.fall_pct <= -2;

        if (isBullish) {
          if (isDip) opportunityCount++;
          else uptrendCount++;
        }

        message += `*${stock.symbol}* ${trend}\n`;
        message += `Price: ₹${stock.ltp} (${stock.fall_pct}%)\n`;
        message += `RSI: ${stock.rsi.toFixed(1)}\n`;
        message += `EMA20: ${stock.price_above_ema20 ? "✅" : "❌"} | EMA50: ${stock.price_above_ema50 ? "✅" : "❌"}\n`;
        message += `SuperTrend: ${stock.is_st_green ? "Bullish" : "Bearish"}\n\n`;
      }

      // Add Summary
      message += `━━━━━━━━━━━━━━━\n`;
      message += `📈 *Market Sentiment Summary*:\n`;
      message += `• *Strong & Rising*: ${uptrendCount} (Bullish trend, but no -2% dip)\n`;
      message += `• *Buy Opportunities*: ${opportunityCount} (Bullish trend + -2% Dip met)\n`;
      message += `• *Bearish/Weak*: ${analysis.length - uptrendCount - opportunityCount} (Below EMAs or ST Red)\n\n`;

      if (opportunityCount > 0) {
        message += `🚀 *Action*: Found ${opportunityCount} dip opportunities! Check the Trading Workflow.`;
      } else if (uptrendCount > 0) {
        message += `💎 *Action*: Market is strong but not at a discount. No new entries recommended.`;
      } else {
        message += `⚠️ *Action*: Market looks weak. Stay cautious.`;
      }

      await sendTelegramMessage(message, {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID
      });
    });
  }
}
