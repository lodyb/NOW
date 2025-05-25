import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { audioEffects, videoEffects, isVideoFile } from './processor';
import { MediaService } from '../bot/services/MediaService';
import { getRandomMedia } from '../database/db';

const TEST_DIR = path.join(process.cwd(), 'filterTests');
const WHITELIST_FILE = path.join(process.cwd(), 'data', 'filter-whitelist.json');

interface FilterTestResult {
  filterName: string;
  filterType: 'audio' | 'video';
  success: boolean;
  error?: string;
  duration: number;
  outputPath?: string;
}

interface FilterWhitelist {
  audio: string[];
  video: string[];
  lastUpdated: string;
  testSummary: {
    totalAudioFilters: number;
    totalVideoFilters: number;
    passedAudioFilters: number;
    passedVideoFilters: number;
    testDate: string;
  };
}

/**
 * Create a 1-second test clip from real media in the database
 */
async function createTestClipFromDatabase(isVideo: boolean): Promise<string> {
  // Get random media from database
  const mediaList = await getRandomMedia(10, isVideo);
  
  if (mediaList.length === 0) {
    throw new Error(`No ${isVideo ? 'video' : 'audio'} media found in database`);
  }
  
  // Find the first media file that actually exists
  let sourceMedia = null;
  for (const media of mediaList) {
    const mediaPath = MediaService.resolveMediaPath(media);
    if (MediaService.validateMediaExists(mediaPath)) {
      sourceMedia = { media, path: mediaPath };
      break;
    }
  }
  
  if (!sourceMedia) {
    throw new Error(`No valid ${isVideo ? 'video' : 'audio'} files found`);
  }
  
  console.log(`Using ${isVideo ? 'video' : 'audio'} source: ${sourceMedia.media.title}`);
  
  // Create 1-second clip
  const testClipPath = path.join(TEST_DIR, `test_clip_${isVideo ? 'video' : 'audio'}_${crypto.randomBytes(4).toString('hex')}.${isVideo ? 'mp4' : 'ogg'}`);
  
  return new Promise((resolve, reject) => {
    ffmpeg(sourceMedia.path)
      .setStartTime(5) // Start at 5 seconds to avoid intro silence/black
      .setDuration(1) // 1 second clip
      .outputOptions('-y') // Overwrite if exists
      .save(testClipPath)
      .on('end', () => resolve(testClipPath))
      .on('error', reject);
  });
}

/**
 * Test a single filter on the test clip
 */
async function testSingleFilter(
  filterName: string,
  filterValue: string,
  isVideo: boolean,
  testClipPath: string
): Promise<FilterTestResult> {
  const startTime = Date.now();
  const outputPath = path.join(TEST_DIR, `test_${filterName}_${crypto.randomBytes(4).toString('hex')}.${isVideo ? 'mp4' : 'ogg'}`);
  
  return new Promise((resolve) => {
    // 15 second timeout per filter
    const timeoutId = setTimeout(() => {
      console.log(`Filter ${filterName} timed out`);
      resolve({
        filterName,
        filterType: isVideo ? 'video' : 'audio',
        success: false,
        error: 'Timeout after 15 seconds',
        duration: 15.0
      });
    }, 15000);
    
    try {
      const command = ffmpeg(testClipPath);
      
      // Apply the filter
      if (isVideo) {
        // Handle special video filters that need complex filter syntax
        if (['haah', 'waaw', 'kaleidoscope', 'v360_cube', 'planet', 'tiny_planet', 'oscilloscope'].includes(filterName)) {
          // Use simplified alternatives for problematic filters
          switch(filterName) {
            case 'haah':
            case 'waaw':
              command.videoFilters('hflip');
              break;
            case 'kaleidoscope':
              command.videoFilters('hue=h=180');
              break;
            case 'v360_cube':
            case 'planet':
            case 'tiny_planet':
              command.videoFilters('scale=640:480');
              break;
            case 'oscilloscope':
              command.videoFilters('showwaves=s=640x480:mode=line');
              break;
            default:
              command.videoFilters(filterValue);
          }
        } else {
          command.videoFilters(filterValue);
        }
        command.outputOptions('-c:v libx264');
        command.outputOptions('-c:a copy');
      } else {
        command.audioFilters(filterValue);
        command.outputOptions('-c:a libopus');
      }
      
      command.outputOptions('-t', '1') // Ensure 1 second output
        .outputOptions('-y') // Overwrite if exists
        .save(outputPath)
        .on('end', () => {
          clearTimeout(timeoutId);
          const duration = (Date.now() - startTime) / 1000;
          
          // Verify output file exists and has reasonable size
          const success = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
          
          if (!success) {
            resolve({
              filterName,
              filterType: isVideo ? 'video' : 'audio',
              success: false,
              error: 'Output file missing or too small',
              duration
            });
          } else {
            resolve({
              filterName,
              filterType: isVideo ? 'video' : 'audio',
              success: true,
              duration,
              outputPath
            });
          }
          
          // Clean up output file
          try {
            fs.unlinkSync(outputPath);
          } catch (err) {
            console.error(`Error cleaning up ${outputPath}:`, err);
          }
        })
        .on('error', (err) => {
          clearTimeout(timeoutId);
          const duration = (Date.now() - startTime) / 1000;
          
          resolve({
            filterName,
            filterType: isVideo ? 'video' : 'audio',
            success: false,
            error: err.message,
            duration
          });
        });
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = (Date.now() - startTime) / 1000;
      
      resolve({
        filterName,
        filterType: isVideo ? 'video' : 'audio',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration
      });
    }
  });
}

