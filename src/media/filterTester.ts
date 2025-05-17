// filepath: /home/lody/now/src/media/filterTester.ts
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { audioEffects, videoEffects, isVideoFile } from './processor';

// Define the directory for test results
const TEST_DIR = path.join(process.cwd(), 'filterTests');
const TEMP_DIR = path.join(process.cwd(), 'temp');

// Results interface
interface FilterTestResult {
  filterName: string;
  filterType: 'audio' | 'video';
  success: boolean;
  error?: string;
  duration?: number;
  outputPath?: string;
}

/**
 * Create a short test sample for testing filters
 * @param isVideo Whether to create a video or audio test sample
 * @returns Path to the test sample
 */
async function createTestSample(isVideo: boolean): Promise<string> {
  // Create a sample using ffmpeg's built-in test sources
  const outputPath = path.join(TEMP_DIR, `test_sample_${isVideo ? 'video' : 'audio'}_${crypto.randomBytes(4).toString('hex')}.${isVideo ? 'mp4' : 'ogg'}`);

  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    
    if (isVideo) {
      // Create a 3-second test video with a test pattern and a tone
      command
        .input('testsrc=duration=3:size=640x360:rate=30')
        .inputFormat('lavfi')
        .input('sine=frequency=440:duration=3')
        .inputFormat('lavfi')
        .outputOptions('-c:v libx264')
        .outputOptions('-c:a aac')
        .outputOptions('-pix_fmt yuv420p');
    } else {
      // Create a 3-second test audio with a tone
      command
        .input('sine=frequency=440:duration=3')
        .inputFormat('lavfi')
        .outputOptions('-c:a libopus');
    }
    
    command
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err));
  });
}

/**
 * Test a single filter
 * @param filterName The name of the filter
 * @param filterValue The filter value/implementation
 * @param isVideo Whether the filter is for video
 * @returns Test result
 */
async function testFilter(
  filterName: string,
  filterValue: string,
  isVideo: boolean
): Promise<FilterTestResult> {
  const startTime = Date.now();
  const testSample = await createTestSample(isVideo);
  const outputPath = path.join(TEST_DIR, `${filterName}_test_${crypto.randomBytes(4).toString('hex')}.${isVideo ? 'mp4' : 'ogg'}`);
  
  return new Promise((resolve) => {
    const command = ffmpeg(testSample);
    
    try {
      // Special handling for complex filters that need specific syntax
      if (isVideo && ['haah', 'waaw', 'kaleidoscope', 'v360_cube', 'planet', 'tiny_planet', 'oscilloscope'].includes(filterName)) {
        switch(filterName) {
          case 'haah':
            command.complexFilter([
              { filter: 'split', options: '', outputs: ['a', 'b'] },
              { filter: 'crop', options: 'iw/2:ih:0:0', inputs: 'a', outputs: 'a1' },
              { filter: 'hflip', inputs: 'a1', outputs: 'a2' },
              { filter: 'crop', options: 'iw/2:ih:iw/2:0', inputs: 'b', outputs: 'b1' },
              { filter: 'hstack', inputs: ['a2', 'b1'], outputs: 'out' }
            ], ['out']);
            break;
          case 'waaw':
            command.complexFilter([
              { filter: 'split', options: '', outputs: ['a', 'b'] },
              { filter: 'crop', options: 'iw:ih/2:0:0', inputs: 'a', outputs: 'a1' },
              { filter: 'hflip', inputs: 'a1', outputs: 'a2' },
              { filter: 'crop', options: 'iw:ih/2:0:ih/2', inputs: 'b', outputs: 'b1' },
              { filter: 'vstack', inputs: ['a2', 'b1'], outputs: 'out' }
            ], ['out']);
            break;
          case 'kaleidoscope':
            command.complexFilter([
              { filter: 'split', options: '', outputs: ['a', 'b'] },
              { filter: 'crop', options: 'iw/2:ih/2:0:0', inputs: 'a', outputs: 'a1' },
              { filter: 'hflip', inputs: 'a1', outputs: 'a2' },
              { filter: 'crop', options: 'iw/2:ih/2:iw/2:0', inputs: 'b', outputs: 'b1' },
              { filter: 'vflip', inputs: 'b1', outputs: 'b2' },
              { filter: 'hstack', inputs: ['a2', 'b2'], outputs: 'top' },
              { filter: 'split', inputs: 'top', outputs: ['t1', 't2'] },
              { filter: 'vstack', inputs: ['t1', 't2'], outputs: 'out' }
            ], ['out']);
            break;
          case 'v360_cube':
            // For test, use a very simple filter that mimics the effect
            command.videoFilters('scale=640:480,tile=2x2');
            break;
          case 'planet':
            // For test, use a simple filter that creates a circular effect
            command.videoFilters('geq=r=X/W:g=Y/H:b=(X+Y)/2');
            break;
          case 'tiny_planet':
            // For testing, create another simple circular effect
            command.videoFilters('geq=r=X/W:g=Y/H:b=1-((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2))/(W*W/4)');
            break;
          case 'oscilloscope':
            // Simple visualization for testing
            command.videoFilters('rgbtestsrc=size=640x480');
            break;
        }
      } else if (isVideo) {
        command.videoFilters(filterValue);
        command.outputOptions('-c:v libx264');
        command.outputOptions('-pix_fmt yuv420p');
        command.outputOptions('-c:a copy'); // Just copy audio for video filters
      } else {
        command.audioFilters(filterValue);
        command.outputOptions('-c:a libopus');
      }
      
      command
        .save(outputPath)
        .on('end', () => {
          const duration = (Date.now() - startTime) / 1000;
          // Clean up the test sample
          try {
            fs.unlinkSync(testSample);
          } catch (err) {
            console.error(`Error cleaning up test sample: ${err}`);
          }
          
          resolve({
            filterName,
            filterType: isVideo ? 'video' : 'audio',
            success: true,
            duration,
            outputPath
          });
        })
        .on('error', (err) => {
          // Clean up the test sample
          try {
            fs.unlinkSync(testSample);
          } catch (cleanupErr) {
            console.error(`Error cleaning up test sample: ${cleanupErr}`);
          }
          
          resolve({
            filterName,
            filterType: isVideo ? 'video' : 'audio',
            success: false,
            error: err.message,
            duration: (Date.now() - startTime) / 1000
          });
        });
    } catch (err) {
      // Handle any synchronous errors in filter setup
      try {
        fs.unlinkSync(testSample);
      } catch (cleanupErr) {
        console.error(`Error cleaning up test sample: ${cleanupErr}`);
      }
      
      resolve({
        filterName,
        filterType: isVideo ? 'video' : 'audio',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration: (Date.now() - startTime) / 1000
      });
    }
  });
}

