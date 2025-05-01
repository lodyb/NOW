const http = require('http');

// Configuration
const SERVER_HOST = '78.148.70.66';
const SERVER_PORT = 3000;
const MEDIA_ID = 1286;  // The ID we're having trouble with
const TEST_ANSWERS = "EBAN'KO\nebanko";

// Function to test the API with different methods and headers
function testApiRequest(method) {
  console.log(`\n--- Testing ${method} request ---`);
  
  // Prepare the request data
  const postData = JSON.stringify({
    answers: TEST_ANSWERS
  });
  
  // Configure the HTTP request options
  const options = {
    hostname: SERVER_HOST,
    port: SERVER_PORT,
    path: `/api/media/${MEDIA_ID}`,
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  console.log(`Sending request to: ${options.hostname}:${options.port}${options.path}`);
  console.log(`Payload: ${postData}`);
  
  // Make the HTTP request
  const req = http.request(options, (res) => {
    let data = '';
    
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log('RESPONSE BODY:');
      try {
        // Try to parse as JSON
        const parsedData = JSON.parse(data);
        console.log(JSON.stringify(parsedData, null, 2));
      } catch (e) {
        // If not valid JSON, just print the raw response
        console.log(data);
      }
    });
  });
  
  req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
  });
  
  // Write the data to the request body
  req.write(postData);
  req.end();
}

// Test both PUT and POST methods
testApiRequest('PUT');

// Add a small delay before the second request to avoid confusion in output
setTimeout(() => {
  testApiRequest('POST');
}, 1000);