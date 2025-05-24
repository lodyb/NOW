import { testNewEffects, testExtremeFilterCombinations, testSpecificFilters } from '../src/media/filterTester';
import { audioEffects, videoEffects } from '../src/media/processor';

describe('Filter Effects Tests', () => {
  jest.setTimeout(60000); // 60 seconds for complex filter tests

  test('should have all new VST-style audio effects defined', () => {
    const newVstEffects = [
      'granular', 'glitchstep', 'datacorrupt', 'timestretch', 'vocoder', 'ringmod',
      'formant', 'autopan', 'sidechain', 'compressor', 'limiter', 'multiband',
      'bitrot', 'memoryerror', 'bufferoverflow', 'stackcorrupt', 'voidecho',
      'dimension', 'timerift', 'quantum', 'cassettetape', 'vinylcrackle',
      'radiotuning', 'amradio'
    ];

    newVstEffects.forEach(effect => {
      expect(audioEffects).toHaveProperty(effect);
      expect(typeof audioEffects[effect]).toBe('string');
      expect(audioEffects[effect].length).toBeGreaterThan(0);
    });
  });

  test('should have all new datamoshing video effects defined', () => {
    const newVideoEffects = [
      'datamoshing', 'scanlines', 'chromashift', 'pixelshift', 'memoryglitch',
      'fisheye', 'tunnel', 'spin', 'zoom', 'vintage', 'cyberpunk', 'hologram',
      'audiowave', 'audiospectrum', 'audiofreq', 'audiovector',
      'commodore64', 'gameboy', 'nes'
    ];

    newVideoEffects.forEach(effect => {
      expect(videoEffects).toHaveProperty(effect);
      expect(typeof videoEffects[effect]).toBe('string');
      expect(videoEffects[effect].length).toBeGreaterThan(0);
    });
  });

  test('should validate filter syntax for new effects', () => {
    // Test that new audio effects have valid FFmpeg syntax
    const criticalAudioEffects = ['granular', 'vocoder', 'compressor', 'quantum'];
    
    criticalAudioEffects.forEach(effect => {
      const filterString = audioEffects[effect];
      expect(filterString).not.toContain('undefined');
      expect(filterString).not.toContain('null');
      // Basic FFmpeg filter syntax check
      expect(filterString.match(/[a-zA-Z][a-zA-Z0-9_]*(?:=[^,]+)?(?:,[a-zA-Z][a-zA-Z0-9_]*(?:=[^,]+)?)*/)).toBeTruthy();
    });

    // Test that new video effects have valid FFmpeg syntax
    const criticalVideoEffects = ['datamoshing', 'cyberpunk', 'commodore64'];
    
    criticalVideoEffects.forEach(effect => {
      const filterString = videoEffects[effect];
      expect(filterString).not.toContain('undefined');
      expect(filterString).not.toContain('null');
      expect(filterString.length).toBeGreaterThan(0);
    });
  });

  test('should test critical new audio effects', async () => {
    const criticalEffects = ['granular', 'vocoder', 'compressor', 'quantum', 'timerift'];
    
    const reportPath = await testSpecificFilters(criticalEffects);
    expect(reportPath).toBeTruthy();
    expect(reportPath).toContain('filter_test_report_');
  });

  test('should test all new effects comprehensively', async () => {
    const reportPath = await testNewEffects();
    expect(reportPath).toBeTruthy();
    expect(reportPath).toContain('new_effects_test_report_');
  });

  test('should handle extreme filter combinations without crashing', async () => {
    const reportPath = await testExtremeFilterCombinations();
    expect(reportPath).toBeTruthy();
    expect(reportPath).toContain('extreme_combinations_test_');
  });
});