const { testAudioFilterChain } = require('../src/media/filterTester');
const { processFilterChainRobust } = require('../src/media/chainProcessor');
const path = require('path');

async function testAudioFilterChain_SingleVsChained() {
  console.log('Testing audio filters application methods...\n');
  
  // Test individual filters separately
  const result1 = await testAudioFilterChain(['alien']);
  console.log(`Test 1 - Single filter: ${result1.success ? 'SUCCESS' : 'FAILED'}`);

  // Test the same filter but applied in sequence (individually)
  const result2 = await testAudioFilterChain(['alien', 'alien']);
  console.log(`Test 2 - Same filter twice: ${result2.success ? 'SUCCESS' : 'FAILED'}`);
  
  // Test multiple different filters
  const result3 = await testAudioFilterChain(['alien', 'echo', 'robotize']); 
  console.log(`Test 3 - Multiple filters chained: ${result3.success ? 'SUCCESS' : 'FAILED'}`);
  
  // Test a complex chain with many filters
  const result4 = await testAudioFilterChain(['alien', 'nuked', 'corrupt', 'chipmunk', 'robotize', 'telephone', 'echo', 'metallic']);
  console.log(`Test 4 - Complex filter chain: ${result4.success ? 'SUCCESS' : 'FAILED'}`);
  
  // NEW: Test extremely problematic filter combinations
  console.log('\n--- Testing Extreme Cases ---');
  
  const result5 = await testAudioFilterChain(['deepfried', 'crushcrush', 'hardclip', 'saturate', 'bitcrush', 'distortion']);
  console.log(`Test 5 - Distortion overload: ${result5.success ? 'SUCCESS' : 'FAILED'}`);
  
  const result6 = await testAudioFilterChain(['quantum', 'timerift', 'dimension', 'voidecho', 'granular']);
  console.log(`Test 6 - Experimental effects: ${result6.success ? 'SUCCESS' : 'FAILED'}`);
  
  // NEW: Test robust chain processor with same problematic combinations
  console.log('\n--- Testing Robust Chain Processor ---');
  
  const testInputPath = path.join(process.cwd(), 'tests', 'test_sample.ogg');
  
  try {
    const result7 = await processFilterChainRobust(
      testInputPath,
      'robust_test_1.ogg', 
      '{deepfried+crushcrush+hardclip+saturate+bitcrush+distortion}',
      undefined,
      (stage, progress) => console.log(`  ${stage}: ${Math.round(progress * 100)}%`)
    );
    console.log(`Test 7 - Robust distortion chain: SUCCESS (${result7.appliedFilters.length}/${result7.appliedFilters.length + result7.skippedFilters.length} filters applied)`);
    if (result7.skippedFilters.length > 0) {
      console.log(`  Skipped: ${result7.skippedFilters.join(', ')}`);
    }
  } catch (error) {
    console.log(`Test 7 - Robust distortion chain: FAILED (${error.message})`);
  }
  
  try {
    const result8 = await processFilterChainRobust(
      testInputPath,
      'robust_test_2.ogg',
      '{alien+nuked+corrupt+chipmunk+robotize+telephone+echo+metallic+reverb+bass}',
      undefined,
      (stage, progress) => console.log(`  ${stage}: ${Math.round(progress * 100)}%`)
    );
    console.log(`Test 8 - Robust mega chain: SUCCESS (${result8.appliedFilters.length}/${result8.appliedFilters.length + result8.skippedFilters.length} filters applied)`);
    if (result8.skippedFilters.length > 0) {
      console.log(`  Skipped: ${result8.skippedFilters.join(', ')}`);
    }
  } catch (error) {
    console.log(`Test 8 - Robust mega chain: FAILED (${error.message})`);
  }
  
  console.log('\nAll tests completed!');
}

testAudioFilterChain_SingleVsChained().catch(console.error);
