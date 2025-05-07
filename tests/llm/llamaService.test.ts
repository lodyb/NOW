import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { spawn } from 'child_process';
import { runInference, formatResponseForDiscord, isLLMServiceReady } from '../../src/llm/llamaService';
import fs from 'fs';

// Mock dependencies
jest.mock('child_process');
jest.mock('fs');

describe('LLM Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock environment values
    process.env.LLM_MODEL_PATH = '/path/to/model.gguf';
    
    // Mock fs.existsSync to return true for our model path
    (fs.existsSync as jest.Mock).mockImplementation((path) => {
      return path === process.env.LLM_MODEL_PATH;
    });
  });
  
  describe('isLLMServiceReady', () => {
    it('should return true when model exists', () => {
      expect(isLLMServiceReady()).toBe(true);
    });
    
    it('should return false when model path is not set', () => {
      delete process.env.LLM_MODEL_PATH;
      expect(isLLMServiceReady()).toBe(false);
    });
    
    it('should return false when model file does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      expect(isLLMServiceReady()).toBe(false);
    });
  });
  
  describe('formatResponseForDiscord', () => {
    it('should format responses within length limit', () => {
      const response = 'This is a test response';
      expect(formatResponseForDiscord(response)).toBe(response);
    });
    
    it('should truncate long responses', () => {
      // Create a string longer than Discord's limit
      const longResponse = 'A'.repeat(3000);
      const formatted = formatResponseForDiscord(longResponse);
      
      expect(formatted.length).toBeLessThan(2000);
      expect(formatted).toContain('truncated');
    });
  });
  
  describe('runInference', () => {
    let mockSpawn: jest.SpyInstance;
    let mockChildProcess: any;
    
    beforeEach(() => {
      // Create a mock for child process
      mockChildProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn()
      };
      
      // Setup event handlers
      const stdoutHandlers: Record<string, Function> = {};
      const stderrHandlers: Record<string, Function> = {};
      const processHandlers: Record<string, Function> = {};
      
      mockChildProcess.stdout.on.mockImplementation((event, handler) => {
        stdoutHandlers[event] = handler;
        return mockChildProcess.stdout;
      });
      
      mockChildProcess.stderr.on.mockImplementation((event, handler) => {
        stderrHandlers[event] = handler;
        return mockChildProcess.stderr;
      });
      
      mockChildProcess.on.mockImplementation((event, handler) => {
        processHandlers[event] = handler;
        return mockChildProcess;
      });
      
      // Mock the spawn function
      mockSpawn = jest.spyOn(spawn as any, 'spawn').mockReturnValue(mockChildProcess);
      
      // Store handlers for later use in tests
      (mockChildProcess as any).emitStdout = (data: string) => {
        stdoutHandlers['data'](Buffer.from(data));
      };
      
      (mockChildProcess as any).emitStderr = (data: string) => {
        stderrHandlers['data'](Buffer.from(data));
      };
      
      (mockChildProcess as any).emitClose = (code: number) => {
        processHandlers['close'](code);
      };
      
      (mockChildProcess as any).emitError = (error: Error) => {
        processHandlers['error'](error);
      };
    });
    
    it('should run inference and return processed response', async () => {
      // Start the inference
      const inferencePromise = runInference('Test prompt');
      
      // Emit some output
      const testPrompt = 'Test prompt';
      const testOutput = `
llama_model_loader: loaded model
${testPrompt}
This is the model's response
llama_print_timings: prompt eval time`;
      
      (mockChildProcess as any).emitStdout(testOutput);
      (mockChildProcess as any).emitClose(0);
      
      // Wait for the promise to resolve
      const result = await inferencePromise;
      
      // Verify that spawn was called with correct arguments
      expect(mockSpawn).toHaveBeenCalledWith('llama-main', expect.arrayContaining([
        '-m', process.env.LLM_MODEL_PATH,
        '-p', 'Test prompt'
      ]));
      
      // Verify the response
      expect(result).toBe('This is the model\'s response');
    });
    
    it('should handle process errors', async () => {
      // Start the inference
      const inferencePromise = runInference('Test prompt');
      
      // Emit an error
      (mockChildProcess as any).emitError(new Error('Process error'));
      
      // Verify the promise rejects
      await expect(inferencePromise).rejects.toThrow('Failed to start LLM inference process');
    });
    
    it('should handle non-zero exit codes', async () => {
      // Start the inference
      const inferencePromise = runInference('Test prompt');
      
      // Emit stderr and close with error code
      (mockChildProcess as any).emitStderr('Error message');
      (mockChildProcess as any).emitClose(1);
      
      // Verify the promise rejects
      await expect(inferencePromise).rejects.toThrow('LLM inference failed with code 1');
    });
    
    it('should use cached responses when available', async () => {
      // First run to populate cache
      let inferencePromise = runInference('Cached prompt');
      (mockChildProcess as any).emitStdout('Cached prompt\nCached response');
      (mockChildProcess as any).emitClose(0);
      await inferencePromise;
      
      // Reset mocks
      mockSpawn.mockClear();
      
      // Second run with same prompt should use cache
      const result = await runInference('Cached prompt');
      
      // Verify spawn was not called again
      expect(mockSpawn).not.toHaveBeenCalled();
      
      // Verify cached response was returned
      expect(result).toBe('Cached response');
    });
  });
});