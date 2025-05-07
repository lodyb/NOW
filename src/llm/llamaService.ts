import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Model configuration
const MODEL_PATH = process.env.LLM_MODEL_PATH || '';
const MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '2048', 10);
const TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || '0.7');
const GPU_LAYERS = parseInt(process.env.LLM_GPU_LAYERS || '35', 10);
const CONTEXT_SIZE = parseInt(process.env.LLM_CONTEXT_SIZE || '4096', 10);
const BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || '512', 10);
const INFERENCE_TIMEOUT = parseInt(process.env.LLM_TIMEOUT || '60000', 10); // 60 seconds
const LLAMA_CPP_PATH = process.env.LLAMA_CPP_PATH || 'llama-cpp';
const LLAMA_CPP_DIR = path.dirname(LLAMA_CPP_PATH || '');

// Cache for recent queries
interface CacheEntry {
  response: string;
  timestamp: number;
}
const queryCache = new Map<string, CacheEntry>();
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

// Check if model exists
const validateModel = (): boolean => {
  if (!MODEL_PATH) {
    console.error('LLM_MODEL_PATH not set in environment variables');
    return false;
  }
  
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`Model file not found at: ${MODEL_PATH}`);
    return false;
  }
  
  return true;
};

// Process the prompt for the model
const processPrompt = (prompt: string): string => {
  // Limit prompt size to prevent context overflow
  const maxPromptLength = CONTEXT_SIZE - MAX_TOKENS - 100;
  if (prompt.length > maxPromptLength) {
    return prompt.substring(0, maxPromptLength);
  }
  return prompt;
};

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

// Run model inference using llama.cpp
export const runInference = (prompt: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    // Validate model
    if (!validateModel()) {
      return reject(new Error('LLM model not available'));
    }
    
    // Check cache
    const cachedResponse = checkCache(prompt);
    if (cachedResponse) {
      return resolve(cachedResponse);
    }
    
    // Process the prompt
    const processedPrompt = processPrompt(prompt);
    
    // Setup llama.cpp parameters - use only basic flags supported by all versions
    const llamaArgs = [
        '-m', MODEL_PATH,
        '-n', MAX_TOKENS.toString(),
        '--temp', TEMPERATURE.toString(),
        '--ctx-size', CONTEXT_SIZE.toString(),
        '-b', BATCH_SIZE.toString(),
        '-ngl', GPU_LAYERS.toString(),
        '--log-disable',
        '--prompt-cache-all',
        '--threads', '12',
        '-p', processedPrompt
      ];
    
    console.log(`Running LLM inference with ${GPU_LAYERS} GPU layers`);
    
    // Prepare environment with LD_LIBRARY_PATH to include llama.cpp directory
    const env = { ...process.env };
    if (LLAMA_CPP_DIR) {
      env.LD_LIBRARY_PATH = `${LLAMA_CPP_DIR}:${env.LD_LIBRARY_PATH || ''}`;
    }
    
    try {
      // Spawn llama.cpp process with updated environment
      const llamaProcess = spawn(LLAMA_CPP_PATH, llamaArgs, { env });
      
      let output = '';
      let error = '';
      let timeout: NodeJS.Timeout | null = null;
      
      // Set timeout for inference
      timeout = setTimeout(() => {
        llamaProcess.kill();
        reject(new Error('LLM inference timed out'));
      }, INFERENCE_TIMEOUT);
      
      // Collect stdout
      llamaProcess.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      // Collect stderr
      llamaProcess.stderr.on('data', (data) => {
        error += data.toString();
      });
      
      // Handle process completion
      llamaProcess.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        
        if (code !== 0) {
          console.error(`llama.cpp exited with code ${code}`);
          console.error(`Error: ${error}`);
          reject(new Error(`LLM inference failed with code ${code}`));
          return;
        }
        
        // Extract the model's response (remove prompt and llama.cpp output info)
        const lines = output.split('\n');
        let responseStarted = false;
        let responseLines: string[] = [];
        
        for (const line of lines) {
          // Skip llama.cpp info lines
          if (line.startsWith('llama_model_loader:') || 
              line.startsWith('llama_new_context_with_model:') ||
              line.startsWith('ggml_metal_init:') ||
              line.startsWith('llama_print_timings:')) {
            continue;
          }
          
          // Start collecting response after we see the prompt
          if (line.includes(processedPrompt.substring(0, 20))) {
            responseStarted = true;
            continue;
          }
          
          if (responseStarted) {
            responseLines.push(line);
          }
        }
        
        // Join response lines
        const response = responseLines.join('\n').trim();
        
        // Cache the response
        updateCache(prompt, response);
        
        resolve(response);
      });
      
      // Handle errors
      llamaProcess.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        console.error('Failed to start llama.cpp process:', err);
        reject(new Error('Failed to start LLM inference process'));
      });
    } catch (error) {
      console.error('Error spawning llama.cpp process:', error);
      reject(new Error(`Failed to start LLM process: ${(error as Error).message}`));
    }
  });
};

// Check if the LLM service is ready
export const isLLMServiceReady = (): boolean => {
  return validateModel();
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