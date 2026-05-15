import { AgentWorkflow, AgentWorkflowStep, AgentWorkflowEvent } from "agents/workflows";
import { TradingAgent } from "./index";
import { sendTelegramMessage } from "./notifications";

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
