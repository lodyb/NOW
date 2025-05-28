import { runInference } from '../../llm/llamaService';
import { logger } from '../../utils/logger';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fetch from 'node-fetch';

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
    filterInfo?: string,
    queuedBy?: string
  ): Promise<string | null> {
    try {
      const currentInfo = this.extractMediaInfo(currentMedia);
      const nextInfo = this.extractMediaInfo(nextMedia);
      
      const prompt = this.buildEnhancedAnnouncementPrompt(currentInfo, nextInfo, filterInfo, queuedBy);
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 250);
        
        // Process the announcement text
        announcement = this.processAnnouncementText(announcement);
        
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
   * Generate TTS audio from text using persistent TTS server and return duration
   */
  static async generateTTSAudio(text: string): Promise<{ path: string; duration: number } | null> {
    try {
      if (!text.trim()) {
        logger.debug('Empty text provided for TTS');
        return null;
      }
      
      // Sanitize text for TTS - remove problematic characters
      const sanitizedText = text
        .replace(/[🎵🎶🎤🎧🎼🎹🥁🎺🎸🎻📻🔊🔉🔈❤️💖⭐✨🌟🎮🎯🎪🎭🎨🎬📺📱💻🖥️🙄😎🤖]/g, '') // Remove emojis
        .replace(/[^\w\s\.,!?'-]/g, '') // Keep only safe characters
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
      
      if (!sanitizedText) {
        logger.debug('Text became empty after sanitization');
        return null;
      }
      
      // Check cache first
      const cacheKey = crypto.createHash('md5').update(sanitizedText).digest('hex');
      
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
      
      try {
        // Use HTTP request to persistent TTS server with longer timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased to 15 seconds
        
        const response = await fetch(`http://localhost:5002/api/tts?text=${encodeURIComponent(sanitizedText)}`, {
          method: 'GET',
          headers: { 
            'Accept': 'audio/wav',
            'User-Agent': 'Discord-Bot/1.0'
          },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          if (arrayBuffer.byteLength > 0) {
            fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
            
            this.ttsCache.set(cacheKey, outputPath);
            const duration = await this.getAudioDuration(outputPath);
            logger.debug(`Generated TTS audio via server: ${outputPath}, duration: ${duration}ms`);
            return { path: outputPath, duration };
          } else {
            logger.debug('TTS server returned empty response, trying fallback');
            return this.generateTTSAudioFallback(sanitizedText, outputPath, cacheKey);
          }
        } else {
          logger.debug(`TTS server failed (${response.status}), trying fallback`);
          return this.generateTTSAudioFallback(sanitizedText, outputPath, cacheKey);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          logger.debug('TTS server timed out, trying fallback');
        } else {
          logger.debug(`TTS server error: ${(error as Error).message}, trying fallback`);
        }
        return this.generateTTSAudioFallback(sanitizedText, outputPath, cacheKey);
      }
    } catch (error) {
      logger.error('TTS generation failed completely', error);
      return null;
    }
  }

  /**
   * Fallback TTS using Python command directly
   */
  private static async generateTTSAudioFallback(
    text: string, 
    outputPath: string, 
    cacheKey: string
  ): Promise<{ path: string; duration: number } | null> {
    return new Promise((resolve) => {
      const coquiTts = spawn(process.env.TTS_BINARY_PATH || 'tts', [
        '--text', text,
        '--model_name', 'tts_models/en/ljspeech/tacotron2-DDC',
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
          logger.debug(`Generated fallback TTS audio: ${outputPath}, duration: ${duration}ms`);
          resolve({ path: outputPath, duration });
        } else {
          logger.debug(`Fallback TTS also failed with code ${code}`);
          resolve(null);
        }
      });
      
      coquiTts.on('error', () => {
        resolve(null);
      });
    });
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
        'You\'re starting a radio show. Give a quick 6-word energetic intro.',
        'You\'re a radio DJ going live. Make a brief 5-word welcome.',
        'Radio station starting up. Give a short 7-word catchy intro.',
        'You\'re launching a music stream. Make a punchy 6-word opening.'
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

  /**
   * Generate a skip announcement
   */
  static async generateSkipAnnouncement(currentTitle: string, nextTitle: string, nextMedia?: any): Promise<string | null> {
    try {
      const nextInfo = nextMedia ? this.extractMediaInfo(nextMedia) : { title: nextTitle, answers: [nextTitle] };
      
      const prompts = [
        `DJ here! Someone skipped to "${this.processText(nextInfo.title)}". Make a witty 6-word quip!`,
        `Radio update! Jumped to "${this.processText(nextInfo.title)}"! Give a sassy 5-word comment!`,
        `DJ booth! Skipped to "${this.processText(nextInfo.title)}"! Make a quick 7-word remark!`,
        `Radio host! Fast-forwarded to "${this.processText(nextInfo.title)}"! Say something clever in 6 words!`
      ];
      
      const prompt = prompts[Math.floor(Math.random() * prompts.length)] + ' Be natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 100);
        
        announcement = this.processAnnouncementText(announcement);
        
        logger.debug(`Generated skip announcement: ${announcement}`);
        return announcement;
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to generate skip announcement');
      return null;
    }
  }

  /**
   * Generate a queue request announcement
   */
  static async generateQueueAnnouncement(username: string, trackTitle: string, mediaInfo?: any): Promise<string | null> {
    try {
      const info = mediaInfo ? this.extractMediaInfo(mediaInfo) : { title: trackTitle, answers: [trackTitle] };
      const processedUsername = this.processText(username);
      
      const prompts = [
        `DJ! ${processedUsername} requested "${this.processText(info.title)}"! Give them a fun 6-word shoutout!`,
        `Radio! ${processedUsername} queued "${this.processText(info.title)}"! Make a friendly 5-word mention!`,
        `Station! ${processedUsername} wants "${this.processText(info.title)}"! Say something nice in 7 words!`,
        `DJ! ${processedUsername} chose "${this.processText(info.title)}"! Give a 6-word response!`
      ];
      
      const prompt = prompts[Math.floor(Math.random() * prompts.length)] + ' Be natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 120);
        
        announcement = this.processAnnouncementText(announcement);
        
        logger.debug(`Generated queue announcement: ${announcement}`);
        return announcement;
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to generate queue announcement');
      return null;
    }
  }

  /**
   * Extract comprehensive media information
   */
  private static extractMediaInfo(media: any): { title: string; answers: string[]; duration?: string } {
    const answers = media.answers ? 
      (Array.isArray(media.answers) ? 
        media.answers.map((a: any) => typeof a === 'string' ? a : a.answer) :
        [media.answers]) :
      [];
    
    const title = answers[0] || media.title || 'unknown track';
    
    // Estimate duration if available from metadata
    let duration: string | undefined;
    if (media.metadata?.duration) {
      const seconds = Math.round(media.metadata.duration);
      if (seconds < 60) {
        duration = `${seconds} seconds`;
      } else if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        duration = `${mins} minute${mins !== 1 ? 's' : ''}`;
      } else {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        duration = `${hours}h ${mins}m`;
      }
    }
    
    return { title, answers, duration };
  }

  /**
   * Process text to convert emojis and foreign characters
   */
  private static processText(text: string): string {
    if (!text) return '';
    
    // Convert emojis to text descriptions
    let processed = text
      .replace(/🎵/g, 'music note')
      .replace(/🎶/g, 'musical notes')
      .replace(/🎤/g, 'microphone')
      .replace(/🎧/g, 'headphones')
      .replace(/🎼/g, 'musical score')
      .replace(/🎹/g, 'piano')
      .replace(/🥁/g, 'drum')
      .replace(/🎺/g, 'trumpet')
      .replace(/🎸/g, 'guitar')
      .replace(/🎻/g, 'violin')
      .replace(/📻/g, 'radio')
      .replace(/🔊/g, 'loud speaker')
      .replace(/🔉/g, 'speaker')
      .replace(/🔈/g, 'quiet speaker')
      .replace(/❤️/g, 'heart')
      .replace(/💖/g, 'sparkling heart')
      .replace(/⭐/g, 'star')
      .replace(/✨/g, 'sparkles')
      .replace(/🌟/g, 'glowing star')
      .replace(/🎮/g, 'game controller')
      .replace(/🎯/g, 'bullseye')
      .replace(/🎪/g, 'circus tent')
      .replace(/🎭/g, 'performing arts')
      .replace(/🎨/g, 'artist palette')
      .replace(/🎬/g, 'clapper board')
      .replace(/📺/g, 'television')
      .replace(/📱/g, 'mobile phone')
      .replace(/💻/g, 'laptop')
      .replace(/🖥️/g, 'desktop computer');
    
    // Basic romaji conversion for common Japanese characters
    processed = processed
      .replace(/を/g, 'wo')
      .replace(/は/g, 'wa')
      .replace(/の/g, 'no')
      .replace(/が/g, 'ga')
      .replace(/で/g, 'de')
      .replace(/に/g, 'ni')
      .replace(/と/g, 'to')
      .replace(/か/g, 'ka')
      .replace(/た/g, 'ta')
      .replace(/さ/g, 'sa')
      .replace(/な/g, 'na')
      .replace(/ま/g, 'ma')
      .replace(/や/g, 'ya')
      .replace(/ら/g, 'ra')
      .replace(/わ/g, 'wa');
    
    return processed;
  }

  /**
   * Process final announcement text
   */
  private static processAnnouncementText(text: string): string {
    return this.processText(text);
  }

  private static buildEnhancedAnnouncementPrompt(
    currentInfo: { title: string; answers: string[]; duration?: string },
    nextInfo: { title: string; answers: string[]; duration?: string },
    filterInfo?: string,
    queuedBy?: string
  ): string {
    const prompts = [
      `DJ here! From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"! ${queuedBy ? `${this.processText(queuedBy)} requested this. ` : ''}Make a 8-word transition!`,
      
      `Radio update! "${this.processText(nextInfo.title)}" is up next! ${nextInfo.duration ? `${nextInfo.duration} track. ` : ''}${queuedBy ? `Thanks ${this.processText(queuedBy)}! ` : ''}Give a 6-word intro!`,
      
      `DJ booth! Moving to "${this.processText(nextInfo.title)}"! ${queuedBy ? `${this.processText(queuedBy)}'s choice. ` : ''}Make a 7-word comment!`,
      
      `Radio time! "${this.processText(nextInfo.title)}" coming up! ${queuedBy ? `Shoutout ${this.processText(queuedBy)}! ` : ''}Give a 5-word bridge!`
    ];
    
    let basePrompt = prompts[Math.floor(Math.random() * prompts.length)];
    
    if (filterInfo) {
      basePrompt += ` Note: ${filterInfo} applied.`;
    }
    
    basePrompt += ' Be natural. No quotes.';
    
    return basePrompt;
  }
}