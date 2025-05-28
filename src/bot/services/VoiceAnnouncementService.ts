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
   * Generate TTS audio from text
   */
  static async generateTTSAudio(text: string): Promise<string | null> {
    try {
      // Check cache first
      const cacheKey = crypto.createHash('md5').update(text).digest('hex');
      
      if (this.ttsCache.has(cacheKey)) {
        const cachedPath = this.ttsCache.get(cacheKey)!;
        if (fs.existsSync(cachedPath)) {
          return cachedPath;
        } else {
          this.ttsCache.delete(cacheKey);
        }
      }

      const outputPath = path.join(TTS_CACHE_DIR, `tts_${cacheKey}.wav`);
      
      return new Promise((resolve) => {
        const say = spawn('say', ['-o', outputPath, text]);
        
        say.on('close', (code) => {
          if (code === 0 && fs.existsSync(outputPath)) {
            this.ttsCache.set(cacheKey, outputPath);
            logger.debug(`Generated TTS audio: ${outputPath}`);
            resolve(outputPath);
          } else {
            logger.debug(`TTS generation failed with code ${code}`);
            resolve(null);
          }
        });
        
        say.on('error', () => {
          resolve(null);
        });
      });
    } catch (error) {
      return null;
    }
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