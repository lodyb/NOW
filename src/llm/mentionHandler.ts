import { Message } from 'discord.js';
import { runInference, formatResponseForDiscord, isLLMServiceReady } from './llamaService';
import { safeReply } from '../bot/utils/helpers';

// Extract the query from a message mentioning the bot
const extractQuery = (message: Message): string => {
  // Remove the mention and extract the actual query
  let content = message.content.trim();
  
  // Remove all mentions of the bot
  message.mentions.users.forEach(user => {
    if (user.id === message.client.user?.id) {
      const mentionRegex = new RegExp(`<@!?${user.id}>`, 'g');
      content = content.replace(mentionRegex, '').trim();
    }
  });
  
  return content;
};

// Process an @NOW mention message
export const handleMention = async (message: Message): Promise<void> => {
  try {
    // Check if LLM service is ready
    if (!(await isLLMServiceReady())) {
      await safeReply(message, 'Sorry, the AI service is not available at the moment.');
      return;
    }
    
    // Extract query from message
    const query = extractQuery(message);
    
    // Don't process empty queries
    if (!query.trim()) {
      await safeReply(message, 'How can I help you? (Please include a question or prompt after mentioning me)');
      return;
    }
    
    console.log(`Processing LLM query: ${query}`);
    
    // Prepare a clean prompt without chat markers
    const prompt = query.trim();
    
    // Run inference
    const response = await runInference(prompt);
    
    // Format response for Discord
    const formattedResponse = formatResponseForDiscord(response);
    
    // Send the response
    await safeReply(message, formattedResponse);
  } catch (error) {
    console.error('Error handling LLM mention:', error);
    await safeReply(message, `Sorry, I encountered an error: ${(error as Error).message}`);
  }
};