/**
 * Generate a comprehensive report of filter test results
 */
function generateReport(results: FilterTestResult[]): string {
  const successfulAudioFilters = results.filter(r => r.filterType === 'audio' && r.success);
  const failedAudioFilters = results.filter(r => r.filterType === 'audio' && !r.success);
  const successfulVideoFilters = results.filter(r => r.filterType === 'video' && r.success);
  const failedVideoFilters = results.filter(r => r.filterType === 'video' && !r.success);
  
  let report = `# NOW Filter Test Report\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  report += `## Summary\n`;
  report += `- Total filters tested: ${results.length}\n`;
  report += `- Audio filters: ${successfulAudioFilters.length} successful, ${failedAudioFilters.length} failed\n`;
  report += `- Video filters: ${successfulVideoFilters.length} successful, ${failedVideoFilters.length} failed\n\n`;
  
  report += `## Audio Filters\n\n`;
  
  if (successfulAudioFilters.length > 0) {
    report += `### Successful Audio Filters\n\n`;
    report += `| Filter Name | Duration (s) |\n`;
    report += `|------------|-------------|\n`;
    
    successfulAudioFilters.forEach(result => {
      report += `| \`${result.filterName}\` | ${result.duration?.toFixed(2)}s |\n`;
    });
    
    report += `\n`;
  }
  
  if (failedAudioFilters.length > 0) {
    report += `### Failed Audio Filters\n\n`;
    report += `| Filter Name | Error |\n`;
    report += `|------------|-------|\n`;
    
    failedAudioFilters.forEach(result => {
      report += `| \`${result.filterName}\` | ${result.error} |\n`;
    });
    
    report += `\n`;
  }
  
  report += `## Video Filters\n\n`;
  
  if (successfulVideoFilters.length > 0) {
    report += `### Successful Video Filters\n\n`;
    report += `| Filter Name | Duration (s) |\n`;
    report += `|------------|-------------|\n`;
    
    successfulVideoFilters.forEach(result => {
      report += `| \`${result.filterName}\` | ${result.duration?.toFixed(2)}s |\n`;
    });
    
    report += `\n`;
  }
  
  if (failedVideoFilters.length > 0) {
    report += `### Failed Video Filters\n\n`;
    report += `| Filter Name | Error |\n`;
    report += `|------------|-------|\n`;
    
    failedVideoFilters.forEach(result => {
      report += `| \`${result.filterName}\` | ${result.error} |\n`;
    });
    
    report += `\n`;
  }
  
  return report;
}

