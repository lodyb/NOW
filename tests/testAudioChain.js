const { testAudioFilterChain } = require('../src/media/filterTester');

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
  
  console.log('\nAll tests completed!');
}

testAudioFilterChain_SingleVsChained().catch(console.error);
