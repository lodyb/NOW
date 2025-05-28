import { runInference } from '../../llm/llamaService';
import { logger } from '../../utils/logger';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';

const TTS_CACHE_DIR = path.join(process.cwd(), 'temp', 'tts_cache');

// Ensure TTS cache directory exists
if (!fs.existsSync(TTS_CACHE_DIR)) {
  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
}

export class VoiceAnnouncementService {
  private static ttsCache = new Map<string, string>();

  /**
   * Generate a quirky radio host announcement using AI
   */
  static async generateRadioAnnouncement(
    currentMedia: any,
    nextMedia: any,
    filterInfo?: string
  ): Promise<string | null> {
    try {
      const currentTitle = this.getMediaTitle(currentMedia);
      const nextTitle = this.getMediaTitle(nextMedia);
      
      const prompt = this.buildAnnouncementPrompt(currentTitle, nextTitle, filterInfo);
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        // Clean up the response - remove quotes and keep it short
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '') // Remove leading/trailing quotes
          .replace(/\n/g, ' ') // Replace newlines with spaces
          .substring(0, 200); // Keep it under 200 chars for TTS
        
        logger.debug(`Generated radio announcement: ${announcement}`);
        return announcement;
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to generate radio announcement');
      return null;
    }
  }

  /**
   * Generate TTS audio from text using Coqui TTS and return duration
   */
  static async generateTTSAudio(text: string): Promise<{ path: string; duration: number } | null> {
    try {
      if (!text.trim()) {
        logger.debug('Empty text provided for TTS');
        return null;
      }
      
      // Check cache first
      const cacheKey = crypto.createHash('md5').update(text).digest('hex');
      
      if (this.ttsCache.has(cacheKey)) {
        const cachedPath = this.ttsCache.get(cacheKey)!;
        if (fs.existsSync(cachedPath)) {
          const duration = await this.getAudioDuration(cachedPath);
          return { path: cachedPath, duration };
        } else {
          this.ttsCache.delete(cacheKey);
        }
      }

      const outputPath = path.join(TTS_CACHE_DIR, `tts_${cacheKey}.wav`);
      
      return new Promise((resolve) => {
        const coquiTts = spawn(process.env.TTS_BINARY_PATH || 'tts', [
          '--text', text,
          '--model_name', 'tts_models/ja/kokoro/tacotron2-DDC',
          '--out_path', outputPath
        ], { stdio: ['pipe', 'pipe', 'pipe'] });
        
        let stderr = '';
        coquiTts.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        coquiTts.on('close', async (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            this.ttsCache.set(cacheKey, outputPath);
            const duration = await this.getAudioDuration(outputPath);
            logger.debug(`Generated Coqui TTS audio: ${outputPath}, duration: ${duration}ms`);
            resolve({ path: outputPath, duration });
          } else {
            logger.debug(`Coqui TTS failed with code ${code} for text: "${text}"`);
            logger.debug(`TTS stderr: ${stderr}`);
            resolve(null);
          }
        });
        
        coquiTts.on('error', (error) => {
          logger.debug(`TTS spawn error: ${error.message}`);
          resolve(null);
        });
      });
    } catch (error) {
      return null;
    }
  }

  /**
   * Get audio duration in milliseconds
   */
  private static async getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-i', filePath,
        '-show_entries', 'format=duration',
        '-v', 'quiet',
        '-of', 'csv=p=0'
      ]);
      
      let output = '';
      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      ffprobe.on('close', () => {
        const duration = parseFloat(output.trim()) || 3; // Default 3 seconds
        resolve(duration * 1000); // Convert to milliseconds
      });
      
      ffprobe.on('error', () => {
        resolve(3000); // Fallback 3 seconds
      });
    });
  }

  /**
   * Clean up old TTS cache files
   */
  static cleanupTTSCache(): void {
    try {
      const files = fs.readdirSync(TTS_CACHE_DIR);
      const cutoffTime = Date.now() - (30 * 60 * 1000); // 30 minutes ago
      
      files.forEach(file => {
        const filePath = path.join(TTS_CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          // Remove from cache map
          for (const [key, value] of this.ttsCache.entries()) {
            if (value === filePath) {
              this.ttsCache.delete(key);
              break;
            }
          }
        }
      });
    } catch (error) {
      // Silent fail on cleanup
    }
  }

  /**
   * Generate a radio intro announcement using AI
   */
  static async generateRadioIntro(): Promise<string | null> {
    try {
      const prompts = [
        'You\'re starting a radio show. Give a quick 10-word energetic intro announcement.',
        'You\'re a radio DJ going live. Make a brief 8-word welcome announcement.',
        'Radio station starting up. Give a short 12-word catchy intro.',
        'You\'re launching a music stream. Make a punchy 10-word opening announcement.'
      ];
      
      const prompt = prompts[Math.floor(Math.random() * prompts.length)] + ' Be conversational and natural. No quotes or formatting.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 150);
        
        logger.debug(`Generated radio intro: ${announcement}`);
        return announcement;
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to generate radio intro');
      return null;
    }
  }

  /**
   * Generate a custom announcement from user text
   */
  static async generateCustomAnnouncement(text: string): Promise<string | null> {
    try {
      const prompt = `You're a radio DJ. Take this request: "${text}" and make it sound like a professional radio announcement in 20 words or less. Be conversational and natural. No quotes or formatting.`;
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 250);
        
        logger.debug(`Generated custom announcement: ${announcement}`);
        return announcement;
      }
      
      return text; // Fallback to original text
    } catch (error) {
      logger.error('Failed to generate custom announcement');
      return text; // Fallback to original text
    }
  }

  private static getMediaTitle(media: any): string {
    if (!media) return 'unknown track';
    
    // Try to get the primary answer first
    if (media.answers && media.answers.length > 0) {
      const firstAnswer = media.answers[0];
      return typeof firstAnswer === 'string' ? firstAnswer : firstAnswer.answer;
    }
    
    return media.title || 'unknown track';
  }

  private static buildAnnouncementPrompt(
    currentTitle: string,
    nextTitle: string,
    filterInfo?: string
  ): string {
    const prompts = [
      `You're a quirky radio DJ. Say one short sentence (under 15 words) about transitioning from "${currentTitle}" to "${nextTitle}".`,
      `You're a sassy radio host. Make a brief quip (under 12 words) about playing "${nextTitle}" after "${currentTitle}".`,
      `You're an irreverent DJ. Give a short intro (under 15 words) for "${nextTitle}" following "${currentTitle}".`,
      `You're a witty radio personality. Make a quick comment (under 12 words) about the transition from "${currentTitle}" to "${nextTitle}".`
    ];
    
    let basePrompt = prompts[Math.floor(Math.random() * prompts.length)];
    
    if (filterInfo) {
      basePrompt += ` ${filterInfo} are being applied.`;
    }
    
    basePrompt += ' Be conversational and natural. No quotes or formatting.';
    
    return basePrompt;
  }
}