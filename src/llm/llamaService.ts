import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Ollama configuration
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL_NAME = process.env.LLM_MODEL_NAME || 'gemma3:4b';
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '2048', 10);
const TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.7');
const INFERENCE_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || '60000', 10); // 60 seconds

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

/**
 * Sanitize LLM response to remove potentially dangerous mentions
 */
const sanitizeResponse = (text: string): string => {
  // Replace @everyone and @here with safe versions that don't ping
  return text
    .replace(/@everyone/gi, '`@everyone`')
    .replace(/@here/gi, '`@here`');
};

// Run model inference using Ollama API
export const runInference = async (prompt: string): Promise<string> => {
  // Check cache
  const cachedResponse = checkCache(prompt);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    console.log(`Running LLM inference with Ollama using ${MODEL_NAME} model`);
    
    // Create a concise system prompt
    const systemPrompt = `You are NOW, a Discord bot assistant that gives extremely concise answers. Be brief, direct, and use Discord markdown when appropriate. Sign off with a fun kaomoji.`;
    
    // Clean the prompt to prevent any confusion
    const cleanPrompt = prompt.replace(/<@&\d+>/g, '').trim();
    
    // Set up API request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT);
    
    // Make API request to Ollama with reduced context parameters
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`, 
      {
        model: MODEL_NAME,
        prompt: cleanPrompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: TEMPERATURE,
          num_predict: Math.min(MAX_TOKENS, 2048),
          context: 0,
          seed: Date.now()
        }
      },
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
    
    // Add kaomoji if none exists
    if (!result.match(/\([^)]*[_^;].*\)/)) {
      const kaomojis = ['(^_^)', '(｡･ω･｡)', '(⌐■_■)', '(≧◡≦)', '(^▽^)', '(✿◠‿◠)'];
      const randomKaomoji = kaomojis[Math.floor(Math.random() * kaomojis.length)];
      result += `\n\n${randomKaomoji}`;
    }
    
    // Cache the response
    updateCache(prompt, result);
    
    return result;
  } catch (error) {
    console.error('Ollama API error:', error);
    
    // Provide a friendly fallback response
    const fallbackResponses = [
      "Sorry, I'm having a bit of trouble with my thinking process right now. Try again in a moment? (･_･;",
      "Hmm, it seems my brain is taking a short break. I'll be back to normal soon! (¬_¬)",
      "My AI circuits need a quick reboot. Please try again shortly. (￣▽￣*)ゞ",
      "I hit a small technical snag. Let me catch my breath and try again later. (・・;)",
      "Oops! My models are a bit overloaded. I'll be back to full capacity soon! (◕︵◕)"
    ];
    
    const randomResponse = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
    return randomResponse;
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