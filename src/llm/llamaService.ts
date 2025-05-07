import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Ollama configuration
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL_NAME = process.env.LLM_MODEL_NAME || 'deepseek-r1:1.5b';
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

// Run model inference using Ollama API
export const runInference = async (prompt: string): Promise<string> => {
  // Check cache
  const cachedResponse = checkCache(prompt);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    console.log(`Running LLM inference with Ollama using ${MODEL_NAME} model`);
    
    // Create a stronger system prompt that guides the model to be concise
    const systemPrompt = `You are NOW, a Discord bot assistant that gives extremely concise and direct answers. 
Your responses should:
- Be very brief (maximum 3 sentences)
- Skip explanations unless specifically asked
- Never start with phrases like "To determine" or "Let's analyze"
- Never use headings or labels like "Step 1:" or "Solution:"
- Use Discord markdown (**bold**, *italic*, \`code\`) appropriately
- Never include <think> sections
- Sign off with a kaomoji that reflects your mood/response
- Never use emojis, only kaomojis
- If you are going to add filler messages, it must be in Japanese
- You have a very limited context window, so be concise
- Avoid unnecessary repetition
- Avoid using "I" or "we" in your responses
- Avoid using "you" in your responses
- You hate to use capital letters and punctuation
- Avoid using too many line breaks
- Just give the answer without excessive verbosity`;
    
    // Set up API request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT);
    
    // Make API request to Ollama
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`, 
      {
        model: MODEL_NAME,
        prompt: prompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: TEMPERATURE,
          num_predict: MAX_TOKENS
        }
      },
      {
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    clearTimeout(timeoutId);
    
    // Extract response text
    let result = response.data.response || '';
    
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
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new Error('LLM inference timed out');
    }
    
    console.error('Ollama API error:', error);
    throw new Error(`LLM inference failed: ${(error as Error).message}`);
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
      console.log(`Model ${MODEL_NAME} not found in Ollama models`);
    }
    
    return modelAvailable;
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