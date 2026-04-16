const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  const endpoints = [
    { name: 'POST findChats', method: 'POST', path: `chat/findChats/${INSTANCE}`, data: { where: {} } },
    { name: 'GET fetchChats', method: 'GET', path: `chat/fetchChats/${INSTANCE}` },
    { name: 'GET getChats', method: 'GET', path: `chat/getChats/${INSTANCE}` },
  ];

  for (const ep of endpoints) {
    console.log(`--- Testing ${ep.name} ---`);
    try {
      const resp = await axios({
        method: ep.method,
        url: `${URL}/${ep.path}`,
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        data: ep.data
      });
      const data = resp.data;
      const count = Array.isArray(data) ? data.length : (data.data ? data.data.length : 'unknown');
      console.log(`Success! Result count: ${count}`);
      if (Array.isArray(data) && data.length > 0) {
        console.log('First entry sample:', JSON.stringify(data[0]).substring(0, 100));
      } else if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        console.log('First entry sample (data.data):', JSON.stringify(data.data[0]).substring(0, 100));
      }
    } catch (e) {
      console.log(`Failed: ${e.message} ${e.response?.status} ${JSON.stringify(e.response?.data)}`);
    }
  }
}

test();
