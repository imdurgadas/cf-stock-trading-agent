export interface TelegramConfig {
  botToken: string;
  chatId: string;
  parseMode?: 'Markdown' | 'HTML';
  replyMarkup?: any;
}

export async function sendTelegramMessage(message: string, config: TelegramConfig) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  
  let msgText = message;
  if (config.parseMode === 'Markdown' || !config.parseMode) {
    msgText = msgText.replace(/__(.*?)__/g, "*$1*");
    msgText = msgText.replace(/<\/?u>/gi, "");
  }
  if (msgText.length > 4000) {
    console.warn(`[Telegram] Message is too long (${msgText.length} chars). Truncating to 3900 chars...`);
    msgText = msgText.substring(0, 3900) + "\n\n[Message Truncated...]";
  }

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: msgText,
      parse_mode: config.parseMode || 'Markdown',
      reply_markup: config.replyMarkup
    }),
  });

  if (!response.ok) {
    const errorText = await response.clone().text();
    console.warn(`[Telegram] sendMessage failed. Status: ${response.status}. Error: ${errorText}`);
    if (errorText.includes("can't parse entities") || errorText.includes("entities")) {
      console.warn("[Telegram] Entity parsing failed on send, retrying in plain text...");
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: msgText,
          reply_markup: config.replyMarkup
        }),
      });
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram error: ${error}`);
  }

  return response.json();
}

export async function editTelegramMessage(messageId: number, message: string, config: TelegramConfig) {
  const url = `https://api.telegram.org/bot${config.botToken}/editMessageText`;
  
  let msgText = message;
  if (config.parseMode === 'Markdown' || !config.parseMode) {
    msgText = msgText.replace(/__(.*?)__/g, "*$1*");
    msgText = msgText.replace(/<\/?u>/gi, "");
  }
  if (msgText.length > 4000) {
    console.warn(`[Telegram] Edited message is too long (${msgText.length} chars). Truncating to 3900 chars...`);
    msgText = msgText.substring(0, 3900) + "\n\n[Message Truncated...]";
  }

  let response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      message_id: messageId,
      text: msgText,
      parse_mode: config.parseMode || 'Markdown',
      reply_markup: config.replyMarkup
    }),
  });

  if (!response.ok) {
    const errorText = await response.clone().text();
    console.warn(`[Telegram] editMessageText failed. Status: ${response.status}. Error: ${errorText}`);
    if (errorText.includes("can't parse entities") || errorText.includes("entities")) {
      console.warn("[Telegram] Entity parsing failed on edit, retrying in plain text...");
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: config.chatId,
          message_id: messageId,
          text: msgText,
          reply_markup: config.replyMarkup
        }),
      });
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram edit error: ${error}`);
  }

  return response.json();
}

export async function answerTelegramCallback(callbackQueryId: string, botToken: string) {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      callback_query_id: callbackQueryId
    }),
  });
}
