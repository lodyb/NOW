import { analyzeAudioLevel } from '../../src/services/media/normalizer';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Media Normalizer', () => {
  // Create a temp directory for test files
  const tempDir = path.join(os.tmpdir(), 'now-test-' + Date.now());
  const outputDir = path.join(tempDir, 'normalized');
  
  beforeAll(() => {
    // Create test directories
    fs.mkdirSync(tempDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'uncompressed'), { recursive: true });
  });
  
  afterAll(() => {
    // Clean up test directories
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Error cleaning up test directories:', error);
    }
  });
  
  // Skip this test if running in CI environment without ffmpeg
  (process.env.CI ? describe.skip : describe)('Audio analysis', () => {
    // This test requires a real audio file to be present
    const testAudioPath = path.resolve(__dirname, '../assets/test-audio.mp3');
    
    // Skip the test if the test file doesn't exist
    beforeAll(() => {
      if (!fs.existsSync(testAudioPath)) {
        console.warn(`Test audio file not found at ${testAudioPath}. Audio tests will be skipped.`);
      }
    });
    
    it('should analyze audio levels correctly', async () => {
      if (!fs.existsSync(testAudioPath)) {
        console.warn('Skipping test because test audio file does not exist');
        return;
      }
      
      const result = await analyzeAudioLevel(testAudioPath);
      
      expect(result).toBeDefined();
      expect(result.peak).toBeDefined();
      expect(result.mean).toBeDefined();
      expect(typeof result.peak).toBe('number');
      expect(typeof result.mean).toBe('number');
      
      // Our test audio file is -20dB, so peak should be close to this
      // We don't need to be exact, just making sure the analysis works
      expect(result.peak).toBeLessThan(-10);
    }, 30000); // Allow 30s for ffmpeg processing
  });
});