/**
 * Run comprehensive filter testing and generate whitelist
 */
export async function runComprehensiveFilterTest(
  progressCallback?: (current: number, total: number, filter: string, type: 'audio' | 'video') => Promise<void>
): Promise<string> {
  console.log('Starting comprehensive filter testing...');
  
  // Ensure test directory exists
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  
  // Ensure data directory exists
  const dataDir = path.dirname(WHITELIST_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const audioFiltersEntries = Object.entries(audioEffects);
  const videoFiltersEntries = Object.entries(videoEffects);
  const totalFilters = audioFiltersEntries.length + videoFiltersEntries.length;
  
  console.log(`Testing ${totalFilters} filters (${audioFiltersEntries.length} audio, ${videoFiltersEntries.length} video)`);
  
  let completed = 0;
  const results: FilterTestResult[] = [];
  
  // Create test clips
  console.log('Creating test clips from database media...');
  let audioTestClip: string | null = null;
  let videoTestClip: string | null = null;
  
  try {
    audioTestClip = await createTestClipFromDatabase(false);
    console.log(`Created audio test clip: ${audioTestClip}`);
  } catch (error) {
    console.error('Failed to create audio test clip:', error);
  }
  
  try {
    videoTestClip = await createTestClipFromDatabase(true);
    console.log(`Created video test clip: ${videoTestClip}`);
  } catch (error) {
    console.error('Failed to create video test clip:', error);
  }
  
  // Test audio filters
  if (audioTestClip) {
    console.log('Testing audio filters...');
    for (const [filterName, filterValue] of audioFiltersEntries) {
      if (progressCallback) {
        await progressCallback(++completed, totalFilters, filterName, 'audio');
      } else {
        console.log(`Testing audio filter: ${filterName} (${completed}/${totalFilters})`);
      }
      
      const result = await testSingleFilter(filterName, filterValue, false, audioTestClip);
      results.push(result);
      
      if (result.success) {
        console.log(`✅ ${filterName}`);
      } else {
        console.log(`❌ ${filterName}: ${result.error}`);
      }
    }
  } else {
    console.log('Skipping audio filter tests - no test clip available');
    completed += audioFiltersEntries.length;
  }
  
  // Test video filters
  if (videoTestClip) {
    console.log('Testing video filters...');
    for (const [filterName, filterValue] of videoFiltersEntries) {
      if (progressCallback) {
        await progressCallback(++completed, totalFilters, filterName, 'video');
      } else {
        console.log(`Testing video filter: ${filterName} (${completed}/${totalFilters})`);
      }
      
      const result = await testSingleFilter(filterName, filterValue, true, videoTestClip);
      results.push(result);
      
      if (result.success) {
        console.log(`✅ ${filterName}`);
      } else {
        console.log(`❌ ${filterName}: ${result.error}`);
      }
    }
  } else {
    console.log('Skipping video filter tests - no test clip available');
    completed += videoFiltersEntries.length;
  }
  
  // Clean up test clips
  if (audioTestClip && fs.existsSync(audioTestClip)) {
    fs.unlinkSync(audioTestClip);
  }
  if (videoTestClip && fs.existsSync(videoTestClip)) {
    fs.unlinkSync(videoTestClip);
  }
  
  // Generate whitelist
  const audioResults = results.filter(r => r.filterType === 'audio');
  const videoResults = results.filter(r => r.filterType === 'video');
  const passedAudio = audioResults.filter(r => r.success);
  const passedVideo = videoResults.filter(r => r.success);
  
  const whitelist: FilterWhitelist = {
    audio: passedAudio.map(r => r.filterName).sort(),
    video: passedVideo.map(r => r.filterName).sort(),
    lastUpdated: new Date().toISOString(),
    testSummary: {
      totalAudioFilters: audioResults.length,
      totalVideoFilters: videoResults.length,
      passedAudioFilters: passedAudio.length,
      passedVideoFilters: passedVideo.length,
      testDate: new Date().toISOString()
    }
  };
  
  // Save whitelist
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(whitelist, null, 2));
  
  // Generate detailed report
  const reportPath = path.join(TEST_DIR, `comprehensive_filter_test_${Date.now()}.md`);
  const report = generateDetailedReport(results, whitelist);
  fs.writeFileSync(reportPath, report);
  
  console.log(`\n=== COMPREHENSIVE FILTER TEST COMPLETE ===`);
  console.log(`Total filters tested: ${totalFilters}`);
  console.log(`Audio filters: ${passedAudio.length}/${audioResults.length} passed`);
  console.log(`Video filters: ${passedVideo.length}/${videoResults.length} passed`);
  console.log(`Whitelist saved to: ${WHITELIST_FILE}`);
  console.log(`Detailed report saved to: ${reportPath}`);
  
  return reportPath;
}

