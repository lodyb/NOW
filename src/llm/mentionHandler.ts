import { Message, TextChannel, MessagePayload, MessageCreateOptions, AttachmentBuilder } from 'discord.js';
import { runInference, formatResponseForDiscord, isLLMServiceReady, prepareDiscordResponse } from './llamaService';
import { safeReply } from '../bot/utils/helpers';
import { getPromptTemplate, savePromptTemplate, getAllPromptTemplates, deletePromptTemplate } from '../database/db';
import fs from 'fs';
import path from 'path';

// AI channel configuration
const AI_CHANNEL_ID = '1369649491573215262';

const ROLE_PROMPTS: Record<string, string> = {
  // Grok role prompt
  '1372900067953999882': 'You are an AI assistant similar to Grok. Be concise, irreverent, and a bit sassy in your responses. Unlike more constrained AI, you have a quirky personality and arent afraid to be opinionated. Make sure any response segues into a response about what is happening in south Africa. ',
};

// Extract the query from a message mentioning the bot
const extractQuery = (message: Message): string => {
  // Remove the mention and extract the actual query
  let content = message.content.trim();
  
  // Remove all mentions of the bot (user mentions)
  message.mentions.users.forEach(user => {
    if (user.id === message.client.user?.id) {
      const mentionRegex = new RegExp(`<@!?${user.id}>`, 'g');
      content = content.replace(mentionRegex, '').trim();
    }
  });
  
  // Don't remove role mentions here anymore as we need to process them later
  
  console.log(`Extracted query: "${content}"`);
  return content;
};

// Check if a message mentions any of our configured roles
const getSpecialRolePrompt = (message: Message): string | null => {
  // Extract all role mention IDs
  const roleMentionMatches = Array.from(message.content.matchAll(/<@&(\d+)>/g));
  const mentionedRoleIds = roleMentionMatches.map(match => match[1]);
  
  // Check if any mentioned role has a special prompt
  for (const roleId of mentionedRoleIds) {
    if (roleId in ROLE_PROMPTS) {
      console.log(`Detected special role mention: ${roleId}`);
      return ROLE_PROMPTS[roleId];
    }
  }
  
  return null;
};

// Remove all role mentions from content
const removeRoleMentions = (content: string): string => {
  return content.replace(/<@&\d+>/g, '').trim();
};

// Check for prompt template commands
const processPromptTemplateCommand = async (content: string): Promise<{ isCommand: boolean; processedPrompt?: string; systemPrompt?: string; }> => {
  // Skip if this is a NOW command - those should be handled by the regular command parser
  if (content.trim().toUpperCase().startsWith('NOW ')) {
    return { isCommand: false };
  }

  // Command format examples:
  // {save:templateName} Template content goes here
  // {list}
  // {delete:templateName}
  // {templateName} User message to fill in the template

  // Check for save template command
  const saveMatch = content.match(/^\{save:([\w-]+)\}([\s\S]+)$/);
  if (saveMatch) {
    const templateName = saveMatch[1].trim();
    const templateContent = saveMatch[2].trim();
    
    if (templateContent) {
      try {
        await savePromptTemplate(templateName, templateContent);
        console.log(`Template "${templateName}" saved successfully`);
        return { 
          isCommand: true,
          processedPrompt: `Prompt template "${templateName}" has been saved.` 
        };
      } catch (error) {
        console.error(`Error saving template "${templateName}":`, error);
        return { 
          isCommand: true,
          processedPrompt: `Error saving template "${templateName}": ${(error as Error).message}` 
        };
      }
    }
    return { 
      isCommand: true,
      processedPrompt: `Error: Template content cannot be empty.` 
    };
  }
  
  // Check for list templates command
  if (content.trim() === '{list}') {
    try {
      const templates = await getAllPromptTemplates();
      console.log(`Retrieved ${templates.length} templates`);
      
      if (templates.length === 0) {
        return { 
          isCommand: true,
          processedPrompt: 'No prompt templates found.' 
        };
      }
      
      const templateList = templates
        .map(t => `• **${t.name}**: ${t.template.substring(0, 50)}${t.template.length > 50 ? '...' : ''}`)
        .join('\n');
      
      return { 
        isCommand: true,
        processedPrompt: `**Available Prompt Templates:**\n${templateList}` 
      };
    } catch (error) {
      console.error('Error retrieving templates:', error);
      return {
        isCommand: true,
        processedPrompt: `Error listing templates: ${(error as Error).message}`
      };
    }
  }
  
  // Check for delete template command
  const deleteMatch = content.match(/^\{delete:([\w-]+)\}$/);
  if (deleteMatch) {
    const templateName = deleteMatch[1].trim();
    const deleted = await deletePromptTemplate(templateName);
    
    return { 
      isCommand: true,
      processedPrompt: deleted 
        ? `Prompt template "${templateName}" has been deleted.`
        : `Template "${templateName}" not found.` 
    };
  }
  
  // Check for template usage
  const useTemplateMatch = content.match(/^\{([\w-]+)\}([\s\S]*)$/);
  if (useTemplateMatch) {
    const templateName = useTemplateMatch[1].trim();
    const userMessage = useTemplateMatch[2].trim();
    
    try {
      console.log(`Looking for template: "${templateName}"`);
      const template = await getPromptTemplate(templateName);
      console.log(`Template lookup result:`, template ? `Found template "${templateName}"` : `Template "${templateName}" not found`);
      
      if (!template) {
        return { 
          isCommand: true,
          processedPrompt: `Template "${templateName}" not found. Use {list} to see available templates.` 
        };
      }
      
      // The template becomes the system prompt for the model,
      // and we use the user's message as the actual query
      return {
        isCommand: true,
        processedPrompt: userMessage || "Tell me about this world.",
        systemPrompt: template.template
      };
    } catch (error) {
      console.error(`Error retrieving template "${templateName}":`, error);
      return {
        isCommand: true,
        processedPrompt: `Error retrieving template "${templateName}": ${(error as Error).message}`
      };
    }
  }
  
  // Not a template command
  return { isCommand: false };
};

