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
      return await agent.findOpportunities({
        min_fall_pct: -2.0,
        min_rsi: 50
      });
    });

    if (!opportunities || opportunities.length === 0) {
      console.log("No opportunities found today.");
      return;
    }

    // 2. Notify via Telegram
    await step.do("notify-user", async () => {
      const loginStatus = await agent.checkKiteLogin();
      
      let message = `🚀 *Stock Alert*
Found ${opportunities.length} buy opportunities.
Top Pick: ${opportunities[0].symbol} (RSI: ${opportunities[0].rsi})\n\n`;

      if (loginStatus.status === "disconnected") {
        message += `⚠️ *Action Required*: Your Kite session has expired.\n1. [Login to Kite](${loginStatus.loginUrl})\n2. After logging in, click the button below.\n\n`;
      }

      message += `[Approve & Buy ₹${amount}](https://cf-stock-trading-agent.durgadas.in/approve?workflowId=${this.workflowId})`;

      await sendTelegramMessage(message, {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID
      });
    });

    // 3. Wait for Approval (Human-in-the-loop)
    const approval = await this.waitForApproval(step, {
      timeout: "1 hour",
      stepName: "User Approval"
    }) as { approved: boolean };

    if (!approval.approved) {
      console.log("Trade rejected by user.");
      return;
    }

    // 4. Place Orders
    const results = await step.do("place-orders", async () => {
      return await agent.executeOrders({
        amount: amount,
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
