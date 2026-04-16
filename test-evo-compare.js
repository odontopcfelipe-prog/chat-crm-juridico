const axios = require('axios');

const URL = 'https://api.andrelustosaadvogados.com.br';
const KEY = '19a05742b587ef8e3e042d3ebe4197ae';
const INSTANCE = 'whatsapp';

async function test() {
  const endpoints = [
    { name: 'POST findContacts', method: 'POST', path: `chat/findContacts/${INSTANCE}`, data: { where: {} } },
    { name: 'POST findChats', method: 'POST', path: `chat/findChats/${INSTANCE}`, data: { where: {} } },
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
    } catch (e) {
      console.log(`Failed: ${e.message} ${e.response?.status} ${JSON.stringify(e.response?.data)}`);
    }
  }
}

test();
