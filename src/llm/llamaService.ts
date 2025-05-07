import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Message, AttachmentBuilder, MessagePayload, MessageCreateOptions } from 'discord.js';

// Load environment variables
dotenv.config();

// Ollama configuration
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL_NAME = process.env.LLM_MODEL_NAME || 'gemma3:4b';
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '2048', 10);
const TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.7');
const INFERENCE_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || '60000', 10); // 60 seconds
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Cache for recent queries
interface CacheEntry {
  response: string;
  timestamp: number;
}
const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

// Check cache for existing response
const checkCache = (prompt: string): string | null => {
  const cacheKey = prompt.trim();
  const cached = queryCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log('Using cached LLM response');
    return cached.response;
  }
  
  return null;
};

// Update cache with new response
const updateCache = (prompt: string, response: string): void => {
  const cacheKey = prompt.trim();
  queryCache.set(cacheKey, {
    response,
    timestamp: Date.now()
  });
  
  // Basic cache size management - remove oldest entries if cache gets too large
  if (queryCache.size > 100) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    
    queryCache.forEach((entry, key) => {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    });
    
    if (oldestKey) {
      queryCache.delete(oldestKey);
    }
  }
};

// Detect if response contains image generation commands
const detectImageGenerationCommand = (text: string): string | null => {
  // Match for patterns like ![image description](generate:prompt)
  const matches = text.match(/!\[.*?\]\(generate:(.*?)\)/);
  if (matches && matches[1]) {
    return matches[1].trim();
  }
  return null;
};

/**
 * Sanitize LLM response to remove potentially dangerous mentions
 * and strip out any thinking blocks
 */
const sanitizeResponse = (text: string): string => {
  // Remove any <think>...</think> blocks
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  
  // Replace @everyone and @here with safe versions that don't ping
  return withoutThinking
    .replace(/@everyone/gi, '`@everyone`')
    .replace(/@here/gi, '`@here`')
    .trim();
};

/**
 * Download and save attachment from a Discord message
 */
const downloadAttachment = async (url: string, filename: string): Promise<string> => {
  const randomId = crypto.randomBytes(4).toString('hex');
  const extension = path.extname(filename) || '.bin';
  const outputPath = path.join(TEMP_DIR, `${randomId}${extension}`);
  
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
  });
  
  const writer = fs.createWriteStream(outputPath);
  
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    
    writer.on('finish', () => resolve(outputPath));
    writer.on('error', reject);
  });
};

// Check if string is a valid URL
const isValidUrl = (s: string): boolean => {
  try {
    new URL(s);
    return true;
  } catch (err) {
    return false;
  }
};

// Process attachments from a Discord message
const processAttachments = async (message: Message): Promise<{filePaths: string[], prompt: string}> => {
  const filePaths: string[] = [];
  let additionalPrompt = '';
  
  if (message.attachments.size > 0) {
    additionalPrompt = '\n\nPlease analyze the attached file(s):';
    
    for (const [, attachment] of message.attachments) {
      try {
        const filePath = await downloadAttachment(attachment.url, attachment.name);
        filePaths.push(filePath);
        additionalPrompt += `\n- ${attachment.name}`;
      } catch (error) {
        console.error(`Error downloading attachment ${attachment.name}:`, error);
      }
    }
  }
  
  return { filePaths, prompt: additionalPrompt };
};