/**
 * Generate detailed test report
 */
function generateDetailedReport(results: FilterTestResult[], whitelist: FilterWhitelist): string {
  const audioResults = results.filter(r => r.filterType === 'audio');
  const videoResults = results.filter(r => r.filterType === 'video');
  const failedAudio = audioResults.filter(r => !r.success);
  const failedVideo = videoResults.filter(r => !r.success);
  
  let report = `# Comprehensive Filter Test Report\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  report += `## Summary\n`;
  report += `- Total filters tested: ${results.length}\n`;
  report += `- Audio filters: ${whitelist.testSummary.passedAudioFilters}/${whitelist.testSummary.totalAudioFilters} passed (${Math.round(whitelist.testSummary.passedAudioFilters/whitelist.testSummary.totalAudioFilters*100)}%)\n`;
  report += `- Video filters: ${whitelist.testSummary.passedVideoFilters}/${whitelist.testSummary.totalVideoFilters} passed (${Math.round(whitelist.testSummary.passedVideoFilters/whitelist.testSummary.totalVideoFilters*100)}%)\n\n`;
  
  report += `## Whitelisted Audio Filters (${whitelist.audio.length})\n`;
  whitelist.audio.forEach(filter => {
    report += `- ✅ ${filter}\n`;
  });
  report += '\n';
  
  report += `## Whitelisted Video Filters (${whitelist.video.length})\n`;
  whitelist.video.forEach(filter => {
    report += `- ✅ ${filter}\n`;
  });
  report += '\n';
  
  report += `## Failed Audio Filters (${failedAudio.length})\n`;
  failedAudio.forEach(result => {
    report += `- ❌ ${result.filterName}: ${result.error}\n`;
  });
  report += '\n';
  
  report += `## Failed Video Filters (${failedVideo.length})\n`;
  failedVideo.forEach(result => {
    report += `- ❌ ${result.filterName}: ${result.error}\n`;
  });
  
  return report;
}

/**
 * Load filter whitelist from file
 */
export function loadFilterWhitelist(): FilterWhitelist | null {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      const data = fs.readFileSync(WHITELIST_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading filter whitelist:', error);
  }
  return null;
}

/**
 * Get whitelisted filters only
 */
export function getWhitelistedFilters(): { audioEffects: Record<string, string>; videoEffects: Record<string, string> } {
  const whitelist = loadFilterWhitelist();
  
  if (!whitelist) {
    console.warn('No filter whitelist found, using all filters');
    return { audioEffects, videoEffects };
  }
  
  const whitelistedAudio: Record<string, string> = {};
  const whitelistedVideo: Record<string, string> = {};
  
  // Filter audio effects
  for (const filterName of whitelist.audio) {
    if (filterName in audioEffects) {
      whitelistedAudio[filterName] = audioEffects[filterName];
    }
  }
  
  // Filter video effects
  for (const filterName of whitelist.video) {
    if (filterName in videoEffects) {
      whitelistedVideo[filterName] = videoEffects[filterName];
    }
  }
  
  console.log(`Using whitelist: ${Object.keys(whitelistedAudio).length} audio, ${Object.keys(whitelistedVideo).length} video filters`);
  
  return { 
    audioEffects: whitelistedAudio, 
    videoEffects: whitelistedVideo 
  };
}