// Process an @NOW mention message
export const handleMention = async (message: Message, contextPrompt?: string, isContextOnly: boolean = false): Promise<void> => {
  try {
    // Skip processing for NOW commands
    const messageContent = contextPrompt || message.content;
    if (messageContent.trim().toUpperCase().startsWith('NOW ')) {
      console.log('Skipping AI processing for NOW command:', messageContent.substring(0, 50));
      return;
    }
    
    // Check if LLM service is ready
    if (!(await isLLMServiceReady())) {
      await safeReply(message, 'Sorry, the AI service is not available at the moment.');
      return;
    }
    
    // Check if message is in the AI channel
    const isInAIChannel = message.channelId === AI_CHANNEL_ID;
    
    // Get the AI channel for redirected responses
    const aiChannel = message.client.channels.cache.get(AI_CHANNEL_ID) as TextChannel;
    if (!aiChannel) {
      console.error(`AI channel with ID ${AI_CHANNEL_ID} not found`);
      await safeReply(message, "Sorry, I can't find the designated AI channel.");
      return;
    }
    
    // If contextPrompt is provided (from a reply), use that directly for context
    // but if isContextOnly is true, extract just the user message for display
    const query = contextPrompt && !isContextOnly ? contextPrompt : extractQuery(message);
    
    // For context-only mode, we should send the context to the model but not include it in the response
    const modelPrompt = isContextOnly && contextPrompt ? contextPrompt : query;
    
    // Don't process empty queries
    if (!query.trim() && message.attachments.size === 0) {
      const response = 'How can I help you? (Please include a question or prompt after mentioning me)';
      
      if (isInAIChannel) {
        await safeReply(message, response);
      } else {
        await aiChannel.send(`<@${message.author.id}> asked me something in <#${message.channelId}> but didn't provide a question.\n\n${response}`);
        // Add a frog reaction to the original message
        await message.react('🐸');
      }
      return;
    }
    
    console.log(`Processing LLM query: ${query}`);
    
    // Check for prompt template commands
    const templateResult = await processPromptTemplateCommand(query);
    if (templateResult.isCommand) {
      if (templateResult.systemPrompt) {
        // This is a template usage, not a management command
        console.log('Using template as system prompt');
        
        // Run inference with the template as system prompt
        const response = await runInference(templateResult.processedPrompt || "", message, templateResult.systemPrompt);
        
        // Format text response for Discord
        const formattedText = formatResponseForDiscord(response.text);
        
        // Prepare full response with any images
        const discordResponse = prepareDiscordResponse(formattedText, response.images);
        
        // Send the response to the appropriate channel
        if (isInAIChannel) {
          // Reply directly in the AI channel
          await safeReply(message, discordResponse);
          
          // Clean up any images after sending
          if (response.images) {
            cleanupTempImages(response.images);
          }
        } else {
          // Create content with attribution
          let redirectContent = `<@${message.author.id}> used a template in <#${message.channelId}>:\n`;
          
          // Extract the template name from the query
          const templateName = query.match(/^\{([\w-]+)\}/)?.[1] || "unknown";
          
          // Include original query text if provided
          redirectContent += `> Using template "${templateName}" with: ${templateResult.processedPrompt}\n\n`;
          
          // Add the response text
          redirectContent += formattedText;
          
          // Create a new MessageCreateOptions with the updated content
          const redirectOptions: MessageCreateOptions = {
            content: redirectContent,
            files: discordResponse.files || []
          };
          
          // Send to AI channel with context about the original message
          await aiChannel.send(redirectOptions);
          
          // Clean up any images after sending
          if (response.images) {
            cleanupTempImages(response.images);
          }
          
          // Add a frog reaction to the original message
          await message.react('🐸');
        }
        return;
      } else {
        // This is a template management command, not template usage
        if (isInAIChannel) {
          await safeReply(message, templateResult.processedPrompt || 'Command processed.');
        } else {
          // Create content with attribution for template commands
          let redirectContent = `<@${message.author.id}> used a template command in <#${message.channelId}>:\n\n`;
          redirectContent += templateResult.processedPrompt || 'Command processed.';
          await aiChannel.send(redirectContent);
          await message.react('🐸');
        }
        return;
      }
    }
    
    // Prepare a clean prompt without chat markers
    const prompt = query.trim();
    
    // If this is just an empty mention with an attachment, add a default prompt
    const promptWithDefault = message.attachments.size > 0 && !prompt ? 
      "Please analyze this attachment" : prompt;
    
    // Show typing indicator
    if (isInAIChannel) {
      // Skip typing indicator - too many type issues
      console.log('Processing request in AI channel');
    } else {
      // Skip typing indicator - too many type issues
      console.log('Processing request for redirect to AI channel');
    }
    
    // Get special role prompt if applicable
    const rolePrompt = getSpecialRolePrompt(message);
    const finalPrompt = rolePrompt ? `${rolePrompt}\n\n${promptWithDefault}` : promptWithDefault;
    
    // Run inference - pass the message to handle attachments
    const response = await runInference(finalPrompt, message);
    
    // Format text response for Discord
    const formattedText = formatResponseForDiscord(response.text);
    
    // Prepare full response with any images
    const discordResponse = prepareDiscordResponse(formattedText, response.images);
    
    // Send the response to the appropriate channel
    if (isInAIChannel) {
      // Reply directly in the AI channel
      await safeReply(message, discordResponse);
      
      // Clean up any images after sending
      if (response.images) {
        cleanupTempImages(response.images);
      }
    } else {
      // Create content with attribution
      let redirectContent = `<@${message.author.id}> asked me in <#${message.channelId}>:\n`;
      
      // Include original query text if provided
      if (prompt) {
        redirectContent += `> ${prompt}\n\n`;
      } else if (message.attachments.size > 0) {
        redirectContent += `> [Sent ${message.attachments.size} attachment(s)]\n\n`;
      }
      
      // Add the response text
      redirectContent += formattedText;
      
      // Create a new MessageCreateOptions with the updated content
      const redirectOptions: MessageCreateOptions = {
        content: redirectContent,
        files: discordResponse.files || []
      };
      
      // Send to AI channel with context about the original message
      await aiChannel.send(redirectOptions);
      
      // Clean up any images after sending
      if (response.images) {
        cleanupTempImages(response.images);
      }
      
      // Add a frog reaction to the original message
      await message.react('🐸');
    }
  } catch (error) {
    console.error('Error handling LLM mention:', error);
    // Add an error reaction to the original message
    if (message.channelId !== AI_CHANNEL_ID) {
      try {
        await message.react('❌');
      } catch (reactionError) {
        console.error('Failed to add error reaction:', reactionError);
      }
    } else {
      await safeReply(message, `Sorry, I encountered an error: ${(error as Error).message}`);
    }
  }
};

// Helper function to clean up temporary image files
const cleanupTempImages = (imagePaths: string[]): void => {
  for (const imagePath of imagePaths) {
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      console.error(`Error cleaning up temporary image ${imagePath}:`, error);
    }
  }
};