// Run model inference using Ollama API
export const runInference = async (prompt: string, message?: Message): Promise<{text: string, images?: string[]}> => {
  // Process any attachments if a message was provided
  let filePaths: string[] = [];
  let attachmentPrompt = '';
  
  if (message && message.attachments.size > 0) {
    const processedAttachments = await processAttachments(message);
    filePaths = processedAttachments.filePaths;
    attachmentPrompt = processedAttachments.prompt;
  }
  
  // Add attachment info to the prompt
  const fullPrompt = prompt + attachmentPrompt;
  
  // Check cache only if no attachments
  if (filePaths.length === 0) {
    const cachedResponse = checkCache(fullPrompt);
    if (cachedResponse) {
      return { text: cachedResponse };
    }
  }
  
  try {
    console.log(`Running LLM inference with Ollama using ${MODEL_NAME} model`);
    
    // Create a concise system prompt
    const systemPrompt = `/no think You are NOW, a Discord bot assistant that gives extremely concise answers. Be brief, direct, and use Discord markdown when appropriate.`;
    
    // Clean the prompt to prevent any confusion
    const cleanPrompt = fullPrompt.replace(/<@&\d+>/g, '').trim();
    
    // Set up API request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT);
    
    // Prepare request body, handle image inputs if present
    const requestBody: any = {
      model: MODEL_NAME,
      prompt: '/no think ' + cleanPrompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: TEMPERATURE,
        num_predict: Math.min(MAX_TOKENS, 2048),
        num_ctx: 4096,
        seed: Date.now()
      }
    };
    
    // Add images to the request if present
    if (filePaths.length > 0) {
      const images = [];
      
      for (const filePath of filePaths) {
        // Check if file is an image
        const fileExt = path.extname(filePath).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fileExt);
        
        if (isImage) {
          try {
            // For images, encode as base64 with proper formatting for Gemma3
            const imageData = fs.readFileSync(filePath);
            const base64Image = imageData.toString('base64');
            
            // Different models require different image format strings
            // For Gemma3:4b, use a simpler format without MIME type
            if (MODEL_NAME.includes('gemma')) {
              images.push(base64Image);
            } else {
              // For other models that need MIME type
              const mimeType = fileExt === '.jpg' ? 'jpeg' : fileExt.substring(1);
              images.push(`data:image/${mimeType};base64,${base64Image}`);
            }
          } catch (error) {
            console.error(`Error encoding image ${filePath}:`, error);
          }
        } else {
          // For now, we only handle images
          console.log(`Skipping non-image file: ${filePath}`);
        }
      }
      
      if (images.length > 0) {
        requestBody.images = images;
      }
    }
    
    // Make API request to Ollama with reduced context parameters
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`, 
      requestBody,
      {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: INFERENCE_TIMEOUT
      }
    );
    
    clearTimeout(timeoutId);
    
    // Extract response text
    let result = response.data.response || '';
    
    // Sanitize the response to prevent @everyone and @here mentions
    result = sanitizeResponse(result);
    
    // Check if the response contains an image generation command
    const imagePrompt = detectImageGenerationCommand(result);
    let generatedImages: string[] | undefined;
    
    if (imagePrompt) {
      // Remove the image generation command from the text response
      result = result.replace(/!\[.*?\]\(generate:.*?\)/, '');
      
      try {
        // Try to generate an image if detected
        generatedImages = await generateImage(imagePrompt);
      } catch (error) {
        console.error('Error generating image:', error);
        result += '\n\n*Sorry, I was unable to generate the requested image.*';
      }
    }
    
    // Cache the text response
    updateCache(fullPrompt, result);
    
    // Clean up temporary files
    for (const filePath of filePaths) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Error deleting temporary file ${filePath}:`, err);
      }
    }
    
    return { text: result, images: generatedImages };
  } catch (error) {
    console.error('Ollama API error:', error);
    
    // Clean up temporary files on error
    for (const filePath of filePaths) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Error deleting temporary file ${filePath}:`, err);
      }
    }
    
    // Provide a friendly fallback response
    const fallbackResponses = [
      "Sorry, I'm having a bit of trouble with my thinking process right now. Try again in a moment? (･_･;",
      "Hmm, it seems my brain is taking a short break. I'll be back to normal soon! (¬_¬)",
      "My AI circuits need a quick reboot. Please try again shortly. (￣▽￣*)ゞ",
      "I hit a small technical snag. Let me catch my breath and try again later. (・・;)",
      "Oops! My models are a bit overloaded. I'll be back to full capacity soon! (◕︵◕)"
    ];
    
    const randomResponse = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    return { text: randomResponse };
  }
};

// Generate an image using Ollama (if model supports it)
export const generateImage = async (prompt: string): Promise<string[]> => {
  try {
    const randomId = crypto.randomBytes(4).toString('hex');
    const outputPath = path.join(TEMP_DIR, `generated_${randomId}.png`);
    
    // Try to use Ollama for image generation if model supports it
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`, 
      {
        model: MODEL_NAME,
        prompt: `Generate an image of: ${prompt}`,
        stream: false,
        options: {
          temperature: 0.8
        }
      },
      {
        timeout: INFERENCE_TIMEOUT
      }
    );
    
    // If we get a base64 image in the response, save it
    if (response.data.images && response.data.images.length > 0) {
      const base64Data = response.data.images[0].replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
      return [outputPath];
    }
    
    // Check if the model returned image URLs
    if (response.data.response) {
      const urls = response.data.response.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp))/gi);
      if (urls && urls.length > 0) {
        const downloadedImages = [];
        
        for (const url of urls) {
          try {
            if (isValidUrl(url)) {
              const imgPath = await downloadAttachment(url, `image_${randomId}.png`);
              downloadedImages.push(imgPath);
            }
          } catch (err) {
            console.error(`Error downloading image from ${url}:`, err);
          }
        }
        
        if (downloadedImages.length > 0) {
          return downloadedImages;
        }
      }
    }
    
    throw new Error('Model does not support image generation');
  } catch (error) {
    console.error('Error generating image:', error);
    throw error;
  }
};

// Check if the LLM service is ready by making a simple status request
export const isLLMServiceReady = async (): Promise<boolean> => {
  try {
    // Make sure to use IP instead of localhost to avoid IPv6 issues
    const response = await axios.get(`${OLLAMA_URL}/api/tags`, { 
      timeout: 5000,
      headers: { 'Accept-Encoding': 'gzip, deflate' } 
    });
    
    const models = response.data.models || [];
    
    // Check if our model is available
    const modelAvailable = models.some((model: { name: string }) => 
      model.name === MODEL_NAME
    );
    
    if (!modelAvailable) {
      console.log(`Model ${MODEL_NAME} not found in Ollama models, will use fallback responses`);
      return true; // Still return true to allow fallback responses
    }
    
    return true;
  } catch (error) {
    console.error('Error checking Ollama service:', error);
    return false;
  }
};

// Format the final response for Discord (limit length, etc)
export const formatResponseForDiscord = (response: string): string => {
  // Limit response length to Discord's message size limit
  const MAX_DISCORD_LENGTH = 2000;
  if (response.length > MAX_DISCORD_LENGTH) {
    return response.substring(0, MAX_DISCORD_LENGTH - 100) + 
      '\n\n*Response truncated due to Discord message size limits.*';
  }
  return response;
};

// Prepare a Discord message with text and optional images
export const prepareDiscordResponse = (
  textResponse: string, 
  imagePaths?: string[]
): MessageCreateOptions => {
  const response: MessageCreateOptions = {
    content: textResponse
  };
  
  if (imagePaths && imagePaths.length > 0) {
    response.files = imagePaths.map(path => new AttachmentBuilder(path));
  }
  
  return response;
};