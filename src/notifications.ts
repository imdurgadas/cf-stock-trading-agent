export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export async function sendTelegramMessage(message: string, config: TelegramConfig) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: message,
      parse_mode: 'Markdown',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram error: ${error}`);
  }

  return response.json();
}
