#!/usr/bin/env npx ts-node

import { runComprehensiveFilterTest } from '../src/media/comprehensiveFilterTester';

async function main() {
  console.log('🧪 Starting comprehensive filter testing...');
  
  try {
    const reportPath = await runComprehensiveFilterTest(
      async (current, total, filter, type) => {
        const percentage = Math.round((current / total) * 100);
        console.log(`[${percentage}%] Testing ${type} filter: ${filter} (${current}/${total})`);
      }
    );
    
    console.log('\n✅ Filter testing complete!');
    console.log(`📄 Report saved to: ${reportPath}`);
    console.log('🔧 Whitelist generated and saved to: data/filter-whitelist.json');
    
  } catch (error) {
    console.error('❌ Filter testing failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}