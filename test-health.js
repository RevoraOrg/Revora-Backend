const http = require('http');

// Simple test to verify health endpoints work
async function testHealthEndpoints() {
  const baseUrl = 'http://localhost:4000';
  
  const endpoints = [
    '/health',
    '/ready', 
    '/live'
  ];

  console.log('Testing health endpoints...\n');

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`);
      const data = await response.json();
      
      console.log(`${endpoint}:`);
      console.log(`  Status: ${response.status}`);
      console.log(`  Response:`, JSON.stringify(data, null, 2));
      console.log('');
    } catch (error) {
      console.log(`${endpoint}: ERROR - ${error.message}`);
    }
  }
}

// Run the test
testHealthEndpoints().catch(console.error);