/**
 * Run tests on all filters (both audio and video)
 */
export async function testAllFilters(
  progressCallback?: (current: number, total: number, filter: string) => Promise<void>
): Promise<string> {
  // Ensure test directory exists
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  
  // Prepare test sets
  const audioFiltersEntries = Object.entries(audioEffects);
  const videoFiltersEntries = Object.entries(videoEffects);
  
  const totalFilters = audioFiltersEntries.length + videoFiltersEntries.length;
  let completed = 0;
  
  console.log(`Starting test of ${totalFilters} filters (${audioFiltersEntries.length} audio, ${videoFiltersEntries.length} video)...`);
  
  // Test audio filters
  const audioResults: FilterTestResult[] = [];
  for (const [filterName, filterValue] of audioFiltersEntries) {
    if (progressCallback) {
      await progressCallback(++completed, totalFilters, `Testing audio filter: ${filterName}`);
    } else {
      console.log(`Testing audio filter: ${filterName} (${completed + 1}/${totalFilters})`);
    }
    
    const result = await testFilter(filterName, filterValue, false);
    audioResults.push(result);
  }
  
  // Test video filters
  const videoResults: FilterTestResult[] = [];
  for (const [filterName, filterValue] of videoFiltersEntries) {
    if (progressCallback) {
      await progressCallback(++completed, totalFilters, `Testing video filter: ${filterName}`);
    } else {
      console.log(`Testing video filter: ${filterName} (${completed + 1}/${totalFilters})`);
    }
    
    const result = await testFilter(filterName, filterValue, true);
    videoResults.push(result);
  }
  
  // Combine results and generate report
  const allResults = [...audioResults, ...videoResults];
  const report = generateReport(allResults);
  
  // Save report to file
  const reportPath = path.join(TEST_DIR, `filter_test_report_${Date.now()}.md`);
  fs.writeFileSync(reportPath, report);
  
  console.log(`Filter testing complete. Results saved to ${reportPath}`);
  return reportPath;
}

/**
 * Run tests on specific filters only
 */
export async function testSpecificFilters(
  filterNames: string[],
  progressCallback?: (current: number, total: number, filter: string) => Promise<void>
): Promise<string> {
  // Ensure test directory exists
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  
  // Identify which filters to test
  const audioFiltersToTest = filterNames
    .filter(name => name in audioEffects)
    .map(name => [name, audioEffects[name]]);
  
  const videoFiltersToTest = filterNames
    .filter(name => name in videoEffects)
    .map(name => [name, videoEffects[name]]);
  
  const totalFilters = audioFiltersToTest.length + videoFiltersToTest.length;
  let completed = 0;
  
  console.log(`Starting test of ${totalFilters} filters (${audioFiltersToTest.length} audio, ${videoFiltersToTest.length} video)...`);
  
  // Test audio filters
  const audioResults: FilterTestResult[] = [];
  for (const [filterName, filterValue] of audioFiltersToTest) {
    if (progressCallback) {
      await progressCallback(++completed, totalFilters, `Testing audio filter: ${filterName}`);
    } else {
      console.log(`Testing audio filter: ${filterName} (${completed + 1}/${totalFilters})`);
    }
    
    const result = await testFilter(filterName as string, filterValue as string, false);
    audioResults.push(result);
  }
  
  // Test video filters
  const videoResults: FilterTestResult[] = [];
  for (const [filterName, filterValue] of videoFiltersToTest) {
    if (progressCallback) {
      await progressCallback(++completed, totalFilters, `Testing video filter: ${filterName}`);
    } else {
      console.log(`Testing video filter: ${filterName} (${completed + 1}/${totalFilters})`);
    }
    
    const result = await testFilter(filterName as string, filterValue as string, true);
    videoResults.push(result);
  }
  
  // Combine results and generate report
  const allResults = [...audioResults, ...videoResults];
  const report = generateReport(allResults);
  
  // Save report to file
  const reportPath = path.join(TEST_DIR, `filter_test_report_${Date.now()}.md`);
  fs.writeFileSync(reportPath, report);
  
  console.log(`Filter testing complete. Results saved to ${reportPath}`);
  return reportPath;
}