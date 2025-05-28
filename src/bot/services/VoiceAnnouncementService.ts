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
      
      const prompt = this.buildRandomPersonalityPrompt(currentInfo, nextInfo, filterInfo, queuedBy);
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 300);
        
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
      const personalities = [
        // Grouchy intros
        'You\'re a grouchy old radio presenter starting another tedious shift. Be short and irritated:',
        'You\'re an angry old DJ going live reluctantly. Be cranky and brief:',
        'You\'re the grumpiest host alive starting your show. Give a bitter intro:',
        
        // Sarcastic intros
        'You\'re starting your radio show with maximum sarcasm today. Be witty and brief:',
        'You\'re a sarcastic DJ who finds the whole situation amusing. Make a dry opening:',
        'You\'re launching your show with sharp wit and cynicism. Be clever but short:',
        
        // Overly enthusiastic intros
        'You\'re an overly caffeinated morning DJ bursting with energy. Be hyperactive but brief:',
        'You\'re a bubbly radio host who\'s genuinely excited about everything. Gush enthusiastically:',
        'You\'re bouncing off the walls with manic energy starting your show. Be frantically upbeat:',
        
        // Bored/Monotone intros
        'You\'re a completely bored radio host who sounds dead inside. Be utterly disinterested:',
        'You\'re counting minutes until your shift ends. Sound flat and lifeless:',
        'You\'re an apathetic presenter who couldn\'t care less. Show zero emotion:',
        
        // Confused intros
        'You\'re a scatterbrained DJ who\'s confused about everything. Be bewildered:',
        'You\'re a forgetful radio host who\'s lost track of what\'s happening. Sound puzzled:',
        'You\'re perpetually confused about your own show. Be adorably lost:',
        
        // Philosophical intros
        'You\'re a pretentious radio host who finds deep meaning in everything. Be pseudo-intellectual:',
        'You\'re a philosophical DJ who overanalyzes radio broadcasting. Sound overly thoughtful:',
        'You\'re starting your show with existential contemplation. Be profoundly pretentious:',
        
        // Anxious intros
        'You\'re an anxious radio host worried about everything going wrong. Be nervously uncertain:',
        'You\'re a jittery DJ second-guessing yourself constantly. Sound worried:',
        'You\'re paranoid that your show might be terrible. Be anxiously brief:',
        
        // Sleepy intros
        'You\'re a drowsy night shift DJ who can barely stay awake. Be sleepily brief:',
        'You\'re exhausted and working a double shift. Sound barely conscious:',
        'You\'re tired and been on air too long. Be wearily short:',
        
        // Conspiracy theorist intros
        'You\'re a paranoid DJ who sees conspiracies in radio broadcasting. Be suspiciously brief:',
        'You\'re conspiracy-minded about the music industry. Sound paranoid but short:',
        'You\'re questioning everything about your own radio show. Be suspiciously uncertain:',
        
        // Dramatic intros
        'You\'re a melodramatic radio host treating this like Shakespeare. Be theatrically brief:',
        'You\'re an over-the-top presenter who lives for drama. Be dramatically short:',
        'You\'re launching your show with theatrical flair. Be dramatically concise:',
        
        // Old-school intros
        'You\'re a retro DJ stuck in the past who hates modern radio. Be nostalgically grumpy:',
        'You\'re a vintage radio host longing for the good old days. Sound wistfully bitter:',
        'You\'re an old-timer disgusted with today\'s broadcasting. Be crankily nostalgic:',
        
        // Manic intros
        'You\'re bouncing off the walls starting your radio show. Be frantically energetic:',
        'You\'re hyperactive and talking way too fast. Be rapid-fire brief:',
        'You\'re manic and can\'t contain your energy. Be chaotically upbeat:'
      ];
      
      const prompt = personalities[Math.floor(Math.random() * personalities.length)] + ' Keep it short and natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 200);
        
        announcement = this.processAnnouncementText(announcement);
        
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
   * Generate a skip announcement
   */
  static async generateSkipAnnouncement(currentTitle: string, nextTitle: string, nextMedia?: any): Promise<string | null> {
    try {
      const nextInfo = nextMedia ? this.extractMediaInfo(nextMedia) : { title: nextTitle, answers: [nextTitle] };
      
      const personalities = [
        // Grouchy skip responses
        `Ugh, someone skipped to "${this.processText(nextInfo.title)}"! Be short and irritated:`,
        `Oh wonderful, jumped to "${this.processText(nextInfo.title)}"! Be cranky and brief:`,
        `Fantastic, skipped to "${this.processText(nextInfo.title)}"! Sound annoyed:`,
        
        // Sarcastic skip responses
        `Oh brilliant, fast-forwarded to "${this.processText(nextInfo.title)}"! Be witty and sarcastic:`,
        `Marvelous, someone couldn't wait for "${this.processText(nextInfo.title)}"! Make a dry comment:`,
        `Perfect, skipped straight to "${this.processText(nextInfo.title)}"! Be cleverly sarcastic:`,
        
        // Bored skip responses  
        `Someone skipped to "${this.processText(nextInfo.title)}"... whatever. Sound utterly disinterested:`,
        `Jumped to "${this.processText(nextInfo.title)}"... okay. Be flat and lifeless:`,
        `Fast-forwarded to "${this.processText(nextInfo.title)}"... sure. Show zero emotion:`,
        
        // Confused skip responses
        `Wait, did we skip to "${this.processText(nextInfo.title)}"? Be bewildered:`,
        `Hold on, is this "${this.processText(nextInfo.title)}" now? Sound puzzled:`,
        `Um, skipped to "${this.processText(nextInfo.title)}"... I think? Be adorably confused:`,
        
        // Dramatic skip responses
        `BEHOLD! Someone has summoned "${this.processText(nextInfo.title)}"! Be theatrically brief:`,
        `The great skip to "${this.processText(nextInfo.title)}" has occurred! Be dramatically short:`,
        `Lo! "${this.processText(nextInfo.title)}" emerges from the void! Be overly dramatic:`,
        
        // Anxious skip responses
        `Oh no, did we skip to "${this.processText(nextInfo.title)}" too early? Be nervously uncertain:`,
        `Was that the right time to skip to "${this.processText(nextInfo.title)}"? Sound worried:`,
        `Skipped to "${this.processText(nextInfo.title)}"... hope that's okay? Be anxiously brief:`
      ];
      
      const prompt = personalities[Math.floor(Math.random() * personalities.length)] + ' Keep it short and natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 150);
        
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
      
      const personalities = [
        // Grouchy queue responses
        `Oh brilliant, ${processedUsername} wants "${this.processText(info.title)}"! Be short and irritated:`,
        `Great, ${processedUsername} requested "${this.processText(info.title)}"! Sound cranky:`,
        `Wonderful, ${processedUsername} queued "${this.processText(info.title)}"! Be grumpy and brief:`,
        
        // Sarcastic queue responses
        `Fantastic, ${processedUsername} chose "${this.processText(info.title)}"! Be witty and sarcastic:`,
        `Marvelous, ${processedUsername} picked "${this.processText(info.title)}"! Make a dry comment:`,
        `Perfect, ${processedUsername} selected "${this.processText(info.title)}"! Be cleverly sarcastic:`,
        
        // Enthusiastic queue responses
        `Amazing! ${processedUsername} requested "${this.processText(info.title)}"! Be hyperenergetic:`,
        `Awesome! ${processedUsername} wants "${this.processText(info.title)}"! Gush enthusiastically:`,
        `Incredible! ${processedUsername} chose "${this.processText(info.title)}"! Be pumped but brief:`,
        
        // Bored queue responses
        `${processedUsername} requested "${this.processText(info.title)}"... okay. Sound utterly disinterested:`,
        `${processedUsername} wants "${this.processText(info.title)}"... sure. Be flat and lifeless:`,
        `${processedUsername} queued "${this.processText(info.title)}"... whatever. Show zero emotion:`,
        
        // Confused queue responses
        `Wait, did ${processedUsername} want "${this.processText(info.title)}"? Be bewildered:`,
        `${processedUsername} requested "${this.processText(info.title)}"... I think? Sound puzzled:`,
        `Is this "${this.processText(info.title)}" from ${processedUsername}? Be adorably confused:`,
        
        // Dramatic queue responses
        `BEHOLD! ${processedUsername} has summoned "${this.processText(info.title)}"! Be theatrically brief:`,
        `The mighty ${processedUsername} demands "${this.processText(info.title)}"! Be dramatically short:`,
        `Lo! ${processedUsername} calls forth "${this.processText(info.title)}"! Be overly dramatic:`,
        
        // Philosophical queue responses
        `${processedUsername}'s choice of "${this.processText(info.title)}" speaks to... be pseudo-intellectual:`,
        `The selection of "${this.processText(info.title)}" by ${processedUsername} represents... sound overly thoughtful:`,
        `${processedUsername} choosing "${this.processText(info.title)}" is like... be profoundly pretentious:`
      ];
      
      const prompt = personalities[Math.floor(Math.random() * personalities.length)] + ' Keep it short and natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 180);
        
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
   * Generate a custom announcement from user text
   */
  static async generateCustomAnnouncement(text: string): Promise<string | null> {
    try {
      const personalities = [
        // Grouchy personalities
        `You're a grouchy old radio presenter. Take this request: "${this.processText(text)}" and make it sound irritated:`,
        `You're an angry old DJ who's fed up. Take this message: "${this.processText(text)}" and be cranky:`,
        `You're the grumpiest host alive. Take this text: "${this.processText(text)}" and give a bitter response:`,
        `You're an exhausted DJ who just wants to go home. Take this announcement: "${this.processText(text)}" and complain briefly:`,
        `You're an irritable presenter with zero patience. Take this request: "${this.processText(text)}" and sound exasperated:`,
        
        // Sarcastic personalities
        `You're a sarcastic DJ. Take this message: "${this.processText(text)}" and deliver it with wit:`,
        `You're a witty host with a sharp tongue. Take this text: "${this.processText(text)}" and be cleverly sarcastic:`,
        `You're a radio personality who loves dry observations. Take this announcement: "${this.processText(text)}" and make a wry remark:`,
        `You're a cynical DJ who sees irony everywhere. Take this request: "${this.processText(text)}" and be dryly amusing:`,
        `You're a sardonic radio host with perfect timing. Take this message: "${this.processText(text)}" and deliver with bite:`,
        
        // Overly enthusiastic personalities
        `You're an overly enthusiastic radio host. Take this text: "${this.processText(text)}" and be hyperenergetic:`,
        `You're an overly caffeinated morning DJ bursting with energy. Take this announcement: "${this.processText(text)}" and be hyperactive:`,
        `You're a bubbly radio host who loves everything. Take this request: "${this.processText(text)}" and gush enthusiastically:`,
        `You're a peppy DJ who's had way too much coffee. Take this message: "${this.processText(text)}" and be bouncy:`,
        `You're a cheerleader pretending to be a radio host. Take this text: "${this.processText(text)}" and be annoyingly upbeat:`,
        
        // Bored personalities
        `You're a bored presenter. Take this announcement: "${this.processText(text)}" and sound disinterested:`,
        `You're a completely bored radio host who sounds dead inside. Take this request: "${this.processText(text)}" and be utterly disinterested:`,
        `You're a monotone DJ counting minutes until your shift ends. Take this message: "${this.processText(text)}" and be flat:`,
        `You're an apathetic presenter who couldn't care less. Take this text: "${this.processText(text)}" and show zero emotion:`,
        `You're a zombie DJ barely conscious. Take this announcement: "${this.processText(text)}" and sound brain-dead:`,
        
        // Confused personalities
        `You're a confused DJ. Take this request: "${this.processText(text)}" and be bewildered:`,
        `You're a scatterbrained DJ always confused. Take this message: "${this.processText(text)}" and be bewildered:`,
        `You're a forgetful radio host who's lost track of everything. Take this text: "${this.processText(text)}" and sound puzzled:`,
        `You're a ditzy presenter who's perpetually lost. Take this announcement: "${this.processText(text)}" and be adorably confused:`,
        `You're a spacey DJ in another dimension. Take this request: "${this.processText(text)}" and sound airheaded:`,
        
        // Dramatic personalities
        `You're a dramatic radio host. Take this message: "${this.processText(text)}" and be theatrical:`,
        `You're a melodramatic radio host who treats everything like Shakespeare. Take this text: "${this.processText(text)}" and be theatrically brief:`,
        `You're an over-the-top presenter who lives for drama. Take this announcement: "${this.processText(text)}" and be dramatically short:`,
        `You're a hammy DJ who thinks you're on Broadway. Take this request: "${this.processText(text)}" and be grandly theatrical:`,
        `You're an operatic radio host who sings everything. Take this message: "${this.processText(text)}" and be melodiously brief:`,
        
        // Philosophical personalities
        `You're a philosophical presenter. Take this text: "${this.processText(text)}" and be pseudo-intellectual:`,
        `You're a pretentious radio host who finds deep meaning in everything. Take this announcement: "${this.processText(text)}" and be pseudo-intellectual:`,
        `You're a philosophical DJ who sees metaphors everywhere. Take this request: "${this.processText(text)}" and make it sound profound:`,
        `You're a mystical radio guru who sees cosmic significance. Take this message: "${this.processText(text)}" and be spiritually pretentious:`,
        `You're an intellectual snob who lectures through everything. Take this text: "${this.processText(text)}" and be condescendingly brief:`,
        
        // Anxious personalities
        `You're an anxious DJ. Take this announcement: "${this.processText(text)}" and sound worried:`,
        `You're an anxious radio host worried about everything going wrong. Take this request: "${this.processText(text)}" and be nervously uncertain:`,
        `You're a jittery DJ always second-guessing yourself. Take this message: "${this.processText(text)}" and sound worried:`,
        `You're a paranoid presenter who thinks everything might be wrong. Take this text: "${this.processText(text)}" and be anxiously brief:`,
        `You're a nervous wreck of a DJ terrified of mistakes. Take this announcement: "${this.processText(text)}" and sound panicked:`,
        
        // Sleepy personalities
        `You're a drowsy night shift DJ who can barely stay awake. Take this request: "${this.processText(text)}" and be sleepily brief:`,
        `You're an exhausted radio host working a double shift. Take this message: "${this.processText(text)}" and sound barely conscious:`,
        `You're a tired presenter who's been on air too long. Take this text: "${this.processText(text)}" and be wearily short:`,
        `You're a sleepy DJ who keeps nodding off. Take this announcement: "${this.processText(text)}" and be drowsily confused:`,
        `You're an insomniac radio host running on no sleep. Take this request: "${this.processText(text)}" and sound deliriously tired:`,
        
        // Conspiracy theorist personalities
        `You're a paranoid DJ who sees conspiracies everywhere. Take this message: "${this.processText(text)}" and be suspiciously brief:`,
        `You're a conspiracy-minded radio host who questions everything. Take this text: "${this.processText(text)}" and sound paranoid:`,
        `You're a tinfoil-hat wearing DJ who distrusts everything. Take this announcement: "${this.processText(text)}" and be conspiratorially terse:`,
        `You're a suspicious radio host who sees hidden agendas. Take this request: "${this.processText(text)}" and be skeptically brief:`,
        
        // Old-school personalities
        `You're a retro DJ stuck in the past who hates modern everything. Take this message: "${this.processText(text)}" and be nostalgically grumpy:`,
        `You're a vintage radio host who longs for the good old days. Take this text: "${this.processText(text)}" and sound wistfully bitter:`,
        `You're an old-timer disgusted with today's world. Take this announcement: "${this.processText(text)}" and be crankily nostalgic:`,
        
        // Manic personalities
        `You're a manic radio DJ bouncing off the walls. Take this request: "${this.processText(text)}" and be frantically energetic:`,
        `You're a hyperactive presenter who talks way too fast. Take this message: "${this.processText(text)}" and be rapid-fire brief:`,
        `You're a caffeinated maniac who can't sit still. Take this text: "${this.processText(text)}" and be chaotically upbeat:`,
        
        // Weird personalities
        `You're a space alien pretending to be a human DJ. Take this announcement: "${this.processText(text)}" and be otherworldly brief:`,
        `You're a robot DJ with glitchy programming. Take this request: "${this.processText(text)}" and be mechanically terse:`,
        `You're a time traveler from the future confused by primitive customs. Take this message: "${this.processText(text)}" and be futuristically puzzled:`,
        `You're a pirate radio host sailing the airwaves. Take this text: "${this.processText(text)}" and be nautically brief:`,
        `You're a medieval herald announcing to the masses. Take this announcement: "${this.processText(text)}" and be regally terse:`,
        
        // Passive-aggressive personalities
        `You're a passive-aggressive DJ who smiles while being mean. Take this request: "${this.processText(text)}" and be sweetly venomous:`,
        `You're a fake-cheerful radio host seething inside. Take this message: "${this.processText(text)}" and be artificially pleasant:`,
        `You're a subtly hostile presenter who never says what they mean. Take this text: "${this.processText(text)}" and be politely cutting:`,
        
        // Existential personalities
        `You're an existentially depressed DJ questioning everything. Take this announcement: "${this.processText(text)}" and be bleakly philosophical:`,
        `You're a nihilistic radio host who sees meaninglessness everywhere. Take this request: "${this.processText(text)}" and be darkly brief:`,
        `You're a depressing DJ who finds futility in everything. Take this message: "${this.processText(text)}" and be existentially terse:`,
        
        // Formal personalities
        `You're an insufferably formal radio announcer who speaks like royalty. Take this text: "${this.processText(text)}" and be pompously brief:`,
        `You're a stuffy BBC-style presenter who's incredibly proper. Take this announcement: "${this.processText(text)}" and be stuffily terse:`,
        `You're an academic radio host who lectures through everything. Take this request: "${this.processText(text)}" and be pedantically brief:`,
        
        // Chaotic personalities
        `You're a chaotic DJ whose thoughts jump everywhere. Take this message: "${this.processText(text)}" and be randomly scattered:`,
        `You're an ADHD radio host easily distracted. Take this text: "${this.processText(text)}" and be distractedly brief:`,
        `You're a stream-of-consciousness DJ whose brain never stops. Take this announcement: "${this.processText(text)}" and be rambly but short:`
      ];
      
      const prompt = personalities[Math.floor(Math.random() * personalities.length)] + ' Keep it short and terse but natural. No quotes.';
      
      const response = await runInference(prompt);
      
      if (response && response.text && response.text.trim()) {
        let announcement = response.text.trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\n/g, ' ')
          .substring(0, 250);
        
        announcement = this.processAnnouncementText(announcement);
        
        logger.debug(`Generated custom announcement: ${announcement}`);
        return announcement;
      }
      
      return this.processAnnouncementText(text);
    } catch (error) {
      logger.error('Failed to generate custom announcement');
      return this.processAnnouncementText(text);
    }
  }

  /**
   * Build random personality prompt with varied emotions and moods
   */
  private static buildRandomPersonalityPrompt(
    currentInfo: { title: string; answers: string[]; duration?: string },
    nextInfo: { title: string; answers: string[]; duration?: string },
    filterInfo?: string,
    queuedBy?: string
  ): string {
    const personalities = [
      // Grouchy/Annoyed personalities
      `You're a grouchy old radio host who's fed up with today. From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? `, thanks to ${this.processText(queuedBy)}` : ''}. Be short and irritated:`,
      `You're an exhausted DJ who just wants to go home. Switching from "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? ` because ${this.processText(queuedBy)} asked` : ''}. Complain briefly:`,
      `You're a cranky presenter having the worst day ever. Playing "${this.processText(nextInfo.title)}" after "${this.processText(currentInfo.title)}"${queuedBy ? `, ${this.processText(queuedBy)}'s request` : ''}. Grumble shortly:`,
      `You're a bitter radio host who hates everything. From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? `, ${this.processText(queuedBy)} picked this` : ''}. Be sourly terse:`,
      `You're an irritable DJ with zero patience left. Transitioning "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? `, per ${this.processText(queuedBy)}` : ''}. Sound exasperated:`,
      
      // Sarcastic personalities  
      `You're a sarcastic radio DJ who finds everything amusing in a twisted way. From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? `, courtesy of ${this.processText(queuedBy)}` : ''}. Make a snarky comment:`,
      `You're a witty host with a sharp tongue. Transitioning "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? ` per ${this.processText(queuedBy)}'s taste` : ''}. Be cleverly sarcastic:`,
      
      // Overly enthusiastic personalities
      `You're an overly caffeinated morning DJ bursting with energy. From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? ` requested by the amazing ${this.processText(queuedBy)}` : ''}! Be hyperenergetic but brief:`,
      `You're a bubbly radio host who genuinely loves every single song. Playing "${this.processText(nextInfo.title)}" after "${this.processText(currentInfo.title)}"${queuedBy ? `, shoutout ${this.processText(queuedBy)}` : ''}! Gush enthusiastically:`,
      
      // Bored/Monotone personalities
      `You're a completely bored radio host who sounds dead inside. From "${this.processText(currentInfo.title)}" to "${this.processText(nextInfo.title)}"${queuedBy ? `, ${this.processText(queuedBy)} requested it` : ''}. Sound utterly disinterested:`,
      `You're a monotone DJ who's counting minutes until your shift ends. Playing "${this.processText(nextInfo.title)}" after "${this.processText(currentInfo.title)}"${queuedBy ? `, per ${this.processText(queuedBy)}` : ''}. Be flat and lifeless:`
    ];
    
    let prompt = personalities[Math.floor(Math.random() * personalities.length)];
    
    if (filterInfo) {
      prompt += ` (${filterInfo} effects active)`;
    }
    
    prompt += ' Keep it short and terse but natural. No quotes or formatting.';
    
    return prompt;
  }

  /**
   * Process and clean announcement text for TTS
   */
  private static processAnnouncementText(text: string): string {
    return text
      .replace(/[🎵🎶🎤🎧🎼🎹🥁🎺🎸🎻📻🔊🔉🔈❤️💖⭐✨🌟🎮🎯🎪🎭🎨🎬📺📱💻🖥️🙄😎🤖]/g, '') // Remove emojis
      .replace(/[^\w\s\.,!?'-]/g, '') // Keep only safe characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Process text for safe inclusion in prompts
   */
  private static processText(text: string): string {
    return text
      .replace(/"/g, "'") // Replace quotes with single quotes
      .replace(/\n/g, ' ') // Replace newlines with spaces
      .trim();
  }

  /**
   * Extract media information for announcements
   */
  private static extractMediaInfo(media: any): { title: string; answers: string[]; duration?: string } {
    if (!media) {
      return { title: 'unknown track', answers: ['unknown track'] };
    }

    const title = this.getMediaTitle(media);
    const answers = media.answers ? 
      (Array.isArray(media.answers) ? 
        media.answers.map((a: any) => typeof a === 'string' ? a : a.answer) : 
        [media.answers]) : 
      [title];

    return {
      title,
      answers,
      duration: media.metadata?.duration
    };
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
}